// agent() children through t3 and the delegation protocol (extensions/workflow/delegation.ts,
// child.ts, t3.ts): unit tests of the spec, marker, state and cleanup, then real Pi sessions with a
// faux model. A parent session runs the workflow extension and a fake t3 tool set whose
// delegate_task, t3_thread_send and t3_thread_wait run child Pi sessions in-process with the task,
// so the child side of the workflow extension runs for real, as in a t3 child.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { AssistantMessage, Context, JsonObject } from "@earendil-works/pi-ai";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_REMINDERS, REMINDER_TYPE } from "../extensions/workflow/child.ts";
import {
	type DelegationSpec,
	delegationMessage,
	delegationsDir,
	parseMarker,
	readSpec,
	readState,
	removeDelegation,
	specPath,
	specSummary,
	statePath,
	sweepDelegations,
	writeSpec,
	writeState,
} from "../extensions/workflow/delegation.ts";
import workflow from "../extensions/workflow/index.ts";
import { INLINE_FILE, runWorkflow, type WorkflowDetails } from "../extensions/workflow/run.ts";
import { nearestThinking, T3_PREFIX, t3Data } from "../extensions/workflow/t3.ts";
import { priced } from "./priced.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "delegation-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sweepRoot = () => mkdtempSync(join(dir, "sweep-"));
const SPEC: DelegationSpec = { id: "0b1c2d3e-aaaa-4bbb-8ccc-123456789abc", system: "x".repeat(1234), tools: ["read", "bash"], schema: { type: "object" }, files: ["src", "README.md"], callerSessionId: "parent-1" };

describe("spec, marker and state", () => {
	test("the first message: marker, readable summary, files, then the message; later runs: marker with the run", () => {
		assert.equal(
			delegationMessage(SPEC, 1, "Do it."),
			`harness-delegation: ${SPEC.id}\nStarted by a workflow script's agent(): system prompt (1.2k chars); tools: read, bash; returns its result with submit_result (a JSON Schema).\nChange only these files: src, README.md.\n\nDo it.`,
		);
		assert.equal(delegationMessage(SPEC, 3, "Again."), `harness-delegation: ${SPEC.id} run 3\n\nAgain.`);
		assert.equal(specSummary({ id: "a", system: "short", tools: ["read"] }), "Started by a workflow script's agent(): system prompt (5 chars); tools: read.");
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

	test("thinking maps to the closest level a t3 model offers; t3 data comes from structuredContent or JSON text", () => {
		const sonnet = ["low", "medium", "high", "xhigh", "max"];
		assert.equal(nearestThinking("medium", sonnet), "medium");
		assert.equal(nearestThinking("off", sonnet), "low");
		assert.equal(nearestThinking("minimal", sonnet), "low");
		assert.equal(nearestThinking("minimal", ["off", "low"]), "low", "a tie goes up");
		assert.equal(nearestThinking("high", ["custom"]), "high", "unknown levels: as asked");
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
const firstUser = (context: Context) => textOf(context.messages.find((m) => m.role === "user")?.content ?? "");
/** The last message that is not a system message (prompt and tool updates come as system messages). */
const lastMessage = (context: Context) => context.messages.findLast((m) => m.role !== "system")!;
/** The prompt's preamble (Pi's base prompt, or the custom one) after replaying the system messages. */
const systemOf = (context: Context) => {
	let preamble = "";
	for (const m of context.messages) if (m.role === "system" && m.sections && "preamble" in m.sections) preamble = m.sections.preamble ?? "";
	return preamble;
};

interface Fixture {
	repo: string;
	agentDir: string;
	sessionsDir: string;
	errors: string[];
	sessions: AgentSession[];
	/** Every fake t3 call: tool name and arguments. */
	calls: { name: string; args: Record<string, unknown> }[];
	/** The child sessions by thread. */
	threads: Map<string, { session: AgentSession; runs: Map<string, Promise<void>> }>;
	/** What t3 answered per clientRequestId: a repeated call gets the same task and run (t3 dedupes). */
	requests: Map<string, { threadId: string; runId: string }>;
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

const workflowExtension = (childRuntime: ModelRuntime) => (pi: ExtensionAPI) =>
	workflow(pi, { experimentsDir: join(dir, "experiments"), workflowDirs: () => [], modelRuntime: async () => childRuntime, agentDir: fx.agentDir });

async function newSession(extensions: ((pi: ExtensionAPI) => void)[], sessionManager = SessionManager.create(fx.repo, fx.sessionsDir), sessionRuntime = runtime): Promise<AgentSession> {
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({ cwd: fx.repo, agentDir: fx.agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, extensionFactories: extensions });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd: fx.repo, agentDir: fx.agentDir, model: sessionRuntime.getModel("faux", "faux-1"), modelRuntime: sessionRuntime, resourceLoader, sessionManager, settingsManager });
	await session.bindExtensions({ onError: (error) => fx.errors.push(`${error.event}: ${error.error}`) });
	fx.sessions.push(session);
	return session;
}

/** The t3 tools as the t3 MCP bridge registers them; each child is a real Pi session with the workflow extension. */
function fakeT3(childRuntime: ModelRuntime, options: { waitMs?: number } = {}) {
	const waitMs = options.waitMs ?? 80;
	let ids = 0;
	const finishedWithin = async (run: Promise<void>, ms: number) => Promise.race([run.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
	const start = (threadId: string, message: string) => {
		const thread = fx.threads.get(threadId)!;
		const runId = `run-${++ids}`;
		thread.runs.set(runId, thread.session.prompt(message));
		return runId;
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
		tool("orchestrator_capabilities", async () => ({
			providers: [
				{ providerInstanceId: "codex", driverKind: "codex", canRunChildTask: false, models: [] },
				{ providerInstanceId: "pi", driverKind: "pi", canRunChildTask: true, models: [{ id: MODEL, options: [{ id: "thinking", values: ["low", "medium", "high"] }] }] },
			],
		}));
		tool("delegate_task", async (args) => {
			const request = String(args.clientRequestId);
			let known = fx.requests.get(request);
			if (!known) {
				const threadId = `thread-${++ids}`;
				const session = await newSession([workflowExtension(childRuntime)], SessionManager.create(fx.repo, fx.sessionsDir), childRuntime);
				fx.threads.set(threadId, { session, runs: new Map() });
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
			const known = fx.requests.get(request) ?? { threadId: String(args.threadId), runId: start(String(args.threadId), String(args.message)) };
			fx.requests.set(request, known);
			return { threadId: known.threadId, runId: known.runId, taskId: `task-${known.threadId}-${ids}`, status: "running", delivery: "started" };
		});
		tool("t3_thread_wait", async (args) => {
			const thread = fx.threads.get(String(args.threadId))!;
			const done = await finishedWithin(thread.runs.get(String(args.runId))!, waitMs);
			return { threadId: args.threadId, runId: args.runId, status: done ? "completed" : "running", timedOut: !done };
		});
		tool("task_status", async (args) => ({ taskId: args.taskId, status: "completed", summary: "t3 summary" }));
		tool("task_cancel", async (args) => {
			for (const thread of fx.threads.values()) await thread.session.abort();
			return { taskId: args.taskId, status: "cancel_requested" };
		});
	};
}

/**
 * Run `code` as a workflow from a parent session in "t3": the parent's model calls the workflow tool
 * once, then answers; children answer with `child(context)`. Returns the tool result's details and text.
 */
async function runInT3(code: string, child: (context: Context) => AssistantMessage | Promise<AssistantMessage>, opts: { childRuntime?: ModelRuntime; budget?: number; signal?: AbortSignal } = {}) {
	const childRuntime = opts.childRuntime ?? runtime;
	const parent = await newSession([workflowExtension(runtime), fakeT3(childRuntime)]);
	parent.setActiveToolsByName([...parent.getActiveToolNames(), "workflow"]);
	const dispatch: FauxResponseStep = (context) => {
		if (!firstUser(context).includes("harness-delegation:")) return lastMessage(context).role === "toolResult" ? say("parent done") : call("workflow", { code, budget: opts.budget ?? 5 });
		return child(context);
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

describe("agent() in t3", () => {
	test("one run: the system prompt and tool subset apply in the child; title, role and target reach t3; files are cleaned up", async () => {
		let seen: Context | undefined;
		const { details, text } = await runInT3(
			"const a = agent({ model: 'faux/faux-1', system: 'You are the careful reviewer.', tools: ['read', 'grep'], files: ['src'], thinking: 'minimal' });\nreturn JSON.stringify(await a.run('Review README.md\\nin depth'));",
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
		assert.match(firstUser(seen!), /^You are a delegated research child\.\n\nharness-delegation: [\w-]+\nStarted by a workflow script's agent\(\): system prompt \(29 chars\); tools: read, grep\.\nChange only these files: src\.\n\nReview README\.md\nin depth$/);
		const [delegate] = callsOf("delegate_task");
		assert.equal(delegate!.args.title, "workflow agent " + /agent (\d+)/.exec(String(delegate!.args.title))![1] + ": Review README.md");
		assert.equal(delegate!.args.role, "research");
		assert.equal(delegate!.args.mode, "wait");
		assert.deepEqual(delegate!.args.target, { providerInstanceId: "pi", model: MODEL, options: { thinking: "low" } });
		assert.ok(callsOf("task_status").length >= 1, "the result is marked delivered");
		const childSession = fx.threads.get("thread-1")!.session;
		assert.deepEqual(details.childSessions, [childSession.sessionId]);
		assert.equal(run.sessionId, childSession.sessionId);
		assert.deepEqual(details.childThreads, ["t3://thread-1"]);
		assert.match(text, /Child threads: t3:\/\/thread-1/);
		assert.deepEqual(readdirSync(delegationsDir(fx.agentDir)), [], "spec and state are deleted when the workflow ends");
	});

	test("a slow child: the wait times out and continues with t3_thread_wait until the run is over", async () => {
		const { details, text } = await runInT3("return (await agent({ model: 'faux/faux-1', tools: ['read'] }).run('slow')).text;", async () => {
			await new Promise((r) => setTimeout(r, 300));
			return say("finally");
		});
		assert.equal(details.status, "completed", details.error);
		assert.equal(text.split("\n\n").at(-1), "finally");
		assert.ok(callsOf("t3_thread_wait").length >= 2, "waited more than once");
		assert.equal(callsOf("t3_thread_wait")[0]!.args.untilDelegatedWorkSettled, true);
	});

	test("an unknown tool fails the run before any request of the child", async () => {
		let childRequests = 0;
		const { details } = await runInT3("await agent({ model: 'faux/faux-1', tools: ['read', 'nope', 'zap'] }).run('x');", () => {
			childRequests++;
			return say("never");
		});
		assert.equal(details.status, "failed");
		assert.match(details.error!, /agent \d+: unknown tools nope, zap; this session has .*\bread\b/);
		assert.equal(childRequests, 0);
	});

	test("schema: a wrong shape goes back to the child as an error; the fixed result arrives as an object", async () => {
		const seen: Context[] = [];
		const { details, text } = await runInT3(
			"const a = agent({ model: 'faux/faux-1', tools: ['read'], schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['ok', 'bad'] }, score: { type: 'number' } }, required: ['verdict', 'score'], additionalProperties: false } });\nreturn JSON.stringify(await a.run('Judge it'));",
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
		const { details } = await runInT3("await agent({ model: 'faux/faux-1', tools: ['read'], schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } }).run('x');", (context) => {
			seen.push(context);
			return say(`no result ${seen.length}`);
		});
		assert.equal(details.status, "failed");
		assert.match(details.error!, new RegExp(`agent \\d+: it finished without calling submit_result \\(reminded ${MAX_REMINDERS} times\\)`));
		assert.equal(seen.length, 1 + MAX_REMINDERS);
		assert.match(JSON.stringify(lastMessage(seen[1]!)), /Reminder 1 of 2/);
		assert.match(JSON.stringify(lastMessage(seen[2]!)), /Reminder 2 of 2/);
		const reminders = fx.threads.get("thread-1")!.session.sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === REMINDER_TYPE);
		assert.equal(reminders.length, MAX_REMINDERS);
	});

	test("a resume goes to the same thread with t3_thread_send and needs its own result", async () => {
		const seen: Context[] = [];
		const { details, text } = await runInT3(
			"const a = agent({ model: 'faux/faux-1', tools: ['read'], schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } });\nconst one = await a.run('first');\nconst two = await a.run('second');\nreturn JSON.stringify({ one, two });",
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
		assert.match(systemOf(seen.at(-1)!), /You are an agent started by a workflow script/, "the spec still applies on the resume");
		assert.match(JSON.stringify(seen.at(-1)!.messages), /first.*second/, "the resume continues the conversation");
		assert.deepEqual(details.childSessions, [one.sessionId], "one child session");
	});

	test("parallel agents are parallel t3 tasks", async () => {
		let active = 0;
		let peak = 0;
		const { details, text } = await runInT3(
			"const out = await map(['a', 'b', 'c'], (n) => agent({ model: 'faux/faux-1', tools: ['read'], system: `You are agent ${n}.` }).run('go'), { concurrency: 3 });\nreturn JSON.stringify(out.map((r) => [r.text, r.threadId]));",
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
			"const a = agent({ model: 'faux/faux-1', tools: ['read'] });\nconst one = await a.run('one');\nconst two = await a.run('two');\nreturn JSON.stringify({ one: one.cost, two: two.cost, total: a.cost, spent: budget.spent });",
			(context) => (lastMessage(context).role === "toolResult" ? say("done") : textOf(lastMessage(context).content).includes("one") ? call("read", { path: "README.md" }) : say("done")),
			{ childRuntime: priced(runtime, 0.25) },
		);
		assert.equal(details.status, "completed", details.error);
		const cost = value(text);
		assert.deepEqual(cost, { one: 0.5, two: 0.25, total: 0.75, spent: 0.75 });
		assert.equal(details.cost, 0.75);

		const over = await runInT3("await agent({ model: 'faux/faux-1', tools: ['bash'] }).run('loop');", async () => {
			await new Promise((r) => setTimeout(r, 200));
			return call("bash", { command: "true" });
		}, { childRuntime: priced(runtime, 0.4), budget: 1 });
		assert.equal(over.details.status, "over budget");
		assert.ok(callsOf("task_cancel").length >= 1, "the t3 task was cancelled");
		assert.ok(over.details.cost > 1 && over.details.cost < 2.5, `stopped soon after: ${over.details.cost}`);
	});
});

describe("agent() without t3", () => {
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
				source: "const a = agent({ model: 'faux/faux-1', system: 'You count.', tools: ['read', 'ls'], schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } });\nconst one = await a.run('first');\nconst two = await a.run('second');\nreturn JSON.stringify({ one, two });",
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
		assert.match(firstUser(seen[0]!), /^harness-delegation: [\w-]+\nStarted by a workflow script's agent\(\)/);
		assert.deepEqual(
			seen.map((c) => textOf(lastMessage(c).content).split("\n").at(-1)!.slice(0, 30)),
			["first", "This run's result is missing: ", "Result recorded. Finish with a", "second", "Result recorded. Finish with a"],
			"run 1: no result, reminded, submitted; run 2: submitted at once",
		);
		assert.deepEqual(readdirSync(delegationsDir(fx.agentDir)), []);

		const unknown = await runWorkflow({ source: "await agent({ model: 'faux/faux-1', tools: ['nope'] }).run('x');", filename: INLINE_FILE, inline: true }, 1, { cwd: fx.repo, runtime, agentDir: fx.agentDir, llmCache: new Map(), library: () => new Map() });
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
		assert.deepEqual(readState(agents, spec.id), { sessionId: first.sessionId, cost: 0, run: 1, done: true, submitted: true, result: { k: "v1" }, text: "ok" });
		const file = first.sessionManager.getSessionFile()!;
		first.dispose();

		const second = await newSession([workflowExtension(runtime)], SessionManager.open(file));
		await second.prompt(delegationMessage(spec, 2, "two"));
		assert.match(systemOf(seen[2]!), /^You are restarted\./);
		assert.deepEqual(toolNames(seen[2]!), ["read", "submit_result"]);
		assert.deepEqual(readState(agents, spec.id), { sessionId: second.sessionId, cost: 0, run: 2, done: true, submitted: true, result: { k: "v3" }, text: "ok" });
	});

	test("a session without a marker, or whose spec is gone, is left alone", async () => {
		const seen: Context[] = [];
		faux.setResponses([(context: Context) => (seen.push(context), say("a")), (context: Context) => (seen.push(context), say("b"))]);
		const plain = await newSession([workflowExtension(runtime)]);
		await plain.prompt("just a task");
		const orphan = await newSession([workflowExtension(runtime)]);
		await orphan.prompt("harness-delegation: gone-1\nStarted by a workflow script's agent(): …\n\nx");
		for (const context of seen) {
			assert.doesNotMatch(toolNames(context).join(","), /submit_result/);
			assert.ok(toolNames(context).includes("bash"), "the default tools");
		}
		assert.equal(existsSync(statePath(delegationsDir(fx.agentDir), "gone-1")), false, "no state for a spec that is gone");
	});
});

describe("durable agents in t3", () => {
	for (const variant of [
		{ name: "its run id known: the resume waits for that run", waitMs: 80, childMs: 600, delegates: 1 },
		{ name: "its start still in flight: the resume repeats delegate_task with the same clientRequestId, which t3 dedupes", waitMs: 5000, childMs: 2500, delegates: 2 },
	])
	test(`an agent in flight when the parent's session ended reattaches to the same t3 task when the session starts again; the result arrives once (${variant.name})`, async () => {
		const background = (await import("../extensions/background/index.ts")).default;
		const withBackground = (pi: ExtensionAPI) => background(pi, { logRoot: join(dir, "logs") });
		const code = "const run = await agent({ model: 'faux/faux-1', tools: ['read'] }).run('slow work');\nreturn 'agent said: ' + run.text;";
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
		const ready = () => fx.threads.size > 0 && (variant.delegates === 2 || readFileSync(journalOf()!, "utf8").includes('"runId"'));
		while (!ready()) await new Promise((r) => setTimeout(r, 20));
		await first.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const journal = journalOf()!;
		while (!readFileSync(journal, "utf8").includes('"t":"end"')) await new Promise((r) => setTimeout(r, 20));
		assert.match(readFileSync(journal, "utf8"), /"status":"interrupted"/);
		const file = first.sessionManager.getSessionFile()!;
		first.dispose();

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
		if (variant.delegates === 1) assert.ok(callsOf("t3_thread_wait").some((c) => c.args.runId === "run-2"), "waited for the recorded run");
		const entries = readFileSync(journal, "utf8");
		assert.match(entries, /"t":"attempt","n":2/);
		assert.match(entries, /"status":"completed"/);
		const runEntries = second.sessionManager.getEntries().flatMap((e) => (e.type === "custom" && e.customType === "workflow-run" ? [(e.data as { state: string }).state] : []));
		assert.deepEqual(runEntries, ["started", "ended", "offered", "started", "ended"]);
	});
});
