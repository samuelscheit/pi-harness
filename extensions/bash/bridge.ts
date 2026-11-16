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
// to the bash call's result, and stdout says so. A call whose client went away (`timeout 5 tool …`,
// `kill`) is aborted.
//
// `tool <name> … &`: a client the command leaves running keeps its call. The socket stays open
// after the command returns while its process group lives, so a client that connects late is
// served too. Such a client is a leftover process (leftovers.ts: counted as background work,
// stopped with the session); the bridge reports its end as a message with its exit code and the
// tool's result (text and images), and takes it out of the leftovers first, so the sweep does not
// report it again. Calls that end while the leftovers are being adopted wait for that, so each
// call is either answered within the bash call or reported as a job, never lost between the two.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { clip, minutes, type SessionJobs, wake } from "../background/jobs.ts";
import { reportWork } from "../background/work.ts";
import { EDIT_BLOCKS_HELP, runEditBlocks } from "./edit-blocks.ts";
import { type Leftover, release } from "./leftovers.ts";
import { SOCKET_ENV } from "./socket.ts";

export const TOOL_COMMAND = "tool";
export { SOCKET_ENV } from "./socket.ts";

export const TOOL_GUIDELINE = `Inside a bash command, \`${TOOL_COMMAND} <name> [arguments]\` calls any of your tools, for example \`${TOOL_COMMAND} read shot.png\` or \`${TOOL_COMMAND} web_fetch --url https://…\` (\`${TOOL_COMMAND} --help\` lists them, \`${TOOL_COMMAND} <name> --help\` shows a tool's arguments). Text results go to stdout; a failed call prints to stderr and exits 1; images are attached to the bash call's result. \`${TOOL_COMMAND} <name> … > out 2>&1 &\` runs any tool in the background: its end reaches you as a new message with its exit code and result. So steps that depend on each other go in one command: \`cargo build && ./target/debug/app && ${TOOL_COMMAND} read shot.png\`. To change files and then check them in one command, \`${TOOL_COMMAND} edit - <<'EOF'\` takes SEARCH/REPLACE blocks for several files (format in \`${TOOL_COMMAND} edit --help\`; each file's path alone on the line above its blocks), followed by the build or test joined with \`&&\` after the closing \`EOF\` line, so that a refused edit stops the command instead of testing the old code. A tool you need that is not loaded among your tool definitions is called the same way, with \`${TOOL_COMMAND} <name>\` in bash; never call another tool (such as creating a thread) as a probe to find or load it.`;

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
		...(tool.name === "edit" ? ["", EDIT_BLOCKS_HELP] : []),
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

export interface ToolRequest {
	argv: readonly string[];
	stdin?: string;
	/** The shell's working directory when it ran `tool`; relative paths resolve against it. */
	cwd?: string;
}

/**
 * Run one `tool` invocation: argv as the client sent it. Each image of the result goes to
 * `attach`, which returns the line that stands for it in the output.
 */
export async function runToolCommand(
	ctx: Pick<ExtensionToolContext, "tools" | "executeTool" | "cwd">,
	request: ToolRequest,
	attach: (image: ImageContent) => string,
	signal: AbortSignal,
): Promise<ToolResponse> {
	const [name, ...rest] = request.argv;
	if (name === undefined || name === "--help" || name === "-h" || name === "help") return { stdout: withNewline(listTools(ctx.tools)), stderr: "", code: 0 };
	const tool = ctx.tools.find((candidate) => candidate.name === name);
	if (!tool) {
		return { stdout: "", stderr: `${TOOL_COMMAND}: unknown tool ${JSON.stringify(name)}. Tools: ${ctx.tools.map((t) => t.name).join(", ")}\n`, code: 2 };
	}
	const cwd = request.cwd ?? ctx.cwd;
	if (name === "edit" && rest.length === 1 && rest[0] === "-") return runEditBlocks(ctx, request.stdin ?? "", cwd, signal);
	if (name === "edit" && rest.length === 0) {
		return { stdout: "", stderr: `${TOOL_COMMAND} edit: no arguments; pass \`--path\` and \`--edits\`, or \`-\` and blocks on stdin.\n\n${EDIT_BLOCKS_HELP}\n`, code: 2 };
	}
	let parsed: ParsedArguments;
	try {
		parsed = parseArguments(tool.parameters as Schema, rest, request.stdin);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		return { stdout: "", stderr: `${TOOL_COMMAND} ${name}: ${error.message}\nRun \`${TOOL_COMMAND} ${name} --help\` for its arguments.\n`, code: 2 };
	}
	if (parsed.help) return { stdout: withNewline(describeTool(tool)), stderr: "", code: 0 };
	// Every tool's `path` is a file or directory: relative to the shell's directory after a `cd`, not the session's.
	if (typeof parsed.args.path === "string" && parsed.args.path !== "" && !isAbsolute(parsed.args.path) && !parsed.args.path.startsWith("~")) {
		parsed.args.path = resolve(cwd, parsed.args.path);
	}

	const outcome = await ctx.executeTool(name, parsed.args, { signal });
	const result = outcome.result as AgentToolResult<unknown> & { structuredContent?: unknown };
	const lines: string[] = [];
	for (const block of result.content ?? []) {
		if (block.type === "text") lines.push(block.text);
		else if (block.type === "image") lines.push(attach(block));
	}
	const text = withNewline(parsed.json && result.structuredContent !== undefined ? JSON.stringify(result.structuredContent, null, 2) : lines.join("\n"));
	return outcome.isError ? { stdout: "", stderr: text || `${TOOL_COMMAND} ${name} failed\n`, code: 1 } : { stdout: text, stderr: "", code: 0 };
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

const state = globalThis as { __harnessToolBin?: string; __harnessToolSockets?: number };
/** The client's file in a `tool` directory. */
const clientIn = (binDir: string) => join(binDir, `${TOOL_COMMAND}.mjs`);

/**
 * The directory holding the `tool` command, per process: a wrapper and a copy of the client, so
 * the command never depends on a release's files, which pruning removes once no session runs it
 * (the process, its scripts and its background `tool` clients outlive the release they started on).
 * Rewritten on each load with the client of the release loaded last; each file by an atomic rename,
 * so a script calling it meanwhile sees whole files.
 */
export function toolBinDir(): string {
	const dir = (state.__harnessToolBin ??= join(tmpdir(), "pi-harness-tool", String(process.pid)));
	mkdirSync(dir, { recursive: true });
	const install = (path: string, content: string | Buffer, mode: number) => {
		const temp = join(dir, `.${TOOL_COMMAND}.${process.hrtime.bigint()}`);
		writeFileSync(temp, content, { mode });
		renameSync(temp, path);
	};
	install(clientIn(dir), readFileSync(new URL("./cli.mjs", import.meta.url)), 0o644);
	install(join(dir, TOOL_COMMAND), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(clientIn(dir))} "$@"\n`, 0o755);
	return dir;
}

/** The line put before a bash command: the `tool` command on PATH and the call's socket. */
export const bridgeLine = (binDir: string, socket: string) => `export ${SOCKET_ENV}=${quote(socket)} PATH=${quote(binDir)}:"$PATH"\n`;

const shellWord = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : quote(word));

/** A `tool` command as the shell ran it. */
export const toolLabel = (argv: readonly string[]) => [TOOL_COMMAND, ...argv.map(shellWord)].join(" ");

/** `tool …` for the `ps` command line of a `tool` client (before or after the wrapper's `exec`); undefined for another process. */
export function clientCommand(command: string, binDir = state.__harnessToolBin): string | undefined {
	if (binDir === undefined) return undefined;
	const prefixes = [`${process.execPath} ${clientIn(binDir)}`, `/bin/sh ${join(binDir, TOOL_COMMAND)}`];
	for (const prefix of prefixes) if (command === prefix || command.startsWith(`${prefix} `)) return TOOL_COMMAND + command.slice(prefix.length);
	return undefined;
}

/** The message a `tool` command left running sends when its call ends, or when it was killed first. */
export function toolEndedText(job: Pick<Leftover, "pid" | "startedBy">, label: string, end: ToolResponse | "killed", ms: number): string {
	const head = `Your background \`${clip(label, 160)}\` (pid ${job.pid}, left running by your command \`${clip(job.startedBy, 160)}\`)`;
	if (end === "killed") return `${head} was killed after ${minutes(ms)}, so its call was aborted.`;
	return `${head} exited with code ${end.code} after ${minutes(ms)}:\n\n${(end.stdout + end.stderr).trimEnd() || "(no output)"}`;
}

/** Whether process group `pgid` still has a live process. */
function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** One `tool` client of a bridge. */
interface Client {
	pid: number | undefined;
	label: string;
	startedAt: number;
	answered: boolean;
	/** Aborts its call: the client went away, or the bash call was aborted while it ran. */
	controller: AbortController;
	/** Images of a call that ended after the command returned: they come with its message. */
	images: ImageContent[];
}

/** What a bash call left running, once it returned. */
export interface Adopted {
	/** The call's process group; undefined when unknown. */
	pgid: number | undefined;
	left: Leftover[];
}

export interface Bridge {
	/** Put before the command. */
	line: string;
	/**
	 * The command returned: adopt what it left running (`adopt`), then serve its `tool` commands as
	 * jobs while its process group lives. Returns the images of the calls answered within the bash
	 * call and the leftovers, the `tool` commands among them named as such.
	 */
	ended(adopt: () => Promise<Adopted>): Promise<{ images: ImageContent[]; left: Leftover[] }>;
}

/**
 * Open the socket of one bash call. `signal` (the bash call's) aborts the calls of its `tool`
 * commands while the command runs; afterwards only a client's death (also at the session's end,
 * which kills the leftovers) aborts its call.
 */
export async function openBridge(
	ctx: Pick<ExtensionToolContext, "tools" | "executeTool" | "cwd">,
	signal: AbortSignal | undefined,
	binDir: string,
	jobs: SessionJobs,
	pollMs: number,
): Promise<Bridge> {
	const images: ImageContent[] = [];
	const path = join(tmpdir(), `pi-tool-${process.pid}-${(state.__harnessToolSockets = (state.__harnessToolSockets ?? 0) + 1)}.sock`);
	rmSync(path, { force: true });
	const clients = new Set<Client>();
	const sockets = new Set<Socket>();
	/** Pids of clients answered: what is left of them when the command returns is no job. */
	const answered = new Set<number>();
	let phase: "running" | "adopting" | "ended" = "running";
	let pgid: number | undefined;
	let adopted!: () => void;
	const gate = new Promise<void>((resolve) => (adopted = resolve));
	/** Wait while the leftovers are adopted: then a call knows whether it is a job. */
	const settled = () => (phase === "adopting" ? gate : undefined);

	const abortAll = () => {
		for (const client of clients) client.controller.abort(signal?.reason);
	};
	signal?.addEventListener("abort", abortAll, { once: true });

	/** The client's leftover when it is a job (left running by the command, its end not reported yet). */
	const jobOf = (client: Client) => {
		const leftover = phase === "ended" && client.pid !== undefined ? jobs.leftovers.get(client.pid) : undefined;
		return leftover?.pgid === pgid ? leftover : undefined;
	};

	const attach = (client: Client) => (image: ImageContent) => {
		if (phase === "running") {
			images.push(image);
			return `[image ${images.length} (${image.mimeType}) is attached to this bash call's result]`;
		}
		if (!jobOf(client)) return `[image (${image.mimeType}) not shown: the bash call that started this command has ended]`;
		client.images.push(image);
		return `[image ${client.images.length} (${image.mimeType}) is attached to the message that reports this command's end]`;
	};

	/** A job's end: take it out of the leftovers (so the sweep does not report it too) and report it. */
	const reportEnd = (client: Client, end: ToolResponse | "killed") => {
		const job = jobOf(client);
		if (!job || !release(jobs, job.pid, job.pgid)) return;
		const text = toolEndedText(job, client.label, end, Date.now() - client.startedAt);
		const images = end === "killed" ? [] : client.images;
		wake(jobs, images.length ? [{ type: "text", text }, ...images] : text, `the end of ${client.label}`);
	};

	const serve = (socket: Socket) => {
		const client: Client = { pid: undefined, label: TOOL_COMMAND, startedAt: Date.now(), answered: false, controller: new AbortController(), images: [] };
		if (phase === "running" && signal?.aborted) client.controller.abort(signal.reason);
		clients.add(client);
		sockets.add(socket);
		// The client keeps its side open until the answer: closing it first means it was killed (`timeout`, `kill`, the session's end).
		socket.on("close", () => {
			clients.delete(client);
			sockets.delete(socket);
			if (client.answered) return;
			client.controller.abort(new Error("the tool command exited"));
			reportEnd(client, "killed");
		});
		socket.on("error", () => {});
		socket.setEncoding("utf8");
		let buffered = "";
		let received = false;
		socket.on("data", async (chunk: string) => {
			if (received) return;
			buffered += chunk;
			const newline = buffered.indexOf("\n");
			if (newline < 0) return;
			received = true;
			let response: ToolResponse;
			try {
				const request = JSON.parse(buffered.slice(0, newline)) as { argv?: unknown; stdin?: unknown; cwd?: unknown; pid?: unknown };
				if (!Array.isArray(request.argv) || !request.argv.every((arg) => typeof arg === "string")) throw new Error("argv must be strings");
				if (Number.isInteger(request.pid)) client.pid = request.pid as number;
				client.label = toolLabel(request.argv);
				const toolRequest: ToolRequest = {
					argv: request.argv,
					...(typeof request.stdin === "string" ? { stdin: request.stdin } : {}),
					...(typeof request.cwd === "string" ? { cwd: request.cwd } : {}),
				};
				// A call that ends while the leftovers are adopted waits for that, so its images go where its result goes.
				const callContext = {
					get tools() {
						return ctx.tools;
					},
					get cwd() {
						return ctx.cwd;
					},
					executeTool: async (...args: Parameters<typeof ctx.executeTool>) => {
						const outcome = await ctx.executeTool(...args);
						await settled();
						return outcome;
					},
				};
				response = await runToolCommand(callContext, toolRequest, attach(client), client.controller.signal);
			} catch (error) {
				response = { stdout: "", stderr: `${TOOL_COMMAND}: ${error instanceof Error ? error.message : String(error)}\n`, code: 1 };
			}
			await settled();
			if (socket.destroyed) return;
			client.answered = true;
			if (client.pid !== undefined) answered.add(client.pid);
			reportEnd(client, response);
			socket.end(JSON.stringify(response));
		});
	};

	const server = createServer(serve);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => resolve());
	});
	chmodSync(path, 0o600);

	const close = () => {
		for (const socket of sockets) socket.destroy();
		server.close();
		rmSync(path, { force: true });
	};

	return {
		line: bridgeLine(binDir, path),
		async ended(adopt) {
			phase = "adopting";
			signal?.removeEventListener("abort", abortAll);
			const result = await adopt();
			pgid = result.pgid;
			const left = result.left.filter((leftover) => {
				// Answered already and about to exit: nothing to track.
				if (answered.has(leftover.pid)) {
					release(jobs, leftover.pid, leftover.pgid);
					return false;
				}
				const client = [...clients].find((c) => c.pid === leftover.pid);
				const command = client ? client.label : clientCommand(leftover.command);
				if (command !== undefined) Object.assign(leftover, { command, tool: true });
				return true;
			});
			// The `tool` commands among them are items of their own kind.
			if (left.some((leftover) => leftover.tool)) reportWork(jobs);
			phase = "ended";
			adopted();
			// Late clients (`tool x &` as the last command still starting) connect while the group lives.
			if (pgid === undefined || !groupAlive(pgid)) close();
			else {
				const group = pgid;
				const poll = setInterval(() => {
					if (groupAlive(group)) return;
					clearInterval(poll);
					close();
				}, pollMs);
				poll.unref?.();
			}
			return { images, left };
		},
	};
}

type Result<T> = AgentToolResult<T>;

/** The bash call's result with the images its `tool` calls returned. */
export function withImages<T>(result: Result<T>, images: readonly ImageContent[]): Result<T> {
	if (images.length === 0) return result;
	return { ...result, content: [...(result.content as (TextContent | ImageContent)[]), ...images] };
}
