// delegate() children and t3's delegate_task as the harness extends it, through the delegation
// protocol (extensions/workflow/delegation.ts, delegate-tool.ts, child.ts, t3.ts): unit tests of the spec, marker, state and cleanup, then real Pi sessions with a
// faux model. A parent session runs the workflow extension and a fake t3 tool set whose
// delegate_task, t3_thread_send and t3_thread_wait run child Pi sessions in-process with the task,
// so the child side of the workflow extension runs for real, as in a t3 child.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { sessionJobs } from "../extensions/background/jobs.ts";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { AssistantMessage, Context, JsonObject } from "@earendil-works/pi-ai";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type AgentSession, createAgentSession, createReadToolDefinition, DefaultResourceLoader, type ExtensionAPI, type ExtensionUIContext, type ExtensionUIQuestion, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import askUser from "../extensions/ask-user/index.ts";
import warm from "../extensions/warm/index.ts";
import { Type } from "typebox";
import { MAX_REMINDERS, REMINDER_TYPE, RESULT_HEADING } from "../extensions/workflow/child.ts";
import {
	BRIEF,
	type DelegationSpec,
	delegateProblem,
	delegationMessage,
	prepareDelegation,
	delegationsDir,
	parseMarker,
	readSpec,
	readState,
	removeDelegation,
	specPath,
	specSummary,
	statePath,
	SUBMIT_TOOL,
	sweepDelegations,
	writeSpec,
	writeState,
} from "../extensions/workflow/delegation.ts";
import workflow from "../extensions/workflow/index.ts";
import { readJournal, runDir } from "../extensions/workflow/journal.ts";
import { renderWorkflow, viewOf } from "../extensions/workflow/render.ts";
import { INLINE_FILE, resumeWorkflow, runWorkflow, type WorkflowDetails } from "../extensions/workflow/run.ts";
import { lockHeld, STOP_FILE } from "../extensions/workflow/stop.ts";
import { livePage } from "../dashboard/server/workflows.ts";
import { T3_PREFIX, t3Data } from "../extensions/workflow/t3.ts";
import { WAKE_MESSAGE } from "../extensions/workflow/parent-turn.ts";
import { questionsUi } from "../extensions/workflow/ask.ts";
import { toolsDeclaration, tsType } from "../extensions/workflow/signatures.ts";
import { parseCompact } from "../extensions/workflow/delegate.ts";
import { parse as parseYaml } from "yaml";
import { priced } from "./priced.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "delegation-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sweepRoot = () => mkdtempSync(join(dir, "sweep-"));
const SPEC: DelegationSpec = { id: "0b1c2d3e-aaaa-4bbb-8ccc-123456789abc", system: "x".repeat(1234), tools: ["read", "bash"], schema: { type: "object" }, callerSessionId: "parent-1" };

describe("spec, marker and state", () => {
	test("the first message: marker, readable summary, brief, then the message; later runs: marker with the run", () => {
		assert.equal(
			delegationMessage(SPEC, 1, "Do it."),
			`harness-delegation: ${SPEC.id}\nDelegated by the harness: system prompt (1.2k chars); tools: read, bash; returns its result with submit_result (a JSON Schema). ${BRIEF}\n\nDo it.`,
		);
		assert.match(BRIEF, /ask with ask_user and options \(continue \/ replan \/ stop\) rather than guess/);
		assert.equal(delegationMessage(SPEC, 3, "Again."), `harness-delegation: ${SPEC.id} run 3\n\nAgain.`);
		assert.equal(specSummary({ id: "a", system: "short", tools: ["read"] }), "Delegated by the harness: system prompt (5 chars); tools: read.");
		assert.equal(specSummary({ id: "a" }), "Delegated by the harness.");
	});

	test("delegate_task arguments: the harness's keys become a spec; fork goes with none of target, system and tools", () => {
		const plain = { task: "t", title: "x" };
		assert.equal(prepareDelegation(plain, dir).input, plain, "t3's alone: untouched, no spec");
		const { input, spec } = prepareDelegation({ task: "Judge it", title: "x", schema: { type: "object" }, system: " Be brief. ", tools: ["read"] }, dir, { callerSessionId: "p" });
		assert.deepEqual(Object.keys(input).sort(), ["task", "title"]);
		assert.deepEqual(readSpec(dir, spec!.id), { id: spec!.id, system: "Be brief.", tools: ["read"], schema: { type: "object" }, callerSessionId: "p" });
		assert.equal(input.task, delegationMessage(spec!, 1, "Judge it"));
		assert.equal(prepareDelegation(input, dir).input, input, "prepared already: untouched");
		const fork = prepareDelegation({ task: "go", fork: true, forkThreadId: "th-1" }, dir, { inherit: { id: "src", system: "S", tools: ["read"] } });
		assert.deepEqual({ ...fork.spec, id: "" }, { id: "", system: "S", tools: ["read"] }, "a fork always gets a spec, keeping its source's prompt and tools");
		assert.deepEqual(fork.input.fork, true);
		assert.deepEqual(fork.input.forkThreadId, "th-1");
		for (const [args, problem] of [
			[{ fork: true, target: { model: "m" } }, /fork takes the source thread's provider, model, options, system prompt and tools: drop target/],
			[{ fork: true, system: "s", tools: ["read"] }, /drop system, tools/],
			[{ forkThreadId: "x" }, /forkThreadId needs fork: true/],
			[{ fork: "yes" }, /fork must be a boolean/],
			[{ schema: { type: "array" } }, /schema must be a JSON Schema of an object/],
			[{ tools: [] }, /tools must be a non-empty array/],
			[{ system: "" }, /system must be a non-empty string/],
		] as const) {
			assert.match(delegateProblem(args) ?? "", problem, JSON.stringify(args));
			assert.throws(() => prepareDelegation({ task: "t", ...args }, dir), problem);
		}
		assert.equal(delegateProblem({ fork: true, schema: { type: "object" }, title: "t" }), undefined, "a fork may have a schema");
	});

	test("the marker is found on any line (t3 puts a preamble first) and only in its exact form", () => {
		assert.deepEqual(parseMarker(`You are a delegated child.\n\n${delegationMessage(SPEC, 1, "x")}`), { id: SPEC.id, run: 1 });
		assert.deepEqual(parseMarker(delegationMessage(SPEC, 12, "x")), { id: SPEC.id, run: 12 });
		for (const text of ["harness-delegation: <id>", "say harness-delegation: abc", "harness-delegation: abc run 0", "harness-delegation: abc run x", "harness-delegation:abc", "no marker"]) {
			assert.equal(parseMarker(text), undefined, text);
		}
		assert.deepEqual(parseMarker("harness-delegation: abc  \nrest"), { id: "abc", run: 1 }, "trailing blanks are fine");
	});

	test("specs and states round-trip; missing, foreign or broken files read as nothing; removal takes both", () => {
		writeSpec(dir, SPEC);
		assert.deepEqual(readSpec(dir, SPEC.id), SPEC);
		assert.equal(readSpec(dir, "other"), undefined);
		writeFileSync(specPath(dir, "broken"), "{");
		assert.equal(readSpec(dir, "broken"), undefined);
		writeFileSync(specPath(dir, "wrong"), JSON.stringify({ ...SPEC, id: "not-wrong" }));
		assert.equal(readSpec(dir, "wrong"), undefined, "a spec must name its own id");
		writeFileSync(specPath(dir, "array"), "[]");
		assert.equal(readSpec(dir, "array"), undefined);
		writeState(dir, SPEC.id, { sessionId: "s", cost: 0.5, run: 2, done: true, text: "t", submitted: true, result: { a: 1 } });
		assert.deepEqual(readState(dir, SPEC.id), { sessionId: "s", cost: 0.5, run: 2, done: true, text: "t", submitted: true, result: { a: 1 } });
		assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "written whole, no temporary left");
		removeDelegation(dir, SPEC.id);
		assert.equal(existsSync(specPath(dir, SPEC.id)), false);
		assert.equal(existsSync(statePath(dir, SPEC.id)), false);
		removeDelegation(dir, SPEC.id);
	});

	test("the sweep removes files older than a day and keeps newer ones; a missing directory is fine", () => {
		const dir = join(sweepRoot(), "delegations");
		writeSpec(dir, SPEC);
		writeState(dir, SPEC.id, { sessionId: "s", cost: 0, run: 1, done: false });
		writeSpec(dir, { ...SPEC, id: "fresh" });
		const old = new Date(Date.now() - 25 * 60 * 60_000);
		utimesSync(specPath(dir, SPEC.id), old, old);
		utimesSync(statePath(dir, SPEC.id), old, old);
		assert.equal(sweepDelegations(dir), 2);
		assert.deepEqual(readdirSync(dir), ["fresh.json"]);
		assert.equal(sweepDelegations(join(dir, "missing")), 0);
	});

	test("t3 data comes from structuredContent or JSON text", () => {
		assert.deepEqual(t3Data("x", { content: [], structuredContent: { a: 1 } }, ""), { a: 1 });
		assert.deepEqual(t3Data("x", "text", '{"b":2}'), { b: 2 });
		assert.throws(() => t3Data("delegate_task", "oops", "oops"), /t3 delegate_task returned no data: oops/);
	});
});

// ---- real sessions -------------------------------------------------------------------------------

let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
const MODEL = "faux/faux-1";

before(async () => {
	faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	const scratch = mkdtempSync(join(tmpdir(), "delegation-runtime-"));
	runtime = await ModelRuntime.create({ authPath: join(scratch, "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "faux-1", name: "Faux", api: faux.api, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8000 }],
	});
});
after(() => faux.unregister());

const say = (text: string) => fauxAssistantMessage(text);
const call = (name: string, args: JsonObject) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const textOf = (content: unknown) => (typeof content === "string" ? content : (content as { type: string; text?: string }[]).flatMap((b) => (b.type === "text" ? [b.text ?? ""] : [])).join("\n"));
/** A child's user messages carry the marker (after a compaction only its later runs do). */
const isChild = (context: Context) => context.messages.some((m) => m.role === "user" && textOf(m.content).includes("harness-delegation:"));
const firstUser = (context: Context) => textOf(context.messages.find((m) => m.role === "user")?.content ?? "");
/** The last message that is not a system message (prompt and tool updates come as system messages). */
const lastMessage = (context: Context) => context.messages.findLast((m) => m.role !== "system")!;
/** The prompt's preamble (Pi's base prompt, or the custom one) after replaying the system messages. */
const systemOf = (context: Context) => {
	let preamble = "";
	for (const m of context.messages) if (m.role === "system" && m.sections && "preamble" in m.sections) preamble = m.sections.preamble ?? "";
	return preamble;
};

/** A t3 child thread: its session, runs, and the questions pending in it (its ask_user cards). */
interface Thread {
	session: AgentSession;
	runs: Map<string, Promise<void>>;
	pending: Map<string, { questions: ExtensionUIQuestion[]; answer: (values: (string | undefined)[] | undefined) => void }>;
}

/** A thread record whose UI turns ask_user's questions into pending requests, as t3's Pi adapter does. */
function newThread(): { thread: Omit<Thread, "session">; ui: ExtensionUIContext } {
	let requests = 0;
	const thread: Omit<Thread, "session"> = { runs: new Map(), pending: new Map() };
	const questions = (asked: ExtensionUIQuestion[]) =>
		new Promise<(string | undefined)[] | undefined>((resolve) => {
			const id = `request-${++requests}`;
			// Answered by respond or by the user on the card: no longer pending.
			thread.pending.set(id, { questions: asked, answer: (values) => (thread.pending.delete(id), resolve(values)) });
		});
	return { thread, ui: questionsUi((asked) => questions(asked)) };
}

interface Fixture {
	repo: string;
	agentDir: string;
	sessionsDir: string;
	errors: string[];
	sessions: AgentSession[];
	/** Every fake t3 call: tool name and arguments. */
	calls: { name: string; args: Record<string, unknown> }[];
	/** The child sessions by thread. */
	threads: Map<string, Thread>;
	/** What t3 answered per clientRequestId: a repeated call gets the same task and run (t3 dedupes). */
	requests: Map<string, { threadId: string; runId: string }>;
	/** A background job's end waking a child: the turn it starts is a new t3 run of its thread, as in t3. */
	wake?: (threadId: string, content: string) => void;
}

let fx: Fixture;
beforeEach(() => {
	const repo = join(dir, "repo");
	mkdirSync(repo, { recursive: true });
	writeFileSync(join(repo, "README.md"), "hello\n");
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
	fx = { repo, agentDir: join(dir, "agent"), sessionsDir: join(dir, "sessions"), errors: [], sessions: [], calls: [], threads: new Map(), requests: new Map() };
	faux.setResponses([]);
});
afterEach(async () => {
	for (const thread of fx.threads.values()) await Promise.allSettled(thread.runs.values());
	for (const session of fx.sessions.splice(0)) session.dispose();
	assert.deepEqual(fx.errors, [], "no extension errors");
});

/** How t3 calls are repeated in these tests: quickly, and given up on after 300 ms. */
const T3_RETRY = { retryDeadlineMs: 300, backoffMs: 20 };
const workflowExtension = (childRuntime: ModelRuntime) => (pi: ExtensionAPI) =>
	workflow(pi, {
		experimentsDir: join(dir, "experiments"),
		workflowDirs: () => [],
		modelRuntime: async () => childRuntime,
		agentDir: fx.agentDir,
		t3Retry: T3_RETRY,
		parentTurn: { pollMs: 20, deadlineMs: 10_000, holdMs: 10_000 },
		harnessBacklog: join(dir, "harness-backlog.md"),
		stateWaitMs: 1000,
	});

async function newSession(extensions: ((pi: ExtensionAPI) => void)[], sessionManager = SessionManager.create(fx.repo, fx.sessionsDir), sessionRuntime = runtime, uiContext?: ExtensionUIContext): Promise<AgentSession> {
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({ cwd: fx.repo, agentDir: fx.agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, extensionFactories: extensions });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd: fx.repo, agentDir: fx.agentDir, model: sessionRuntime.getModel("faux", "faux-1"), modelRuntime: sessionRuntime, resourceLoader, sessionManager, settingsManager });
	await session.bindExtensions({ ...(uiContext ? { uiContext } : {}), onError: (error) => fx.errors.push(`${error.event}: ${error.error}`) });
	fx.sessions.push(session);
	return session;
}

/**
 * The t3 tools as the t3 MCP bridge registers them; each child is a real Pi session with the workflow extension.
 * `failWait`: while it says so, t3_thread_wait fails as the bridge's fetch does when its HTTP request is cut or refused.
 * `parentRun`: whether the calling thread has an active run; without one delegate_task is refused as t3 refuses it.
 */
function fakeT3(childRuntime: ModelRuntime, options: { waitMs?: number; failWait?: () => boolean; parentRun?: () => boolean } = {}) {
	const waitMs = options.waitMs ?? 80;
	let ids = 0;
	const finishedWithin = async (run: Promise<void>, ms: number) => Promise.race([run.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
	const start = (threadId: string, message: string) => {
		const thread = fx.threads.get(threadId)!;
		const runId = `run-${++ids}`;
		// As t3 does: a `/compact` message is Pi's compaction, not a prompt.
		const compact = parseCompact(message);
		// A compaction Pi refuses still ends the run, as in t3.
		thread.runs.set(runId, compact ? thread.session.compact(compact.instructions).then(() => undefined, () => undefined) : thread.session.prompt(message));
		return runId;
	};
	fx.wake = (threadId, content) => {
		const thread = fx.threads.get(threadId)!;
		thread.runs.set(`run-${++ids}`, thread.session.sendCustomMessage({ customType: "background-job", content, display: true }, { triggerTurn: true }));
	};
	const threadOf = (taskId: unknown) => /^task-(thread-\d+)/.exec(String(taskId))?.[1];
	/** The child's last assistant text: t3's summary of a run. */
	const summaryOf = (threadId: string | undefined) => {
		const last = threadId ? fx.threads.get(threadId)?.session.messages.findLast((m) => m.role === "assistant") : undefined;
		return last ? textOf(last.content) : null;
	};
	return (pi: ExtensionAPI) => {
		const tool = (name: string, run: (args: Record<string, unknown>) => Promise<Record<string, unknown>>) =>
			pi.registerTool({
				name: `${T3_PREFIX}${name}`,
				label: name,
				description: name,
				parameters: Type.Object({}, { additionalProperties: true }),
				outputSchema: Type.Object({}, { additionalProperties: true }),
				async execute(_id, params, signal) {
					fx.calls.push({ name, args: params as Record<string, unknown> });
					// As an MCP client does: an aborted call stops waiting; t3's work goes on.
					const aborted = new Promise<never>((_resolve, reject) => {
						if (signal?.aborted) reject(signal.reason);
						signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
					const data = await Promise.race([run(params as Record<string, unknown>), aborted]);
					const content = [{ type: "text" as const, text: JSON.stringify(data) }];
					// As the bridge returns it: the MCP result, whose structuredContent is t3's data.
					return { content, structuredContent: { content, structuredContent: data } as unknown as JsonObject, details: undefined };
				},
			});
		tool("delegate_task", async (args) => {
			if (options.parentRun && !options.parentRun()) throw new Error("OrchestratorMcpFailure(parent_not_active): Delegated tasks require an active run owned by this MCP provider session.");
			const request = String(args.clientRequestId);
			let known = fx.requests.get(request);
			if (!known) {
				const threadId = `thread-${++ids}`;
				let manager = SessionManager.create(fx.repo, fx.sessionsDir);
				if (args.fork === true) {
					// t3 starts the child as `pi --fork <source session file>`.
					const source = fx.threads.get(String(args.forkThreadId))?.session.sessionFile;
					if (!source) throw new Error("fake t3: fork needs the forkThreadId of a known thread");
					manager = SessionManager.forkFrom(source, fx.repo, fx.sessionsDir);
				} else if (args.forkSessionFile !== undefined) {
					// t3 forks a template's session file, only one under <agentDir>/templates/.
					const file = String(args.forkSessionFile);
					if (!file.startsWith(`${join(fx.agentDir, "templates")}/`)) throw new Error(`fake t3: forkSessionFile outside the templates: ${file}`);
					manager = SessionManager.forkFrom(file, fx.repo, fx.sessionsDir);
				}
				const { thread, ui } = newThread();
				const session = await newSession([workflowExtension(childRuntime), askUser, warm], manager, childRuntime, ui);
				fx.threads.set(threadId, Object.assign(thread, { session }));
				// t3 sends a one-line role preamble, a blank line, then the task.
				known = { threadId, runId: start(threadId, `You are a delegated ${String(args.role)} child.\n\n${String(args.task)}`) };
				fx.requests.set(request, known);
			}
			const { threadId, runId } = known;
			const done = await finishedWithin(fx.threads.get(threadId)!.runs.get(runId)!, waitMs);
			return { taskId: `task-${threadId}`, childThreadId: threadId, childRunId: runId, link: `t3://${threadId}`, status: done ? "completed" : "running", waitTimedOut: !done };
		});
		tool("t3_thread_send", async (args) => {
			const request = String(args.clientRequestId);
			if (args.mode === "steer") {
				const thread = fx.threads.get(String(args.threadId))!;
				await thread.session.steer(String(args.message));
				return { threadId: args.threadId, runId: [...thread.runs.keys()].at(-1), status: "running", delivery: "steered" };
			}
			const known = fx.requests.get(request) ?? { threadId: String(args.threadId), runId: start(String(args.threadId), String(args.message)) };
			fx.requests.set(request, known);
			return { threadId: known.threadId, runId: known.runId, taskId: `task-${known.threadId}-${ids}`, status: "running", delivery: "started" };
		});
		tool("t3_thread_wait", async (args) => {
			if (options.failWait?.()) throw new TypeError("fetch failed");
			const thread = fx.threads.get(String(args.threadId))!;
			// As in t3: only the run's end or the timeout ends a wait, not a pending question; without a run id, the latest run.
			const run = thread.runs.get(args.runId === undefined ? [...thread.runs.keys()].at(-1)! : String(args.runId))!;
			const done = await finishedWithin(run, Math.min(waitMs, Number(args.timeoutMs ?? waitMs)));
			return { threadId: args.threadId, runId: args.runId, status: done ? "completed" : "running", timedOut: !done };
		});
		tool("t3_pending_request", async (args) => {
			const thread = fx.threads.get(String(args.threadId))!;
			if (args.action === "list") return { requestIds: [...thread.pending.keys()] };
			const requestId = String(args.requestId);
			const pending = thread.pending.get(requestId);
			if (!pending) throw new Error(`fake t3: no pending request ${requestId}`);
			if (args.action === "read") {
				return { requestId, questions: pending.questions.map((q, i) => ({ id: `${requestId}:${i}`, header: "Question", question: q.title, options: (q.options ?? []).map(({ label, description }) => ({ label, description: description || label })) })) };
			}
			// respond: one value per question, in order, as t3's adapter answers Pi.
			const answers = args.answers as Record<string, unknown>;
			pending.answer(pending.questions.map((_q, i) => (typeof answers[`${requestId}:${i}`] === "string" ? (answers[`${requestId}:${i}`] as string) : undefined)));
			return { requestId, status: "answered" };
		});
		tool("task_status", async (args) => ({ taskId: args.taskId, status: "completed", summary: summaryOf(threadOf(args.taskId)) }));
		tool("task_cancel", async (args) => {
			await fx.threads.get(threadOf(args.taskId)!)?.session.abort();
			return { taskId: args.taskId, status: "cancel_requested" };
		});
	};
}

/**
 * Run `code` as a workflow from a parent session in "t3": the parent's model calls the workflow tool
 * once, then answers; children answer with `child(context)`. Returns the tool result's details and text.
 */
async function runInT3(code: string, child: FauxResponseStep, opts: { childRuntime?: ModelRuntime; budget?: number; signal?: AbortSignal; failWait?: () => boolean } = {}) {
	const childRuntime = opts.childRuntime ?? runtime;
	const parent = await newSession([workflowExtension(runtime), fakeT3(childRuntime, opts.failWait ? { failWait: opts.failWait } : {})]);
	parent.setActiveToolsByName([...parent.getActiveToolNames(), "workflow"]);
	const dispatch: FauxResponseStep = (...args) => {
		const [context] = args;
		if (!isChild(context)) return lastMessage(context).role === "toolResult" ? say("parent done") : call("workflow", { code, budget: opts.budget ?? 5 });
		return typeof child === "function" ? child(...args) : child;
	};
	faux.setResponses(Array.from({ length: 60 }, () => dispatch));
	await parent.prompt("go");
	const result = parent.messages.find((m) => m.role === "toolResult" && m.toolName === "workflow");
	assert.ok(result && result.role === "toolResult", "the workflow ran");
	return { details: result.details as unknown as WorkflowDetails, text: textOf(result.content), parent };
}

const value = (text: string) => JSON.parse(text.split("\n\n").at(-1)!);
/** The tools declared to the model after replaying the system messages. */
const toolNames = (context: Context) => {
	const names = new Set<string>();
	for (const m of context.messages) {
		if (m.role !== "system") continue;
		for (const t of m.toolsAdded ?? []) names.add(t.name);
		for (const t of m.toolsRemoved ?? []) names.delete(t.name);
	}
	return [...names].sort();
};
const callsOf = (name: string) => fx.calls.filter((c) => c.name === name);

describe("delegate() in t3", () => {
	test("one run: the system prompt and tool subset apply in the child; title, role and target reach t3 as given; files are cleaned up", async () => {
		let seen: Context | undefined;
		const { details, text } = await runInT3(
			"const a = delegate({ target: { model: 'faux/faux-1', options: { thinking: 'low' } }, role: 'review', system: 'You are the careful reviewer.', tools: ['read', 'grep'] });\nreturn JSON.stringify(await a.run('Review README.md\\nin depth'));",
			(context) => {
				seen = context;
				return say("Looks fine.");
			},
		);
		assert.equal(details.status, "completed", details.error);
		const run = value(text);
		assert.equal(run.text, "Looks fine.");
		assert.equal(run.threadId, "thread-1");
		assert.deepEqual(run.changed, []);
		assert.equal(run.result, undefined);
		assert.match(systemOf(seen!), /^You are the careful reviewer\./);
		assert.doesNotMatch(systemOf(seen!), /started by a workflow script\. You start without/, "the script's system replaces the default role");
		assert.deepEqual(toolNames(seen!), ["grep", "read"], "exactly the listed tools, grep activated");
		assert.match(firstUser(seen!), /^You are a delegated review child\.\n\nharness-delegation: [\w-]+\nDelegated by the harness: system prompt \(29 chars\); tools: read, grep\. When the plan no longer fits.*\n\nReview README\.md\nin depth$/);
		const [delegate] = callsOf("delegate_task");
		assert.equal(delegate!.args.title, "workflow delegate 1: Review README.md");
		assert.equal(delegate!.args.role, "review");
		assert.equal(delegate!.args.mode, "wait");
		assert.deepEqual(delegate!.args.target, { model: MODEL, options: { thinking: "low" } }, "as given: t3 resolves it");
		for (const key of ["schema", "system", "tools"]) assert.equal(key in delegate!.args, false, `${key} stays with the harness`);
		assert.ok(callsOf("task_status").length >= 1, "the result is marked delivered");
		const childSession = fx.threads.get("thread-1")!.session;
		assert.deepEqual(details.childSessions, [childSession.sessionId]);
		assert.equal(run.sessionId, childSession.sessionId);
		assert.deepEqual(details.childThreads, ["t3://thread-1"]);
		assert.match(text, /Child threads: t3:\/\/thread-1/);
		assert.deepEqual(readdirSync(delegationsDir(fx.agentDir)), [], "spec and state are deleted when the workflow ends");
	});

	test("a slow child: the wait times out and continues with t3_thread_wait until the run is over", async () => {
		const { details, text } = await runInT3("return (await delegate({ target: { model: 'faux/faux-1' }, tools: ['read'] }).run('slow')).text;", async () => {
			await new Promise((r) => setTimeout(r, 300));
			return say("finally");
		});
		assert.equal(details.status, "completed", details.error);
		assert.equal(text.split("\n\n").at(-1), "finally");
		assert.ok(callsOf("t3_thread_wait").length >= 2, "waited more than once");
		assert.equal(callsOf("t3_thread_wait")[0]!.args.untilDelegatedWorkSettled, true);
		assert.equal(callsOf("t3_thread_wait")[0]!.args.timeoutMs, 240_000, "below Pi's default HTTP idle timeout of 300 s, which would cut it");
	});

	test("a wait slice follows Pi's httpIdleTimeoutMs setting, which t3's bridge fetches under", async () => {
		mkdirSync(fx.agentDir, { recursive: true });
		writeFileSync(join(fx.agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 60_000 }));
		try {
			const { details } = await runInT3("return (await delegate({ target: { model: 'faux/faux-1' }, tools: ['read'] }).run('slow')).text;", async () => {
				await new Promise((r) => setTimeout(r, 200));
				return say("finally");
			});
			assert.equal(details.status, "completed", details.error);
			assert.deepEqual([...new Set(callsOf("t3_thread_wait").map((c) => c.args.timeoutMs))], [45_000]);
		} finally {
			rmSync(join(fx.agentDir, "settings.json"), { force: true });
		}
	});

	test("t3 cuts waits (fetch failed, as at 300 s on 2026-11-14): they are repeated, the run completes, the child is not cancelled", async () => {
		let failures = 3;
		const { details, text } = await runInT3(
			"return (await delegate({ target: { model: 'faux/faux-1' }, tools: ['read'] }).run('slow')).text;",
			async () => {
				await new Promise((r) => setTimeout(r, 300));
				return say("finally");
			},
			{ failWait: () => failures-- > 0 },
		);
		assert.equal(details.status, "completed", details.error);
		assert.equal(text.split("\n\n").at(-1), "finally");
		assert.ok(callsOf("t3_thread_wait").length >= 4, "the failed waits and the ones after");
		assert.equal(callsOf("task_cancel").length, 0, "the child was not cancelled");
	});

	test("t3 unreachable past the deadline: the run is interrupted, its children run on; a resume reattaches to them and the result arrives once", async () => {
		let down = false;
		let childRuns = 0;
		const parent = await newSession([workflowExtension(runtime), fakeT3(runtime, { failWait: () => down })]);
		parent.setActiveToolsByName([...parent.getActiveToolNames(), "workflow"]);
		const code = "const out = await map(['a', 'b'], (n) => delegate({ target: { model: 'faux/faux-1' }, tools: ['read'], system: `You are agent ${n}.` }).run('review'), { concurrency: 2 });\nreturn out.map((r) => r.text).join(' + ');";
		let release!: () => void;
		const released = new Promise<void>((r) => (release = r));
		let resumeId = "";
		const dispatch: FauxResponseStep = async (context) => {
			if (isChild(context)) {
				childRuns++;
				// The children keep working while t3 is unreachable, and finish only after the run gave up.
				down = true;
				await released;
				return say(`${/You are agent (\w)/.exec(systemOf(context))![1]} reviewed`);
			}
			const last = lastMessage(context);
			if (last.role === "toolResult") return say("parent done");
			return textOf(last.content).includes("resume") ? call("workflow", { resume: resumeId }) : call("workflow", { code, budget: 5 });
		};
		faux.setResponses(Array.from({ length: 20 }, () => dispatch));
		await parent.prompt("go");
		const results = () => parent.messages.flatMap((m) => (m.role === "toolResult" && m.toolName === "workflow" ? [m] : []));
		const first = results()[0]!;
		const details = first.details as unknown as WorkflowDetails;
		assert.equal(details?.status, "interrupted", details?.error);
		assert.match(details!.error!, /interrupted: t3 did not answer t3_thread_wait for 0 s \(\d+ attempts; last: t3 t3_thread_wait: fetch failed\)\. Its child threads keep running; resume the workflow to reattach to them\./);
		assert.match(textOf(first.content), new RegExp(`call workflow with resume: "${details!.id}"`));
		assert.equal(callsOf("task_cancel").length, 0, "no child was cancelled");
		const journal = join(runDir(fx.agentDir, details!.id), "journal.jsonl");
		assert.equal(readJournal(journal).filter((e) => e.t === "failed").length, 0, "no delegate failed: both are in flight");
		assert.deepEqual(viewOf(readJournal(journal)).calls.map((c) => c.status), ["interrupted", "interrupted"]);

		// t3 is back and the children finish; the resume waits for their recorded runs.
		down = false;
		release();
		resumeId = details!.id;
		const waitsBefore = callsOf("t3_thread_wait").length;
		await parent.prompt("resume it");
		const second = results().at(-1)!;
		const resumed = second.details as unknown as WorkflowDetails;
		assert.equal(resumed?.status, "completed", resumed?.error);
		assert.equal(textOf(second.content).split("\n\n").at(-1), "a reviewed + b reviewed");
		assert.equal(childRuns, 2, "each child ran once");
		assert.equal(fx.threads.size, 2, "no new task");
		assert.equal(callsOf("delegate_task").length, 2);
		assert.equal(callsOf("t3_thread_send").length, 0);
		const recordedRuns = new Set(readJournal(journal).flatMap((e) => (e.t === "meta" && typeof e.data.runId === "string" ? [e.data.runId] : [])));
		assert.ok(callsOf("t3_thread_wait").slice(waitsBefore).every((c) => recordedRuns.has(String(c.args.runId))), "the resume waited for the recorded runs");
		assert.equal(callsOf("task_cancel").length, 0);
	});

	test("submit_result listed in tools with a schema is the child's own tool, not an unknown one", async () => {
		const seen: Context[] = [];
		const { details, text } = await runInT3(
			"return JSON.stringify((await delegate({ target: { model: 'faux/faux-1' }, tools: ['read', 'submit_result'], schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } }).run('count')).result);",
			(context) => {
				seen.push(context);
				return seen.length === 1 ? call("submit_result", { n: 3 }) : say("Submitted.");
			},
		);
		assert.equal(details.status, "completed", details.error);
		assert.deepEqual(value(text), { n: 3 });
		assert.deepEqual(toolNames(seen[0]!), ["read", "submit_result"], "once");
	});

	test("an unknown tool fails the run before any request of the child", async () => {
		let childRequests = 0;
		const { details } = await runInT3("await delegate({ target: { model: 'faux/faux-1' }, tools: ['read', 'nope', 'zap'] }).run('x');", () => {
			childRequests++;
			return say("never");
		});
		assert.equal(details.status, "failed");
		assert.match(details.error!, /delegate \d+: unknown tools nope, zap; this session has .*\bread\b/);
		assert.equal(childRequests, 0);
	});

	test("schema: a wrong shape goes back to the child as an error; the fixed result arrives as an object", async () => {
		const seen: Context[] = [];
		const { details, text } = await runInT3(
			"const a = delegate({ target: { model: 'faux/faux-1' }, tools: ['read'], schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['ok', 'bad'] }, score: { type: 'number' } }, required: ['verdict', 'score'], additionalProperties: false } });\nreturn JSON.stringify(await a.run('Judge it'));",
			(context) => {
				seen.push(context);
				if (seen.length === 1) return call("submit_result", { verdict: "maybe", score: 1 });
				if (seen.length === 2) return call("submit_result", { verdict: "ok", score: "0.5" });
				return say("Submitted.");
			},
		);
		assert.equal(details.status, "completed", details.error);
		const run = value(text);
		assert.deepEqual(run.result, { verdict: "ok", score: 0.5 }, "validated and coerced like any tool call");
		assert.equal(run.text, "Submitted.");
		assert.deepEqual(toolNames(seen[0]!), ["read", "submit_result"]);
		assert.match(firstUser(seen[0]!), /returns its result with submit_result/);
		const error = lastMessage(seen[1]!);
		assert.equal(error.role, "toolResult");
		assert.equal(error.role === "toolResult" && error.isError, true);
		assert.match(textOf(error.content), /verdict/);
	});

	test("schema: a child that never submits is reminded twice, then the run fails", async () => {
		const seen: Context[] = [];
		const { details } = await runInT3("await delegate({ target: { model: 'faux/faux-1' }, tools: ['read'], schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } }).run('x');", (context) => {
			seen.push(context);
			return say(`no result ${seen.length}`);
		});
		assert.equal(details.status, "failed");
		assert.match(details.error!, new RegExp(`delegate \\d+: it finished without calling submit_result \\(reminded ${MAX_REMINDERS} times\\)`));
		assert.equal(seen.length, 1 + MAX_REMINDERS);
		assert.match(JSON.stringify(lastMessage(seen[1]!)), /Reminder 1 of 2/);
		assert.match(JSON.stringify(lastMessage(seen[2]!)), /Reminder 2 of 2/);
		const reminders = fx.threads.get("thread-1")!.session.sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === REMINDER_TYPE);
		assert.equal(reminders.length, MAX_REMINDERS);
	});

	test("a resume goes to the same thread with t3_thread_send and needs its own result", async () => {
		const seen: Context[] = [];
		const { details, text } = await runInT3(
			"const a = delegate({ target: { model: 'faux/faux-1' }, tools: ['read'], schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } });\nconst one = await a.run('first');\nconst two = await a.run('second');\nreturn JSON.stringify({ one, two });",
			(context) => {
				seen.push(context);
				const last = textOf(lastMessage(context).content);
				if (last.includes("first")) return call("submit_result", { n: 1 });
				if (last.includes("run 2")) return say("forgot");
				if (last.includes("Reminder 1")) return call("submit_result", { n: 2 });
				return say(lastMessage(context).role === "toolResult" && seen.length < 3 ? "one done" : "two done");
			},
		);
		assert.equal(details.status, "completed", details.error);
		const { one, two } = value(text);
		assert.deepEqual([one.result, two.result], [{ n: 1 }, { n: 2 }]);
		assert.deepEqual([one.text, two.text], ["one done", "two done"]);
		assert.equal(one.threadId, two.threadId);
		assert.equal(callsOf("delegate_task").length, 1);
		const [send] = callsOf("t3_thread_send");
		assert.equal(send!.args.threadId, one.threadId);
		assert.match(String(send!.args.message), /^harness-delegation: [\w-]+ run 2\n\nsecond$/);
		assert.deepEqual(toolNames(seen.at(-1)!), ["read", "submit_result"], "the spec still applies on the resume");
		assert.match(JSON.stringify(seen.at(-1)!.messages), /first.*second/, "the resume continues the conversation");
		assert.deepEqual(details.childSessions, [one.sessionId], "one child session");
	});

	test("parallel agents are parallel t3 tasks", async () => {
		let active = 0;
		let peak = 0;
		const { details, text } = await runInT3(
			"const out = await map(['a', 'b', 'c'], (n) => delegate({ target: { model: 'faux/faux-1' }, tools: ['read'], system: `You are agent ${n}.` }).run('go'), { concurrency: 3 });\nreturn JSON.stringify(out.map((r) => [r.text, r.threadId]));",
			async (context) => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 150));
				active--;
				return say(`${/You are agent (\w)/.exec(systemOf(context))![1]} done`);
			},
		);
		assert.equal(details.status, "completed", details.error);
		const out = value(text) as [string, string][];
		assert.deepEqual(out.map(([t]) => t), ["a done", "b done", "c done"]);
		assert.equal(new Set(out.map(([, thread]) => thread)).size, 3);
		assert.equal(peak, 3);
		assert.equal(details.childSessions.length, 3);
	});

	test("cost: the child sessions' cost per run, in total, and against the budget, which stops a child that overspends", async () => {
		const { details, text } = await runInT3(
			"const a = delegate({ target: { model: 'faux/faux-1' }, tools: ['read'] });\nconst one = await a.run('one');\nconst two = await a.run('two');\nreturn JSON.stringify({ one: one.cost, two: two.cost, total: a.cost, spent: budget.spent });",
			(context) => (lastMessage(context).role === "toolResult" ? say("done") : textOf(lastMessage(context).content).includes("one") ? call("read", { path: "README.md" }) : say("done")),
			{ childRuntime: priced(runtime, 0.25) },
		);
		assert.equal(details.status, "completed", details.error);
		const cost = value(text);
		assert.deepEqual(cost, { one: 0.5, two: 0.25, total: 0.75, spent: 0.75 });
		assert.equal(details.cost, 0.75);

		const over = await runInT3("await delegate({ target: { model: 'faux/faux-1' }, tools: ['bash'] }).run('loop');", async () => {
			await new Promise((r) => setTimeout(r, 200));
			return call("bash", { command: "true" });
		}, { childRuntime: priced(runtime, 0.4), budget: 1 });
		assert.equal(over.details.status, "over budget");
		assert.ok(callsOf("task_cancel").length >= 1, "the t3 task was cancelled");
		assert.ok(over.details.cost > 1 && over.details.cost < 2.5, `stopped soon after: ${over.details.cost}`);
	});

	test("cost: a delegate run that fails keeps what its child spent, in the journal, the page and a resume's total", async () => {
		const code = "await delegate({ target: { model: 'faux/faux-1' }, tools: ['read'], schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } }).run('x');";
		const { details } = await runInT3(code, () => say("no result"), { childRuntime: priced(runtime, 0.25) });
		assert.equal(details.status, "failed");
		const spent = 0.25 * (1 + MAX_REMINDERS);
		assert.equal(details.cost, spent);
		const journal = readJournal(join(runDir(fx.agentDir, details.id), "journal.jsonl"));
		const failed = journal.find((e) => e.t === "failed");
		assert.equal(failed?.t === "failed" && failed.cost, spent, "recorded with the failure");
		assert.equal(viewOf(journal).cost, spent, "the page counts it");
		// Resumed: the failed run runs again (outside t3 here, in-process) and fails the same way; both attempts' cost counts
		// (attempt 2 of the run on 2026-11-14 showed $1.82 of $12.81 when the failure's cost was not counted).
		const resumed = await resumeWorkflow({ id: details.id }, { cwd: fx.repo, runtime: priced(runtime, 0.25), agentDir: fx.agentDir, llmCache: new Map(), library: () => new Map() });
		assert.equal(resumed.details.status, "failed");
		assert.equal(resumed.details.retriedCalls, 1);
		assert.equal(resumed.details.replayedCalls, 0);
		assert.equal(resumed.details.cost, 2 * spent);
	});
});

/** A parent in "t3" whose model makes the given calls one after another, then says "parent done"; children answer with `child`. */
async function parentCalls(calls: { name: string; args: JsonObject }[], child: (context: Context) => AssistantMessage) {
	const parent = await newSession([workflowExtension(runtime), fakeT3(runtime, { waitMs: 5000 })]);
	const seen: Context[] = [];
	let next = 0;
	const dispatch: FauxResponseStep = (context) => {
		if (isChild(context)) return child(context);
		seen.push(context);
		const step = calls[next++];
		return step ? call(step.name, step.args) : say("parent done");
	};
	faux.setResponses(Array.from({ length: 30 }, () => dispatch));
	await parent.prompt("go");
	const results = parent.messages.flatMap((m) => (m.role === "toolResult" ? [{ name: m.toolName, text: textOf(m.content), isError: m.isError }] : []));
	return { parent, seen, results };
}

describe("a child's run that waits for its background jobs (workflow 20261116-072148-b6c213)", () => {
	const JOB = "job-1";
	const schema = "{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }";
	const code = `return JSON.stringify(await delegate({ target: { model: 'faux/faux-1' }, tools: ['read'], schema: ${schema} }).run('test it'));`;
	const sessionOf = (threadId: string) => fx.threads.get(threadId)!.session;
	/** A bash call of the child that moved to the background: pending work its run waits for. */
	const startJob = (threadId: string) =>
		sessionJobs(sessionOf(threadId).sessionId).jobs.set(JOB, { callId: JOB, toolName: "bash", input: { command: "pytest tests" }, startedAt: Date.now(), log: join(dir, "job.log"), controller: new AbortController() });
	/** The job ends after `ms`: it leaves the session's work, and its end wakes the child (a new t3 run). */
	const endJob = (threadId: string, ms: number) =>
		setTimeout(() => {
			sessionJobs(sessionOf(threadId).sessionId).jobs.delete(JOB);
			fx.wake!(threadId, "The tests passed.");
		}, ms);
	/** The child: starts the job and ends its turn waiting for it; woken by its end, submits and finishes. */
	const child = (onStart: () => void, wokenDelayMs = 0): FauxResponseStep => async (context) => {
		const last = lastMessage(context);
		if (last.role === "toolResult") return say("All green.");
		if (textOf(last.content).includes("The tests passed.")) {
			await new Promise((r) => setTimeout(r, wokenDelayMs));
			return call(SUBMIT_TOOL, { a: "green" });
		}
		onStart();
		return say("Waiting for pid 75262 (the tests).");
	};
	const backlog = () => join(dir, "harness-backlog.md");
	afterEach(() => {
		for (const thread of fx.threads.values()) sessionJobs(thread.session.sessionId).jobs.delete(JOB);
	});

	test("a turn that ends waiting for a job is no result: the run ends after the turn the job's end wakes, unreminded", async () => {
		const { details, text } = await runInT3(code, child(() => (startJob("thread-1"), endJob("thread-1", 400))));
		assert.equal(details.status, "completed", details.error);
		const run = value(text);
		assert.equal(run.text, "All green.", "not the waiting turn's text");
		assert.deepEqual(run.result, { a: "green" });
		const reminders = sessionOf("thread-1").messages.filter((m) => m.role === "custom" && m.customType === REMINDER_TYPE);
		assert.deepEqual(reminders, [], "a run waiting for its jobs is not reminded to submit");
		assert.ok(details.log.some((line) => /delegate 1 · waiting for its background work: bash: .*pytest tests/.test(line)), details.log.join("\n"));
		assert.equal(existsSync(backlog()), false, "no harness fault");
	});

	test("without a schema: the result is the woken turn's text, not the waiting turn's (\"Warte auf pid 75262\")", async () => {
		const plain = "return (await delegate({ target: { model: 'faux/faux-1' }, tools: ['read'] }).run('test it')).text;";
		const { details, text } = await runInT3(plain, (context) => {
			if (textOf(lastMessage(context).content).includes("The tests passed.")) return say("All green.");
			startJob("thread-1");
			endJob("thread-1", 400);
			return say("Waiting for pid 75262 (the tests).");
		});
		assert.equal(details.status, "completed", details.error);
		assert.equal(text.split("\n\n").at(-1), "All green.");
	});

	test("a woken turn that outlasts the report's lag is followed through t3 (its thread's latest run) until the run ends", async () => {
		const { details, text } = await runInT3(code, child(() => (startJob("thread-1"), endJob("thread-1", 10)), 2500));
		assert.equal(details.status, "completed", details.error);
		assert.deepEqual(value(text).result, { a: "green" });
		assert.ok(callsOf("t3_thread_wait").some((c) => c.args.runId === undefined), "followed the thread's latest run");
		assert.equal(existsSync(backlog()), false, "no harness fault");
	});

	test("a child whose process ended while it waited leaves no end: a harness fault, noted in the harness backlog with the run", async () => {
		const dead = spawnSync("true").pid!;
		const { details } = await runInT3(
			code,
			child(() => {
				startJob("thread-1");
				// Its Pi process ends while the job runs: the state's pid names a process that is gone.
				setTimeout(() => {
					const states = readdirSync(delegationsDir(fx.agentDir)).filter((f) => f.endsWith(".result.json"));
					const id = states[0]!.slice(0, -".result.json".length);
					writeState(delegationsDir(fx.agentDir), id, { ...readState(delegationsDir(fx.agentDir), id)!, pid: dead });
				}, 200);
			}),
		);
		assert.equal(details.status, "failed");
		assert.match(details.error ?? "", new RegExp(`HarnessFault: delegate 1: the child reported no end of run 1 \\(its state: run 1, not done, waiting for bash: .*pytest tests, pid ${dead} ended\\)`));
		const note = readFileSync(backlog(), "utf8");
		assert.match(note, /Harness fault, noted automatically by the workflow runtime: delegate 1: the child reported no end of run 1/);
		assert.match(note, new RegExp(`Workflow run ${details.id}; journal ${details.journal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	});
});

describe("a workflow that fails while children work, and its resume (workflow 20261119-151815-eac9a7)", () => {
	const JOB = "job-1";
	const backlog = () => join(dir, "harness-backlog.md");
	afterEach(() => {
		for (const thread of fx.threads.values()) sessionJobs(thread.session.sessionId).jobs.delete(JOB);
	});

	test("a sibling fails while a child waits for its background jobs: the child is cancelled and its missing report is no harness fault", async () => {
		const code = [
			"const waiting = delegate({ target: { model: 'faux/faux-1' }, tools: ['read'] }).run('test it');",
			"waiting.catch(() => undefined);",
			"await new Promise((r) => setTimeout(r, 600));",
			"throw new Error('a sibling failed');",
		].join("\n");
		const { details } = await runInT3(code, () => {
			// Its turn ends while its job runs on: the run waits for the job, which outlasts the workflow.
			sessionJobs(fx.threads.get("thread-1")!.session.sessionId).jobs.set(JOB, { callId: JOB, toolName: "bash", input: { command: "pytest tests" }, startedAt: Date.now(), log: join(dir, "job.log"), controller: new AbortController() });
			return say("I'm waiting for the study re-run (pid 57256).");
		});
		assert.equal(details.status, "failed");
		assert.match(details.error ?? "", /a sibling failed/);
		// What the aborted run does after the workflow's end (the fault was noted after a git snapshot).
		await new Promise((r) => setTimeout(r, 500));
		assert.equal(existsSync(backlog()), false, "no harness fault");
		assert.deepEqual([...new Set(callsOf("task_cancel").map((c) => c.args.taskId))], ["task-thread-1"], "the waiting child was cancelled with its workflow");
		const journal = readJournal(join(runDir(fx.agentDir, details.id), "journal.jsonl"));
		assert.equal(journal.filter((e) => e.t === "failed").length, 0, "the run stays in flight for a resume");
	});

	test("a resume runs a failed run again with a new request: the child gets the message, not t3's answer to the failed request", async () => {
		const parent = await newSession([workflowExtension(runtime), fakeT3(runtime)]);
		parent.setActiveToolsByName([...parent.getActiveToolNames(), "workflow"]);
		const code = "const a = delegate({ target: { model: 'faux/faux-1' }, tools: ['read'], schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } });\nawait a.run('first');\nreturn JSON.stringify((await a.run('second')).result);";
		let failing = true;
		let resumeId = "";
		const dispatch: FauxResponseStep = (context) => {
			const last = lastMessage(context);
			if (!isChild(context)) {
				if (last.role === "toolResult") return say("parent done");
				return textOf(last.content).includes("resume") ? call("workflow", { resume: resumeId }) : call("workflow", { code, budget: 5 });
			}
			if (last.role === "toolResult") return say("done");
			const text = textOf(last.content);
			if (text.endsWith("first")) return call(SUBMIT_TOOL, { n: 1 });
			// Run 2 fails (as the 429 did): no result, through both reminders.
			return failing ? say("no result") : call(SUBMIT_TOOL, { n: 2 });
		};
		faux.setResponses(Array.from({ length: 30 }, () => dispatch));
		await parent.prompt("go");
		const results = () => parent.messages.flatMap((m) => (m.role === "toolResult" && m.toolName === "workflow" ? [m] : []));
		const failed = results()[0]!.details as unknown as WorkflowDetails;
		assert.equal(failed.status, "failed");
		assert.match(failed.error ?? "", /delegate 1: it finished without calling submit_result/);

		failing = false;
		resumeId = failed.id;
		await parent.prompt("resume it");
		const second = results().at(-1)!;
		const resumed = second.details as unknown as WorkflowDetails;
		assert.equal(resumed.status, "completed", resumed.error);
		assert.deepEqual(value(textOf(second.content)), { n: 2 });
		assert.equal(resumed.retriedCalls, 1);
		const sends = callsOf("t3_thread_send").map((c) => String(c.args.clientRequestId));
		assert.equal(sends.length, 2, "run 2, then run 2 again");
		assert.notEqual(sends[0], sends[1], "a new request, which t3 does not answer with the failed run");
		const seen = fx.threads.get("thread-1")!.session.messages.filter((m) => m.role === "user" && textOf(m.content).endsWith("second"));
		assert.equal(seen.length, 2, "the child got run 2's message again");
		assert.equal(existsSync(backlog()), false, "no harness fault");
		const journal = readJournal(join(runDir(fx.agentDir, failed.id), "journal.jsonl"));
		const requests = journal.flatMap((e) => (e.t === "meta" && typeof e.data.requestId === "string" ? [e.data.requestId] : []));
		assert.deepEqual(requests.slice(-2), sends, "each request was recorded before it was sent");
	});
});

describe("t3's delegate_task as the harness extends it", () => {
	const schema = { type: "object", properties: { verdict: { type: "string", enum: ["ok", "bad"] } }, required: ["verdict"], additionalProperties: false };

	test("the model passes schema, system and tools: the tool declares them, t3 gets the prepared task, the child applies them, and the result comes back in the task's result", async () => {
		const childSeen: Context[] = [];
		const { seen, results } = await parentCalls(
			[
				{ name: `${T3_PREFIX}delegate_task`, args: { task: "Judge README.md", title: "judge", mode: "wait", schema, system: "You judge files.", tools: ["read"] } },
				{ name: `${T3_PREFIX}task_status`, args: { taskId: "task-thread-1" } },
			],
			(context) => {
				childSeen.push(context);
				return childSeen.length === 1 ? call("submit_result", { verdict: "ok" }) : say("Judged: fine.");
			},
		);
		const declared = seen[0]!.messages.flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []) : [])).find((t) => t.name === `${T3_PREFIX}delegate_task`)!;
		assert.deepEqual(Object.keys((declared.parameters as { properties: object }).properties).sort(), ["schema", "system", "template", "tools"], "the model sees the harness's parameters");
		const [delegated] = callsOf("delegate_task");
		assert.deepEqual(Object.keys(delegated!.args).sort(), ["mode", "task", "title"], "t3 gets its own arguments only");
		assert.match(String(delegated!.args.task), /^harness-delegation: [\w-]+\nDelegated by the harness: system prompt \(16 chars\); tools: read; returns its result with submit_result \(a JSON Schema\)\. When the plan no longer fits.*\n\nJudge README\.md$/);
		assert.match(systemOf(childSeen[0]!), /^You judge files\./);
		assert.deepEqual(toolNames(childSeen[0]!), ["read", "submit_result"]);
		const final = fx.threads.get("thread-1")!.session.messages.findLast((m) => m.role === "assistant")!;
		assert.equal(textOf(final.content), `Judged: fine.\n${RESULT_HEADING}{\n  "verdict": "ok"\n}\n\`\`\``, "the final message carries the result");
		const status = results.find((r) => r.name === `${T3_PREFIX}task_status`)!;
		assert.match(status.text, /Result \(submit_result\):\\n```json\\n\{\\n  \\"verdict\\": \\"ok\\"/, "the task's result has it");
		const spec = readSpec(delegationsDir(fx.agentDir), parseMarker(String(delegated!.args.task))!.id)!;
		assert.equal(readState(delegationsDir(fx.agentDir), spec.id)!.text, "Judged: fine.", "the run's own text stays without the result");
	});

	test("invalid harness arguments and a fork with target, system or tools are refused before t3 is called; plain t3 calls pass untouched", async () => {
		const { results } = await parentCalls(
			[
				{ name: `${T3_PREFIX}delegate_task`, args: { task: "x", fork: true, system: "s" } },
				{ name: `${T3_PREFIX}delegate_task`, args: { task: "x", fork: true, target: { model: MODEL } } },
				{ name: `${T3_PREFIX}delegate_task`, args: { task: "x", forkThreadId: "thread-9" } },
				{ name: `${T3_PREFIX}delegate_task`, args: { task: "x", schema: { type: "string" } } },
				{ name: `${T3_PREFIX}delegate_task`, args: { task: "plain", mode: "wait" } },
			],
			() => say("child done"),
		);
		const refused = results.filter((r) => r.isError).map((r) => r.text);
		assert.equal(refused.length, 4);
		assert.match(refused[0]!, /fork takes the source thread's provider, model, options, system prompt and tools: drop system/);
		assert.match(refused[1]!, /drop target/);
		assert.match(refused[2]!, /forkThreadId needs fork: true/);
		assert.match(refused[3]!, /schema must be a JSON Schema of an object/);
		assert.deepEqual(callsOf("delegate_task").map((c) => c.args), [{ task: "plain", mode: "wait" }], "only the plain call reached t3, unchanged");
	});
});

describe("the handle", () => {
	const BIG = "x".repeat(100_000);
	/** A child that answers with a long text (so the session can be compacted), and the compaction's summary. */
	const childAnswers = (log: string[]): FauxResponseStep => async (context, options) => {
		const all = JSON.stringify(context.messages);
		if (all.includes("keep the verdict")) return say("Summary: the verdict was ok.");
		const last = textOf(lastMessage(context).content);
		log.push(last.split("\n").at(-1)!);
		if (last.includes("slow")) {
			await new Promise((r) => setTimeout(r, 600));
			return lastMessage(context).role === "toolResult" ? say("slow done") : call("read", { path: "README.md" });
		}
		// The steering message comes after the tool result, as a user message.
		if (last.includes("also check the tests")) return say("steered done");
		if (lastMessage(context).role === "toolResult") return say("tool done");
		if (last.includes("wait forever")) {
			// Until the request is aborted (a stop), at most 5 s.
			await new Promise((r) => {
				setTimeout(r, 5000);
				options?.signal?.addEventListener("abort", r, { once: true });
			});
			return say("not stopped");
		}
		return say(`${last.split("\n").at(-1)} done ${BIG}`);
	};
	const script = [
		"const a = delegate({ target: { model: 'faux/faux-1' }, tools: ['read'] });",
		"const one = await a.run('first');",
		"await a.compact('keep the verdict');",
		"await a.warm('2h');",
		"const slow = a.run('slow');",
		"await new Promise((r) => setTimeout(r, 300));",
		"await a.steer('also check the tests');",
		"const two = await slow;",
		"const stopped = a.run('wait forever');",
		"await new Promise((r) => setTimeout(r, 300));",
		"await a.stop();",
		"const error = await stopped.then(() => 'not stopped', (e) => e.message);",
		"const fork = await a.fork('forked');",
		"return JSON.stringify({ one: one.text.slice(0, 10), two: two.text, error, fork: fork.text.slice(0, 11), forkThread: fork.threadId ?? null, sameThread: fork.threadId === a.threadId });",
	].join("\n");
	const compacted = (session: AgentSession) => session.sessionManager.getEntries().find((e) => e.type === "compaction") as { summary?: string } | undefined;

	test("in t3: compact sends Pi's /compact, steer reaches the running turn, stop cancels the task, fork forks the child's thread", async () => {
		const log: string[] = [];
		const { details, text } = await runInT3(script, childAnswers(log), { budget: 5 });
		assert.equal(details.status, "completed", details.error);
		const out = value(text);
		assert.deepEqual(out, { one: "first done", two: "steered done", error: "delegate 1: the run was stopped", fork: "forked done", forkThread: "thread-7", sameThread: false });
		const sends = callsOf("t3_thread_send").map((c) => [c.args.message, c.args.mode]);
		assert.deepEqual(sends[0], ["/compact keep the verdict", "queue"]);
		assert.deepEqual(sends[1], ["/warm 2h", "queue"], "Pi's /warm, as a message");
		assert.deepEqual(sends.find(([, mode]) => mode === "steer"), ["also check the tests", "steer"]);
		const source = fx.threads.get("thread-1")!.session;
		assert.match(compacted(source)?.summary ?? "", /Summary: the verdict was ok\./, "the child compacted");
		assert.ok(callsOf("task_cancel").some((c) => String(c.args.taskId).startsWith("task-thread-1")), "stop cancelled the task");
		const forkCall = callsOf("delegate_task").at(-1)!;
		assert.equal(forkCall.args.fork, true);
		assert.equal(forkCall.args.forkThreadId, "thread-1");
		assert.equal("target" in forkCall.args, false, "a fork takes its source's target");
		const forked = fx.threads.get("thread-7")!.session;
		assert.match(JSON.stringify(forked.messages), /also check the tests/, "the fork has the source's conversation");
		const journal = readJournal(details.journal);
		assert.ok(source.sessionManager.getEntries().some((e) => e.type === "custom" && e.customType === "harness-warm"), "the child holds its cache warm");
		assert.deepEqual(journal.flatMap((e) => (e.t === "start" ? [e.label] : [])), ["#1: first", "#1 compact: keep the verdict", "#1 warm: 2h", "#1 run 2: slow", "#1 steer: also check the tests", "#1 run 3: wait forever", "#1 stop", "#2: forked"]);
	});

	test("a compaction that does not happen fails compact(), in t3 and in-process", async () => {
		const code = "const a = delegate({ target: { model: 'faux/faux-1' }, tools: ['read'] });\nawait a.run('short');\nreturn await a.compact().then(() => 'compacted', (e) => e.message);";
		const inT3 = await runInT3(code, say("short answer"));
		assert.equal(inT3.details.status, "completed", inT3.details.error);
		assert.match(inT3.text.split("\n\n").at(-1)!, /^delegate 1: the compaction failed: Compaction failed: Nothing to compact \(session too small\)$/);
		faux.setResponses([say("short answer")]);
		const inProcess = await runWorkflow({ source: code, filename: INLINE_FILE, inline: true }, 1, { cwd: fx.repo, runtime, agentDir: fx.agentDir, llmCache: new Map(), library: () => new Map() });
		assert.match(inProcess.text.split("\n\n").at(-1)!, /Nothing to compact \(session too small\)/);
	});

	test("in-process: compact is Pi's compaction, steer and stop reach the session, fork is Pi's session fork", async () => {
		const log: string[] = [];
		faux.setResponses(Array.from({ length: 30 }, () => childAnswers(log)));
		const { details, text } = await runWorkflow({ source: script, filename: INLINE_FILE, inline: true }, 1, {
			cwd: fx.repo,
			runtime,
			agentDir: fx.agentDir,
			llmCache: new Map(),
			library: () => new Map(),
			sessionDir: fx.sessionsDir,
			parentSessionFile: join(fx.sessionsDir, "parent.jsonl"),
		});
		assert.equal(details.status, "completed", details.error);
		assert.deepEqual(value(text), { one: "first done", two: "steered done", error: "delegate 1: the run was stopped", fork: "forked done", forkThread: null, sameThread: true });
		assert.equal(details.childSessions.length, 2);
		const files = readdirSync(fx.sessionsDir).map((f) => readFileSync(join(fx.sessionsDir, f), "utf8"));
		const source = files.find((f) => f.includes(details.childSessions[0]!) && f.includes('"type":"compaction"'));
		assert.ok(source?.includes("Summary: the verdict was ok."), "the child compacted with the instructions");
		assert.ok(source?.includes('"customType":"harness-warm"'), "the child holds its cache warm");
		const forked = files.find((f) => f.split("\n")[0]!.includes(details.childSessions[1]!))!;
		assert.match(forked, /also check the tests/, "the fork has the source's conversation");
		assert.match(forked, /forked/);
	});
});

describe("questions go to the parent (onAsk)", () => {
	const QUESTION = {
		title: "The plan no longer fits: how do I go on?",
		options: [
			{ label: "continue", description: "as planned" },
			{ label: "replan", description: "rethink the remaining steps" },
			{ label: "stop", description: "report what is done" },
		],
	};
	/** A child that asks QUESTION on each new message, then reports the answer it got as its tool result. */
	const asking: FauxResponseStep = (context) => {
		const last = lastMessage(context);
		if (last.role === "toolResult" && last.toolName === "ask_user") return say(`got: ${textOf(last.content).split("Answer: ")[1]} (error: ${last.isError})`);
		return call("ask_user", { questions: [QUESTION] });
	};
	const askEntries = (journal: string) => readJournal(journal).filter((e) => (e.t === "start" && e.kind === "ask") || ((e.t === "done" || e.t === "failed") && e.key.startsWith("ask:")));

	test("in t3: onAsk's answers reach the child's blocking ask_user as its tool result, in the same run, journaled", async () => {
		const { details, text } = await runInT3(
			"const asked = [];\nconst a = delegate({ target: { model: 'faux/faux-1' }, tools: ['read', 'ask_user'], onAsk: async (questions) => { asked.push(questions); return [questions[0].options[1].label]; } });\nconst r = await a.run('do the task');\nreturn JSON.stringify({ text: r.text, asked });",
			asking,
		);
		assert.equal(details.status, "completed", details.error);
		const out = value(text);
		assert.equal(out.text, "got: replan (error: false)");
		assert.deepEqual(out.asked, [[{ id: "request-1:0", title: QUESTION.title, options: QUESTION.options }]]);
		assert.deepEqual(callsOf("t3_pending_request").map((c) => c.args.action), ["list", "read", "respond"]);
		assert.deepEqual(callsOf("t3_pending_request").at(-1)!.args, { action: "respond", threadId: "thread-1", requestId: "request-1", answers: { "request-1:0": "replan" } });
		assert.equal(callsOf("delegate_task").length, 1);
		assert.equal(callsOf("t3_thread_send").length, 0, "answered within the same run");
		const entries = askEntries(details.journal);
		assert.equal(entries.length, 2);
		assert.equal(entries[0]!.t === "start" && entries[0]!.label, `#1 asks: ${QUESTION.title}`);
		assert.deepEqual(entries[1]!.t === "done" && entries[1]!.value, { answers: ["replan"], by: "onAsk" });
	});

	test("in t3: undefined passes the question up unchanged (whoever answers it, the workflow does not), and a throw stops the run", async () => {
		let answered = false;
		const passedUp = runInT3(
			"let calls = 0;\nconst a = delegate({ target: { model: 'faux/faux-1' }, tools: ['ask_user'], onAsk: () => (calls++, undefined) });\nconst r = await a.run('do the task');\nreturn JSON.stringify({ text: r.text, calls });",
			asking,
		);
		// The parent thread's user answers it on the card, once the workflow passed it up.
		const until = async (ok: () => boolean) => {
			while (!ok()) await new Promise((r) => setTimeout(r, 20));
		};
		await until(() => callsOf("t3_pending_request").some((c) => c.args.action === "read"));
		await new Promise((r) => setTimeout(r, 200));
		const pending = fx.threads.get("thread-1")!.pending;
		assert.equal(pending.size, 1, "still pending");
		pending.get("request-1")!.answer(["continue"]);
		answered = true;
		const { details, text } = await passedUp;
		assert.ok(answered);
		assert.equal(details.status, "completed", details.error);
		assert.deepEqual(value(text), { text: "got: continue (error: false)", calls: 1 });
		assert.equal(callsOf("t3_pending_request").filter((c) => c.args.action === "respond").length, 0);
		const passed = askEntries(details.journal).at(-1)!;
		assert.deepEqual(passed.t === "done" && passed.value, { answers: null, by: "none" });

		fx.calls.length = 0;
		const thrown = await runInT3("await delegate({ target: { model: 'faux/faux-1' }, tools: ['ask_user'], onAsk: async () => { throw new Error('no plan B'); } }).run('do the task');", asking);
		assert.equal(thrown.details.status, "failed");
		assert.match(thrown.details.error!, /no plan B/);
		assert.ok(callsOf("task_cancel").length >= 1, "the child was stopped");
		assert.equal(askEntries(thrown.details.journal).at(-1)!.t, "failed");
	});

	test("in-process: onAsk answers the child's ask_user; a resume replays the journaled answer instead of asking again", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let asks = 0;
		faux.setResponses(
			Array.from({ length: 20 }, () => async (context: Context) => {
				const last = lastMessage(context);
				if (last.role === "toolResult" && last.toolName === "ask_user") {
					// The first run waits here until the workflow is stopped with its child; the resumed one goes on.
					if (++asks === 1) await gate;
					return say(`got: ${textOf(last.content).split("Answer: ")[1]}`);
				}
				return call("ask_user", { questions: [QUESTION] });
			}),
		);
		const env = { cwd: fx.repo, runtime, agentDir: fx.agentDir, llmCache: new Map(), library: () => new Map(), sessionDir: fx.sessionsDir, parentSessionFile: join(fx.sessionsDir, "parent.jsonl") };
		const code = "const a = delegate({ target: { model: 'faux/faux-1' }, tools: ['ask_user'], onAsk: async (questions) => { log('onAsk called'); return { [questions[0].id]: 'stop' }; } });\nreturn (await a.run('do the task')).text;";
		let id = "";
		const first = runWorkflow({ source: code, filename: INLINE_FILE, inline: true }, 1, { ...env, onStart: (run) => (id = run.id) });
		while (asks === 0) await new Promise((r) => setTimeout(r, 20));
		writeFileSync(join(runDir(fx.agentDir, id), STOP_FILE), JSON.stringify({ children: true }));
		const stopped = await first;
		release();
		assert.equal(stopped.details.status, "stopped");
		assert.match(stopped.details.log.join("\n"), /onAsk called/);
		const resumed = await resumeWorkflow({ id }, env);
		assert.equal(resumed.details.status, "completed", resumed.details.error);
		assert.equal(resumed.text.split("\n\n").at(-1), "got: stop");
		assert.doesNotMatch(resumed.details.log.join("\n"), /onAsk called/, "answered from the journal");
		assert.equal(asks, 2, "the child asked again after the resume");
		const entries = askEntries(resumed.details.journal);
		assert.equal(entries.filter((e) => e.t === "start").length, 1, "one question recorded, replayed");
	});

	test("in-process: without an answer from onAsk the question goes up to the workflow session's ask_user", async () => {
		faux.setResponses(Array.from({ length: 6 }, () => asking));
		const asked: unknown[] = [];
		const executeTool = async (name: string, args: unknown) => {
			asked.push({ name, args });
			return { value: "", structured: false, isError: false, text: "answered", details: { answers: ["from the user"] } };
		};
		const { details, text } = await runWorkflow({ source: "return (await delegate({ target: { model: 'faux/faux-1' }, tools: ['ask_user'] }).run('do the task')).text;", filename: INLINE_FILE, inline: true }, 1, {
			cwd: fx.repo,
			runtime,
			agentDir: fx.agentDir,
			llmCache: new Map(),
			library: () => new Map(),
			executeTool,
			toolNames: ["ask_user"],
		});
		assert.equal(details.status, "completed", details.error);
		assert.equal(text.split("\n\n").at(-1), "got: from the user (error: false)");
		assert.equal(asked.length, 1);
		assert.deepEqual(asked[0], { name: "ask_user", args: { questions: [QUESTION], wait_minutes: 35_000 } });
	});
});

describe("every tool as a typed, awaitable function", () => {
	test("signatures: compact types from JSON Schema, short descriptions only, ask_user and delegate_task special", () => {
		assert.equal(tsType({ type: "object", properties: { a: { type: "string" }, b: { type: "integer" }, c: { type: "array", items: { enum: ["x", "y"] } } }, required: ["a"] }), '{ a: string; b?: number; c?: ("x" | "y")[] }');
		assert.equal(tsType({ anyOf: [{ type: "string" }, { type: "null" }] }), "string | null");
		assert.equal(tsType({ type: ["string", "number"] }), "string | number");
		assert.equal(tsType({ const: "go" }), '"go"');
		assert.equal(tsType({ type: "object", properties: { deep: { type: "object", properties: { deeper: { type: "object", properties: { deepest: { type: "object", properties: { x: { type: "string" } } } } } } } } }), "{ deep?: { deeper?: { deepest?: object } } }", "three levels deep, then object");
		assert.equal(tsType({ type: "object" }), "Record<string, unknown>");
		assert.equal(tsType({ type: "object", properties: { "a-b": { type: "boolean" } }, required: ["a-b"] }), '{ "a-b": boolean }');
		const declaration = toolsDeclaration([
			{ name: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
			{ name: "mcp__t3-code__task_status", description: `${"A long description ".repeat(10)}.`, parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] }, outputSchema: { type: "object" } },
			{ name: "ask_user", description: "Ask.", parameters: { type: "object" } },
			{ name: `${T3_PREFIX}delegate_task`, description: "x", parameters: { type: "object" } },
		]);
		assert.equal(
			declaration,
			[
				"type CallOptions = { idempotent?: boolean };",
				"declare const tools: {",
				"\t/** Ask. */",
				"\task_user(args: Record<string, unknown>, options?: CallOptions): Promise<(string | undefined)[]>;",
				'\t"mcp__t3-code__delegate_task": typeof delegate;',
				'\t"mcp__t3-code__task_status"(args: { taskId: string }, options?: CallOptions): Promise<any>;',
				"\t/** Read a file. */",
				"\tread(args: { path: string }, options?: CallOptions): Promise<string>;",
				"};",
			].join("\n"),
		);
	});

	test("the workflow tool's description lists the session's tools with their signatures", async () => {
		let described = "";
		const parent = await newSession([workflowExtension(runtime), fakeT3(runtime)]);
		parent.setActiveToolsByName([...parent.getActiveToolNames(), "workflow"]);
		faux.setResponses([
			(context: Context) => {
				const tools = context.messages.flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []) : []));
				described = tools.find((t) => t.name === "workflow")?.description ?? "";
				return say("ok");
			},
		]);
		await parent.prompt("go");
		const readSignature = `\tread(args: ${tsType(createReadToolDefinition(".").parameters)}, options?: CallOptions): Promise<any>;`;
		assert.match(readSignature, /^\tread\(args: \{ path: string; offset\?: number; limit\?: number[;}]/);
		assert.ok(described.includes(`\t/** Read the contents of a file. */\n${readSignature}`), described);
		assert.match(described, /\tedit\(args: \{ path: string; edits: \{ oldText: string; newText: string \}\[\] \}, options\?: CallOptions\): Promise<string>;/);
		assert.match(described, /\t"mcp__t3-code__delegate_task": typeof delegate;/);
		assert.match(described, /\n\t"mcp__t3-code__t3_pending_request"\(args: Record<string, unknown>/, "no description that only repeats the name");
		assert.doesNotMatch(described, /\tworkflow\(/, "not the workflow tool itself");
		assert.doesNotMatch(described, /declare const tools: Record<string/, "the generic declaration is replaced");
		assert.ok(described.length < 12_000, `compact: ${described.length} chars`);
	});

	test("tools.ask_user resolves to the answers once they exist; t3's delegate_task is delegate()", async () => {
		const shown: { questions: ExtensionUIQuestion[] }[] = [];
		const ui = new Proxy(
			{
				questions: (questions: ExtensionUIQuestion[]) => {
					shown.push({ questions });
					return new Promise<(string | undefined)[]>((r) => setTimeout(() => r(["no", undefined]), 300));
				},
			} as Partial<ExtensionUIContext>,
			{ get: (target, name) => (name in target ? target[name as keyof typeof target] : () => undefined) },
		) as ExtensionUIContext;
		const parent = await newSession([workflowExtension(runtime), fakeT3(runtime), askUser], SessionManager.create(fx.repo, fx.sessionsDir), runtime, ui);
		parent.setActiveToolsByName([...parent.getActiveToolNames(), "workflow"]);
		const code = [
			"const answers = await tools.ask_user({ questions: [{ title: 'Go on?', options: [{ label: 'yes', description: 'keep going' }, { label: 'no' }] }, { title: 'Why?' }], wait_minutes: 0 });",
			"const handle = tools['mcp__t3-code__delegate_task']({ target: { model: 'faux/faux-1' }, tools: ['read'] });",
			"const run = await handle.run('say hi');",
			"return JSON.stringify({ answers, same: tools['mcp__t3-code__delegate_task'] === delegate, text: run.text, thread: handle.threadId });",
		].join("\n");
		faux.setResponses(
			Array.from({ length: 10 }, () => (context: Context) => {
				if (isChild(context)) return say("hi");
				return lastMessage(context).role === "toolResult" ? say("parent done") : call("workflow", { code, budget: 1 });
			}),
		);
		await parent.prompt("go");
		const result = parent.messages.find((m) => m.role === "toolResult" && m.toolName === "workflow");
		assert.ok(result?.role === "toolResult");
		const details = result.details as unknown as WorkflowDetails;
		assert.equal(details.status, "completed", details.error);
		assert.deepEqual(value(textOf(result.content)), { answers: ["no", null], same: true, text: "hi", thread: "thread-1" });
		assert.deepEqual(shown, [{ questions: [{ title: "Go on?", options: [{ label: "yes", description: "keep going" }, { label: "no" }] }, { title: "Why?" }] }], "one dialog; wait_minutes 0 does not stop the wait");
		const asked = readJournal(details.journal).find((e) => e.t === "start" && e.kind === "tool");
		assert.equal(asked?.t === "start" && asked.idempotent, true, "a resume may ask again");
	});
});

describe("delegate() without t3", () => {
	test("in-process: the same spec semantics (system prompt, tools, schema and its reminders, resume)", async () => {
		const seen: Context[] = [];
		faux.setResponses(
			Array.from({ length: 10 }, () => (context: Context) => {
				seen.push(context);
				const last = textOf(lastMessage(context).content);
				if (last.includes("first")) return say("no result yet");
				if (last.includes("Reminder 1")) return call("submit_result", { n: 1 });
				if (last.includes("run 2")) return call("submit_result", { n: 2 });
				return say("done");
			}),
		);
		const { details, text } = await runWorkflow(
			{
				source: "const a = delegate({ target: { model: 'faux/faux-1' }, system: 'You count.', tools: ['read', 'ls'], schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } });\nconst one = await a.run('first');\nconst two = await a.run('second');\nreturn JSON.stringify({ one, two });",
				filename: INLINE_FILE,
				inline: true,
			},
			1,
			{ cwd: fx.repo, runtime, agentDir: fx.agentDir, llmCache: new Map(), library: () => new Map() },
		);
		assert.equal(details.status, "completed", details.error);
		const { one, two } = value(text);
		assert.deepEqual([one.result, two.result], [{ n: 1 }, { n: 2 }]);
		assert.equal(one.threadId, undefined);
		assert.match(systemOf(seen[0]!), /^You count\./);
		assert.deepEqual(toolNames(seen[0]!), ["ls", "read", "submit_result"]);
		assert.match(firstUser(seen[0]!), /^harness-delegation: [\w-]+\nDelegated by the harness: system prompt/);
		assert.deepEqual(
			seen.map((c) => textOf(lastMessage(c).content).split("\n").at(-1)!.slice(0, 30)),
			["first", "This run's result is missing: ", "Result recorded. Finish with a", "second", "Result recorded. Finish with a"],
			"run 1: no result, reminded, submitted; run 2: submitted at once",
		);
		assert.deepEqual(readdirSync(delegationsDir(fx.agentDir)), []);

		const unknown = await runWorkflow({ source: "await delegate({ target: { model: 'faux/faux-1' }, tools: ['nope'] }).run('x');", filename: INLINE_FILE, inline: true }, 1, { cwd: fx.repo, runtime, agentDir: fx.agentDir, llmCache: new Map(), library: () => new Map() });
		assert.match(unknown.details.error!, /unknown tool nope/);
	});
});

describe("the child side", () => {
	test("the spec survives a restart of the child's Pi: it is read again from the session's first message", async () => {
		const agents = delegationsDir(fx.agentDir);
		const spec: DelegationSpec = { id: "restart-1", system: "You are restarted.", tools: ["read"], schema: { type: "object", properties: { k: { type: "string" } }, required: ["k"] } };
		writeSpec(agents, spec);
		const seen: Context[] = [];
		faux.setResponses(
			Array.from({ length: 6 }, () => (context: Context) => {
				seen.push(context);
				return lastMessage(context).role === "toolResult" ? say("ok") : call("submit_result", { k: `v${seen.length}` });
			}),
		);
		const manager = SessionManager.create(fx.repo, fx.sessionsDir);
		const first = await newSession([workflowExtension(runtime)], manager);
		await first.prompt(delegationMessage(spec, 1, "one"));
		assert.deepEqual(readState(agents, spec.id), { sessionId: first.sessionId, cost: 0, run: 1, done: true, pid: process.pid, submitted: true, result: { k: "v1" }, text: "ok" });
		const file = first.sessionManager.getSessionFile()!;
		first.dispose();

		const second = await newSession([workflowExtension(runtime)], SessionManager.open(file));
		await second.prompt(delegationMessage(spec, 2, "two"));
		assert.match(systemOf(seen[2]!), /^You are restarted\./);
		assert.deepEqual(toolNames(seen[2]!), ["read", "submit_result"]);
		assert.deepEqual(readState(agents, spec.id), { sessionId: second.sessionId, cost: 0, run: 2, done: true, pid: process.pid, submitted: true, result: { k: "v3" }, text: "ok" });
	});

	test("a session without a marker, or whose spec is gone, is left alone", async () => {
		const seen: Context[] = [];
		faux.setResponses([(context: Context) => (seen.push(context), say("a")), (context: Context) => (seen.push(context), say("b"))]);
		const plain = await newSession([workflowExtension(runtime)]);
		await plain.prompt("just a task");
		const orphan = await newSession([workflowExtension(runtime)]);
		await orphan.prompt("harness-delegation: gone-1\nDelegated by the harness.\n\nx");
		for (const context of seen) {
			assert.doesNotMatch(toolNames(context).join(","), /submit_result/);
			assert.ok(toolNames(context).includes("bash"), "the default tools");
		}
		assert.equal(existsSync(statePath(delegationsDir(fx.agentDir), "gone-1")), false, "no state for a spec that is gone");
	});
});

describe("durable agents in t3", () => {
	for (const variant of [
		{ name: "its run id known: the resume waits for that run", waitMs: 80, childMs: 600, idsKnown: true, childStarted: true, delegates: 1 },
		{ name: "its start in flight, the child started: the resume waits for the child's report without calling t3 again (t3 dedupes only per process)", waitMs: 5000, childMs: 2500, idsKnown: false, childStarted: true, delegates: 1 },
		{ name: "its start in flight, the child not started: the resume repeats delegate_task with the same clientRequestId", waitMs: 5000, childMs: 2500, idsKnown: false, childStarted: false, delegates: 2 },
	])
	test(`an agent in flight when the parent's session ended reattaches to the same t3 task when the session starts again; the result arrives once (${variant.name})`, async () => {
		const background = (await import("../extensions/background/index.ts")).default;
		const withBackground = (pi: ExtensionAPI) => background(pi, { logRoot: join(dir, "logs") });
		const code = "const run = await delegate({ target: { model: 'faux/faux-1' }, tools: ['read'] }).run('slow work');\nreturn 'agent said: ' + run.text;";
		let childRuns = 0;
		const parentSays: string[] = [];
		const dispatch: FauxResponseStep = async (context) => {
			if (firstUser(context).includes("harness-delegation:")) {
				childRuns++;
				await new Promise((r) => setTimeout(r, variant.childMs));
				return say("child finished");
			}
			const last = lastMessage(context);
			const text = textOf(last.content);
			const offered = /stopped when its Pi process ended:\n- (\d{8}-\d{6}-[0-9a-f]{6})/.exec(text);
			const reply = (line: string) => (parentSays.push(line), say(line));
			if (offered) return call("workflow", { resume: offered[1]! });
			if (last.role === "toolResult") return reply("parent waiting");
			if (text.includes("Workflow completed")) return reply(`parent got: ${text.split("\n\n").at(-1)}`);
			return call("workflow", { code, budget: 5 });
		};
		faux.setResponses(Array.from({ length: 30 }, () => dispatch));

		const extensions = () => [withBackground, workflowExtension(runtime), fakeT3(runtime, { waitMs: variant.waitMs })];
		const first = await newSession(extensions());
		first.setActiveToolsByName([...first.getActiveToolNames(), "workflow"]);
		await first.prompt("go");
		const journals = join(fx.agentDir, "workflows");
		const journalOf = () => (existsSync(journals) && readdirSync(journals)[0] ? join(journals, readdirSync(journals)[0]!, "journal.jsonl") : undefined);
		// The parent's Pi quits while the child works: after t3 answered with the run (variant 1), or while delegate_task waits.
		const ready = () => fx.threads.size > 0 && (!variant.idsKnown || readFileSync(journalOf()!, "utf8").includes('"runId"'));
		while (!ready()) await new Promise((r) => setTimeout(r, 20));
		await first.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const journal = journalOf()!;
		while (!readFileSync(journal, "utf8").includes('"t":"end"')) await new Promise((r) => setTimeout(r, 20));
		assert.match(readFileSync(journal, "utf8"), /"status":"interrupted"/);
		const file = first.sessionManager.getSessionFile()!;
		first.dispose();
		const spec = /"spec":\{"id":"([\w-]+)"/.exec(readFileSync(journal, "utf8"))![1]!;
		// As if the parent died before the child's Pi reported anything.
		if (!variant.childStarted) rmSync(statePath(delegationsDir(fx.agentDir), spec), { force: true });

		const second = await newSession(extensions(), SessionManager.open(file));
		const deadline = Date.now() + 15_000;
		while (!parentSays.some((line) => line.startsWith("parent got")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
		assert.deepEqual(parentSays.filter((line) => line.startsWith("parent got")), ["parent got: agent said: child finished"], "the result arrives once");
		assert.equal(fx.threads.size, 1, "no second task");
		assert.equal(childRuns, 1, "the child's run was not repeated");
		assert.equal(callsOf("t3_thread_send").length, 0, "no message was sent again");
		const delegates = callsOf("delegate_task");
		assert.equal(delegates.length, variant.delegates);
		assert.equal(new Set(delegates.map((d) => d.args.clientRequestId)).size, 1);
		if (variant.idsKnown) assert.ok(callsOf("t3_thread_wait").some((c) => c.args.runId === "run-2"), "waited for the recorded run");
		const entries = readFileSync(journal, "utf8");
		assert.match(entries, /"t":"attempt","n":2/);
		assert.match(entries, /"status":"completed"/);
		const runEntries = second.sessionManager.getEntries().flatMap((e) => (e.type === "custom" && e.customType === "workflow-run" ? [(e.data as { state: string }).state] : []));
		assert.deepEqual(runEntries, ["started", "ended", "offered", "started", "ended"]);
	});
});

describe("stopping a run and resuming it with edited code, in t3", () => {
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const until = async (what: string, ok: () => boolean, ms = 15_000) => {
		const deadline = Date.now() + ms;
		while (!ok()) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await sleep(20);
		}
	};
	const count = (name: string) => (existsSync(join(fx.repo, name)) ? readFileSync(join(fx.repo, name), "utf8").split("\n").filter(Boolean).length : 0);
	const journalOf = (id: string) => readJournal(join(fx.agentDir, "workflows", id, "journal.jsonl"));
	/** Gates still closed: released after each test, so its child runs end. */
	const closed: (() => void)[] = [];
	afterEach(() => {
		for (const release of closed.splice(0)) release();
	});

	/**
	 * A parent session in "t3" (background, workflow and fake t3 tools) whose model makes each
	 * `do <json>` prompt one workflow call and answers everything else with "ok"; a child whose task
	 * names a gate waits until it is released.
	 */
	async function parentInT3(t3Runs?: { adoptMs: number; log: { at: number; what: string }[] }) {
		const background = (await import("../extensions/background/index.ts")).default;
		/** As t3 sees the parent: a run from a turn's start (adopted `adoptMs` later) until Pi reports it settled. */
		let run = false;
		const parentRun = t3Runs
			? () => {
					if (run) t3Runs.log.push({ at: Date.now(), what: "start" });
					return run;
				}
			: undefined;
		const told: { role: string; text: string }[] = [];
		const gates = new Map<string, { open: Promise<void>; release: () => void; runs: number }>();
		const gate = (name: string) => {
			let release!: () => void;
			const open = new Promise<void>((resolve) => (release = resolve));
			closed.push(release);
			gates.set(name, { open, release, runs: 0 });
			return gates.get(name)!;
		};
		const dispatch: FauxResponseStep = async (context) => {
			const last = lastMessage(context);
			const text = textOf(last.content);
			if (firstUser(context).includes("harness-delegation:")) {
				if (last.role === "user" && text.includes("interrupted before it finished")) return say("continued");
				const name = [...gates.keys()].find((n) => firstUser(context).includes(n));
				if (!name) return say("child done");
				const g = gates.get(name)!;
				g.runs++;
				await g.open;
				return say(`${name} done`);
			}
			told.push({ role: last.role, text });
			if (last.role === "user" && text.startsWith("do ")) return call("workflow", JSON.parse(text.slice(3)) as JsonObject);
			return say("ok");
		};
		faux.setResponses(Array.from({ length: 200 }, () => dispatch));
		const parent = await newSession([(pi) => background(pi, { logRoot: join(dir, "logs") }), workflowExtension(runtime), fakeT3(runtime, parentRun ? { parentRun } : {})]);
		parent.setActiveToolsByName([...parent.getActiveToolNames(), "workflow"]);
		if (t3Runs) {
			parent.subscribe((event) => {
				if (event.type === "agent_start") setTimeout(() => (run = true), t3Runs.adoptMs);
				if (event.type === "agent_settled") run = false;
				if (event.type === "agent_start" || event.type === "agent_settled") t3Runs.log.push({ at: Date.now(), what: event.type });
			});
		}
		/** One workflow call; resolves to its tool result. */
		const act = async (args: Record<string, unknown>) => {
			await until("an idle parent", () => !parent.isStreaming);
			const before = parent.messages.length;
			await parent.prompt(`do ${JSON.stringify(args)}`);
			const result = parent.messages.slice(before).find((m) => m.role === "toolResult" && m.toolName === "workflow");
			return result?.role === "toolResult" ? textOf(result.content) : "";
		};
		const start = async (code: string) => /Workflow run (\d{8}-\d{6}-[0-9a-f]{6}) /.exec(await act({ code, budget: 5 }))![1]!;
		const message = async (pattern: RegExp) => {
			await until(`a message ${pattern}`, () => told.some((t) => pattern.test(t.text)));
			return told.find((t) => pattern.test(t.text))!.text;
		};
		return { told, gate, act, start, message, parent };
	}

	test("delegates started after the parent's turn ended: t3 refuses them (parent_not_active); one wake, they start in the woken turn, whose end waits for them; the run completes", async () => {
		const log: { at: number; what: string }[] = [];
		const { start, message, parent, told } = await parentInT3({ adoptMs: 150, log });
		const id = await start(
			[
				"await shell('sleep 1');",
				"const out = await Promise.all(Array.from({ length: 6 }, (_, i) => delegate({ target: { model: 'faux/faux-1' } }).run('task ' + i)));",
				"return out.map((r) => r.text).join(' | ');",
			].join("\n"),
		);
		const completed = await message(/Workflow completed/);
		assert.equal(completed.split("\n\n").at(-1), Array(6).fill("child done").join(" | "));
		const wakes = parent.messages.filter((m) => m.role === "custom" && m.customType === WAKE_MESSAGE);
		assert.equal(wakes.length, 1, "one wake for six refused starts");
		assert.ok(told.some((t) => t.text.includes("t3 starts a delegated agent only during a turn of this thread")), "the woken agent is told why");
		const refused = callsOf("delegate_task").length - 6;
		assert.ok(refused >= 6, `every start was refused first (${refused} refusals)`);
		assert.equal(fx.threads.size, 6, "each started once");
		// Turns: the one that started the workflow, the woken one (held until the starts are in), the one the result wakes.
		const starts = log.filter((e) => e.what === "start");
		assert.equal(starts.length, 6);
		const woken = log.findIndex((e) => e.what === "agent_start" && e.at > log.find((s) => s.what === "agent_settled")!.at);
		const wokenSettled = log.findIndex((e, i) => i > woken && e.what === "agent_settled");
		assert.ok(woken > 0 && wokenSettled > woken, JSON.stringify(log));
		assert.ok(starts.every((s) => log.indexOf(s) > woken && log.indexOf(s) < wokenSettled), "all six started in the woken turn, which settled only after them");
		const view = viewOf(journalOf(id));
		assert.deepEqual(view.calls.filter((c) => c.kind === "delegate").map((c) => c.status), Array(6).fill("done"));
		assert.equal(view.status, "completed");
	});

	test("a stop cuts off shell calls and keeps agents running, whose results are recorded; stopping a stopped or finished run fails clearly", async () => {
		const { gate, act, start, message } = await parentInT3();
		const slow = gate("slow work A");
		const id = await start(
			[
				"await shell('echo s >> shell-count');",
				"await tools.bash({ command: 'echo t >> tool-count' });",
				"const a = delegate({ target: { model: 'faux/faux-1' }, tools: ['read'] });",
				"const [one] = await Promise.all([a.run('slow work A'), shell('echo x >> cut; if [ ! -f go ]; then sleep 2; echo late >> late; fi')]);",
				"return 'result: ' + one.text;",
			].join("\n"),
		);
		await until("the agent and the shell call to run", () => slow.runs === 1 && count("cut") === 1);
		const stopped = await act({ stop: id });
		assert.match(stopped, new RegExp(`Stopped workflow run ${id}; its result arrives as a message\\. Continue it with workflow \\{ resume: "${id}" \\}, or with changed code`));
		const result = await message(/Workflow stopped/);
		assert.match(result, /1 delegate run keeps running; results are recorded when they end/);
		assert.match(result, /Cut off by the stop, may have taken effect partly: shell echo x >> cut;.*A resume asks whether to run them again \(inFlight\)/);
		assert.match(result, new RegExp(`workflow \\{ resume: "${id}", code: "…" \\}: calls the new code makes as before are answered from the journal.*Effects so far \\(commits, files\\) stay`));
		await sleep(2500);
		assert.equal(count("late"), 0, "the shell call's process group was killed");
		assert.equal(callsOf("task_cancel").length, 0, "the agent keeps running");
		const end = journalOf(id).findLast((e) => e.t === "end");
		assert.ok(end?.t === "end");
		assert.equal(end.status, "stopped");
		assert.equal(end.lingering?.length, 1);
		const agentKey = end.lingering![0]!;
		assert.match(agentKey, /^delegate:/);
		assert.equal(lockHeld(fx.agentDir, id), true, "the process waits for its agent");
		assert.match(await act({ stop: id }), /is stopped already; its agents still run: pass stopChildren: true to cancel them/);

		slow.release();
		await until("the agent's result in the journal", () => journalOf(id).some((e, i, all) => e.t === "done" && e.key === agentKey && i > all.indexOf(end)));
		await until("the run released", () => !lockHeld(fx.agentDir, id));
		assert.match(await act({ stop: id }), new RegExp(`workflow run ${id} is stopped already\\. Continue it with`));

		writeFileSync(join(fx.repo, "go"), "");
		await act({ resume: id, inFlight: "rerun" });
		const completed = await message(/Workflow completed/);
		assert.equal(completed.split("\n\n").at(-1), "result: slow work A done", "the result the agent recorded after the stop");
		assert.deepEqual([count("shell-count"), count("tool-count"), count("cut"), count("late")], [1, 1, 2, 0], "only the cut-off call ran again");
		assert.equal(slow.runs, 1, "the agent did not run again");
		assert.equal(callsOf("delegate_task").length, 1);
		assert.match(await act({ stop: id }), new RegExp(`workflow run ${id} already ended \\(completed\\); there is nothing to stop`));
		assert.match(await act({ stop: "20260101-000000-abcdef" }), /no workflow run 20260101-000000-abcdef/);
	});

	test("status lists the open delegates with title, thread and task id; steer reaches all running ones or those named, through t3", async () => {
		const { gate, act, start, message } = await parentInT3();
		const [a, b] = [gate("slow work A"), gate("slow work B")];
		const id = await start("const out = await Promise.all([delegate({ target: { model: 'faux/faux-1' }, title: 'Review A' }).run('slow work A'), delegate({ target: { model: 'faux/faux-1' } }).run('slow work B')]);\nreturn out.map((r) => r.text).join(' | ');");
		await until("both agents to run", () => a.runs === 1 && b.runs === 1);
		await until("both task ids recorded", () => journalOf(id).filter((e) => e.t === "meta" && typeof e.data.taskId === "string").length === 2);
		const status = parseYaml(await act({ status: id })) as { calls: { open: number }; delegates: Record<string, unknown>[] };
		assert.equal(status.calls.open, 2);
		const threadOf = (title: string) => fx.requests.get(String(callsOf("delegate_task").find((c) => c.args.title === title)!.args.clientRequestId))!.threadId;
		const [threadA, threadB] = [threadOf("Review A"), threadOf("workflow delegate 2: slow work B")];
		assert.notEqual(threadA, threadB);
		assert.deepEqual(status.delegates.map(({ seconds, ...rest }) => (assert.equal(typeof seconds, "number"), rest)), [
			{ call: "#1: slow work A", status: "running", title: "Review A", threadId: threadA, taskId: `task-${threadA}` },
			{ call: "#2: slow work B", status: "running", title: "workflow delegate 2: slow work B", threadId: threadB, taskId: `task-${threadB}` },
		]);
		const steers = () => callsOf("t3_thread_send").filter((c) => c.args.mode === "steer").map((c) => [c.args.threadId, c.args.message]);
		assert.match(await act({ steer: id, text: "only B: be brief", delegates: [threadB] }), new RegExp(`Workflow run ${id}: Steered 1 delegate: delegate 2 "workflow delegate 2: slow work B" \\(thread ${threadB}\\)\\.`));
		assert.match(await act({ steer: id, text: "everyone: cite lines" }), /Steered 2 delegates/);
		assert.match(await act({ steer: id, text: "x", delegates: ["review a"] }), /Steered 1 delegate: delegate 1 "Review A"/, "a title matches without case");
		assert.deepEqual(steers(), [[threadB, "only B: be brief"], [threadA, "everyone: cite lines"], [threadB, "everyone: cite lines"], [threadA, "x"]]);
		assert.match(await act({ steer: id, text: "x", delegates: ["Review C"] }), /No running delegate matches "Review C"; nothing was steered/);
		assert.match(await act({ steer: id }), /steer needs text/);
		assert.match(await act({ status: id, text: "x" }), /text and delegates go with steer/);
		assert.equal(steers().length, 4);
		a.release();
		b.release();
		const completed = await message(/Workflow completed/);
		assert.match(completed.split("\n\n").at(-1)!, /slow work A done \| slow work B done/);
		const ended = parseYaml(await act({ status: id })) as { status: string; delegates?: unknown };
		assert.equal(ended.status, "completed");
		assert.equal(ended.delegates, undefined, "no open delegate calls");
		assert.match(await act({ steer: id, text: "late" }), new RegExp(`workflow run ${id} already ended \\(completed\\)`));
	});

	test("stopChildren cancels the agents; a resume asks the stopped child to continue", async () => {
		const { gate, act, start, message } = await parentInT3();
		const slow = gate("slow work A");
		const id = await start("const one = await delegate({ target: { model: 'faux/faux-1' }, tools: ['read'] }).run('slow work A');\nreturn 'result: ' + one.text;");
		await until("the agent to run", () => slow.runs === 1);
		assert.match(await act({ stop: id, stopChildren: true }), new RegExp(`Stopped workflow run ${id} and cancelled its agents`));
		const result = await message(/Workflow stopped/);
		assert.doesNotMatch(result, /keeps running/);
		// The cancel goes out without waiting for t3.
		await until("the task cancelled", () => callsOf("task_cancel").length === 1);
		slow.release();
		const end = journalOf(id).findLast((e) => e.t === "end");
		assert.ok(end?.t === "end" && end.status === "stopped" && end.lingering === undefined);
		await until("the run released", () => !lockHeld(fx.agentDir, id));

		await act({ resume: id });
		const completed = await message(/Workflow completed/);
		assert.equal(completed.split("\n\n").at(-1), "result: continued");
		assert.match(String(callsOf("t3_thread_send")[0]?.args.message), /^harness-delegation: [\w-]+\n.*\n\nYour previous run was interrupted before it finished \(it was stopped, or a process ended\)/);
		assert.equal(callsOf("delegate_task").length, 1, "the same task");
	});

	test("resume with edited code: calls before the edit are not repeated, an unchanged agent in flight is adopted, a changed one is cancelled and runs anew; page and live view mark the edit", async () => {
		const { gate, act, start, message } = await parentInT3();
		const slowA = gate("slow work A");
		const slowB = gate("slow work B");
		const script = (taskB: string, marker: string) =>
			[
				"await shell('echo s >> shell-count');",
				"await tools.bash({ command: 'echo t >> tool-count' });",
				"const a = delegate({ target: { model: 'faux/faux-1' }, tools: ['read'] });",
				"const b = delegate({ target: { model: 'faux/faux-1' }, tools: ['read'], system: 'You are B.' });",
				`const [one, two] = await Promise.all([a.run('slow work A'), b.run('${taskB}')]);`,
				`await shell('echo ${marker} >> after');`,
				"return one.text + ' / ' + two.text;",
			].join("\n");
		const id = await start(script("slow work B", "v1"));
		await until("both agents to run", () => slowA.runs === 1 && slowB.runs === 1);
		await act({ stop: id });
		await message(/Workflow stopped/);

		const v2 = script("changed work B", "v2");
		assert.match(await act({ resume: id, code: v2 }), new RegExp(`Workflow run ${id} \\(resume 1\\)`));
		await sleep(300);
		assert.equal(callsOf("task_cancel").length, 0, "the old agent B runs until agent A, which may still bring recorded calls, settled");
		slowA.release();
		const completed = await message(/Workflow completed/);
		slowB.release();
		assert.equal(completed.split("\n\n").at(-1), "slow work A done / child done");
		assert.match(completed, /1 recorded call not used by the new code: delegate #2: slow work B/);
		assert.deepEqual([count("shell-count"), count("tool-count")], [1, 1], "shell and tool calls before the edit were not repeated");
		assert.equal(readFileSync(join(fx.repo, "after"), "utf8"), "v2\n", "the edited part ran live");
		assert.equal(slowA.runs, 1, "agent A was adopted, not run again");
		const delegates = callsOf("delegate_task");
		assert.equal(delegates.length, 3);
		assert.match(String(delegates[2]!.args.task), /changed work B/);
		const cancels = callsOf("task_cancel");
		assert.equal(cancels.length, 1, "the old agent B was cancelled");
		const oldB = delegates.find((d) => String(d.args.task).includes("slow work B"))!;
		assert.equal(cancels[0]!.args.taskId, `task-${fx.requests.get(String(oldB.args.clientRequestId))!.threadId}`);

		const journal = journalOf(id);
		const view = viewOf(journal);
		assert.deepEqual(view.calls.map((c) => [c.label.slice(0, 30), c.status, c.version]), [
			["echo s >> shell-count", "replayed", 1],
			['bash {"command":"echo t >> too', "replayed", 1],
			["#1: slow work A", "done", 1],
			["#2: slow work B", "unused", 1],
			["#2: changed work B", "done", 2],
			["echo v2 >> after", "done", 2],
		]);
		const marker = /<div class="edit-marker" data-version="2">new code from here · v2 <code>\w{12}<\/code><\/div>/;
		assert.match(renderWorkflow(journal), marker, "the page");
		assert.match(livePage(journal, id), marker, "the dashboard's live view");
	});
});

describe("templates", () => {
	/** A project template in the test repository: it reads README.md and has one example. */
	const writeRecipe = (model = MODEL) => {
		mkdirSync(join(fx.repo, ".pi", "templates"), { recursive: true });
		writeFileSync(join(fx.repo, ".pi", "templates", "review.md"), `---\nmodel: ${model}\nthinking: low\nread: README.md\n---\nYou review this repository.\n\n:::user\nReview x.\n:::\n:::assistant\nx is fine.\n:::\n`);
	};
	/** The child's context as the model saw it: roles and the first texts, without the prompt. */
	const conversation = (context: Context) => context.messages.filter((m) => m.role !== "system").map((m) => `${m.role}: ${textOf(m.content).split("\n")[0]}`);
	const TEMPLATE_HISTORY = ["user: You review this repository.", "assistant: ", "toolResult: hello", "assistant: I have read README.md.", "user: Review x.", "assistant: x is fine.", 'user: This is where the template "review" ends. The task follows.'];

	test("delegate_task with a template: t3 forks the template's session file on its model; the child starts with the template's history and is told which template, built when", async () => {
		writeRecipe();
		const childSeen: Context[] = [];
		const { seen, results } = await parentCalls([{ name: `${T3_PREFIX}delegate_task`, args: { task: "Review README.md", mode: "wait", template: "review", tools: ["read"] } }], (context) => {
			childSeen.push(context);
			return say("reviewed");
		});
		assert.equal(results[0]!.isError, false, results[0]!.text);
		const declared = seen[0]!.messages.flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []) : [])).find((t) => t.name === `${T3_PREFIX}delegate_task`)!;
		assert.match((declared.parameters as { properties: { template: { description: string } } }).properties.template.description, /Templates here: review\.$/);
		const [delegated] = callsOf("delegate_task");
		const file = join(fx.agentDir, "templates", "review");
		assert.ok(String(delegated!.args.forkSessionFile).startsWith(file), "t3 forks the built session file");
		assert.deepEqual(delegated!.args.target, { model: MODEL, options: { thinking: "low" } }, "the template's model and thinking");
		assert.equal(delegated!.args.template, undefined, "the name stays with the harness");
		assert.match(String(delegated!.args.task), /^harness-delegation: [\w-]+\nDelegated by the harness from template review \(built \d{4}-\d\d-\d\dT[\d:.]+Z; rebuilt now: it was not built yet\): tools: read\. When/);
		assert.deepEqual(conversation(childSeen[0]!).slice(0, -1), TEMPLATE_HISTORY);
		assert.match(conversation(childSeen[0]!).at(-1)!, /^user: You are a delegated undefined child\.$/);
		assert.match(textOf(lastMessage(childSeen[0]!).content), /Review README\.md$/);
		// The child's prompt leads its context, ahead of the template.
		assert.equal(childSeen[0]!.messages[0]!.role, "system");
		assert.deepEqual(toolNames(childSeen[0]!), ["read"]);
	});

	test("template refusals: with fork, with another target model, an unknown name", async () => {
		writeRecipe();
		const { results } = await parentCalls(
			[
				{ name: `${T3_PREFIX}delegate_task`, args: { task: "x", template: "review", fork: true } },
				{ name: `${T3_PREFIX}delegate_task`, args: { task: "x", template: "review", target: { model: "faux/other" } } },
				{ name: `${T3_PREFIX}delegate_task`, args: { task: "x", template: "nope" } },
			],
			() => say("child done"),
		);
		const refused = results.map((r) => r.text);
		assert.match(refused[0]!, /use one of template and fork/);
		assert.match(refused[1]!, /template review runs on faux\/faux-1 \(its turns belong to that model\): omit target\.model or pass faux\/faux-1/);
		assert.match(refused[2]!, /no template nope \(templates: review\)/);
		assert.deepEqual(callsOf("delegate_task"), [], "nothing reached t3");
	});

	test("delegate({ template }) in a workflow, in t3 and in-process: the same history, then the task", async () => {
		writeRecipe();
		const seen: Context[] = [];
		const { details } = await runInT3("return (await delegate({ template: 'review' }).run('Review a.ts')).text;", (context) => {
			seen.push(context);
			return say("t3 child done");
		});
		assert.equal(details.status, "completed", details.error);
		assert.deepEqual(conversation(seen[0]!).slice(0, TEMPLATE_HISTORY.length), TEMPLATE_HISTORY);
		assert.ok(String(callsOf("delegate_task")[0]!.args.forkSessionFile).endsWith("session.jsonl"));

		const inProcess: Context[] = [];
		faux.setResponses([
			(context: Context) => {
				inProcess.push(context);
				return say("in-process child done");
			},
		]);
		const run = await runWorkflow({ source: "return (await delegate({ template: 'review' }).run('Review b.ts')).text;", filename: INLINE_FILE, inline: true }, 1, { cwd: fx.repo, runtime, agentDir: fx.agentDir, llmCache: new Map(), library: () => new Map() });
		assert.equal(run.details.status, "completed", run.details.error);
		assert.deepEqual(conversation(inProcess[0]!).slice(0, TEMPLATE_HISTORY.length), TEMPLATE_HISTORY);
		assert.match(textOf(lastMessage(inProcess[0]!).content), /^harness-delegation: [\w-]+\nDelegated by the harness from template review \(built [^)]+\)\. When[\s\S]*Review b\.ts$/, "built already: no rebuild note");
		const bad = await runWorkflow({ source: "await delegate({ template: 'review', target: { model: 'faux/other' } }).run('x');", filename: INLINE_FILE, inline: true }, 1, { cwd: fx.repo, runtime, agentDir: fx.agentDir, llmCache: new Map(), library: () => new Map() });
		assert.match(bad.details.error!, /template review runs on faux\/faux-1/);
	});
});
