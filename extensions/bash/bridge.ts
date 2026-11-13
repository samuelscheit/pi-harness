// Tools from bash: inside a bash call, `tool <name> [arguments]` runs any tool the agent can call.
//
// Steps that depend on each other (build, run, look at the screenshot it wrote) took one model
// request each: tool calls in one response run in parallel, so a dependent call would race the
// one it needs. A script expresses the order, and the model writes shell well; JavaScript code
// mode was promoted for this and saw 4 calls against 4841 bash calls (2026-11-12/13). So bash is
// the one way to script, and this bridge gives it the tools.
//
// Each bash call gets a Unix socket of its own and a `tool` command on its PATH (a small Node
// client, cli.mjs). The client sends its argv; the bridge parses it against the tool's parameter
// schema and runs the call through `ctx.executeTool()`, the session's tool pipeline: validation,
// hooks and permissions as for a call the model made, recorded as a nested call of the bash call.
// Text results go to stdout and failures to stderr with exit code 1, so `&&`, `if` and `set -e`
// work. Images (a screenshot read with `tool read`) cannot pass through a pipe: they are attached
// to the bash call's result, and stdout says so. The socket closes when the bash call ends; a
// nested call still running is aborted, as is one whose client went away (`timeout 5 tool …`).

import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { createBashToolDefinition, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

type BashDefinition = ReturnType<typeof createBashToolDefinition>;

export const TOOL_COMMAND = "tool";
export const SOCKET_ENV = "PI_TOOL_SOCKET";

export const TOOL_GUIDELINE = `Inside a bash command, \`${TOOL_COMMAND} <name> [arguments]\` calls any of your tools, for example \`${TOOL_COMMAND} read shot.png\` or \`${TOOL_COMMAND} web_fetch --url https://…\` (\`${TOOL_COMMAND} --help\` lists them, \`${TOOL_COMMAND} <name> --help\` shows a tool's arguments). Text results go to stdout; a failed call prints to stderr and exits 1; images are attached to the bash call's result. So steps that depend on each other go in one command: \`cargo build && ./target/debug/app && ${TOOL_COMMAND} read shot.png\`.`;

/** A JSON schema as tool parameters declare them (TypeBox). */
interface Schema {
	type?: string | string[];
	properties?: Record<string, Schema>;
	required?: string[];
	items?: Schema;
	anyOf?: Schema[];
	oneOf?: Schema[];
	enum?: unknown[];
	const?: unknown;
	description?: string;
}

export interface ToolResponse {
	stdout: string;
	stderr: string;
	code: number;
}

export interface ParsedArguments {
	args: Record<string, unknown>;
	/** `--json`: print the structured result. */
	json: boolean;
	help: boolean;
}

export class UsageError extends Error {}

const normalize = (name: string) => name.toLowerCase().replace(/[-_]/g, "");

/** The JSON types a schema allows; empty when it says nothing (any). */
function typesOf(schema: Schema | undefined): Set<string> {
	if (!schema) return new Set();
	const variants = schema.anyOf ?? schema.oneOf;
	if (variants) return new Set(variants.flatMap((variant) => [...typesOf(variant)]));
	if (schema.type) return new Set(Array.isArray(schema.type) ? schema.type : [schema.type]);
	if (schema.const !== undefined || schema.enum) return new Set([...(schema.enum ?? [schema.const])].map((value) => typeof value));
	return new Set();
}

function parseJson(raw: string, what: string): unknown {
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new UsageError(`${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** One command-line value as the property's schema wants it. */
export function coerce(schema: Schema | undefined, raw: string, name: string): unknown {
	const types = typesOf(schema);
	if (types.size === 0) return /^\s*[[{"]/.test(raw) ? parseJson(raw, `--${name}`) : raw;
	if (types.has("string")) return raw;
	if (types.has("integer") || types.has("number")) {
		const value = Number(raw);
		if (raw.trim() === "" || !Number.isFinite(value)) throw new UsageError(`--${name} must be a number, got ${JSON.stringify(raw)}`);
		if (!types.has("number") && !Number.isInteger(value)) throw new UsageError(`--${name} must be an integer, got ${raw}`);
		return value;
	}
	if (types.has("boolean")) {
		if (raw === "true" || raw === "false") return raw === "true";
		throw new UsageError(`--${name} must be true or false, got ${JSON.stringify(raw)}`);
	}
	if (types.has("array") && !raw.trimStart().startsWith("[")) return [coerce(schema?.items, raw, name)];
	const value = parseJson(raw, `--${name}`);
	if (types.has("object") && !types.has("array") && (typeof value !== "object" || value === null || Array.isArray(value))) {
		throw new UsageError(`--${name} must be a JSON object`);
	}
	return value;
}

/**
 * A tool's arguments from the command line: `--name value`, `--name=value`, a bare `--flag` or
 * `--no-flag` for booleans, a repeated option for arrays (or one JSON array), JSON for objects,
 * positional values for the required properties in order, and `--args <json>` (`-` reads stdin)
 * as the base the options override. Option names match properties ignoring case, `-` and `_`.
 * `--json` and `--help` are the command's own unless the tool has a property of that name.
 */
export function parseArguments(schema: Schema, argv: readonly string[], stdin?: string): ParsedArguments {
	const properties = schema.properties ?? {};
	const byName = new Map(Object.keys(properties).map((name) => [normalize(name), name]));
	const args: Record<string, unknown> = {};
	const given = new Set<string>();
	const positional: string[] = [];
	let base: Record<string, unknown> = {};
	let json = false;
	let help = false;

	const set = (name: string, raw: string) => {
		const property = properties[name];
		const value = coerce(property, raw, name);
		if (typesOf(property).has("array") && Array.isArray(args[name]) && !raw.trimStart().startsWith("[")) {
			(args[name] as unknown[]).push(...(value as unknown[]));
		} else args[name] = value;
		given.add(name);
	};

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i]!;
		if (token === "--") {
			positional.push(...argv.slice(i + 1));
			break;
		}
		if (!token.startsWith("--") || token === "--") {
			if (token === "-h" && !byName.has("h")) help = true;
			else positional.push(token);
			continue;
		}
		const eq = token.indexOf("=");
		const key = token.slice(2, eq < 0 ? undefined : eq);
		const inline = eq < 0 ? undefined : token.slice(eq + 1);
		const name = byName.get(normalize(key));
		const next = () => {
			if (inline !== undefined) return inline;
			if (i + 1 >= argv.length) throw new UsageError(`--${key} needs a value`);
			return argv[++i]!;
		};
		if (name === undefined) {
			if (key === "help") help = true;
			else if (key === "json" && inline === undefined) json = true;
			else if (key === "args") {
				const raw = next();
				const value = parseJson(raw === "-" ? (stdin ?? "") : raw, "--args");
				if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UsageError("--args must be a JSON object");
				base = value as Record<string, unknown>;
			} else {
				const negated = key.startsWith("no-") ? byName.get(normalize(key.slice(3))) : undefined;
				if (negated !== undefined && typesOf(properties[negated]).has("boolean") && inline === undefined) {
					args[negated] = false;
					given.add(negated);
				} else {
					const options = Object.keys(properties).map((p) => `--${p}`);
					throw new UsageError(`unknown option --${key}${options.length ? `; options: ${options.join(", ")}` : "; this tool takes no arguments"}`);
				}
			}
			continue;
		}
		const types = typesOf(properties[name]);
		if (types.has("boolean") && !types.has("string") && inline === undefined && !(argv[i + 1] === "true" || argv[i + 1] === "false")) {
			args[name] = true;
			given.add(name);
		} else set(name, next());
	}

	const open = (schema.required ?? []).filter((name) => !given.has(name) && !(name in base));
	if (positional.length > open.length) {
		const extra = positional.slice(open.length).map((value) => JSON.stringify(value));
		throw new UsageError(
			open.length === 0 && (schema.required ?? []).length === 0
				? `unexpected argument ${extra.join(" ")}: pass options as --name value`
				: `unexpected argument ${extra.join(" ")}: positional values fill the required arguments (${(schema.required ?? []).join(", ")}) only; pass others as --name value`,
		);
	}
	positional.forEach((raw, index) => set(open[index]!, raw));
	return { args: { ...base, ...args }, json, help };
}

const firstParagraph = (text: string) => text.trim().split(/\n\s*\n/)[0]!.replace(/\s+/g, " ");

const typeName = (schema: Schema | undefined): string => {
	const types = [...typesOf(schema)];
	if (types.length === 0) return "json";
	if (types.length === 1 && types[0] === "array") return `${typeName(schema?.items)}…`;
	return types.join("|");
};

/** `tool <name> --help`. */
export function describeTool(tool: Pick<AgentTool, "name" | "description" | "parameters">): string {
	const schema = tool.parameters as Schema;
	const properties = Object.entries(schema.properties ?? {});
	const required = new Set(schema.required ?? []);
	const usage = [
		`${TOOL_COMMAND} ${tool.name}`,
		...(schema.required ?? []).map((name) => `<${name}>`),
		...properties.filter(([name]) => !required.has(name)).map(([name, property]) => `[--${name} <${typeName(property)}>]`),
	].join(" ");
	const options = properties.map(([name, property]) => {
		const note = property.description ? ` ${property.description.replace(/\s+/g, " ").trim()}` : "";
		return `  --${name} <${typeName(property)}>${required.has(name) ? " (required)" : ""}${note}`;
	});
	return [
		`${tool.name}: ${tool.description.trim()}`,
		"",
		`Usage: ${usage}`,
		...(options.length ? ["", "Options:", ...options] : []),
		"",
		`Arrays: repeat the option or pass a JSON array. Objects: JSON. All arguments as JSON: --args '{…}', or --args - to read them from stdin (a heredoc).`,
		"--json prints the structured result, when the tool has one.",
	].join("\n");
}

/** `tool --help`. */
export function listTools(tools: readonly Pick<AgentTool, "name" | "description">[]): string {
	const width = Math.max(0, ...tools.map((tool) => tool.name.length));
	return [
		`Usage: ${TOOL_COMMAND} <name> [arguments]   (${TOOL_COMMAND} <name> --help shows a tool's arguments)`,
		"",
		"Tools:",
		...tools.map((tool) => `  ${tool.name.padEnd(width)}  ${firstParagraph(tool.description).slice(0, 120)}`),
	].join("\n");
}

const withNewline = (text: string) => (text === "" || text.endsWith("\n") ? text : `${text}\n`);

/**
 * Run one `tool` invocation: argv as the client sent it. Images of the result go to `images`
 * (attached to the bash call's result); the response names them.
 */
export async function runToolCommand(
	ctx: Pick<ExtensionToolContext, "tools" | "executeTool">,
	request: { argv: readonly string[]; stdin?: string },
	images: ImageContent[],
	signal: AbortSignal,
): Promise<ToolResponse> {
	const [name, ...rest] = request.argv;
	if (name === undefined || name === "--help" || name === "-h" || name === "help") return { stdout: withNewline(listTools(ctx.tools)), stderr: "", code: 0 };
	const tool = ctx.tools.find((candidate) => candidate.name === name);
	if (!tool) {
		return { stdout: "", stderr: `${TOOL_COMMAND}: unknown tool ${JSON.stringify(name)}. Tools: ${ctx.tools.map((t) => t.name).join(", ")}\n`, code: 2 };
	}
	let parsed: ParsedArguments;
	try {
		parsed = parseArguments(tool.parameters as Schema, rest, request.stdin);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		return { stdout: "", stderr: `${TOOL_COMMAND} ${name}: ${error.message}\nRun \`${TOOL_COMMAND} ${name} --help\` for its arguments.\n`, code: 2 };
	}
	if (parsed.help) return { stdout: withNewline(describeTool(tool)), stderr: "", code: 0 };

	const outcome = await ctx.executeTool(name, parsed.args, { signal });
	const result = outcome.result as AgentToolResult<unknown> & { structuredContent?: unknown };
	const lines: string[] = [];
	for (const block of result.content ?? []) {
		if (block.type === "text") lines.push(block.text);
		else if (block.type === "image") {
			images.push(block);
			lines.push(`[image ${images.length} (${block.mimeType}) is attached to this bash call's result]`);
		}
	}
	const text = withNewline(parsed.json && result.structuredContent !== undefined ? JSON.stringify(result.structuredContent, null, 2) : lines.join("\n"));
	return outcome.isError ? { stdout: "", stderr: text || `${TOOL_COMMAND} ${name} failed\n`, code: 1 } : { stdout: text, stderr: "", code: 0 };
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

const state = globalThis as { __harnessToolBin?: string; __harnessToolSockets?: number };

/**
 * The directory holding the `tool` command, per process. Rewritten on each load, so it runs the
 * client of the release loaded last (an atomic rename: a script calling it meanwhile sees a whole file).
 */
export function toolBinDir(): string {
	const dir = (state.__harnessToolBin ??= join(tmpdir(), "pi-harness-tool", String(process.pid)));
	mkdirSync(dir, { recursive: true });
	const client = fileURLToPath(new URL("./cli.mjs", import.meta.url));
	const temp = join(dir, `.${TOOL_COMMAND}.${process.hrtime.bigint()}`);
	writeFileSync(temp, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(client)} "$@"\n`, { mode: 0o755 });
	renameSync(temp, join(dir, TOOL_COMMAND));
	return dir;
}

/** The line put before a bash command: the `tool` command on PATH and the call's socket. */
export const bridgeLine = (binDir: string, socket: string) => `export ${SOCKET_ENV}=${quote(socket)} PATH=${quote(binDir)}:"$PATH"\n`;

/**
 * Read one request (a JSON line), answer, close. The client keeps its side open until the answer:
 * after a half-close, its death would go unnoticed until the answer is written.
 */
function serve(socket: Socket, handle: (request: { argv: string[]; stdin?: string }, signal: AbortSignal) => Promise<ToolResponse>, parent: AbortSignal) {
	const controller = new AbortController();
	const abort = () => controller.abort(parent.reason);
	parent.addEventListener("abort", abort, { once: true });
	let buffered = "";
	let received = false;
	let answered = false;
	// The client went away before its answer (killed by `timeout`, the shell ended): stop its call.
	socket.on("close", () => {
		parent.removeEventListener("abort", abort);
		if (!answered) controller.abort(new Error("the tool command exited"));
	});
	socket.on("error", () => {});
	socket.setEncoding("utf8");
	socket.on("data", async (chunk: string) => {
		if (received) return;
		buffered += chunk;
		const newline = buffered.indexOf("\n");
		if (newline < 0) return;
		received = true;
		let response: ToolResponse;
		try {
			const request = JSON.parse(buffered.slice(0, newline)) as { argv?: unknown; stdin?: unknown };
			if (!Array.isArray(request.argv) || !request.argv.every((arg) => typeof arg === "string")) throw new Error("argv must be strings");
			response = await handle({ argv: request.argv, ...(typeof request.stdin === "string" ? { stdin: request.stdin } : {}) }, controller.signal);
		} catch (error) {
			response = { stdout: "", stderr: `${TOOL_COMMAND}: ${error instanceof Error ? error.message : String(error)}\n`, code: 1 };
		}
		answered = true;
		if (!socket.destroyed) socket.end(JSON.stringify(response));
	});
}

export interface Bridge {
	/** Put before the command. */
	line: string;
	images: ImageContent[];
	close(): Promise<void>;
}

/** Open the socket of one bash call. */
export async function openBridge(ctx: Pick<ExtensionToolContext, "tools" | "executeTool">, signal: AbortSignal, binDir: string): Promise<Bridge> {
	const images: ImageContent[] = [];
	const path = join(tmpdir(), `pi-tool-${process.pid}-${(state.__harnessToolSockets = (state.__harnessToolSockets ?? 0) + 1)}.sock`);
	rmSync(path, { force: true });
	const open = new Set<Socket>();
	const server = createServer((socket) => {
		open.add(socket);
		socket.on("close", () => open.delete(socket));
		serve(socket, (request, callSignal) => runToolCommand(ctx, request, images, callSignal), signal);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => resolve());
	});
	chmodSync(path, 0o600);
	return {
		line: bridgeLine(binDir, path),
		images,
		close: async () => {
			for (const socket of open) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(path, { force: true });
		},
	};
}

type Result<T> = AgentToolResult<T>;

/** The bash call's result with the images its `tool` calls returned. */
export function withImages<T>(result: Result<T>, images: readonly ImageContent[]): Result<T> {
	if (images.length === 0) return result;
	return { ...result, content: [...(result.content as (TextContent | ImageContent)[]), ...images] };
}

/** `definition` (bash) with `tool` available inside its commands. Without a tool context (no session), it runs as is. */
export function withToolBridge(definition: BashDefinition): BashDefinition {
	const binDir = toolBinDir();
	return {
		...definition,
		async execute(callId, params, signal, onUpdate, ctx) {
			const toolContext = ctx as Partial<ExtensionToolContext> | undefined;
			if (typeof toolContext?.executeTool !== "function") return definition.execute(callId, params, signal, onUpdate, ctx);
			const lifetime = new AbortController();
			const forward = () => lifetime.abort(signal?.reason);
			if (signal?.aborted) forward();
			else signal?.addEventListener("abort", forward, { once: true });
			const bridge = await openBridge(toolContext as ExtensionToolContext, lifetime.signal, binDir);
			try {
				const result = await definition.execute(callId, { ...params, command: bridge.line + params.command }, signal, onUpdate, ctx);
				return withImages(result, bridge.images);
			} finally {
				signal?.removeEventListener("abort", forward);
				// Calls still running when the command ended have no one to answer to.
				lifetime.abort(new Error("the bash command ended"));
				await bridge.close();
			}
		},
	};
}
