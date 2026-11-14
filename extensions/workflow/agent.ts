// agent(): a child agent for a workflow that sees only the messages the script sends it.
//
// In t3 (the session has t3's tools) each child is a t3 delegated task with a thread of its own
// under the calling thread (t3.ts), where the user can watch, steer and stop it. Elsewhere it is an
// in-process Pi session, a session file of its own next to the parent's naming it. Both get the same
// spec and the same messages (delegation.ts) and run the same child extension (child.ts), so the
// system prompt, the tool set and the result schema mean the same everywhere.
//
// The child reports its session, cost and each run's text, result or error in its state file; the
// parent counts the cost against the budget while the child runs, links the session to the calling
// tool (details.childSessions, for the metrics index), and returns the files the working tree
// changed during each run. `files` is told to the child, not enforced: agents run in parallel in
// one working tree, as t3 children do.
//
// Each run is a durable call (durable.ts). Its journal records the spec and, as soon as they are
// known, the child's t3 task and thread or its session file; the run's outcome records the agent's
// state, so a replayed run restores the agent and its later runs go to the same child. A run in
// flight when the workflow's process died reattaches: in t3 it waits for the recorded run; without
// one, it waits for the child's report when the child started the run (its state file says so),
// and otherwise repeats the call with the same clientRequestId (t3 dedupes it within one Pi process
// only). In-process it reopens the child's session file. A child whose run was cut off (its own
// process ended too) gets a message to continue.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { canonical, changedPaths, type Snapshot, snapshot } from "../lib/workspace.ts";
import { delegatedChild } from "./child.ts";
import { type DelegationSpec, type DelegationState, delegationMessage, delegationsDir, readSpec, readState, removeDelegation, SUBMIT_TOOL, touchSpec, writeSpec } from "./delegation.ts";
import { type CallContext, type Durable, isInterruption } from "./durable.ts";
import { CACHE_RETENTION, resolveModel, type Thinking, thinkingOption } from "./models.ts";
import { type T3, T3Child, type T3ChildIds } from "./t3.ts";

export const DEFAULT_AGENT_MODEL = "anthropic/claude-sonnet-5-5";
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const DEFAULT_SYSTEM = [
	"You are an agent started by a workflow script. You start without the conversation that led here: everything you need is in the messages you get or in the files.",
	"Do what each message asks. When done, answer briefly: your final message is returned to the script as text.",
].join("\n");
/** Sent to a child whose run was cut off when processes ended, as a run with the same number. */
export const CONTINUE_MESSAGE = "Your previous run was interrupted before it finished (a process ended). Continue the task of this run where you left off, and finish it as the run asked.";
/** How often the child's state is read while it runs (cost, session). */
const POLL_MS = 500;
/** How long a run's state may lag behind the end of the run (t3 reports the end on its own path). */
const STATE_WAIT_MS = 15_000;

export interface AgentOptions {
	model: string;
	system: string;
	tools: string[];
	files?: string[];
	schema?: Record<string, unknown>;
	thinking: Thinking;
}

export interface AgentEnv {
	cwd: string;
	/** The repository root; undefined outside a git repository. */
	root: string | undefined;
	runtime: ModelRuntime;
	agentDir: string;
	/** Where in-process child sessions are stored (next to the parent's), and the parent's file; in memory without. */
	sessionDir?: string;
	parentSessionFile?: string;
	/** The calling session, recorded in the spec. */
	callerSessionId?: string;
	/** t3's tools, when the session runs in t3: children become t3 tasks. */
	t3?: T3;
	durable: Durable;
	/** This agent's number in its workflow run (agent() calls in script order). */
	number: number;
	signal: AbortSignal;
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

export interface AgentRun {
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

export interface AgentHandle {
	run(message: string): Promise<AgentRun>;
	readonly cost: number;
}

/** What a run's journal outcome records besides the run: the agent, to restore on replay. */
interface AgentState {
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

const stringList = (value: unknown, name: string): string[] | undefined => {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v.trim())) {
		throw new TypeError(`agent(): ${name} must be a non-empty array of non-empty strings`);
	}
	return value as string[];
};

/** The options a script passed, checked and with defaults; throws with what is wrong. */
export function agentOptions(raw: unknown): AgentOptions {
	const options = (raw ?? {}) as Record<string, unknown>;
	if (typeof options !== "object" || Array.isArray(options)) throw new TypeError("agent(options?): options must be an object");
	const known = new Set(["model", "system", "tools", "files", "schema", "thinking"]);
	const unknown = Object.keys(options).find((key) => !known.has(key));
	if (unknown) throw new TypeError(`agent(): unknown option ${unknown} (use ${[...known].join(", ")})`);
	for (const key of ["model", "system"] as const) {
		if (options[key] !== undefined && (typeof options[key] !== "string" || !options[key].trim())) throw new TypeError(`agent(): ${key} must be a non-empty string`);
	}
	const schema = options.schema;
	if (schema !== undefined && (typeof schema !== "object" || schema === null || (schema as { type?: unknown }).type !== "object")) {
		throw new TypeError('agent(): schema must be a JSON Schema of an object ({ type: "object", properties: … })');
	}
	const files = stringList(options.files, "files");
	return {
		model: (options.model as string | undefined) ?? DEFAULT_AGENT_MODEL,
		system: (options.system as string | undefined)?.trim() ?? DEFAULT_SYSTEM,
		tools: stringList(options.tools, "tools") ?? DEFAULT_TOOLS,
		...(files ? { files } : {}),
		...(schema ? { schema: schema as Record<string, unknown> } : {}),
		thinking: options.thinking === undefined ? "medium" : thinkingOption(options.thinking, "agent()"),
	};
}

/** One short line for a child's tool call. */
function callLine(tool: string, args: unknown): string {
	const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const value = [record.command, record.path].find((v): v is string => typeof v === "string") ?? "";
	return `${tool} ${value.split("\n")[0]!.slice(0, 120)}`.trim();
}

const headline = (text: string) => (text.split("\n").find((line) => line.trim()) ?? "").trim();

/** How a child's runs are carried out: a t3 task or an in-process session. */
interface Transport {
	/** Send one run's message (`script`: the script's own message, for a title); resolves when the run is over. */
	run(message: string, requestId: string, script: string, remember: (meta: RunMeta) => void): Promise<void>;
	/** Continue a run that was in flight when the process died (`recorded`: what its journal knew): `message` may have been sent already, `continuation` asks to go on. */
	reattach(message: string, continuation: string, requestId: string, script: string, recorded: RunMeta, remember: (meta: RunMeta) => void): Promise<void>;
	/** What identifies the child, for the journal. */
	state(): Pick<AgentState, "t3" | "sessionFile">;
	restore(state: Pick<AgentState, "t3" | "sessionFile">): void;
	cancel(): void;
	dispose(): void;
	threadId?: string;
	/** For an error when the child left no report: where it ran and how it ended. */
	describe(): string;
}

function inProcess(options: AgentOptions, dir: string, label: string, env: AgentEnv): Transport {
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
			extensionFactories: [{ name: "workflow-agent", factory: (pi) => void delegatedChild(pi, dir) }],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: env.cwd,
			agentDir: env.agentDir,
			model: resolveModel(env.runtime, options.model),
			thinkingLevel: options.thinking,
			modelRuntime: env.runtime,
			resourceLoader,
			tools: [...options.tools, ...(options.schema ? [SUBMIT_TOOL] : [])],
			sessionManager: manager,
			settingsManager,
		});
		session.subscribe((event) => {
			if (event.type === "tool_execution_start") env.progress(`${label} · ${callLine(event.toolName, event.args)}`);
		});
		return session;
	};
	const fresh = () => (env.sessionDir ? SessionManager.create(env.cwd, env.sessionDir, { parentSession: env.parentSessionFile }) : SessionManager.inMemory(env.cwd));
	const prompt = async (message: string, manager: () => SessionManager, remember: (meta: RunMeta) => void) => {
		const session = await (child ??= create(manager()));
		if (session.sessionFile && session.sessionFile !== sessionFile) {
			sessionFile = session.sessionFile;
			remember({ sessionFile });
		}
		// Checked right before prompt(): an abort while the session was created would reach no run.
		if (env.signal.aborted) throw env.signal.reason;
		await session.prompt(message);
	};
	const recorded = () => (sessionFile && existsSync(sessionFile) ? SessionManager.open(sessionFile) : fresh());
	return {
		run: (message, _requestId, _script, remember) => prompt(message, recorded, remember),
		// The child died with the parent's process: reopen its session and ask it to go on; without one, nothing ran yet.
		reattach: (message, continuation, _requestId, _script, _recorded, remember) => prompt(sessionFile && existsSync(sessionFile) ? continuation : message, recorded, remember),
		state: () => (sessionFile ? { sessionFile } : {}),
		restore: (state) => {
			sessionFile = state.sessionFile ?? sessionFile;
		},
		cancel: () => void child?.then((session) => session.abort(), () => undefined),
		dispose: () => void child?.then((session) => session.dispose(), () => undefined),
		describe: () => "its in-process session",
	};
}

function inT3(t3: T3, options: AgentOptions, label: string, env: AgentEnv): Transport {
	let task: T3Child | undefined;
	let restored: T3ChildIds = {};
	const child = (script: string) => {
		if (task) return task;
		task = new T3Child(t3, {
			title: `workflow ${label}: ${headline(script).slice(0, 60)}`,
			role: options.tools.some((tool) => tool === "edit" || tool === "write") ? "implementation" : "research",
			model: options.model,
			thinking: options.thinking,
		});
		task.restore(restored);
		return task;
	};
	const started = (known: string | undefined, remember: (meta: RunMeta) => void) => (ids: T3ChildIds) => {
		remember(ids);
		if (!known && ids.threadId) {
			env.thread(ids.link ?? ids.threadId);
			env.progress(`${label} · t3 thread ${ids.link ?? ids.threadId}`);
		}
	};
	return {
		run: (message, requestId, script, remember) => child(script).run(message, requestId, env.signal, started(child(script).threadId, remember)),
		// A run whose id the journal has is waited for; else t3 dedupes the repeated call on its request id.
		reattach: (message, _continuation, requestId, script, recorded, remember) => child(script).reattach(message, requestId, recorded.runId, env.signal, started(child(script).threadId, remember)),
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

/** agent(options): checked at once; the child starts on the first run. */
export function createAgent(raw: unknown, env: AgentEnv): AgentHandle {
	const options = agentOptions(raw);
	resolveModel(env.runtime, options.model);
	const label = `agent ${env.number}`;
	const dir = delegationsDir(env.agentDir);
	let spec: DelegationSpec = {
		id: randomUUID(),
		system: options.system,
		tools: options.tools,
		...(options.schema ? { schema: options.schema } : {}),
		...(options.files ? { files: options.files } : {}),
		...(env.callerSessionId ? { callerSessionId: env.callerSessionId } : {}),
	};
	const transport = env.t3 ? inT3(env.t3, options, label, env) : inProcess(options, dir, label, env);
	let runs = 0;
	let cost = 0;
	let running = false;
	let disposed = false;
	/** The key of the first run: the agent's identity in the journal. */
	let firstKey: string | undefined;
	/** The cost of each child session counted so far. */
	let counted = new Map<string, number>();
	env.onDispose((interrupted) => {
		disposed = true;
		transport.dispose();
		// A resume reattaches to the child: it keeps running (t3) and keeps its spec and state.
		if (interrupted) return;
		if (running) transport.cancel();
		removeDelegation(dir, spec.id);
	});

	/** Count what the child reported since the last look; returns its state. */
	const sync = (): DelegationState | undefined => {
		const state = readState(dir, spec.id);
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
	const finalState = async (n: number, waitMs = STATE_WAIT_MS): Promise<DelegationState | undefined> => {
		const deadline = Date.now() + waitMs;
		for (;;) {
			const state = sync();
			if (state && (state.run > n || (state.run === n && state.done))) return state;
			if (Date.now() >= deadline || env.signal.aborted) return undefined;
			await new Promise((r) => setTimeout(r, 100));
		}
	};

	const changedSince = async (before: Snapshot | undefined): Promise<string[]> => {
		if (!before) return [];
		const after = await snapshot(before.root);
		if (after.head !== before.head) env.warn(`${label}: HEAD moved during its run (${before.head ?? "none"} → ${after.head ?? "none"}); it committed or switched branches`);
		return (await changedPaths(before, after)).map((path) => relative(canonical(env.cwd), path));
	};

	const agentState = (): AgentState => ({ firstKey: firstKey!, spec, runs, cost, counted: Object.fromEntries(counted), ...transport.state() });
	const restore = (state: AgentState) => {
		firstKey = state.firstKey;
		spec = state.spec;
		runs = state.runs;
		cost = state.cost;
		counted = new Map(Object.entries(state.counted));
		transport.restore(state);
	};

	/** Run `n` live, or reattach to it when it was in flight at a crash. */
	const execute = async (n: number, message: string, call: CallContext, reattach: boolean) => {
		if (n === 1) firstKey = call.key;
		const recorded = call.recorded as RunMeta;
		if (reattach) {
			if (recorded.spec) spec = recorded.spec;
			transport.restore({ ...(recorded.sessionFile ? { sessionFile: recorded.sessionFile } : {}), ...(recorded.threadId ? { t3: { taskId: recorded.taskId, threadId: recorded.threadId, link: recorded.link } } : {}) });
			if (env.t3 && recorded.threadId && !recorded.runId) env.warn(`${label}: run ${n} had no run id recorded; repeating its call with the same request id`);
			env.warn(`${label}: run ${n} reattached after the workflow's process ended; its changed files are those since the resume`);
		} else call.meta({ spec });
		// The spec is gone when the sweep took it; the child reads it on every run.
		if (!readSpec(dir, spec.id)) writeSpec(dir, spec);
		else touchSpec(dir, spec.id);
		runs = n;
		const before = env.root ? await snapshot(env.root) : undefined;
		const costBefore = cost;
		const poll = setInterval(sync, POLL_MS);
		// An interrupted run leaves the child working: the resume reattaches to it.
		const cancel = () => {
			if (!isInterruption(env.signal.reason)) transport.cancel();
		};
		env.signal.addEventListener("abort", cancel, { once: true });
		running = true;
		const requestId = `${spec.id}-run-${n}`;
		const remember = (meta: RunMeta) => call.meta({ ...meta });
		try {
			env.progress(`${label} · ${reattach ? "reattaching" : "running"}`);
			const runMessage = delegationMessage(spec, n, message);
			const continuation = delegationMessage(spec, n, CONTINUE_MESSAGE);
			const done = () => {
				const state = readState(dir, spec.id);
				return state !== undefined && (state.run > n || (state.run === n && state.done));
			};
			if (!reattach) await transport.run(runMessage, requestId, message, remember);
			else if (!done()) {
				if (env.t3 && !recorded.runId && readState(dir, spec.id)?.run === n) {
					// The child runs this run (its state says so) but its t3 run is unknown: t3 dedupes a repeated call only
					// within the Pi process that made it, so repeating it here would start the work again. Its report comes in its state.
					await finalState(n, Number.POSITIVE_INFINITY);
				} else {
					await transport.reattach(runMessage, continuation, requestId, message, recorded, remember);
					// The child's own run was cut off too (its process ended): ask it to go on.
					if (!(await finalState(n, 2000))) await transport.run(continuation, `${requestId}-continue`, message, remember);
				}
			}
		} finally {
			running = false;
			clearInterval(poll);
			env.signal.removeEventListener("abort", cancel);
			env.ran();
		}
		if (env.signal.aborted) throw env.signal.reason;
		const state = await finalState(n);
		const changed = await changedSince(before);
		if (!state || state.run !== n) throw new Error(`${label}: the child reported no end of run ${n}; ${transport.describe()}`);
		if (state.error) throw new Error(`${label}: ${state.error}`);
		const run: AgentRun = {
			text: state.text ?? "",
			...(options.schema ? { result: state.result } : {}),
			changed,
			cost: cost - costBefore,
			sessionId: state.sessionId,
			...(transport.threadId ? { threadId: transport.threadId } : {}),
		};
		return { value: { run, agent: agentState() }, cost: run.cost };
	};

	// Runs of one agent are one conversation: they go one after the other.
	let queue: Promise<unknown> = Promise.resolve();
	const runOnce = async (message: string): Promise<AgentRun> => {
		if (env.signal.aborted) throw env.signal.reason;
		if (disposed) throw new Error(`${label} was used after its workflow ended`);
		const n = runs + 1;
		const args = n === 1 ? { options, message } : { agent: firstKey, run: n, message };
		const value = (await env.durable.call(
			{ kind: "agent", args, label: `${label}${n > 1 ? ` run ${n}` : ""}: ${headline(message).slice(0, 100)}`, model: options.model },
			(call) => execute(n, message, call, false),
			(call) => execute(n, message, call, true),
		)) as { run: AgentRun; agent: AgentState };
		restore(value.agent);
		return value.run;
	};

	return {
		run(message: unknown) {
			if (typeof message !== "string" || !message.trim()) return Promise.reject(new TypeError("agent().run(message): message must be a non-empty string"));
			const result = queue.then(() => runOnce(message));
			queue = result.catch(() => undefined);
			return result;
		},
		get cost() {
			return cost;
		},
	};
}
