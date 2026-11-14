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

/**
 * What a durable run (durable.ts) puts into the script's realm: the clock and randomness the
 * script sees (recorded on replay), and `hold`, which counts a pending timer as work that may still
 * make a recorded call.
 */
export interface ScriptHost {
	now: () => number;
	random: () => number;
	hold: () => () => void;
}

// Runs in the script's realm before the script: Date and Math.random read the host's clock.
const PRELUDE = `(() => {
	const host = globalThis.__host;
	delete globalThis.__host;
	const Real = Date;
	class RecordedDate extends Real {
		constructor(...args) { if (args.length === 0) super(host.now()); else super(...args); }
		static now() { return host.now(); }
	}
	globalThis.Date = new Proxy(RecordedDate, { apply: () => new Real(host.now()).toString() });
	Math.random = () => host.random();
})();`;

/** Timers that count as pending work while they wait. */
function heldTimers(hold: ScriptHost["hold"]) {
	const releases = new Map<NodeJS.Timeout, () => void>();
	return {
		setTimeout: (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
			const release = hold();
			const timer = setTimeout(() => {
				releases.delete(timer);
				try {
					fn(...args);
				} finally {
					release();
				}
			}, ms);
			releases.set(timer, release);
			return timer;
		},
		clearTimeout: (timer: NodeJS.Timeout) => {
			clearTimeout(timer);
			releases.get(timer)?.();
			releases.delete(timer);
		},
	};
}

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
export function evaluate(js: string, filename: string, globals: Record<string, unknown>, host?: ScriptHost): WorkflowModule {
	const module = { exports: {} as Record<string, unknown> };
	const require = (id: string) => {
		throw new Error(`workflows cannot import modules ("${id}"); use tools, shell, llm, agent and workflows instead`);
	};
	const context = vm.createContext({ ...STANDARD_GLOBALS, ...(host ? heldTimers(host.hold) : {}), ...globals, module, exports: module.exports, require, ...(host ? { __host: host } : {}) });
	if (host) new vm.Script(PRELUDE, { filename: "workflow-prelude.js" }).runInContext(context);
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
