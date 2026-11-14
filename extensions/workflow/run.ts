// One workflow run: the script's globals (api.d.ts) bound to the run's state, then the report the
// parent gets back.
//
// The run owns an abort signal that every call uses: the tool's abort, an exceeded budget and the
// script's end all fire it, so calls still in flight stop and child agents are disposed. Costs of
// llm() (also reported as the tool result's usage) and of child agents (their own session files)
// count against the budget. In a git repository the run takes a snapshot first, for `changes()`
// and the changed files the metrics index reads (details.changedFiles).

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { type ToolCall, type Usage, validateToolArguments } from "@earendil-works/pi-ai";
import { type ModelRuntime, truncateHead } from "@earendil-works/pi-coding-agent";
import { stringify } from "yaml";
import { runShell } from "../lib/process.ts";
import { canonical, changedPaths, diffSince, gitRoot, type Snapshot, snapshot } from "../lib/workspace.ts";
import { createAgent } from "./agent.ts";
import { T3, T3_DELEGATE, T3_PREFIX, t3Data } from "./t3.ts";
import { compile, evaluate, inlineModule, scriptStack } from "./compile.ts";
import type { SavedWorkflow } from "./library.ts";
import { llm } from "./llm.ts";
import { sh } from "./sh.ts";

const DEFAULT_CONCURRENCY = 4;
const MAX_LLM_IN_FLIGHT = 8;
const LOG_KEPT = 200;
const LOG_SHOWN = 20;
const PROGRESS_LINES = 8;
const OUTPUT = { maxLines: 400, maxBytes: 30_000 };
export const INLINE_FILE = "workflow.ts";

/** What a nested tool call gives the script. */
export interface ToolOutcome {
	value: unknown;
	/** The value is the tool's structured result, which it returns also on failure (bash: a non-zero exit). */
	structured: boolean;
	isError: boolean;
	text: string;
}

export interface RunEnv {
	cwd: string;
	runtime: ModelRuntime;
	agentDir: string;
	/** llm() results of the session, by input digest. */
	llmCache: Map<string, unknown>;
	/** Run a session tool (ctx.executeTool); undefined outside a session. */
	executeTool?: (name: string, args: unknown, signal: AbortSignal) => Promise<ToolOutcome>;
	/** The tools executeTool can call; with t3's, agent() children become t3 tasks. */
	toolNames?: readonly string[];
	/** The calling session's id. */
	sessionId?: string;
	/** The saved workflows, for workflows.*. */
	library: () => ReadonlyMap<string, SavedWorkflow>;
	sessionDir?: string;
	parentSessionFile?: string;
	signal?: AbortSignal;
	onUpdate?: (details: WorkflowDetails) => void;
}

export interface WorkflowDetails {
	/** The goal was reached (details.ok for the metrics index): the script returned, without `ok: false`, within budget. */
	ok: boolean;
	status: "running" | "completed" | "failed" | "aborted" | "over budget";
	/** The saved workflow's name; absent for inline code. */
	workflow?: string;
	error?: string;
	durationMs: number;
	budget: number;
	cost: number;
	llmCalls: number;
	cachedCalls: number;
	agentRuns: number;
	/** Child agent sessions (details.childSessions for the metrics index). */
	childSessions: string[];
	/** The t3 threads of child agents (links). */
	childThreads: string[];
	/** Files changed during the run (absolute; details.changedFiles for the metrics index). */
	changedFiles: string[];
	warnings: string[];
	/** The last progress lines. */
	log: string[];
	/** The full report, when it was cut. */
	outputFile?: string;
}

export interface WorkflowEntry {
	/** TypeScript: a module for saved workflows, an async function body otherwise. */
	source: string;
	filename: string;
	inline: boolean;
	name?: string;
	input?: unknown;
}

class BudgetExceeded extends Error {
	constructor(limit: number, spent: number) {
		super(`the budget of $${limit.toFixed(2)} is used up ($${spent.toFixed(4)} spent)`);
		this.name = "BudgetExceeded";
	}
}

const addUsage = (a: Usage | undefined, b: Usage): Usage =>
	a
		? {
				...a,
				input: a.input + b.input,
				output: a.output + b.output,
				cacheRead: a.cacheRead + b.cacheRead,
				cacheWrite: a.cacheWrite + b.cacheWrite,
				totalTokens: a.totalTokens + b.totalTokens,
				cost: {
					input: a.cost.input + b.cost.input,
					output: a.cost.output + b.cost.output,
					cacheRead: a.cost.cacheRead + b.cost.cacheRead,
					cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
					total: a.cost.total + b.cost.total,
				},
			}
		: structuredClone(b);

/** A limit on how many calls of a kind run at once. */
function limiter(max: number) {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async <T>(task: () => Promise<T>): Promise<T> => {
		if (active >= max) await new Promise<void>((grant) => waiting.push(grant));
		active++;
		try {
			return await task();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

/** map(): at most `concurrency` calls at once; on the first error no new items start, and it rejects once the running ones settle. */
async function mapItems(items: unknown, fn: unknown, options: unknown): Promise<unknown[]> {
	if (!Array.isArray(items)) throw new TypeError("map(items, fn, options?): items must be an array");
	if (typeof fn !== "function") throw new TypeError("map(items, fn, options?): fn must be a function");
	const concurrency = (options as { concurrency?: unknown } | undefined)?.concurrency ?? DEFAULT_CONCURRENCY;
	if (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("map(): concurrency must be a positive integer");
	const results = new Array<unknown>(items.length);
	let next = 0;
	let failure: { error: unknown } | undefined;
	const worker = async () => {
		while (!failure && next < items.length) {
			const index = next++;
			try {
				results[index] = await fn(items[index], index);
			} catch (error) {
				failure ??= { error };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	if (failure) throw failure.error;
	return results;
}

const show = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	try {
		return stringify(value, { lineWidth: 0 }).trimEnd();
	} catch {
		return String(value);
	}
};

/** Run a workflow and report. Throws only when the entry does not compile or load (nothing ran). */
export async function runWorkflow(entry: WorkflowEntry, budgetLimit: number, env: RunEnv): Promise<{ text: string; details: WorkflowDetails; usage?: Usage }> {
	if (!Number.isFinite(budgetLimit) || budgetLimit <= 0) throw new Error("budget must be a positive number of USD");
	const started = performance.now();
	const controller = new AbortController();
	const forwardAbort = () => controller.abort(env.signal?.reason ?? new Error("aborted"));
	if (env.signal?.aborted) forwardAbort();
	env.signal?.addEventListener("abort", forwardAbort, { once: true });
	const signal = controller.signal;

	const details: WorkflowDetails = {
		ok: false,
		status: "running",
		...(entry.name ? { workflow: entry.name } : {}),
		durationMs: 0,
		budget: budgetLimit,
		cost: 0,
		llmCalls: 0,
		cachedCalls: 0,
		agentRuns: 0,
		childSessions: [],
		childThreads: [],
		changedFiles: [],
		warnings: [],
		log: [],
	};
	const lines: string[] = [];
	const publish = () => env.onUpdate?.({ ...details, log: lines.slice(-PROGRESS_LINES), durationMs: performance.now() - started });
	const progress = (line: string) => {
		lines.push(line);
		if (lines.length > LOG_KEPT) lines.splice(0, lines.length - LOG_KEPT);
		publish();
	};
	let usage: Usage | undefined;
	let overBudget = false;
	const spend = (usd: number) => {
		details.cost += usd;
		if (!overBudget && details.cost > budgetLimit) {
			overBudget = true;
			controller.abort(new BudgetExceeded(budgetLimit, details.cost));
		}
		publish();
	};
	const disposers: (() => void)[] = [];
	const root = await gitRoot(env.cwd);
	const start: Snapshot | undefined = root ? await snapshot(root) : undefined;
	const llmSlot = limiter(MAX_LLM_IN_FLIGHT);
	const executeTool = env.executeTool;
	const t3 =
		executeTool && env.toolNames?.includes(T3_DELEGATE)
			? new T3(async (name, args, callSignal) => {
					const outcome = await executeTool(`${T3_PREFIX}${name}`, args, callSignal);
					if (outcome.isError) throw new Error(`t3 ${name}: ${outcome.text || "failed"}`);
					return t3Data(name, outcome.value, outcome.text);
				})
			: undefined;
	const live = () => {
		if (signal.aborted) throw signal.reason;
	};

	const globals: Record<string, unknown> = {
		cwd: env.cwd,
		tools: new Proxy(
			{},
			{
				get: (_target, name) =>
					typeof name !== "string"
						? undefined
						: async (args: unknown = {}) => {
								live();
								if (!env.executeTool) throw new Error("tools are only available in a session");
								const outcome = await env.executeTool(name, args, signal);
								live();
								if (outcome.isError && !outcome.structured) throw new Error(outcome.text || `tool ${name} failed`);
								return outcome.value;
							},
			},
		),
		shell: async (command: unknown, options: unknown) => {
			live();
			if (typeof command !== "string" || !command.trim()) throw new TypeError("shell(command, options?): command must be a non-empty string");
			const { cwd, timeoutSeconds } = (options ?? {}) as { cwd?: unknown; timeoutSeconds?: unknown };
			if (cwd !== undefined && typeof cwd !== "string") throw new TypeError("shell(): cwd must be a string");
			if (timeoutSeconds !== undefined && (typeof timeoutSeconds !== "number" || !(timeoutSeconds > 0))) throw new TypeError("shell(): timeoutSeconds must be a positive number");
			progress(`shell ${command.split("\n")[0]!.slice(0, 120)}`);
			const result = await runShell(command, { cwd: resolve(env.cwd, cwd ?? "."), signal, timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000 });
			live();
			return { exitCode: result.exitCode, output: result.output, timedOut: result.timedOut };
		},
		llm: (prompt: unknown, options: unknown) =>
			llmSlot(async () => {
				live();
				return llm(prompt, options, {
					runtime: env.runtime,
					cache: env.llmCache,
					signal,
					spend: (u) => {
						usage = addUsage(usage, u);
						spend(u.cost.total);
					},
					counted: (cached) => {
						details.llmCalls++;
						if (cached) details.cachedCalls++;
						publish();
					},
				});
			}),
		agent: (options: unknown) =>
			createAgent(options, {
				cwd: env.cwd,
				root,
				runtime: env.runtime,
				agentDir: env.agentDir,
				sessionDir: env.sessionDir,
				parentSessionFile: env.parentSessionFile,
				callerSessionId: env.sessionId,
				t3,
				signal,
				spend,
				started: (id) => details.childSessions.push(id),
				thread: (link) => details.childThreads.push(link),
				ran: () => details.agentRuns++,
				progress,
				warn: (line) => details.warnings.push(line),
				onDispose: (dispose) => disposers.push(dispose),
			}),
		map: mapItems,
		sh,
		log: (...values: unknown[]) => progress(values.map((v) => (typeof v === "string" ? v : show(v))).join(" ")),
		changes: async () => {
			if (!root || !start) throw new Error(`changes() needs a git repository; ${env.cwd} is not in one`);
			const files = await changedPaths(start, await snapshot(root));
			return { files: files.map((f) => relative(canonical(env.cwd), f)), diff: await diffSince(start, files) };
		},
		budget: Object.freeze({
			limit: budgetLimit,
			get spent() {
				return details.cost;
			},
		}),
		workflows: new Proxy(
			{},
			{
				get: (_target, name) => {
					if (typeof name !== "string") return undefined;
					return async (input: unknown = {}) => {
						live();
						const saved = env.library().get(name);
						if (!saved) throw new Error(`no saved workflow ${name}; saved: ${[...env.library().keys()].join(", ") || "none"}`);
						const call: ToolCall = { type: "toolCall", id: `workflow-${name}`, name, arguments: input as ToolCall["arguments"] };
						const checked = validateToolArguments({ name, description: "", parameters: saved.meta.parameters }, call);
						progress(`workflow ${name}`);
						return load({ source: saved.source, filename: saved.file, inline: false }).run(checked);
					};
				},
			},
		),
	};
	globals.console = { log: globals.log, info: globals.log, warn: globals.log, error: globals.log, debug: globals.log };
	const load = (e: Pick<WorkflowEntry, "source" | "filename" | "inline">) =>
		evaluate(compile(e.inline ? inlineModule(e.source) : e.source, e.filename), e.filename, globals);

	let value: unknown;
	let failure: unknown;
	try {
		const module = load(entry);
		publish();
		value = await module.run(entry.input);
	} catch (error) {
		failure = error;
	} finally {
		env.signal?.removeEventListener("abort", forwardAbort);
		if (!signal.aborted) controller.abort(new Error("the workflow ended"));
		for (const dispose of disposers) dispose();
	}
	if (root && start) details.changedFiles = await changedPaths(start, await snapshot(root));
	details.durationMs = performance.now() - started;
	details.status = overBudget ? "over budget" : env.signal?.aborted ? "aborted" : failure !== undefined ? "failed" : "completed";
	const declaredOk = value && typeof value === "object" && typeof (value as { ok?: unknown }).ok === "boolean" ? (value as { ok: boolean }).ok : true;
	details.ok = details.status === "completed" && declaredOk;
	if (failure !== undefined) details.error = scriptStack(failure, entry.filename);
	details.log = lines.slice(-PROGRESS_LINES);
	return { text: report(details, value, failure !== undefined, lines, env.cwd), details, ...(usage ? { usage } : {}) };
}

function report(details: WorkflowDetails, value: unknown, failed: boolean, lines: string[], cwd: string): string {
	const stats = [
		`${(details.durationMs / 1000).toFixed(1)} s`,
		`$${details.cost.toFixed(4)} of $${details.budget.toFixed(2)}`,
		`${details.llmCalls} llm call${details.llmCalls === 1 ? "" : "s"}${details.cachedCalls ? ` (${details.cachedCalls} cached)` : ""}`,
		`${details.agentRuns} agent run${details.agentRuns === 1 ? "" : "s"}`,
	];
	const out = [`Workflow ${details.workflow ? `${details.workflow} ` : ""}${details.status} · ${stats.join(" · ")}`];
	if (details.changedFiles.length) out.push(`Changed files: ${details.changedFiles.map((f) => relative(canonical(cwd), f)).join(", ")}`);
	for (const warning of details.warnings) out.push(`Warning: ${warning}`);
	if (details.childThreads.length) out.push(`Child threads: ${details.childThreads.join(", ")}`);
	if (details.childSessions.length) out.push(`Child sessions: ${details.childSessions.join(", ")}`);
	const shown = show(value);
	if (shown) out.push("", shown);
	if (failed) {
		out.push("", details.error ?? "");
		if (lines.length) out.push("", `Last log lines:\n${lines.slice(-LOG_SHOWN).join("\n")}`);
	}
	const text = out.join("\n");
	const cut = truncateHead(text, OUTPUT);
	if (!cut.truncated) return text;
	const dir = join(tmpdir(), "pi-workflow");
	mkdirSync(dir, { recursive: true });
	details.outputFile = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
	writeFileSync(details.outputFile, text);
	return `${cut.content}\n[cut; the full report is in ${details.outputFile}]`;
}
