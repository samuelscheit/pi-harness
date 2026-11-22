// One workflow run: the script's globals (api.d.ts) bound to the run's state, then the report the
// parent gets back.
//
// Every run is durable (durable.ts): it gets an id and a journal (journal.ts) in
// `<agentDir>/workflows/<id>/`, and every call to the outside goes through the journal. A run whose
// process died, that stopped because its session ended or its extension context went stale (a
// harness reload), or that was stopped on request (stop.ts), is resumed by `resumeWorkflow`: the
// script runs again from its start, and the calls the journal answers run nothing. A resume may
// bring edited code, which runs live from its first call the journal cannot answer (durable.ts).
// A lock in the run's directory keeps two processes from running it at once.
//
// The run owns an abort signal that every call uses: the tool's abort, a stop, an exceeded budget
// and the script's end all fire it, so calls still in flight stop. Agents run under a signal of
// their own, which a stop leaves alone unless it asks to stop the children too: they go on, and
// the process waits for them before it releases the run (stop.ts, linger). Costs of
// llm() (also reported as the tool result's usage) and of child agents (their own session files)
// count against the budget, replayed calls with their recorded cost. In a git repository the run
// takes a snapshot first (kept with the journal for a resume), for `changes()` and the changed
// files the metrics index reads (details.changedFiles).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { type ToolCall, type Usage, validateToolArguments } from "@earendil-works/pi-ai";
import { type ExtensionUIQuestion, type ModelRuntime, truncateHead } from "@earendil-works/pi-coding-agent";
import { stringify } from "yaml";
import { acquireLock } from "../lib/lock.ts";
import { runShell } from "../lib/process.ts";
import { ownWrites } from "./own-writes.ts";
import { canonical, changedPaths, diffSince, type FileState, gitRoot, type Snapshot, snapshot } from "../lib/workspace.ts";
import { createDelegate, type SteerTarget } from "./delegate.ts";
import { harnessFault } from "./fault.ts";
import { Phases } from "./phases.ts";
import { compile, evaluate, inlineModule, type ScriptHost, scriptStack } from "./compile.ts";
import { blockingCalls, Durable, type InFlightPolicy, isInterruption, isStop, retryableFailures, WorkflowStopped } from "./durable.ts";
import { codeHash, currentSource, Journal, type JournalEntry, journalPath, newRunId, readJournal, RESUMABLE, type RunHeader, runDir, runState, SNAPSHOT_FILE } from "./journal.ts";
import type { SavedWorkflow } from "./library.ts";
import { DEFAULT_LLM_MODEL, llm } from "./llm.ts";
import { sh } from "./sh.ts";
import { watchSteer } from "./steer.ts";
import { clearStopRequest, linger, lockPath, takeLingering, watchStop } from "./stop.ts";
import type { ParentTurn } from "./parent-turn.ts";
import { cancelTask, inT3, T3, T3_DELEGATE, type T3Options, t3CallVia, t3WaitMs } from "./t3.ts";

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
	/** The result's details (ask_user's answers). */
	details?: unknown;
}

/** How long a workflow's ask_user waits: until answered or the run stops (setTimeout's limit is about 24.8 days). */
const ASK_WAIT_MINUTES = 35_000;

export interface RunEnv {
	cwd: string;
	runtime: ModelRuntime;
	agentDir: string;
	/** llm() results of the session, by input digest. */
	llmCache: Map<string, unknown>;
	/** Run a session tool (ctx.executeTool); undefined outside a session. */
	executeTool?: (name: string, args: unknown, signal: AbortSignal) => Promise<ToolOutcome>;
	/** The tools executeTool can call; with t3's, delegate() children become t3 tasks. */
	toolNames?: readonly string[];
	/** How t3 calls that fail in transport are repeated; default t3.ts's. */
	t3Retry?: Pick<T3Options, "retryDeadlineMs" | "backoffMs">;
	/** The calling session's turn, which t3 needs to start delegated tasks (parent-turn.ts). */
	parent?: ParentTurn;
	/** The calling session's model ("provider/id"): in-process children's default. */
	model?: string;
	/** The calling session's id and file. */
	sessionId?: string;
	/** The saved workflows, for workflows.*. */
	library: () => ReadonlyMap<string, SavedWorkflow>;
	sessionDir?: string;
	parentSessionFile?: string;
	signal?: AbortSignal;
	onUpdate?: (details: WorkflowDetails) => void;
	/** The run has its id and journal; called before the script runs. */
	onStart?: (run: { id: string; journal: string; attempt: number }) => void;
	/** Where harness faults are noted (fault.ts); default the harness repository's backlog. */
	harnessBacklog?: string;
	/** How long a child's report may lag behind the end of its turn; default delegate.ts's. */
	stateWaitMs?: number;
}

export type WorkflowStatus = "running" | "completed" | "failed" | "aborted" | "over budget" | "interrupted" | "stopped" | "diverged";

export interface WorkflowDetails {
	/** The goal was reached (details.ok for the metrics index): the script returned, without `ok: false`, within budget. */
	ok: boolean;
	status: WorkflowStatus;
	/** The run's id and journal; `attempt` counts the resumes (1 for the first execution). */
	id: string;
	journal: string;
	attempt: number;
	/** The saved workflow's name; absent for inline code. */
	workflow?: string;
	error?: string;
	durationMs: number;
	budget: number;
	cost: number;
	llmCalls: number;
	cachedCalls: number;
	delegateRuns: number;
	/** Calls answered from the journal in this execution. */
	replayedCalls: number;
	/** Recorded failures of agent runs and llm calls that ran again in this execution. */
	retriedCalls: number;
	/** Recorded calls the (edited) script did not use. */
	unusedCalls: number;
	/** Agent runs a stop left running; their outcomes are recorded when they end. */
	lingeringDelegates: number;
	/** Child agent sessions (details.childSessions for the metrics index). */
	childSessions: string[];
	/** The t3 threads of child agents (links). */
	childThreads: string[];
	/** Files this run wrote: its delegates' own tool calls, its write/edit tool calls and the files its shell and bash calls changed and named (absolute; details.changedFiles for the metrics index). */
	changedFiles: string[];
	/** Files the working tree changed during the run that the run did not write: someone else's work (absolute). */
	othersChangedFiles: string[];
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

export interface ResumeRequest {
	id: string;
	/** What to do with shell and tools.* calls that were in flight; without, such calls stop the resume. */
	inFlight?: "rerun" | "fail";
	/** A new budget for the whole run (the recorded spend counts against it). */
	budget?: number;
	/** Edited code: answered from the journal while it makes the recorded calls, live from its first other one. */
	code?: string;
}

export interface WorkflowResult {
	text: string;
	details: WorkflowDetails;
	usage?: Usage;
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

/** Errors that end the whole run (or a phase's money), not one item's work: map stops starting items at once. */
const RUN_ENDING = new Set(["BudgetExceeded", "PhaseBudgetExceeded", "WorkflowStopped", "DivergenceError"]);
const endsRun = (error: unknown) => RUN_ENDING.has((error as { name?: unknown } | null)?.name as string) || isInterruption(error);

const messageOf = (error: unknown) => (error instanceof Error || (error && typeof error === "object" && "message" in error) ? String((error as { message: unknown }).message) : String(error));

/**
 * map() without `settle` when items failed: every failed item with its error; the results of the
 * others in `results` (undefined for the failed ones). A resume runs only the failed calls again.
 */
export class MapError extends AggregateError {
	readonly results: unknown[];
	/** The indexes of the failed items, ascending. */
	readonly failed: number[];
	constructor(failures: Map<number, unknown>, results: unknown[]) {
		const failed = [...failures.keys()].sort((a, b) => a - b);
		const lines = failed.map((index) => `- items[${index}]: ${messageOf(failures.get(index)).split("\n")[0]}`);
		super(
			failed.map((index) => failures.get(index)),
			[
				`map: ${failed.length} of ${results.length} items failed; the other ${results.length - failed.length} finished (their results are recorded).`,
				...lines,
				"A resume (workflow { resume: \"<id>\" }) runs only the failed agent and llm calls again; the finished ones come from the journal. To keep going without them, map with { settle: true }.",
			].join("\n"),
		);
		this.name = "MapError";
		this.results = results;
		this.failed = failed;
	}
}

/**
 * map(): at most `concurrency` calls at once. An item that fails does not stop the others: every
 * item runs, then a MapError names every failed one (with `settle`, each item's `{ ok, value }` or
 * `{ ok: false, error }` comes back instead). An error that ends the run (a budget, a stop, an
 * interruption: `endsRun`, or the run's signal) stops starting items and is thrown once the running
 * ones settle. Fan-outs of independent agents were the rule (22 of 22 fan-out scripts used map, 1
 * handled errors per item), and stopping at the first failure lost the finished work (2026-11-16).
 */
async function mapItems(items: unknown, fn: unknown, options: unknown, signal?: AbortSignal): Promise<unknown[]> {
	if (!Array.isArray(items)) throw new TypeError("map(items, fn, options?): items must be an array");
	if (typeof fn !== "function") throw new TypeError("map(items, fn, options?): fn must be a function");
	const { concurrency = DEFAULT_CONCURRENCY, settle = false } = (options ?? {}) as { concurrency?: unknown; settle?: unknown };
	if (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("map(): concurrency must be a positive integer");
	if (typeof settle !== "boolean") throw new TypeError("map(): settle must be a boolean");
	const results = new Array<unknown>(items.length);
	const failures = new Map<number, unknown>();
	let next = 0;
	let ending: { error: unknown } | undefined;
	const worker = async () => {
		while (!ending && !signal?.aborted && next < items.length) {
			const index = next++;
			try {
				results[index] = await fn(items[index], index);
			} catch (error) {
				if (endsRun(error) || signal?.aborted) ending ??= { error };
				else failures.set(index, error);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	if (ending) throw ending.error;
	if (signal?.aborted) throw signal.reason;
	// From the items: `results` has holes where items failed, which Array.map skips.
	if (settle) return items.map((_, index) => (failures.has(index) ? { ok: false, error: failures.get(index) } : { ok: true, value: results[index] }));
	if (failures.size) throw new MapError(failures, results);
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

const firstLine = (text: string, max = 120) => text.split("\n")[0]!.slice(0, max);

/** The options object a script passed last to shell() or a tool, and whether it marks the call idempotent. */
function idempotentOption(options: unknown, where: string): boolean {
	if (options === undefined) return false;
	const value = (options as { idempotent?: unknown } | null)?.idempotent;
	if (value !== undefined && typeof value !== "boolean") throw new TypeError(`${where}: idempotent must be a boolean`);
	return value === true;
}

// The start snapshot, kept with the journal so changes() after a resume compares with the start.
type StoredState = { exists: false } | { exists: true; hash: string; content?: string };
function saveSnapshot(path: string, snap: Snapshot): void {
	const files = [...snap.files].map(([file, state]): [string, StoredState] => [file, state.exists ? { exists: true, hash: state.hash, ...(state.content ? { content: state.content.toString("base64") } : {}) } : { exists: false }]);
	writeFileSync(path, JSON.stringify({ root: snap.root, ...(snap.head ? { head: snap.head } : {}), files }));
}
function loadSnapshot(path: string): Snapshot | undefined {
	if (!existsSync(path)) return undefined;
	const stored = JSON.parse(readFileSync(path, "utf8")) as { root: string; head?: string; files: [string, StoredState][] };
	const files = new Map<string, FileState>(stored.files.map(([file, state]) => [file, state.exists ? { exists: true, hash: state.hash, ...(state.content ? { content: Buffer.from(state.content, "base64") } : {}) } : { exists: false }]));
	return { root: stored.root, ...(stored.head ? { head: stored.head } : {}), files };
}

/** Start a new run and report. Throws only when the entry does not compile or load (nothing ran). */
export async function runWorkflow(entry: WorkflowEntry, budgetLimit: number, env: RunEnv): Promise<WorkflowResult> {
	if (!Number.isFinite(budgetLimit) || budgetLimit <= 0) throw new Error("budget must be a positive number of USD");
	const id = newRunId();
	const header: RunHeader = {
		t: "run",
		id,
		at: Date.now(),
		entry: { source: entry.source, filename: entry.filename, inline: entry.inline, ...(entry.name ? { name: entry.name } : {}), ...(entry.input === undefined ? {} : { input: entry.input }) },
		budget: budgetLimit,
		cwd: env.cwd,
		...(env.sessionId ? { sessionId: env.sessionId } : {}),
		...(env.parentSessionFile ? { sessionFile: env.parentSessionFile } : {}),
	};
	const journal = new Journal(journalPath(env.agentDir, id));
	journal.append(header, true);
	return execute(header, [header], journal, budgetLimit, "stop", env);
}

/**
 * Resume a run from its journal: its script (or `code`) from its start, recorded calls answered from
 * the journal. Throws (nothing ran) when the run is unknown, running in a live process, finished
 * (without `code`), the code does not compile, or it has shell or tools.* calls in flight and no
 * `inFlight` decision.
 */
export async function resumeWorkflow(request: ResumeRequest, env: RunEnv): Promise<WorkflowResult> {
	const { entries, header, end } = runState(env.agentDir, request.id);
	if (end && request.code === undefined && !RESUMABLE.has(end.status) && !(end.status === "failed" && retryableFailures(entries).length > 0)) {
		throw new Error(`workflow run ${request.id} ended (${end.status}); there is nothing to resume (pass code to continue it with changed code). Its result:\n\n${end.text}`);
	}
	if (request.code !== undefined) compile(header.entry.inline ? inlineModule(request.code) : request.code, header.entry.filename);
	const blocking = blockingCalls(entries);
	if (blocking.length && !request.inFlight) {
		throw new Error(
			[
				`workflow run ${request.id} was not resumed: these calls were in flight when it stopped, and running them again could repeat their effects:`,
				...blocking.map((call) => `- ${call.kind} ${call.label} (${call.key})`),
				'Check whether they took effect, then resume with inFlight: "rerun" (run them again) or inFlight: "fail" (they throw an InterruptedCallError the script can catch). Mark calls that are safe to repeat with { idempotent: true }.',
			].join("\n"),
		);
	}
	const lastBudget = entries.findLast((e) => e.t === "attempt" && e.budget !== undefined);
	const budget = request.budget ?? (lastBudget?.t === "attempt" ? lastBudget.budget : undefined) ?? header.budget;
	if (!Number.isFinite(budget) || budget <= 0) throw new Error("budget must be a positive number of USD");
	return execute(header, entries, new Journal(journalPath(env.agentDir, request.id)), budget, request.inFlight ?? "stop", { ...env, cwd: header.cwd }, request.code);
}

/** Why a run's lock is taken, for the refused resume. */
function lockedMessage(agentDir: string, id: string, dir: string): string {
	let pid = "";
	try {
		pid = ` (pid ${readFileSync(join(lockPath(dir), "pid"), "utf8").trim()})`;
	} catch {
		// Just released or taken.
	}
	return runState(agentDir, id).end?.status === "stopped"
		? `workflow run ${id} is stopped, and another process${pid} still waits for its agents; resume it from that session, or stop its agents with workflow { stop: "${id}", stopChildren: true } first`
		: `workflow run ${id} is running in another process${pid}`;
}

async function execute(header: RunHeader, recorded: readonly JournalEntry[], journal: Journal, budgetLimit: number, inFlight: InFlightPolicy, env: RunEnv, code?: string): Promise<WorkflowResult> {
	const dir = runDir(env.agentDir, header.id);
	// A stopped run's agents still running in this process are handed over with its lock.
	const handed = takeLingering(header.id);
	const unlock = handed?.unlock ?? acquireLock(lockPath(dir));
	if (!unlock) {
		journal.close();
		throw new Error(lockedMessage(env.agentDir, header.id, dir));
	}
	clearStopRequest(dir);
	const attempt = recorded.filter((e) => e.t === "attempt").length + 1;
	journal.append({ t: "attempt", n: attempt, at: Date.now(), pid: process.pid, budget: budgetLimit }, true);
	const entries = [...recorded];
	if (code !== undefined) {
		const edit: JournalEntry = { t: "edit", at: Date.now(), n: attempt, hash: codeHash(code), source: code };
		journal.append(edit, true);
		entries.push(edit);
	}
	const entry: WorkflowEntry = { ...header.entry, source: currentSource(entries) };

	const started = performance.now();
	const controller = new AbortController();
	const signal = controller.signal;
	// Agents' work: aborted with the run, except by a stop that keeps them running.
	const children = new AbortController();
	signal.addEventListener("abort", () => {
		if (!isStop(signal.reason) || signal.reason.children) children.abort(signal.reason);
	});
	const forwardAbort = () => controller.abort(env.signal?.reason ?? new Error("aborted"));
	if (env.signal?.aborted) forwardAbort();
	env.signal?.addEventListener("abort", forwardAbort, { once: true });

	const details: WorkflowDetails = {
		ok: false,
		status: "running",
		id: header.id,
		journal: journal.path,
		attempt,
		...(entry.name ? { workflow: entry.name } : {}),
		durationMs: 0,
		budget: budgetLimit,
		cost: 0,
		llmCalls: 0,
		cachedCalls: 0,
		delegateRuns: 0,
		replayedCalls: 0,
		retriedCalls: 0,
		unusedCalls: 0,
		lingeringDelegates: 0,
		childSessions: [],
		childThreads: [],
		changedFiles: [],
		othersChangedFiles: [],
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
	const phases = new Phases(journal, progress);
	let usage: Usage | undefined;
	let overBudget = false;
	const spend = (usd: number) => {
		details.cost += usd;
		phases.spend(usd);
		if (!overBudget && details.cost > budgetLimit) {
			overBudget = true;
			const exceeded = new BudgetExceeded(budgetLimit, details.cost);
			controller.abort(exceeded);
			// Also agents a stop left running.
			children.abort(exceeded);
		}
		publish();
	};
	let t3: T3 | undefined;
	const durable = new Durable({
		journal,
		entries,
		inFlight,
		attempt,
		signal,
		// A phase over its budget aborts its calls too.
		signalFor: (kind) => {
			const base = kind === "delegate" ? children.signal : signal;
			const phase = phases.signal();
			return phase ? AbortSignal.any([base, phase]) : base;
		},
		phaseOf: () => phases.current(),
		...(handed ? { inherited: handed.works } : {}),
		replayed: (kind, cost) => {
			if (kind === "llm") details.llmCalls++;
			if (kind === "delegate") details.delegateRuns++;
			if (cost > 0) spend(cost);
		},
		retried: (_kind, cost) => {
			if (cost > 0) spend(cost);
		},
		diverged: (error) => controller.abort(error),
		// Agent runs the edited code does not use, whose t3 children run on without a process waiting for them.
		dropped: (calls) => {
			for (const { meta } of calls) if (t3 && typeof meta.taskId === "string") cancelTask(t3, meta.taskId, "the workflow's edited code does not use this delegate run");
		},
	});
	const stopWatch = watchStop(dir, (request) => {
		const reason = new WorkflowStopped(request.children);
		controller.abort(reason);
		if (request.children) for (const work of durable.unsettled().values()) work.cancel(reason);
	});
	/** The script's delegates, for `workflow { steer }` (steer.ts). */
	const steerable: SteerTarget[] = [];
	const host: ScriptHost = { now: () => durable.now(), random: () => durable.random(), hold: () => durable.hold() };
	const disposers: ((interrupted: boolean) => void)[] = [];
	const root = await gitRoot(env.cwd);
	const snapshotFile = join(dir, SNAPSHOT_FILE);
	let start: Snapshot | undefined = root ? loadSnapshot(snapshotFile) : undefined;
	// What the run itself wrote (own-writes.ts), apart from the files others change in the tree meanwhile.
	const written = new Set<string>();
	const bookkeeping: Promise<void>[] = [];
	const writes = ownWrites();
	let callIds = 0;
	/** Runs a session tool or shell command (one aborted by `signal` returns at once, the report waits for its bookkeeping), adding the files it changed to `written`. */
	const recording = async <T extends object>(name: string, args: unknown, at: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> => {
		const id = `call-${++callIds}`;
		// The snapshot before a command must not delay an abort: a call aborted meanwhile never runs.
		const aborted = new Promise<never>((_resolve, reject) => {
			if (signal.aborted) reject(signal.reason);
			else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
		aborted.catch(() => undefined);
		await Promise.race([writes.started(id, name, (args ?? {}) as Record<string, unknown>, at), aborted]);
		const record = async (failed: boolean) => {
			for (const path of await writes.ended(id, failed)) written.add(path);
		};
		let outcome: T;
		try {
			outcome = await fn();
		} catch (error) {
			// A call that fails or is aborted rejects at once (its journal entry must not wait for a snapshot); the report waits for the bookkeeping.
			bookkeeping.push(record(true).catch(() => undefined));
			throw error;
		}
		const bookkept = record("isError" in outcome && outcome.isError === true);
		if (signal.aborted) bookkeeping.push(bookkept.catch(() => undefined));
		else await bookkept;
		return outcome;
	};
	if (root && !start) {
		start = await snapshot(root);
		saveSnapshot(snapshotFile, start);
	}
	const llmSlot = limiter(MAX_LLM_IN_FLIGHT);
	const live = () => {
		if (signal.aborted) throw signal.reason;
	};
	/** Stop the run as interrupted (resumable); t3 children run on (an interruption does not cancel them). */
	const interrupt = (error: unknown) => {
		controller.abort(error);
		children.abort(error);
	};
	// A tool call that fails because the run is interrupted stops the whole run as interrupted.
	const executeTool = env.executeTool
		? async (name: string, args: unknown, callSignal: AbortSignal) => {
				try {
					return await env.executeTool!(name, args, callSignal);
				} catch (error) {
					if (isInterruption(error)) interrupt(error);
					throw error;
				}
			}
		: undefined;
	t3 =
		executeTool && inT3(env.toolNames ?? [])
			? new T3(t3CallVia(executeTool), { waitMs: t3WaitMs(env.cwd, env.agentDir), ...env.t3Retry, unreachable: interrupt, ...(env.parent ? { parent: env.parent } : {}) })
			: undefined;
	let delegates = 0;
	/** Ask whoever runs the workflow with its session's ask_user; resolves to the answers in order. */
	const askUser = async (questions: readonly ExtensionUIQuestion[], callSignal: AbortSignal) => {
		if (!executeTool) throw new Error("ask_user needs a session");
		const outcome = await executeTool("ask_user", { questions: questions.map(({ title, options }) => ({ title, ...(options ? { options } : {}) })), wait_minutes: ASK_WAIT_MINUTES }, callSignal);
		if (outcome.isError) throw new Error(outcome.text || "ask_user failed");
		const answers = (outcome.details as { answers?: (string | undefined)[] } | undefined)?.answers;
		if (!answers) throw new Error(`ask_user returned no answers: ${outcome.text}`);
		return answers;
	};

	const globals: Record<string, unknown> = {
		cwd: env.cwd,
		tools: new Proxy(
			{},
			{
				get: (_target, name) => {
					if (typeof name !== "string") return undefined;
					// t3's delegate_task is delegate() itself: awaited, with a handle.
					if (name === T3_DELEGATE) return globals.delegate;
					return async (args: unknown = {}, options?: unknown) => {
								live();
								if (!executeTool) throw new Error("tools are only available in a session");
								// ask_user resolves to the answers, waiting until they exist; asking again after a crash only shows the questions again.
								const asking = name === "ask_user";
								const idempotent = asking || idempotentOption(options, `tools.${name}()`);
								return durable.call({ kind: "tool", args: { name, args }, label: `${name} ${firstLine(JSON.stringify(args) ?? "", 100)}`, idempotent }, async (call) => {
									if (asking) return { value: await askUser(((args ?? {}) as { questions?: ExtensionUIQuestion[] }).questions ?? [], call.signal) };
									const outcome = await recording(name, args, env.cwd, call.signal, () => executeTool(name, args, call.signal));
									live();
									if (outcome.isError && !outcome.structured) throw new Error(outcome.text || `tool ${name} failed`);
									return { value: outcome.value };
								});
							};
				},
			},
		),
		shell: async (command: unknown, options: unknown) => {
			live();
			if (typeof command !== "string" || !command.trim()) throw new TypeError("shell(command, options?): command must be a non-empty string");
			const { cwd, timeoutSeconds } = (options ?? {}) as { cwd?: unknown; timeoutSeconds?: unknown };
			if (cwd !== undefined && typeof cwd !== "string") throw new TypeError("shell(): cwd must be a string");
			if (timeoutSeconds !== undefined && (typeof timeoutSeconds !== "number" || !(timeoutSeconds > 0))) throw new TypeError("shell(): timeoutSeconds must be a positive number");
			const idempotent = idempotentOption(options, "shell()");
			return durable.call({ kind: "shell", args: { command, cwd: cwd ?? null, timeoutSeconds: timeoutSeconds ?? null }, label: firstLine(command), idempotent }, async (call) => {
				progress(`shell ${firstLine(command)}`);
				const where = resolve(env.cwd, cwd ?? ".");
				const result = await recording("bash", { command }, where, call.signal, () => runShell(command, { cwd: where, signal: call.signal, timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000 }));
				live();
				return { value: { exitCode: result.exitCode, output: result.output, timedOut: result.timedOut } };
			});
		},
		llm: (prompt: unknown, options: unknown) => {
			const model = (options as { model?: unknown } | undefined)?.model;
			return durable.call({ kind: "llm", args: { prompt, options: options ?? null }, label: typeof prompt === "string" ? firstLine(prompt, 100) : "llm()", model: typeof model === "string" ? model : DEFAULT_LLM_MODEL }, (call) =>
				llmSlot(async () => {
					live();
					const value = await llm(prompt, options, {
						runtime: env.runtime,
						cache: env.llmCache,
						signal: call.signal,
						spend: (u) => {
							usage = addUsage(usage, u);
							call.spend(u.cost.total);
							spend(u.cost.total);
						},
						counted: (cached) => {
							details.llmCalls++;
							if (cached) details.cachedCalls++;
							publish();
						},
					});
					return { value };
				}),
			);
		},
		delegate: (params: unknown) =>
			createDelegate(params, {
				cwd: env.cwd,
				root,
				runtime: env.runtime,
				agentDir: env.agentDir,
				...(env.model ? { model: env.model } : {}),
				...(executeTool ? { askUp: askUser } : {}),
				header: () => phases.header(),
				sessionDir: env.sessionDir,
				parentSessionFile: env.parentSessionFile,
				callerSessionId: env.sessionId,
				t3,
				durable,
				next: () => ++delegates,
				spend,
				started: (id) => {
					if (!details.childSessions.includes(id)) details.childSessions.push(id);
				},
				thread: (link) => details.childThreads.push(link),
				ran: () => details.delegateRuns++,
				progress,
				warn: (line) => details.warnings.push(line),
				wrote: (paths) => paths.forEach((p) => written.add(p)),
				...(env.stateWaitMs ? { stateWaitMs: env.stateWaitMs } : {}),
				fault: (message) =>
					harnessFault(message, { ...(env.harnessBacklog ? { backlog: env.harnessBacklog } : {}), cwd: env.cwd, ...(env.sessionId ? { sessionId: env.sessionId } : {}), runId: header.id, journal: journal.path }),
				onDispose: (dispose) => disposers.push(dispose),
				track: (child) => steerable.push(child),
			}),
		phase: (name: unknown, fn: unknown, options: unknown) => phases.run(name, fn, options),
		plan: Object.freeze({ expect: (names: unknown) => phases.expect(names) }),
		map: (items: unknown, fn: unknown, options: unknown) => mapItems(items, fn, options, controller.signal),
		sh,
		log: (...values: unknown[]) => progress(values.map((v) => (typeof v === "string" ? v : show(v))).join(" ")),
		changes: (paths?: unknown) => {
			if (paths !== undefined && !(Array.isArray(paths) && paths.every((p) => typeof p === "string"))) throw new TypeError("changes(paths): paths must be an array of strings");
			const only = paths?.map((p: string) => canonical(resolve(env.cwd, p)));
			const wanted = (file: string) => !only || only.some((p) => file === p || file.startsWith(`${p}/`));
			return durable.call({ kind: "changes", args: only ? { paths } : {}, label: "changes()" }, async () => {
				if (!root || !start) throw new Error(`changes() needs a git repository; ${env.cwd} is not in one`);
				const files = (await changedPaths(start, await snapshot(root))).filter(wanted);
				return { value: { files: files.map((f) => relative(canonical(env.cwd), f)), diff: await diffSince(start, files) } };
			});
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
						return durable.call({ kind: "workflow", args: { name, input: checked }, label: `workflow ${name}` }, async () => {
							progress(`workflow ${name}`);
							return { value: await load({ source: saved.source, filename: saved.file, inline: false }).run(checked) };
						});
					};
				},
			},
		),
	};
	globals.console = { log: globals.log, info: globals.log, warn: globals.log, error: globals.log, debug: globals.log };
	const load = (e: Pick<WorkflowEntry, "source" | "filename" | "inline">) => evaluate(compile(e.inline ? inlineModule(e.source) : e.source, e.filename), e.filename, globals, host);

	let value: unknown;
	let failure: unknown;
	const ended = new Error("the workflow ended");
	const steerWatch = watchSteer(dir, () => steerable, children.signal, progress);
	try {
		const module = load(entry);
		env.onStart?.({ id: header.id, journal: journal.path, attempt });
		publish();
		value = await module.run(entry.input);
	} catch (error) {
		failure = error;
	} finally {
		env.signal?.removeEventListener("abort", forwardAbort);
		if (!signal.aborted) controller.abort(ended);
	}
	const reason: unknown = signal.reason;
	if (reason === ended && failure === undefined) durable.finish();
	const diverged = (reason as { name?: unknown } | null)?.name === "DivergenceError";
	const stopped = !overBudget && !diverged && isStop(reason);
	const interrupted = !overBudget && !diverged && !stopped && (isInterruption(reason) || isInterruption(env.signal?.reason));
	// Work still running: agents a plain stop keeps linger; any other end stops them (an interruption leaves t3 children running).
	const unsettled = durable.unsettled();
	const keep = stopped && !(reason as WorkflowStopped).children;
	if (!keep) for (const work of unsettled.values()) work.cancel(reason);
	const lingering = keep ? [...unsettled].filter(([, work]) => work.kind === "delegate").map(([key]) => key) : [];
	if (diverged) failure = reason;
	await Promise.all(bookkeeping);
	details.changedFiles = [...written].sort();
	if (root && start) details.othersChangedFiles = (await changedPaths(start, await snapshot(root))).filter((f) => !written.has(f));
	details.durationMs = performance.now() - started;
	details.replayedCalls = durable.replayedCalls;
	details.retriedCalls = durable.retriedCalls;
	details.unusedCalls = durable.unused.length;
	details.lingeringDelegates = lingering.length;
	details.status = overBudget ? "over budget" : diverged ? "diverged" : stopped ? "stopped" : interrupted ? "interrupted" : env.signal?.aborted ? "aborted" : failure !== undefined ? "failed" : "completed";
	const declaredOk = value && typeof value === "object" && typeof (value as { ok?: unknown }).ok === "boolean" ? (value as { ok: boolean }).ok : true;
	details.ok = details.status === "completed" && declaredOk;
	if (failure !== undefined) details.error = interrupted ? `interrupted: ${(reason as Error).message}` : stopped ? (reason as Error).message : scriptStack(failure, entry.filename);
	details.log = lines.slice(-PROGRESS_LINES);
	const cutOff = stopped ? blockingCalls(readJournal(journal.path)).map((call) => `${call.kind} ${call.label}`) : [];
	const retry = details.status === "failed" ? retryableFailures(readJournal(journal.path)).length : 0;
	const text = report(details, value, failure !== undefined, lines, env.cwd, { unused: durable.unused.map((call) => `${call.kind} ${call.label}`), cutOff, retry });
	journal.append({ t: "end", at: Date.now(), status: details.status, ok: details.ok, cost: details.cost, text, ...(lingering.length ? { lingering } : {}) }, true);
	// Delegation state stays for a resume (interrupted, stopped): reattaching agents need it.
	const release = () => {
		for (const dispose of disposers) dispose(interrupted || stopped);
		journal.close();
	};
	stopWatch.close();
	steerWatch.close();
	if (keep && unsettled.size) linger(dir, header.id, unsettled, unlock, release);
	else {
		release();
		unlock();
	}
	return { text, details, ...(usage ? { usage } : {}) };
}

function report(details: WorkflowDetails, value: unknown, failed: boolean, lines: string[], cwd: string, calls: { unused: string[]; cutOff: string[]; retry: number }): string {
	const stats = [
		`${(details.durationMs / 1000).toFixed(1)} s`,
		`$${details.cost.toFixed(4)} of $${details.budget.toFixed(2)}`,
		`${details.llmCalls} llm call${details.llmCalls === 1 ? "" : "s"}${details.cachedCalls ? ` (${details.cachedCalls} cached)` : ""}`,
		`${details.delegateRuns} delegate run${details.delegateRuns === 1 ? "" : "s"}`,
		...(details.replayedCalls ? [`${details.replayedCalls} replayed from the journal`] : []),
		...(details.retriedCalls ? [`${details.retriedCalls} failed call${details.retriedCalls === 1 ? "" : "s"} ran again`] : []),
		`run ${details.id}`,
	];
	const out = [`Workflow ${details.workflow ? `${details.workflow} ` : ""}${details.status} · ${stats.join(" · ")}`];
	if (details.status === "interrupted") out.push(`It can continue from its journal: call workflow with resume: "${details.id}".`);
	if (calls.retry)
		out.push(
			`${calls.retry} agent or llm call${calls.retry === 1 ? "" : "s"} failed. workflow { resume: "${details.id}" } runs ${calls.retry === 1 ? "it" : "them"} again; everything that finished comes from the journal at no cost.`,
		);
	if (details.status === "stopped") {
		if (details.lingeringDelegates) out.push(`${details.lingeringDelegates} delegate run${details.lingeringDelegates === 1 ? " keeps" : "s keep"} running; results are recorded when they end (workflow { stop: "${details.id}", stopChildren: true } cancels them).`);
		if (calls.cutOff.length) out.push(`Cut off by the stop, may have taken effect partly: ${calls.cutOff.join("; ")}. A resume asks whether to run them again (inFlight).`);
		out.push(
			`Continue with workflow { resume: "${details.id}" }, or change the script and continue with workflow { resume: "${details.id}", code: "…" }: calls the new code makes as before are answered from the journal; from its first other call it runs live. Effects so far (commits, files) stay.`,
		);
	}
	if (calls.unused.length) out.push(`${calls.unused.length} recorded call${calls.unused.length === 1 ? "" : "s"} not used by the new code: ${calls.unused.slice(0, 10).join("; ")}${calls.unused.length > 10 ? "; …" : ""}`);
	const shownPaths = (files: string[]) => files.map((f) => relative(canonical(cwd), f)).join(", ");
	if (details.changedFiles.length) out.push(`Written by this run: ${shownPaths(details.changedFiles)}`);
	if (details.othersChangedFiles.length) out.push(`Changed by others meanwhile (not this run; do not restore or revert): ${shownPaths(details.othersChangedFiles)}`);
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
	details.outputFile = join(dir, `${details.id}.txt`);
	writeFileSync(details.outputFile, text);
	return `${cut.content}\n[cut; the full report is in ${details.outputFile}]`;
}
