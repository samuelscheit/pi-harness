// delegate(): a workflow's child agent, which sees only the messages the script sends it. It is
// t3's `delegate_task` as the harness extends it (delegate-tool.ts), awaited: the same parameters
// (without the task, which `run` sends, and without how to wait), plus `onAsk` (part of the
// workflow, not of the tool). It returns a handle:
// - run(message): the first run delegates, later ones resume the same conversation;
// - compact(instructions?): Pi's `/compact`, sent as a message (t3 maps it to Pi's compaction);
// - warm(duration): the harness's `/warm` (extensions/warm), sent as a message: hold the child's
//   prompt cache warm, e.g. while the workflow works on something else before its next run;
// - steer(text): steers the running turn; stop(): stops the child's work;
// - fork(message): a new child forked from this one's conversation, running `message`;
// - cost, threadId.
//
// In t3 (the session has t3's tools) each child is a t3 delegated task with a thread of its own
// under the calling thread (t3.ts), where the user can watch, steer and stop it. Elsewhere it is an
// in-process Pi session, a session file of its own next to the parent's naming it, with the same
// semantics: the same spec and messages (delegation.ts), the same child extension (child.ts),
// `/compact` is Pi's compaction, `/warm` the same command, and a fork is Pi's session fork.
//
// The child reports its session, cost and each run's text, result or error in its state file; the
// parent counts the cost against the budget while the child runs, links the session to the calling
// tool (details.childSessions, for the metrics index), and returns the files the working tree
// changed during each run.
//
// Each run and each operation is a durable call (durable.ts). Its journal records the spec and, as
// soon as they are known, the child's t3 task and thread or its session file; the run's outcome
// records the handle's state, so a replayed run restores it and its later runs go to the same
// child. A run in flight when the workflow's process died reattaches: in t3 it waits for the
// recorded run; without one, it waits for the child's report when the child started the run (its
// state file says so), and otherwise repeats the call with the same clientRequestId (t3 dedupes it
// within one Pi process only). In-process it reopens the child's session file. A child whose run
// was cut off (its process ended too) gets a message to continue.

import { existsSync } from "node:fs";
import { relative } from "node:path";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { canonical, changedPaths, type Snapshot, snapshot } from "../lib/workspace.ts";
import askUser from "../ask-user/index.ts";
import warm from "../warm/index.ts";
import { type Ask, answerPending, answersInOrder, type Question, questionsUi } from "./ask.ts";
import { delegatedChild, RUN_STOPPED } from "./child.ts";
import { type DelegationSpec, type DelegationState, delegateProblem, delegationMessage, delegationsDir, HARNESS_KEYS, prepareDelegation, readSpec, readState, removeDelegation, SUBMIT_TOOL, touchSpec, writeSpec } from "./delegation.ts";
import { type CallContext, type Durable, isInterruption } from "./durable.ts";
import { CACHE_RETENTION, resolveModel, THINKING, type Thinking } from "./models.ts";
import { type T3, T3Child, type T3ChildIds } from "./t3.ts";

/** The model of an in-process child without `target.model` when the caller's is unknown. */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5-5";
/** Sent to a child whose run was cut off when processes ended, as a run with the same number. */
export const CONTINUE_MESSAGE = "Your previous run was interrupted before it finished (it was stopped, or a process ended). Continue the task of this run where you left off, and finish it as the run asked.";
/** How often the child's state is read while it runs (cost, session). */
const POLL_MS = 500;
/** How long a run's state may lag behind the end of the run (t3 reports the end on its own path). */
const STATE_WAIT_MS = 15_000;

/** delegate_task's own parameters a workflow passes through to t3. */
const T3_KEYS = ["target", "title", "role", "isolation", "runtimeMode", "interactionMode", "fork", "forkThreadId"] as const;
const KNOWN = new Set<string>([...T3_KEYS, ...HARNESS_KEYS, "onAsk"]);

/** `/compact [instructions]`: Pi's compaction command, as t3 recognizes it in a message. */
export const compactCommand = (instructions?: string) => (instructions?.trim() ? `/compact ${instructions.trim()}` : "/compact");
/** The instructions of a `/compact` message, or undefined when the message is no compaction. */
export function parseCompact(text: string): { instructions?: string } | undefined {
	const trimmed = text.trim();
	if (trimmed === "/compact") return {};
	return /^\/compact\s/.test(trimmed) ? { instructions: trimmed.slice("/compact".length).trim() } : undefined;
}

export interface DelegateOptions {
	/** delegate_task's arguments for t3 (target, title, role, …); no harness keys. */
	t3: Record<string, unknown>;
	schema?: Record<string, unknown>;
	system?: string;
	tools?: string[];
	/** Answers the child's questions; undefined passes them up. Not journaled with the options (a function). */
	onAsk?: (questions: Question[]) => unknown;
}

export interface DelegateEnv {
	/** The current phase's header for a run's message (phases.ts), or undefined outside phases. */
	header?: () => string | undefined;
	/** Ask whoever runs the workflow (its session's ask_user): where an in-process child's questions go up. */
	askUp?: (questions: Question[], signal: AbortSignal) => Promise<(string | undefined)[] | undefined>;
	cwd: string;
	/** The repository root; undefined outside a git repository. */
	root: string | undefined;
	runtime: ModelRuntime;
	agentDir: string;
	/** The calling session's model ("provider/id"): an in-process child's default. */
	model?: string;
	/** Where in-process child sessions are stored (next to the parent's), and the parent's file; in memory without. */
	sessionDir?: string;
	parentSessionFile?: string;
	/** The calling session, recorded in the spec. */
	callerSessionId?: string;
	/** t3's tools, when the session runs in t3: children become t3 tasks. */
	t3?: T3;
	durable: Durable;
	/** Numbers delegates in script order. */
	next: () => number;
	/** Each response's cost in USD. */
	spend: (usd: number) => void;
	/** A child session started. */
	started: (sessionId: string) => void;
	/** A child's t3 thread started (its link). */
	thread: (link: string) => void;
	/** A run finished. */
	ran: () => void;
	progress: (line: string) => void;
	warn: (line: string) => void;
	/** Register cleanup for the end of the workflow run; `interrupted`: the run will be resumed, children keep their state. */
	onDispose: (dispose: (interrupted: boolean) => void) => void;
}

export interface DelegateRun {
	text: string;
	/** The submitted object, with a schema. */
	result?: unknown;
	/** Files the working tree changed during the run, relative to cwd (also other agents' changes meanwhile). */
	changed: string[];
	/** This run's cost in USD. */
	cost: number;
	sessionId?: string;
	threadId?: string;
}

export interface DelegateHandle {
	run(message: string, options?: { header?: boolean }): Promise<DelegateRun>;
	compact(instructions?: string): Promise<void>;
	warm(duration: string): Promise<void>;
	steer(text: string): Promise<void>;
	stop(): Promise<void>;
	fork(message: string): Promise<DelegateRun & { handle: DelegateHandle }>;
	readonly cost: number;
	readonly threadId: string | undefined;
}

/** What a run's journal outcome records besides the run: the handle, to restore on replay. */
interface HandleState {
	firstKey: string;
	spec: DelegationSpec;
	runs: number;
	cost: number;
	counted: Record<string, number>;
	t3?: T3ChildIds;
	sessionFile?: string;
}

/** What a run's journal meta records while it runs, to reattach. */
interface RunMeta {
	spec?: DelegationSpec;
	sessionFile?: string;
	taskId?: string;
	threadId?: string;
	link?: string;
	runId?: string;
}

/** delegate()'s parameters, checked; throws with what is wrong. */
export function delegateOptions(raw: unknown): DelegateOptions {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("delegate(params?): params must be an object");
	const params = raw as Record<string, unknown>;
	const unknown = Object.keys(params).find((key) => !KNOWN.has(key));
	if (unknown) throw new TypeError(`delegate(): unknown parameter ${unknown} (use ${[...KNOWN].join(", ")}; the task is run()'s message)`);
	const problem = delegateProblem(params);
	if (problem) throw new TypeError(`delegate(): ${problem}`);
	if (params.onAsk !== undefined && typeof params.onAsk !== "function") throw new TypeError("delegate(): onAsk must be a function (questions) => answers | undefined");
	const t3 = Object.fromEntries(T3_KEYS.filter((key) => params[key] !== undefined).map((key) => [key, params[key]]));
	return {
		t3,
		...(params.onAsk ? { onAsk: params.onAsk as (questions: Question[]) => unknown } : {}),
		...(params.schema !== undefined ? { schema: params.schema as Record<string, unknown> } : {}),
		...(params.system !== undefined ? { system: (params.system as string).trim() } : {}),
		...(params.tools !== undefined ? { tools: params.tools as string[] } : {}),
	};
}

/** An in-process child's model and thinking: `target.model` and `target.options.thinking`, else the caller's model. */
function inProcessModel(options: DelegateOptions, env: DelegateEnv): { model: string; thinking: Thinking } {
	const target = (options.t3.target ?? {}) as { model?: unknown; options?: { thinking?: unknown } };
	const model = typeof target.model === "string" ? target.model : (env.model ?? DEFAULT_MODEL);
	const thinking = target.options?.thinking;
	return { model, thinking: typeof thinking === "string" && (THINKING as readonly string[]).includes(thinking) ? (thinking as Thinking) : "medium" };
}

/** One short line for a child's tool call. */
function callLine(tool: string, args: unknown): string {
	const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const value = [record.command, record.path].find((v): v is string => typeof v === "string") ?? "";
	return `${tool} ${value.split("\n")[0]!.slice(0, 120)}`.trim();
}

const headline = (text: string) => (text.split("\n").find((line) => line.trim()) ?? "").trim();

/** Where a fork starts: the source's conversation and spec. */
interface ForkSource {
	spec: DelegationSpec;
	threadId?: string;
	sessionFile?: string;
	/** The source's first run's key: the fork's identity in the journal is derived from it. */
	key: string;
}

/** How a child's runs are carried out: a t3 task or an in-process session. */
interface Transport {
	/** Send one run's message (prepared: marker, summary); resolves when the run is over. */
	run(message: string, requestId: string, remember: (meta: RunMeta) => void, signal: AbortSignal): Promise<void>;
	/** Continue a run that was in flight when the run stopped (`recorded`: what its journal knew): `message` may have been sent already, `continuation` asks to go on. */
	reattach(message: string, continuation: string, requestId: string, recorded: RunMeta, remember: (meta: RunMeta) => void, signal: AbortSignal): Promise<void>;
	/** A slash command as a message (`/compact`, `/warm`); resolves when it is done. */
	command(text: string, requestId: string, signal: AbortSignal): Promise<void>;
	steer(text: string, requestId: string, signal: AbortSignal): Promise<void>;
	/** What identifies the child, for the journal. */
	state(): Pick<HandleState, "t3" | "sessionFile">;
	restore(state: Pick<HandleState, "t3" | "sessionFile">): void;
	cancel(): void;
	dispose(): void;
	readonly threadId?: string;
	readonly sessionFile?: string;
	/** For an error when the child left no report: where it ran and how it ended. */
	describe(): string;
}

function inProcess(options: DelegateOptions, dir: string, label: string, env: DelegateEnv, fork: ForkSource | undefined, ask: Ask): Transport {
	const { model, thinking } = inProcessModel(options, env);
	let child: Promise<AgentSession> | undefined;
	let sessionFile: string | undefined;
	const create = async (manager: SessionManager) => {
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 3 }, cacheRetention: CACHE_RETENTION });
		const resourceLoader = new DefaultResourceLoader({
			cwd: env.cwd,
			agentDir: env.agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			// ask_user, whose questions the workflow answers (questionsUi below).
			extensionFactories: [
				{ name: "workflow-delegate", factory: (pi) => void delegatedChild(pi, dir) },
				{ name: "ask-user", factory: askUser },
				// h.warm's /warm.
				{ name: "warm", factory: warm },
			],
		});
		await resourceLoader.reload();
		const tools = options.tools ?? fork?.spec.tools;
		const { session } = await createAgentSession({
			cwd: env.cwd,
			agentDir: env.agentDir,
			model: resolveModel(env.runtime, model),
			thinkingLevel: thinking,
			modelRuntime: env.runtime,
			resourceLoader,
			...(tools ? { tools: [...tools, ...(options.schema || fork?.spec.schema ? [SUBMIT_TOOL] : [])] } : {}),
			sessionManager: manager,
			settingsManager,
		});
		await session.bindExtensions({ uiContext: questionsUi(ask) });
		session.subscribe((event) => {
			if (event.type === "tool_execution_start") env.progress(`${label} · ${callLine(event.toolName, event.args)}`);
		});
		return session;
	};
	const fresh = () => {
		if (fork) {
			if (!fork.sessionFile || !existsSync(fork.sessionFile)) throw new Error(`${label}: the source of the fork has no session file (in-process children need a session directory to fork)`);
			return SessionManager.forkFrom(fork.sessionFile, env.cwd, env.sessionDir);
		}
		return env.sessionDir ? SessionManager.create(env.cwd, env.sessionDir, { parentSession: env.parentSessionFile }) : SessionManager.inMemory(env.cwd);
	};
	const recorded = () => (sessionFile && existsSync(sessionFile) ? SessionManager.open(sessionFile) : fresh());
	const session = async (remember: (meta: RunMeta) => void = () => undefined) => {
		const opened = await (child ??= create(recorded()));
		if (opened.sessionFile && opened.sessionFile !== sessionFile) {
			sessionFile = opened.sessionFile;
			remember({ sessionFile });
		}
		return opened;
	};
	const prompt = async (message: string, remember: (meta: RunMeta) => void, signal: AbortSignal) => {
		const opened = await session(remember);
		// Checked right before prompt(): an abort while the session was created would reach no run.
		if (signal.aborted) throw signal.reason;
		await opened.prompt(message);
	};
	return {
		run: (message, _requestId, remember, signal) => prompt(message, remember, signal),
		// The child died with the parent's process or was stopped: reopen its session and ask it to go on; without one, nothing ran yet.
		reattach: (message, continuation, _requestId, _recorded, remember, signal) => prompt(sessionFile && existsSync(sessionFile) ? continuation : message, remember, signal),
		// As t3 does: /compact is Pi's compaction; other commands are prompts Pi dispatches to their extension.
		command: async (text) => {
			const opened = await session();
			const compact = parseCompact(text);
			if (compact) await opened.compact(compact.instructions);
			else await opened.prompt(text);
		},
		steer: async (text) => void (await (await session()).steer(text)),
		state: () => (sessionFile ? { sessionFile } : {}),
		restore: (state) => {
			sessionFile = state.sessionFile ?? sessionFile;
		},
		cancel: () => void child?.then((s) => s.abort(), () => undefined),
		dispose: () => void child?.then((s) => s.dispose(), () => undefined),
		get sessionFile() {
			return sessionFile;
		},
		describe: () => "its in-process session",
	};
}

function inT3(t3: T3, options: DelegateOptions, label: string, env: DelegateEnv, fork: ForkSource | undefined, ask: Ask): Transport {
	let task: T3Child | undefined;
	let restored: T3ChildIds = {};
	/** Pending requests answered or passed up: each is handled once. */
	const handled = new Set<string>();
	const child = (title: string) => {
		if (task) return task;
		const params = { title, ...options.t3, ...(fork ? { fork: true, forkThreadId: fork.threadId } : {}) };
		// Without onAsk every question goes up, as t3 reports it: nothing to read.
		task = new T3Child(t3, params, options.onAsk ? (current, signal) => answerPending(t3.call, current.threadId!, handled, ask, signal) : undefined);
		task.restore(restored);
		return task;
	};
	const existing = () => {
		if (!task?.threadId && !restored.threadId) throw new Error(`${label} has no thread yet: run it first`);
		return child("");
	};
	const started = (known: string | undefined, remember: (meta: RunMeta) => void) => (ids: T3ChildIds) => {
		remember(ids);
		if (!known && ids.threadId) {
			env.thread(ids.link ?? ids.threadId);
			env.progress(`${label} · t3 thread ${ids.link ?? ids.threadId}`);
		}
	};
	// The prepared first message: the marker and summary, a blank line, maybe the phase header, then the script's message.
	const titled = (message: string) => {
		const body = message.slice(message.indexOf("\n\n") + 2).replace(/^\[workflow phase: [^\n]*\]\n\n/, "");
		return child(`workflow ${label}: ${headline(body).slice(0, 60)}`);
	};
	return {
		run: (message, requestId, remember, signal) => titled(message).run(message, requestId, signal, started(titled(message).threadId, remember)),
		// A run whose id the journal has is waited for; else t3 dedupes the repeated call on its request id.
		reattach: (message, _continuation, requestId, recorded, remember, signal) => titled(message).reattach(message, requestId, recorded.runId, signal, started(titled(message).threadId, remember)),
		command: (text, requestId, signal) => existing().send(text, "queue", requestId, signal),
		steer: (text, requestId, signal) => existing().send(text, "steer", requestId, signal),
		state: () => {
			const ids = task?.ids ?? restored;
			return Object.keys(ids).length ? { t3: ids } : {};
		},
		restore: (state) => {
			restored = { ...restored, ...state.t3 };
			task?.restore(restored);
		},
		cancel: () => task?.cancel(),
		dispose: () => undefined,
		get threadId() {
			return task?.threadId ?? restored.threadId;
		},
		describe: () => `its t3 task (thread ${task?.link ?? task?.threadId ?? "not started"}, status ${task?.status || "unknown"}${task?.summary ? `: ${task.summary.slice(0, 300)}` : ""})`,
	};
}

/** delegate(params): checked at once; the child starts on the first run. */
export function createDelegate(raw: unknown, env: DelegateEnv, source?: ForkSource): DelegateHandle {
	const options = delegateOptions(raw ?? {});
	let fork = source;
	if (!env.t3) {
		resolveModel(env.runtime, inProcessModel(options, env).model);
		// fork: true forks the calling session, here with Pi's session fork as well.
		if (options.t3.fork === true && !fork) {
			if (options.t3.forkThreadId !== undefined) throw new TypeError("delegate(): forkThreadId names a t3 thread; outside t3 fork a delegate with its fork()");
			fork = { spec: { id: "caller" }, key: "caller", ...(env.parentSessionFile ? { sessionFile: env.parentSessionFile } : {}) };
		}
	}
	const number = env.next();
	const label = `delegate ${number}`;
	/** In journal labels, which their kind (delegate) precedes. */
	const tag = `#${number}`;
	const dir = delegationsDir(env.agentDir);
	/** The child's questions: onAsk answers or passes them up; journaled, so a resume replays the answers. */
	const ask: Ask = async (questions, signal) => {
		const value = (await env.durable.call({ kind: "ask", args: { delegate: firstKey ?? label, questions }, label: `${tag} asks: ${headline(questions[0]?.title ?? "").slice(0, 80)}` }, async () => {
			const returned = options.onAsk ? await options.onAsk(questions) : undefined;
			let answers = returned === undefined ? undefined : answersInOrder(questions, returned);
			if (!answers && !env.t3 && env.askUp) answers = await env.askUp(questions, signal);
			return { value: { answers: answers ?? null, by: returned !== undefined ? "onAsk" : answers ? "up" : "none" } };
		})) as { answers: (string | null)[] | null };
		return value.answers?.map((answer) => answer ?? undefined);
	};
	const transport = env.t3 ? inT3(env.t3, options, label, env, fork, ask) : inProcess(options, dir, label, env, fork, ask);
	let spec: DelegationSpec | undefined;
	let runs = 0;
	let cost = 0;
	let running = false;
	let disposed = false;
	/** The key of the first run: the handle's identity in the journal. */
	let firstKey: string | undefined;
	/** The cost of each child session counted so far. */
	let counted = new Map<string, number>();
	env.onDispose((interrupted) => {
		disposed = true;
		transport.dispose();
		// A resume reattaches to the child: it keeps running (t3) and keeps its spec and state.
		if (interrupted) return;
		if (running) transport.cancel();
		if (spec) removeDelegation(dir, spec.id);
	});

	/** Count what the child reported since the last look; returns its state. */
	const sync = (): DelegationState | undefined => {
		const state = spec && readState(dir, spec.id);
		if (!state) return undefined;
		if (!counted.has(state.sessionId)) {
			counted.set(state.sessionId, 0);
			env.started(state.sessionId);
		}
		const delta = state.cost - counted.get(state.sessionId)!;
		if (delta > 0) {
			counted.set(state.sessionId, state.cost);
			cost += delta;
			env.spend(delta);
		}
		return state;
	};

	/** The state of run `n` once it is done; undefined when the child does not report it in time. */
	const finalState = async (n: number, signal: AbortSignal, waitMs = STATE_WAIT_MS): Promise<DelegationState | undefined> => {
		const deadline = Date.now() + waitMs;
		for (;;) {
			const state = sync();
			if (state && (state.run > n || (state.run === n && state.done))) return state;
			if (Date.now() >= deadline || signal.aborted) return undefined;
			await new Promise((r) => setTimeout(r, 100));
		}
	};
	/** A run the child ended because it was stopped (cancelled) is no result: a reattach asks it to go on. */
	const stoppedRun = (state: DelegationState | undefined, n: number) => state?.run === n && state.done && state.error === RUN_STOPPED;

	const changedSince = async (before: Snapshot | undefined): Promise<string[]> => {
		if (!before) return [];
		const after = await snapshot(before.root);
		if (after.head !== before.head) env.warn(`${label}: HEAD moved during its run (${before.head ?? "none"} → ${after.head ?? "none"}); it committed or switched branches`);
		return (await changedPaths(before, after)).map((path) => relative(canonical(env.cwd), path));
	};

	const handleState = (): HandleState => ({ firstKey: firstKey!, spec: spec!, runs, cost, counted: Object.fromEntries(counted), ...transport.state() });
	const restore = (state: HandleState) => {
		firstKey = state.firstKey;
		spec = state.spec;
		runs = state.runs;
		cost = state.cost;
		counted = new Map(Object.entries(state.counted));
		transport.restore(state);
	};

	/** The first run's message for t3 or the in-process child, and the spec it wrote. */
	const firstMessage = (message: string) => {
		// A fork's target only chose the in-process model; t3 forks take their source's.
		const t3Args = fork ? Object.fromEntries(Object.entries(options.t3).filter(([key]) => key !== "target")) : options.t3;
		const prepared = prepareDelegation(
			{ ...t3Args, ...(fork ? { fork: true } : {}), task: message, ...(options.schema ? { schema: options.schema } : {}), ...(options.system !== undefined ? { system: options.system } : {}), ...(options.tools ? { tools: options.tools } : {}) },
			dir,
			{ always: true, ...(env.callerSessionId ? { callerSessionId: env.callerSessionId } : {}), ...(fork ? { inherit: { ...fork.spec, ...(options.schema ? { schema: options.schema } : {}) } } : {}) },
		);
		return { message: String(prepared.input.task), spec: prepared.spec! };
	};

	/** Run `n` live, or reattach to it when it was in flight when the run stopped. */
	const execute = async (n: number, raw: string, head: string | undefined, call: CallContext, reattach: boolean) => {
		// The phase header goes before the script's message (not into the call's key).
		const message = head ? `${head}\n\n${raw}` : raw;
		const { signal } = call;
		if (n === 1) firstKey = call.key;
		const recorded = call.recorded as RunMeta;
		let runMessage: string;
		if (reattach && recorded.spec) {
			spec = recorded.spec;
			runMessage = delegationMessage(spec, n, message);
			transport.restore({ ...(recorded.sessionFile ? { sessionFile: recorded.sessionFile } : {}), ...(recorded.threadId ? { t3: { taskId: recorded.taskId, threadId: recorded.threadId, link: recorded.link } } : {}) });
			if (env.t3 && recorded.threadId && !recorded.runId) env.warn(`${label}: run ${n} had no run id recorded; repeating its call with the same request id`);
			env.warn(`${label}: run ${n} reattached after the workflow stopped; its changed files are those since the resume`);
		} else if (n === 1) {
			({ message: runMessage, spec } = firstMessage(message));
			call.meta({ spec });
		} else runMessage = delegationMessage(spec!, n, message);
		const current = spec!;
		// The spec is gone when the sweep took it; the child reads it on every run.
		if (!readSpec(dir, current.id)) writeSpec(dir, current);
		else touchSpec(dir, current.id);
		runs = n;
		const before = env.root ? await snapshot(env.root) : undefined;
		const costBefore = cost;
		const poll = setInterval(sync, POLL_MS);
		// An interrupted run leaves the child working: the resume reattaches to it.
		const cancel = () => {
			if (!isInterruption(signal.reason)) transport.cancel();
		};
		signal.addEventListener("abort", cancel, { once: true });
		running = true;
		const requestId = `${current.id}-run-${n}`;
		const remember = (meta: RunMeta) => call.meta({ ...meta });
		try {
			env.progress(`${label} · ${reattach ? "reattaching" : "running"}`);
			const continuation = delegationMessage(current, n, CONTINUE_MESSAGE);
			const done = () => {
				const state = readState(dir, current.id);
				return state !== undefined && (state.run > n || (state.run === n && state.done)) && !stoppedRun(state, n);
			};
			if (!reattach) await transport.run(runMessage, requestId, remember, signal);
			else if (!done()) {
				const state = readState(dir, current.id);
				if (env.t3 && !recorded.runId && state?.run === n && !stoppedRun(state, n)) {
					// The child runs this run (its state says so) but its t3 run is unknown: t3 dedupes a repeated call only
					// within the Pi process that made it, so repeating it here would start the work again. Its report comes in its state.
					await finalState(n, signal, Number.POSITIVE_INFINITY);
				} else {
					await transport.reattach(runMessage, continuation, requestId, recorded, remember, signal);
					// The child's own run was cut off too (its process ended, or it was stopped): ask it to go on.
					const after = await finalState(n, signal, 2000);
					if (!after || stoppedRun(after, n)) await transport.run(continuation, `${requestId}-continue`, remember, signal);
				}
			}
		} catch (error) {
			// The parent's side failed (t3, or onAsk threw): the child would wait for an answer or a reader forever.
			if (!signal.aborted) transport.cancel();
			throw error;
		} finally {
			running = false;
			clearInterval(poll);
			signal.removeEventListener("abort", cancel);
			env.ran();
		}
		if (signal.aborted) throw signal.reason;
		const state = await finalState(n, signal);
		const changed = await changedSince(before);
		if (!state || state.run !== n) throw new Error(`${label}: the child reported no end of run ${n}; ${transport.describe()}`);
		if (state.error) throw new Error(`${label}: ${state.error}`);
		const run: DelegateRun = {
			text: state.text ?? "",
			...(current.schema ? { result: state.result } : {}),
			changed,
			cost: cost - costBefore,
			sessionId: state.sessionId,
			...(transport.threadId ? { threadId: transport.threadId } : {}),
		};
		return { value: { run, handle: handleState() }, cost: run.cost };
	};

	// Runs and compactions of one child are one conversation: they go one after the other.
	let queue: Promise<unknown> = Promise.resolve();
	const queued = <T>(task: () => Promise<T>): Promise<T> => {
		const result = queue.then(task);
		queue = result.catch(() => undefined);
		return result;
	};
	const usable = () => {
		if (disposed) throw new Error(`${label} was used after its workflow ended`);
	};
	const nonEmpty = (value: unknown, what: string) => {
		if (typeof value !== "string" || !value.trim()) throw new TypeError(`delegate().${what}: must be a non-empty string`);
		return value;
	};

	const runOnce = async (message: string, head: string | undefined): Promise<DelegateRun> => {
		usable();
		const n = runs + 1;
		const args = n === 1 ? { options, message, ...(fork ? { fork: fork.key } : {}) } : { delegate: firstKey, run: n, message };
		const value = (await env.durable.call(
			{ kind: "delegate", args, label: `${tag}${n > 1 ? ` run ${n}` : ""}: ${headline(message).slice(0, 100)}`, ...(env.t3 ? {} : { model: inProcessModel(options, env).model }) },
			(call) => execute(n, message, head, call, false),
			(call) => execute(n, message, head, call, true),
		)) as { run: DelegateRun; handle: HandleState };
		restore(value.handle);
		return value.run;
	};

	/** An operation on the child besides a run (compact, steer, stop), journaled so a resume does not repeat it. */
	const operate = (op: string, text: string | undefined, act: (requestId: string, signal: AbortSignal) => Promise<void>) => {
		usable();
		if (!firstKey) return Promise.reject(new Error(`${label} has not run yet: ${op} needs a running or finished child`));
		const live = async (call: CallContext) => {
			await act(`${spec!.id}-${op}-${call.key}`, call.signal);
			return { value: null };
		};
		return env.durable.call({ kind: "delegate", args: { delegate: firstKey, op, ...(text === undefined ? {} : { text }) }, label: `${tag} ${op}${text ? `: ${headline(text).slice(0, 80)}` : ""}` }, live, live).then(() => undefined);
	};

	const handle: DelegateHandle = {
		run: (message: unknown, runOptions?: unknown) => {
			try {
				const checked = nonEmpty(message, "run(message)");
				// Read now: the phase the script calls run() in.
				const head = (runOptions as { header?: unknown } | undefined)?.header === false ? undefined : env.header?.();
				return queued(() => runOnce(checked, head));
			} catch (error) {
				return Promise.reject(error);
			}
		},
		compact: (instructions?: unknown) => {
			if (instructions !== undefined && typeof instructions !== "string") return Promise.reject(new TypeError("delegate().compact(instructions?): instructions must be a string"));
			return queued(() => operate("compact", instructions as string | undefined, (requestId, signal) => transport.command(compactCommand(instructions as string | undefined), requestId, signal)));
		},
		warm: (duration: unknown) => {
			try {
				const checked = nonEmpty(duration, "warm(duration)").trim();
				return queued(() => operate("warm", checked, (requestId, signal) => transport.command(`/warm ${checked}`, requestId, signal)));
			} catch (error) {
				return Promise.reject(error);
			}
		},
		steer: (text: unknown) => {
			try {
				const checked = nonEmpty(text, "steer(text)");
				return operate("steer", checked, (requestId, signal) => transport.steer(checked, requestId, signal));
			} catch (error) {
				return Promise.reject(error);
			}
		},
		stop: () => operate("stop", undefined, async () => transport.cancel()),
		fork: (message: unknown) =>
			queued(async () => {
				const checked = nonEmpty(message, "fork(message)");
				usable();
				if (!firstKey || !spec) throw new Error(`${label} has not run yet: fork needs a conversation to fork`);
				const from: ForkSource = { spec, key: firstKey, ...(transport.threadId ? { threadId: transport.threadId } : {}), ...(transport.sessionFile ? { sessionFile: transport.sessionFile } : {}) };
				// t3 gives a fork its source's model; in-process the source's target says it.
				const dropped = ["title", "fork", "forkThreadId", ...(env.t3 ? ["target"] : [])];
				const inherited = Object.fromEntries(Object.entries(options.t3).filter(([key]) => !dropped.includes(key)));
				const forked = createDelegate(inherited, env, from);
				return { ...(await forked.run(checked)), handle: forked };
			}),
		get cost() {
			return cost;
		},
		get threadId() {
			return transport.threadId;
		},
	};
	return handle;
}
