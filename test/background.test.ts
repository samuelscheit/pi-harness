// Background calls (extensions/background): the messages and the session state, then real Pi
// sessions (faux model) with a slow custom tool: every long tool call the model makes moves to the
// background and its end wakes the session; nested calls, aborts, the session's end, reloads,
// images and background work behave as for bash (test/bash.test.ts covers bash's own parts).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, getApiProvider, registerApiProvider, registerFauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai/compat";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import background from "../extensions/background/index.ts";
import { callLabel, detachedText, finishedContent, finishedText, JOB_MESSAGE_TYPE, type Job, sessionJobs } from "../extensions/background/jobs.ts";

const job = (overrides: Partial<Job> = {}): Job => ({
	callId: "c1",
	toolName: "workflow",
	input: { code: "return 1", budget: 1 },
	startedAt: 0,
	log: "/tmp/c1.log",
	controller: new AbortController(),
	...overrides,
});

describe("messages and state", () => {
	test("a call is named by its tool and its arguments: a lone string as is, else JSON, clipped", () => {
		assert.equal(callLabel("bash", { command: "make\n  all" }), "`bash` call `make all`");
		assert.equal(callLabel("workflow", { code: "return 1", budget: 1 }), '`workflow` call `{"code":"return 1","budget":1}`');
		assert.equal(callLabel("ls", {}), "`ls` call `{}`");
		const long = callLabel("t", { a: "x".repeat(500), b: 1 });
		assert.ok(long.length < 220 && long.endsWith("…`"), long);
	});

	test("a detached call names why, its process group and how to stop it when it has one, its log and the tail of its output", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
		const byTime = detachedText(job({ pgid: 42 }), "time", lines, 125_000);
		assert.match(byTime, /^It still ran after 2 min 5 s, so the call moved to the background and keeps running \(process group 42; stop it with `kill -- -42`\)\. Its latest output is in \/tmp\/c1\.log\./);
		assert.match(byTime, /do not wait or poll for it/);
		assert.match(byTime, /\[… 10 earlier lines in the log\]\nline 11\n/);
		assert.match(byTime, /line 30$/);
		assert.doesNotMatch(byTime, /line 10\n/);
		const byMessage = detachedText(job(), "message", "  \n", 3000);
		assert.match(byMessage, /^A new message arrived while it ran, so the call moved to the background and keeps running\. /);
		assert.match(byMessage, /No output so far\.$/);
		assert.equal(
			detachedText(job(), "start", " \n", 0),
			"`workflow` always runs in the background: the call started and keeps running. Its latest output is in /tmp/c1.log.\n\nWhen it ends, its result reaches you as a new message, also after your turn has ended: do not wait or poll for it. Do the work that does not depend on it, or end your turn.",
		);
		assert.match(detachedText(job(), "start", "Run 1 · live view http://x", 0), /end your turn\.\n\nRun 1 · live view http:\/\/x$/, "what the call reported at its start comes along");
	});

	test("a job's end names the call, how it ended and its result; images come along", () => {
		const text = (result: object) => finishedText(job(), { result: result as never }, 61_000);
		assert.equal(text({ content: [{ type: "text", text: "ok" }] }), 'Your background `workflow` call `{"code":"return 1","budget":1}` (call c1) finished after 1 min 1 s:\n\nok');
		assert.match(text({ content: [{ type: "text", text: "boom" }], isError: true, structuredContent: { exit_code: 2 } }), /failed with exit code 2 after 1 min 1 s:\n\nboom$/);
		assert.match(text({ content: [], isError: true }), /failed after 1 min 1 s:\n\n\(no output\)$/);
		assert.match(finishedText(job(), { error: new Error("timed out") }, 90_000), /failed after 1 min 30 s:\n\ntimed out$/);
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		assert.deepEqual(finishedContent("t", { result: { content: [{ type: "text", text: "x" }, image], details: undefined } }), [{ type: "text", text: "t" }, image]);
		assert.equal(finishedContent("t", { error: new Error("x") }), "t");
	});

	test("session state made by an older release gets the fields a newer one added, and keeps its own", () => {
		const all = ((globalThis as { __harnessJobs?: Map<string, unknown> }).__harnessJobs ??= new Map());
		const jobs = new Map([["c1", { callId: "c1" }]]);
		all.set("old-session", { calls: new Map(), foreground: new Map(), jobs, api: undefined });
		try {
			const state = sessionJobs("old-session");
			assert.equal(state.jobs, jobs, "existing state stays");
			assert.ok(state.leftovers instanceof Map);
			assert.ok("poll" in state);
			assert.equal(sessionJobs("old-session").leftovers, state.leftovers, "filled in once");
		} finally {
			all.delete("old-session");
		}
	});
});

// A 1×1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const DETACH_MS = 400;

interface SlowCall {
	signal: AbortSignal | undefined;
	ended: boolean;
}

let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
let dir: string;
const open: AgentSession[] = [];
const extensionErrors: string[] = [];
/** Calls of the slow tool, by call id. */
const slowCalls = new Map<string, SlowCall>();

before(async () => {
	faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	const scratch = mkdtempSync(join(tmpdir(), "bgc-runtime-"));
	runtime = await ModelRuntime.create({ authPath: join(scratch, "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "faux-1", name: "Faux", api: faux.api, reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8000 }],
	});
});
after(() => faux.unregister());
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "bgc-"));
	slowCalls.clear();
});
afterEach(async () => {
	assert.deepEqual(extensionErrors.splice(0), [], "no extension errors");
	for (const session of open.splice(0)) {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
	rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("slow: aborted"))), { once: true });
	});

/** `slow` sleeps `ms` (stopping on its signal's abort) after a progress update; `caller` runs `slow` through ctx.executeTool. */
function tools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "slow",
		label: "slow",
		description: "Sleeps.",
		parameters: Type.Object({ ms: Type.Number(), text: Type.String(), image: Type.Optional(Type.Boolean()) }),
		async execute(id, params, signal, onUpdate) {
			const call: SlowCall = { signal, ended: false };
			slowCalls.set(id, call);
			onUpdate?.({ content: [{ type: "text", text: `progress of ${params.text}` }], details: undefined });
			await sleep(params.ms, signal);
			call.ended = true;
			return { content: [{ type: "text", text: `slept: ${params.text}` }, ...(params.image ? [{ type: "image" as const, data: PNG, mimeType: "image/png" }] : [])], details: { text: params.text } };
		},
	});
	pi.registerTool({
		name: "caller",
		label: "caller",
		description: "Runs slow from a script.",
		parameters: Type.Object({ ms: Type.Number() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const outcome = await ctx.executeTool("slow", { ms: params.ms, text: "nested" });
			return { content: outcome.result.content, details: undefined };
		},
	});
}

async function newSession(backgroundTools: readonly string[] = []): Promise<AgentSession> {
	const cwd = mkdtempSync(join(dir, "repo-"));
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: dir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		extensionFactories: [(pi: ExtensionAPI) => background(pi, { detachAfterMs: DETACH_MS, logRoot: join(dir, "logs"), backgroundTools }), tools],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: dir,
		model: runtime.getModel("faux", "faux-1"),
		modelRuntime: runtime,
		resourceLoader,
		sessionManager: SessionManager.create(cwd, join(dir, "sessions")),
		settingsManager,
	});
	await session.bindExtensions({ onError: (error) => extensionErrors.push(`${error.event}: ${error.error}`) });
	open.push(session);
	return session;
}

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const slow = (ms: number, text: string, image?: boolean) => call("slow", image ? { ms, text, image } : { ms, text });
const respond = (...steps: FauxResponseStep[]) => faux.setResponses(steps);
const textOf = (content: string | readonly { type: string; text?: string }[]) => (typeof content === "string" ? content : content.map((c) => c.text ?? "").join(""));
const toolTexts = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "toolResult" ? [textOf(m.content)] : []));
const reports = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "custom" && m.customType === JOB_MESSAGE_TYPE ? [m] : []));
const jobsOf = (s: AgentSession) => sessionJobs(s.sessionManager.getSessionId()).jobs;
const settled = (s: AgentSession, reply: string) => () => !s.isStreaming && s.messages.at(-1)?.role === "assistant" && JSON.stringify(s.messages.at(-1)).includes(reply);
async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}
function workEvents(s: AgentSession): number[] {
	const seen: number[] = [];
	s.subscribe((event) => {
		if (event.type === "background_work") seen.push(event.pending);
	});
	return seen;
}
const onlyCall = () => {
	assert.equal(slowCalls.size, 1);
	return [...slowCalls.values()][0]!;
};

describe("long tool calls move to the background", () => {
	test("after the limit: the tool returns the output so far, the run ends, and the call's end wakes the session with its result", async () => {
		const s = await newSession();
		const work = workEvents(s);
		let wakeSeen = "";
		respond(slow(1200, "build"), fauxAssistantMessage("It runs in the background."), (context) => {
			wakeSeen = JSON.stringify(context.messages.at(-1));
			return fauxAssistantMessage("It finished.");
		});
		const t0 = Date.now();
		await s.prompt("go");
		assert.ok(Date.now() - t0 < 1100, "the run did not wait for the call");
		const [detached] = toolTexts(s);
		assert.match(detached!, /^It still ran after \d s, so the call moved to the background and keeps running\. Its latest output is in \S+\.log\./);
		assert.match(detached!, /Output so far:\nprogress of build$/);
		const [running] = [...jobsOf(s).values()];
		assert.equal(running?.toolName, "slow");
		assert.deepEqual(work, [1]);
		assert.equal(onlyCall().ended, false);

		await until("the wake run", settled(s, "It finished."));
		const [report] = reports(s);
		assert.match(textOf(report!.content), /^Your background `slow` call `\{"ms":1200,"text":"build"\}` \(call [^)]+\) finished after \d s:\n\nslept: build$/);
		assert.match(wakeSeen, /Your background `slow` call/, "the wake run starts from the report");
		assert.equal(jobsOf(s).size, 0);
		assert.deepEqual(work, [1, 0]);
		assert.equal(readFileSync(running!.log, "utf8"), "slept: build", "the log ends with the final output");
	});

	test("a user message moves it at once; the agent reads the message with the result", async () => {
		const s = await newSession();
		let steered = "";
		respond(slow(30_000, "long"), (context) => {
			steered = JSON.stringify(context.messages.slice(-2));
			return fauxAssistantMessage("Doing the other thing.");
		});
		const t0 = Date.now();
		const run = s.prompt("go");
		await until("the call started", () => slowCalls.size === 1);
		await s.steer("do something else");
		await run;
		assert.ok(Date.now() - t0 < DETACH_MS, "moved before the limit");
		assert.match(toolTexts(s)[0]!, /^A new message arrived while it ran, so the call moved to the background/);
		assert.match(steered, /do something else/);
		assert.equal(jobsOf(s).size, 1);
		assert.equal(onlyCall().signal?.aborted, false);
	});

	test("a call a tool makes through ctx.executeTool stays in the foreground of its caller; only the caller moves", async () => {
		const s = await newSession();
		respond(call("caller", { ms: 1000 }), fauxAssistantMessage("Caller in the background."), fauxAssistantMessage("Seen."));
		await s.prompt("go");
		assert.deepEqual([...jobsOf(s).values()].map((j) => j.toolName), ["caller"]);
		await until("the caller's report", settled(s, "Seen."));
		assert.match(textOf(reports(s)[0]!.content), /^Your background `caller` call `\{"ms":1000\}` \(call [^)]+\) finished after \d s:\n\nslept: nested$/);
		assert.equal(onlyCall().ended, true);
	});

	test("an abort stops a foreground call, but not one already in the background", async () => {
		const s = await newSession();
		respond(slow(30_000, "first"), slow(30_000, "second"), fauxAssistantMessage("unused"));
		const run = s.prompt("go");
		await until("the second call", () => slowCalls.size === 2);
		const [first, second] = [...slowCalls.values()];
		assert.equal(jobsOf(s).size, 1, "the first is in the background");
		await s.abort();
		await run;
		assert.equal(second!.signal?.aborted, true, "the foreground call stopped");
		assert.equal(first!.signal?.aborted, false, "the background call runs on");
		assert.equal(jobsOf(s).size, 1);
	});

	test("an abort before the call moves stops it, and it never becomes a job", async () => {
		const s = await newSession();
		const work = workEvents(s);
		respond(slow(30_000, "x"), fauxAssistantMessage("unused"));
		const run = s.prompt("go");
		await until("the call", () => slowCalls.size === 1);
		await s.abort();
		await run;
		assert.equal(onlyCall().signal?.aborted, true);
		assert.match(toolTexts(s)[0]!, /slow: aborted/);
		await new Promise((r) => setTimeout(r, DETACH_MS + 100));
		assert.equal(jobsOf(s).size, 0);
		assert.deepEqual(work, []);
		assert.equal(sessionJobs(s.sessionManager.getSessionId()).foreground.size, 0);
	});

	test("a reload keeps it running and its end reaches the reloaded extension; the session's end stops it", async () => {
		const s = await newSession();
		const work = workEvents(s);
		respond(slow(1000, "a"), slow(30_000, "b"), fauxAssistantMessage("Both in the background."), fauxAssistantMessage("A done after reload."));
		await s.prompt("go");
		assert.equal(jobsOf(s).size, 2);
		const provider = getApiProvider(faux.api);
		await s.reload();
		if (!getApiProvider(faux.api)) registerApiProvider(provider as never);
		const [a, b] = [...slowCalls.values()];
		assert.equal(a!.signal?.aborted, false);
		await until("a's report after the reload", settled(s, "A done after reload."));
		assert.match(textOf(reports(s)[0]!.content), /finished after \d s:\n\nslept: a$/);
		assert.equal(jobsOf(s).size, 1);
		const [log] = [...jobsOf(s).values()].map((j) => j.log);
		await s.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		assert.equal(b!.signal?.aborted, true, "the session's end stops it");
		assert.equal(existsSync(log!), false, "its log went with the session");
		assert.deepEqual(work, [1, 2, 1]);
	});

	test("images of the result come with the report", async () => {
		const s = await newSession();
		respond(slow(700, "shot", true), fauxAssistantMessage("In the background."), fauxAssistantMessage("Seen it."));
		await s.prompt("go");
		await until("the wake run", settled(s, "Seen it."));
		const content = reports(s)[0]!.content;
		assert.ok(typeof content !== "string");
		assert.deepEqual(content.map((c) => c.type), ["text", "image"]);
		assert.match(textOf(content), /slept: shot$/);
	});

	test("a fast call is untouched: its own result, details and updates; no job, no log, no background work", async () => {
		const s = await newSession();
		const work = workEvents(s);
		const updates: string[] = [];
		s.subscribe((event) => {
			if (event.type === "tool_execution_update") updates.push(textOf(event.partialResult.content));
		});
		respond(slow(10, "quick"), fauxAssistantMessage("ok"));
		await s.prompt("go");
		const result = s.messages.find((m) => m.role === "toolResult");
		assert.ok(result?.role === "toolResult");
		assert.equal(textOf(result.content), "slept: quick");
		assert.deepEqual(result.details, { text: "quick" });
		assert.equal(result.isError, false);
		assert.deepEqual(updates, ["progress of quick"]);
		assert.deepEqual(work, []);
		assert.equal(existsSync(join(dir, "logs")), false);
		await new Promise((r) => setTimeout(r, DETACH_MS + 100));
		assert.equal(reports(s).length, 0);
	});

	test("a tool of the background set starts there at once, and its result arrives as a message; called nested, it stays in the foreground", async () => {
		const s = await newSession(["slow"]);
		respond(slow(200, "bg"), fauxAssistantMessage("Started."), fauxAssistantMessage("Seen."));
		const t0 = Date.now();
		await s.prompt("go");
		assert.ok(Date.now() - t0 < 200, "the call returned before the tool ended");
		assert.match(toolTexts(s)[0]!, /^`slow` always runs in the background: the call started and keeps running\. Its latest output is in \S+\.log\.\n\nWhen it ends/);
		assert.deepEqual([...jobsOf(s).values()].map((j) => j.toolName), ["slow"]);
		await until("its report", settled(s, "Seen."));
		assert.match(textOf(reports(s)[0]!.content), /^Your background `slow` call `\{"ms":200,"text":"bg"\}` \(call [^)]+\) finished after \d s:\n\nslept: bg$/);

		respond(call("caller", { ms: 50 }), fauxAssistantMessage("Nested done."));
		await s.prompt("again");
		assert.equal(toolTexts(s)[1], "slept: nested", "the caller got the nested result");
		assert.equal(reports(s).length, 1);
		assert.equal(jobsOf(s).size, 0);
	});

	test("a call that fails fast fails as before", async () => {
		const s = await newSession();
		respond(call("slow", { ms: "not a number", text: "x" }), fauxAssistantMessage("ok"));
		await s.prompt("go");
		const result = s.messages.find((m) => m.role === "toolResult");
		assert.ok(result?.role === "toolResult" && result.isError);
		assert.equal(jobsOf(s).size, 0);
	});
});
