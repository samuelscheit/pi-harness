// Workflow scripts are TypeScript, compiled to CommonJS by jiti (Pi's own TypeScript loader; its
// transform keeps every statement on its source line) and evaluated in a fresh node:vm context per
// run, whose globals are the script API (api.d.ts) plus a few standard ones. Nothing else of Node is
// reachable: no require, process or file system; scripts act through tools, shell, llm and agent,
// so their effects pass the session's hooks and metrics. The context is not a security boundary
// (the script runs in Pi's process with the agent's own rights), only a scope.
//
// Inline code is the body of an async function. It is wrapped as a module's default export on its
// first line, so line numbers in errors are the script's own.

import { createHash } from "node:crypto";
import vm from "node:vm";
import { createJiti } from "jiti";

/** How long a module's top level may run synchronously (it should only declare). */
const LOAD_TIMEOUT_MS = 2000;

let jiti: ReturnType<typeof createJiti> | undefined;
const compiled = new Map<string, string>();

/** A module with an async function body as its default export, on the body's first line. */
export const inlineModule = (body: string) => `export default async function () {${body}\n}`;

/** TypeScript (ES module) to CommonJS with the same line numbers; cached by content. Throws for syntax errors. */
export function compile(source: string, filename: string): string {
	const key = createHash("sha256").update(filename).update("\0").update(source).digest("hex");
	const hit = compiled.get(key);
	if (hit !== undefined) return hit;
	jiti ??= createJiti(import.meta.url);
	const js = jiti.transform({ source, filename, ts: true, retainLines: true });
	// jiti reports a parse error as a module exporting it instead of throwing.
	const failed = /^exports\.__JITI_ERROR__ = (.*)$/s.exec(js);
	if (failed) {
		const error = JSON.parse(failed[1]!) as { line?: number; column?: number; message?: string };
		throw new SyntaxError(`${filename}:${error.line ?? "?"}:${error.column ?? "?"}: ${(error.message ?? "cannot parse").trim()}`);
	}
	compiled.set(key, js);
	return js;
}

/** Host values a script may use besides the API: its own realm brings the language built-ins. */
const STANDARD_GLOBALS = { setTimeout, clearTimeout, structuredClone, URL, URLSearchParams, TextEncoder, TextDecoder };

export interface WorkflowModule {
	/** The module's `meta` export (saved workflows). */
	meta: unknown;
	/** The default export. */
	run: (input?: unknown) => Promise<unknown>;
}

/**
 * Run a compiled module's top level in a new context with `globals`, and return its exports.
 * Throws for errors at the top level, imports, and a missing default function.
 */
export function evaluate(js: string, filename: string, globals: Record<string, unknown>): WorkflowModule {
	const module = { exports: {} as Record<string, unknown> };
	const require = (id: string) => {
		throw new Error(`workflows cannot import modules ("${id}"); use tools, shell, llm, agent and workflows instead`);
	};
	const context = vm.createContext({ ...STANDARD_GLOBALS, ...globals, module, exports: module.exports, require });
	new vm.Script(js, { filename }).runInContext(context, { timeout: LOAD_TIMEOUT_MS });
	const run = module.exports.default;
	if (typeof run !== "function") throw new Error(`${filename} has no default export function (export default async function (input) { … })`);
	return { meta: module.exports.meta, run: run as WorkflowModule["run"] };
}

/**
 * An error's message and the frames inside the script, as `file:line:column`: the host frames
 * (this extension, Node) say nothing about the script.
 */
export function scriptStack(error: unknown, filename: string): string {
	// Errors thrown in the script's realm are no `instanceof Error` here.
	if (typeof error !== "object" || error === null || !("message" in error)) return String(error);
	const name = "name" in error && typeof error.name === "string" ? error.name : "Error";
	const head = `${name}: ${String(error.message)}`;
	const stack = "stack" in error && typeof error.stack === "string" ? error.stack : "";
	const frames = stack.split("\n").filter((line) => /^\s+at /.test(line) && line.includes(filename)).map((line) => line.trim());
	return [head, ...frames].join("\n    ");
}
