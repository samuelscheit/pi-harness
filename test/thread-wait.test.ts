// The guard against an idle re-wait on a t3 thread (extensions/thread-wait): the rule on synthetic
// branches (every edge of "no other tool call and no message since"), then real Pi sessions (faux
// model) where the hook refuses the repeat, lets a wait through after other work or a message, and
// leaves a script's own wait slices alone.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRuntime, type SessionEntry, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import threadWait from "../extensions/thread-wait/index.ts";
import { idleRewait, isThreadWait, ownChildWait, timedOutWaits } from "../extensions/thread-wait/wait.ts";

const WAIT = "mcp__t3-code__t3_thread_wait";
const TIMED_OUT = { threadId: "thread:a", runId: "run:1", status: "completed", timedOut: true };

let n = 0;
let at = 0;
const assistant = (...calls: { id: string; name: string; args?: Record<string, unknown> }[]): SessionEntry =>
	({ type: "message", id: `e${++n}`, parentId: null, timestamp: "", message: { role: "assistant", content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args ?? {} })), timestamp: (at += 1000) } }) as unknown as SessionEntry;
const result = (id: string, toolName: string, data: unknown, isError = false): SessionEntry =>
	({ type: "message", id: `e${++n}`, parentId: null, timestamp: "", message: { role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }], isError, timestamp: (at += 1000) } }) as unknown as SessionEntry;
const message = (role: "user" | "custom", text: string): SessionEntry => ({ type: "message", id: `e${++n}`, parentId: null, timestamp: "", message: { role, content: [{ type: "text", text }], timestamp: (at += 1000) } }) as unknown as SessionEntry;
/** A wait call and its result. */
const waited = (id: string, args: Record<string, unknown>, data: unknown, toolName = WAIT, isError = false): SessionEntry[] => [assistant({ id, name: toolName, args }), result(id, toolName, data, isError)];
const NOW = () => at + 120_000;

describe("isThreadWait", () => {
	test("t3's wait under either bridge name, nothing else", () => {
		assert.equal(isThreadWait("mcp__t3-code__t3_thread_wait"), true);
		assert.equal(isThreadWait("mcp__t3_code__t3_thread_wait"), true);
		assert.equal(isThreadWait("mcp__t3-code__t3_thread_read"), false);
		assert.equal(isThreadWait("t3_thread_wait"), false);
		assert.equal(isThreadWait("mcp__other__t3_thread_wait"), false);
		assert.equal(isThreadWait("mcp__t3-code__task_status"), false);
	});
});

describe("ownChildWait", () => {
	const DELEGATED = { taskId: "node:t1", childThreadId: "thread:child", link: "[Port the kernel](t3-thread://v2/x/thread:child)", status: "running", next: "Completion wakes this thread." };
	const delegated = (data: unknown = DELEGATED, tool = "mcp__t3-code__delegate_task") => [assistant({ id: `d${++n}`, name: tool }), result(`d${n}`, tool, data)];

	test("refuses a wait on the session's own delegated child, naming the task, why, and `goal wait`", () => {
		const reason = ownChildWait(delegated(), { threadId: "thread:child", timeoutMs: 3_600_000 })!;
		assert.match(reason, /^Refused: thread thread:child is your own delegated child \(task node:t1, delegated task: Port the kernel\)\. Its run's end wakes you .* t3 ends a t3_thread_wait after 60 minutes at most/);
		assert.match(reason, /call `goal` with action `wait` naming `task node:t1` \(or the child's thread id/);
		assert.match(reason, /without a goal, end your turn with one line/);
		assert.match(reason, /task_status with taskId thread:child\.$/);
	});

	test("the child stays the session's after its task ended, and after a follow-up started a new task; the newest running task is named", () => {
		const branch = [...delegated(), message("user", "Delegated task node:t1 (Port the kernel) [completed]: half")];
		assert.match(ownChildWait(branch, { threadId: "thread:child" })!, /\(task node:t1, /, "an ended task: its child's runs still wake the session");
		const followUp = [...branch, ...delegated({ threadId: "thread:child", taskId: "node:t2", status: "running", delivery: "started" }, "mcp__t3-code__t3_thread_send")];
		assert.match(ownChildWait(followUp, { threadId: "thread:child", runId: "run:9" })!, /\(task node:t2, delegated task: Port the kernel\)/, "a send's task, also with a runId");
		assert.match(ownChildWait(delegated({ taskId: "node:t3", childThreadId: "thread:asks", status: "running", hasPendingQuestion: true }), { threadId: "thread:asks", untilDelegatedWorkSettled: true })!, /task node:t3/, "a child waiting on a question");
	});

	test("other threads, a send to a thread no task owns, failed or foreign results and malformed calls are not refused", () => {
		const branch = delegated();
		assert.equal(ownChildWait(branch, { threadId: "thread:other" }), undefined);
		assert.equal(ownChildWait(branch, { threadId: "node:t1" }), undefined, "a task id is no thread (t3's wait takes threads)");
		assert.equal(ownChildWait(branch, {}), undefined);
		assert.equal(ownChildWait(branch, null), undefined);
		assert.equal(ownChildWait([], { threadId: "thread:child" }), undefined);
		assert.equal(ownChildWait(delegated({ threadId: "thread:top", status: "running", delivery: "started" }, "mcp__t3-code__t3_thread_send"), { threadId: "thread:top" }), undefined, "a top-level thread: its end wakes no one");
		assert.equal(ownChildWait([assistant({ id: "x", name: "mcp__t3-code__delegate_task" }), result("x", "mcp__t3-code__delegate_task", DELEGATED, true)], { threadId: "thread:child" }), undefined, "a failed start");
		assert.equal(ownChildWait(delegated(DELEGATED, "bash"), { threadId: "thread:child" }), undefined, "another tool's output");
	});
});

describe("idleRewait", () => {
	beforeEach(() => {
		at = 1_000_000;
	});

	test("refuses the same wait again after a timeout, naming the last result, how long ago, and what to do", () => {
		const branch = waited("c1", { threadId: "thread:a", timeoutMs: 21_600_000 }, { ...TIMED_OUT, timeout: { capped: true }, thread: { status: "completed", holding: ["task t1 (N6): running", "a", "b", "c"] }, note: "timeoutMs 21600000 is above the server maximum of 3600000 ms." });
		const reason = idleRewait(branch, { threadId: "thread:a", timeoutMs: 21_600_000 }, NOW())!;
		assert.match(reason, /^Refused: you waited on thread thread:a 2 min ago, the wait timed out \(status completed, held by task t1 \(N6\): running; a; b; and 1 more\. t3 said: timeoutMs 21600000 is above the server maximum of 3600000 ms\.\), and you made no other tool call and received no message since\./);
		assert.match(reason, /Change the approach:/);
		assert.match(reason, /t3_thread_read, or task_status/);
		assert.match(reason, /ask the user/, "without `next`, the agent may have nothing left: it says so or asks");
		assert.match(reason, /allowed again after any other tool call or new message\.$/);
	});

	test("with `next` the advice is to end the turn", () => {
		const branch = waited("c1", { threadId: "thread:a" }, { ...TIMED_OUT, status: "running", next: "Completion wakes this thread, so end your turn." });
		assert.match(idleRewait(branch, { threadId: "thread:a" }, NOW())!, /completion wakes you \(`next` was set\): end your turn/);
	});

	test("no earlier wait, a settled one, an unrelated tool: nothing to refuse", () => {
		assert.equal(idleRewait([], { threadId: "thread:a" }, NOW()), undefined);
		assert.equal(idleRewait(waited("c1", { threadId: "thread:a" }, { ...TIMED_OUT, timedOut: false }), { threadId: "thread:a" }, NOW()), undefined, "the earlier wait returned its result");
		assert.equal(idleRewait(waited("c1", { threadId: "thread:a" }, "not json {"), { threadId: "thread:a" }, NOW()), undefined);
		assert.equal(idleRewait(waited("c1", { threadId: "thread:a" }, TIMED_OUT, WAIT, true), { threadId: "thread:a" }, NOW()), undefined, "an error is no timeout");
		assert.equal(idleRewait(waited("c1", { threadId: "thread:a" }, TIMED_OUT), { threadId: undefined }, NOW()), undefined, "a call without a thread is t3's to refuse");
		assert.equal(idleRewait(waited("c1", { threadId: "thread:a" }, TIMED_OUT), null, NOW()), undefined);
	});

	test("any other tool call, or any message, lets the wait through", () => {
		const timedOut = waited("c1", { threadId: "thread:a" }, TIMED_OUT);
		for (const between of [
			[assistant({ id: "c2", name: "bash", args: { command: "ls" } }), result("c2", "bash", "ok")],
			[assistant({ id: "c2", name: "mcp__t3-code__t3_thread_read", args: { threadId: "thread:a" } }), result("c2", "mcp__t3-code__t3_thread_read", {})],
			[assistant({ id: "c2", name: "goal", args: { action: "wait" } }), result("c2", "goal", "ok")],
			[result("c2", "bash", "a result without its call in view")],
			[message("user", "how is it going?")],
			[message("custom", "Delegated task t1 [completed]")],
		]) {
			assert.equal(idleRewait([...timedOut, ...between], { threadId: "thread:a" }, NOW()), undefined, JSON.stringify(between[0]).slice(0, 80));
		}
		// Waiting on, or reading, another thread is not other work on this one... but a tool call is a tool call.
		assert.equal(idleRewait([...timedOut, ...waited("c2", { threadId: "thread:b" }, { ...TIMED_OUT, threadId: "thread:b" })], { threadId: "thread:a" }, NOW()) !== undefined, true, "a wait on another thread is no work");
	});

	test("another wait in between does not lift the refusal of the first; a tool call after both does", () => {
		const a = waited("c1", { threadId: "thread:a" }, TIMED_OUT);
		const b = waited("c2", { threadId: "thread:b" }, { ...TIMED_OUT, threadId: "thread:b" });
		assert.ok(idleRewait([...a, ...b], { threadId: "thread:a" }, NOW()));
		assert.ok(idleRewait([...a, ...b], { threadId: "thread:b" }, NOW()));
		assert.equal(idleRewait([...a, ...b], { threadId: "thread:c" }, NOW()), undefined, "a thread not waited on yet");
		assert.equal(idleRewait([...a, ...b, assistant({ id: "c3", name: "read" }), result("c3", "read", "x")], { threadId: "thread:a" }, NOW()), undefined);
	});

	test("waits issued together in one message: a plain tool call beside them is work, so none of them is idle", () => {
		const parallel = [
			assistant({ id: "c1", name: WAIT, args: { threadId: "thread:a" } }, { id: "c2", name: WAIT, args: { threadId: "thread:b" } }),
			result("c1", WAIT, TIMED_OUT),
			result("c2", WAIT, { ...TIMED_OUT, threadId: "thread:b" }),
		];
		assert.ok(idleRewait(parallel, { threadId: "thread:a" }, NOW()));
		assert.ok(idleRewait(parallel, { threadId: "thread:b" }, NOW()));
		const withWork = [
			assistant({ id: "c1", name: WAIT, args: { threadId: "thread:a" } }, { id: "c2", name: "bash", args: { command: "npm test" } }),
			result("c1", WAIT, TIMED_OUT),
			result("c2", "bash", "ok"),
		];
		assert.equal(idleRewait(withWork, { threadId: "thread:a" }, NOW()), undefined);
	});

	test("a settled wait closes the refusal: the next wait after a timeout then a result is fine, and a later timeout opens it again", () => {
		const branch = [...waited("c1", { threadId: "thread:a" }, TIMED_OUT), ...waited("c2", { threadId: "thread:a" }, { ...TIMED_OUT, timedOut: false }), ...waited("c3", { threadId: "thread:a" }, TIMED_OUT)];
		assert.ok(idleRewait(branch, { threadId: "thread:a" }, NOW()));
		assert.equal(idleRewait(branch.slice(0, 4), { threadId: "thread:a" }, NOW()), undefined);
	});

	test("the target decides: runId, untilDelegatedWorkSettled, environment and thread", () => {
		const timeouts = (args: Record<string, unknown>, data: Record<string, unknown> = TIMED_OUT) => waited("c1", args, data);
		const refused = (branch: SessionEntry[], call: Record<string, unknown>) => idleRewait(branch, call, NOW()) !== undefined;
		// No runId: the latest run, again.
		assert.ok(refused(timeouts({ threadId: "thread:a" }), { threadId: "thread:a" }));
		assert.ok(!refused(timeouts({ threadId: "thread:a" }), { threadId: "thread:a", runId: "run:9" }), "a named run is not the latest the earlier wait followed");
		assert.ok(refused(timeouts({ threadId: "thread:a" }), { threadId: "thread:a", runId: "run:1" }), "the run the result reported is the same wait");
		// A runId: the same one, or the one the result followed; not the latest.
		assert.ok(refused(timeouts({ threadId: "thread:a", runId: "run:5" }, { ...TIMED_OUT, runId: "run:6" }), { threadId: "thread:a", runId: "run:5" }));
		assert.ok(refused(timeouts({ threadId: "thread:a", runId: "run:5" }, { ...TIMED_OUT, runId: "run:6" }), { threadId: "thread:a", runId: "run:6" }), "t3 follows a restart or a moved message to its run");
		assert.ok(!refused(timeouts({ threadId: "thread:a", runId: "run:5" }, { ...TIMED_OUT, runId: "run:6" }), { threadId: "thread:a" }));
		assert.ok(!refused(timeouts({ threadId: "thread:a", runId: "run:5" }), { threadId: "thread:a", runId: "run:7" }));
		// The condition: a plain wait on a settled run returns at once.
		assert.ok(!refused(timeouts({ threadId: "thread:a", untilDelegatedWorkSettled: true }), { threadId: "thread:a" }));
		assert.ok(!refused(timeouts({ threadId: "thread:a" }), { threadId: "thread:a", untilDelegatedWorkSettled: true }));
		assert.ok(refused(timeouts({ threadId: "thread:a", untilDelegatedWorkSettled: true }), { threadId: "thread:a", untilDelegatedWorkSettled: true }));
		assert.ok(refused(timeouts({ threadId: "thread:a", untilDelegatedWorkSettled: true }), { threadId: "thread:a", untilDelegatedWorkSettled: true, timeoutMs: 5 }), "another timeout is the same wait");
		// Environment and thread.
		assert.ok(!refused(timeouts({ threadId: "thread:a" }), { threadId: "thread:a", environmentId: "env:2" }));
		assert.ok(refused(timeouts({ threadId: "thread:a", environmentId: "env:2" }), { threadId: "thread:a", environmentId: "env:2" }));
		assert.ok(!refused(timeouts({ threadId: "thread:a" }), { threadId: "thread:b" }));
	});

	test("the canonical bridge name counts as the same tool", () => {
		const branch = waited("c1", { threadId: "thread:a" }, TIMED_OUT, "mcp__t3_code__t3_thread_wait");
		assert.ok(idleRewait(branch, { threadId: "thread:a" }, NOW()));
		assert.equal(timedOutWaits(branch).length, 1);
	});

	test("a branch with other entries (custom, compaction) between is read through; a compaction summary message resets", () => {
		const branch = [...waited("c1", { threadId: "thread:a" }, TIMED_OUT), { type: "custom", id: "x", parentId: null, timestamp: "", customType: "harness-goal", data: null } as unknown as SessionEntry];
		assert.ok(idleRewait(branch, { threadId: "thread:a" }, NOW()), "a bookkeeping entry is not work");
		assert.equal(idleRewait([...branch, message("user", "continue")], { threadId: "thread:a" }, NOW()), undefined);
	});
});

// ---- Real sessions ----

let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
let dir: string;
const open: AgentSession[] = [];
before(async () => {
	faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	runtime = await ModelRuntime.create({ authPath: join(mkdtempSync(join(tmpdir(), "thread-wait-runtime-")), "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "faux-1", name: "Faux", api: faux.api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8000 }],
	});
});
after(() => faux.unregister());
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "thread-wait-"));
	mkdirSync(join(dir, "repo"));
});
afterEach(() => {
	for (const session of open.splice(0)) session.dispose();
	rmSync(dir, { recursive: true, force: true });
});

/** The wait tool as t3 answers it: a timeout, and `slices` (what a script's nested waits call). */
function fakeT3(pi: ExtensionAPI, calls: string[]) {
	const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: {} });
	pi.registerTool({
		name: WAIT,
		label: "t3_thread_wait",
		description: "Wait for a thread.",
		parameters: Type.Object({ threadId: Type.String(), runId: Type.Optional(Type.String()), untilDelegatedWorkSettled: Type.Optional(Type.Boolean()) }),
		execute: async (_id, params) => {
			calls.push(params.threadId);
			return json({ threadId: params.threadId, runId: "run:1", status: "running", timedOut: true, note: "still running" });
		},
	});
	pi.registerTool({
		name: "script",
		label: "script",
		description: "A script that waits in slices, as a workflow does.",
		parameters: Type.Object({}),
		execute: async (_id, _params, signal, _update, ctx) => {
			for (let i = 0; i < 3; i++) await ctx.executeTool(WAIT, { threadId: "thread:script" }, { signal });
			return json({ slices: 3 });
		},
	});
	pi.registerTool({ name: "work", label: "work", description: "Other work.", parameters: Type.Object({}), execute: async () => json("done") });
	pi.registerTool({
		name: "mcp__t3-code__delegate_task",
		label: "delegate_task",
		description: "Start a child.",
		parameters: Type.Object({ task: Type.String() }),
		execute: async () => json({ taskId: "node:t1", childThreadId: "thread:script", link: "[Port](t3-thread://v2/x/thread:script)", status: "running", next: "Completion wakes this thread." }),
	});
}

async function newSession(calls: string[]): Promise<AgentSession> {
	const cwd = join(dir, "repo");
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, extensionFactories: [threadWait, (pi: ExtensionAPI) => fakeT3(pi, calls)] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir: dir, model: runtime.getModel("faux", "faux-1"), modelRuntime: runtime, resourceLoader, sessionManager: SessionManager.create(cwd, join(dir, "sessions")), settingsManager });
	await session.bindExtensions({ onError: (error) => assert.fail(`${error.event}: ${error.error}`) });
	open.push(session);
	return session;
}

const call = (name: string, args: Parameters<typeof fauxToolCall>[1] = {}) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const respond = (...steps: FauxResponseStep[]) => faux.setResponses(steps);
const toolTexts = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "toolResult" ? [`${m.isError ? "error: " : ""}${typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join("")}`] : []));

describe("the guard in a real session", () => {
	test("the repeat of a timed-out wait is refused and never reaches t3; other work or a message lifts it", async () => {
		const calls: string[] = [];
		const s = await newSession(calls);
		respond(
			call(WAIT, { threadId: "thread:a" }),
			call(WAIT, { threadId: "thread:a" }),
			call(WAIT, { threadId: "thread:a" }),
			call(WAIT, { threadId: "thread:b" }),
			call("work"),
			call(WAIT, { threadId: "thread:a" }),
			fauxAssistantMessage("done"),
		);
		await s.prompt("wait");
		const texts = toolTexts(s);
		assert.match(texts[0]!, /"timedOut":true/);
		assert.match(texts[1]!, /^error: Refused: you waited on thread thread:a .*the wait timed out \(status running\. t3 said: still running\)/);
		assert.match(texts[2]!, /^error: Refused/, "asking again changes nothing");
		assert.match(texts[3]!, /"threadId":"thread:b"/, "another thread is its own wait");
		assert.match(texts[5]!, /"threadId":"thread:a"/, "after other work");
		assert.deepEqual(calls, ["thread:a", "thread:b", "thread:a"], "refused calls never ran");

		// A new message (the user's, a notification) lifts it as well.
		respond(call(WAIT, { threadId: "thread:a" }), fauxAssistantMessage("again"));
		await s.prompt("it finished, look");
		assert.deepEqual(calls, ["thread:a", "thread:b", "thread:a", "thread:a"]);
	});

	test("a wait on the session's own delegated child is refused and never reaches t3; a script's wait on it is its own", async () => {
		const calls: string[] = [];
		const s = await newSession(calls);
		respond(call("mcp__t3-code__delegate_task", { task: "Port it." }), call(WAIT, { threadId: "thread:script", timeoutMs: 3_600_000 }), call("script"), fauxAssistantMessage("done"));
		await s.prompt("delegate and wait");
		assert.match(toolTexts(s)[1]!, /^error: Refused: thread thread:script is your own delegated child \(task node:t1, delegated task: Port\)/);
		assert.deepEqual(calls, ["thread:script", "thread:script", "thread:script"], "only the script's slices ran");
	});

	test("a script's own waits (a workflow's slices) are no repeats, and do not count as the model's", async () => {
		const calls: string[] = [];
		const s = await newSession(calls);
		respond(call("script"), call(WAIT, { threadId: "thread:script" }), call(WAIT, { threadId: "thread:script" }), fauxAssistantMessage("done"));
		await s.prompt("run it");
		assert.deepEqual(calls, ["thread:script", "thread:script", "thread:script", "thread:script"], "three slices and the model's own first wait");
		assert.match(toolTexts(s).at(-1)!, /^error: Refused/, "the model's second wait right after its first is refused");
	});

	test("the refusal survives a reload: the rule reads the branch", async () => {
		const calls: string[] = [];
		const s = await newSession(calls);
		respond(call(WAIT, { threadId: "thread:a" }), fauxAssistantMessage("waiting"));
		await s.prompt("wait");
		const provider = (await import("@earendil-works/pi-ai/compat")).getApiProvider(faux.api);
		await s.reload();
		if (!(await import("@earendil-works/pi-ai/compat")).getApiProvider(faux.api)) (await import("@earendil-works/pi-ai/compat")).registerApiProvider(provider as never);
		assert.ok(idleRewait(s.sessionManager.getBranch(), { threadId: "thread:a" }, Date.now()), "the timeout is still on the branch");
	});
});
