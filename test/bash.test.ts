// The harness's bash (extensions/bash): the record line and messages, then real Pi sessions (faux
// model, real bash) where commands leave processes running and each one's end wakes the session,
// where `setsid` is refused, and where a long command moves to the background and its end wakes
// the session.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { ImageContent } from "@earendil-works/pi-ai";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, getApiProvider, registerApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import background, { readGroup, recordLine } from "../extensions/bash/index.ts";
import { detachedText, finishedText, JOB_MESSAGE_TYPE, sessionJobs } from "../extensions/bash/jobs.ts";

describe("record line and messages", () => {
	test("the record line writes the shell's pid, also into a path with quotes", () => {
		const dir = mkdtempSync(join(tmpdir(), "bg-line-"));
		try {
			const file = join(dir, "it's here");
			const out = execFileSync("bash", ["-c", `${recordLine(file)}echo $$`], { encoding: "utf8" }).trim();
			assert.equal(execFileSync("cat", [file], { encoding: "utf8" }), out);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a detached call names why, how to stop it, its log and the tail of its output", () => {
		const job = { callId: "c1", command: "make", startedAt: 0, pgid: 42, log: "/tmp/c1.log" };
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
		const byTime = detachedText(job, "time", lines, 125_000);
		assert.match(byTime, /^It still ran after 2 min 5 s, so it moved to the background and keeps running \(process group 42; stop it with `kill -- -42`\)\. Its latest output is in \/tmp\/c1\.log\./);
		assert.match(byTime, /do not wait or poll for it/);
		assert.match(byTime, /\[… 10 earlier lines in the log\]\nline 11\n/);
		assert.match(byTime, /line 30$/);
		assert.doesNotMatch(byTime, /line 10\n/);
		const byMessage = detachedText({ ...job, pgid: undefined }, "message", "  \n", 3000);
		assert.match(byMessage, /^A new message arrived while it ran, so the command moved to the background and keeps running\. /);
		assert.match(byMessage, /No output so far\.$/);
	});

	test("a job's end names the command, how it ended and its result", () => {
		const job = { callId: "c1", command: "make\n  all", startedAt: 0, pgid: 42, log: "/tmp/c1.log" };
		const text = (result: object) => finishedText(job, { result: result as never }, 61_000);
		assert.equal(text({ content: [{ type: "text", text: "ok" }] }), "Your background command `make all` (call c1) finished after 1 min 1 s:\n\nok");
		assert.match(text({ content: [{ type: "text", text: "boom" }], isError: true, structuredContent: { exit_code: 2 } }), /failed with exit code 2 after 1 min 1 s:\n\nboom$/);
		assert.match(text({ content: [] }), /finished after 1 min 1 s:\n\n\(no output\)$/);
		assert.match(finishedText(job, { error: new Error("out\n\nCommand timed out after 90 seconds") }, 90_000), /failed after 1 min 30 s:\n\nout\n\nCommand timed out after 90 seconds$/);
	});

	test("session state made by an older release gets the fields a newer one added, and keeps its own", () => {
		const all = ((globalThis as { __harnessJobs?: Map<string, unknown> }).__harnessJobs ??= new Map());
		const jobs = new Map([["c1", { callId: "c1" }]]);
		all.set("old-session", { topLevel: new Map(), foreground: new Map(), jobs, api: undefined });
		try {
			const state = sessionJobs("old-session");
			assert.equal(state.jobs, jobs, "existing state stays");
			assert.ok(state.calls instanceof Map && state.leftovers instanceof Map);
			assert.ok("poll" in state);
			assert.equal(sessionJobs("old-session").calls, state.calls, "filled in once");
		} finally {
			all.delete("old-session");
		}
	});

	test("readGroup reads a positive integer, else nothing", () => {
		const d = mkdtempSync(join(tmpdir(), "bg-group-"));
		try {
			for (const [content, expected] of [["123", 123], ["", undefined], ["-4", undefined], ["1.5", undefined], ["x", undefined]] as const) {
				writeFileSync(join(d, "f"), content);
				assert.equal(readGroup(join(d, "f")), expected, content);
			}
			assert.equal(readGroup(join(d, "missing")), undefined);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

});

const kill = (pid: number) => {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone.
	}
};

let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
let dir: string;
const open: AgentSession[] = [];

before(async () => {
	faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	const scratch = mkdtempSync(join(tmpdir(), "bg-runtime-"));
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
	dir = mkdtempSync(join(tmpdir(), "bg-"));
	mkdirSync(join(dir, "repo"));
});
afterEach(() => {
	assert.deepEqual(extensionErrors.splice(0), [], "no extension errors");
	// Stop whatever a test left running: its jobs' groups and its leftovers.
	for (const session of open.splice(0)) {
		const jobs = sessionJobs(session.sessionManager.getSessionId());
		for (const pgid of [...jobs.jobs.values()].flatMap((j) => (j.pgid === undefined ? [] : [-j.pgid]))) kill(pgid);
		for (const pid of jobs.leftovers.keys()) kill(pid);
		clearInterval(jobs.poll);
		session.dispose();
	}
	rmSync(dir, { recursive: true, force: true });
});

/** A tool that runs bash through `ctx.executeTool`, as codemode and workflow scripts do. */
function nestedBash(pi: ExtensionAPI) {
	pi.registerTool({
		name: "script",
		label: "script",
		description: "Runs a bash command from a script.",
		parameters: Type.Object({ command: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const outcome = await ctx.executeTool("bash", { command: params.command });
			return { content: outcome.result.content, details: undefined };
		},
	});
}

const DETACH_MS = 600;
const extensionErrors: string[] = [];

async function newSession(detachAfterMs = DETACH_MS): Promise<AgentSession> {
	const cwd = join(dir, "repo");
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: dir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		extensionFactories: [(pi: ExtensionAPI) => background(pi, { dir: join(dir, "groups"), detachAfterMs, pollMs: 100 }), nestedBash],
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
	// Like the RPC mode: an error listener is a binding, so a reload emits session_start.
	await session.bindExtensions({ onError: (error) => extensionErrors.push(`${error.event}: ${error.error}`) });
	session.setActiveToolsByName([...session.getActiveToolNames(), "script"]);
	open.push(session);
	return session;
}

const bash = (command: string, timeout?: number) => fauxAssistantMessage([fauxToolCall("bash", timeout === undefined ? { command } : { command, timeout })], { stopReason: "toolUse" });
const respond = (...steps: FauxResponseStep[]) => faux.setResponses(steps);
const marker = () => join(dir, `marker-${Math.random().toString(36).slice(2)}`);
const leftoversOf = (s: AgentSession) => sessionJobs(s.sessionManager.getSessionId()).leftovers;
const groupFiles = () => (existsSync(join(dir, "groups")) ? readdirSync(join(dir, "groups")).flatMap((d) => readdirSync(join(dir, "groups", d))) : []);

describe("processes a command leaves running", () => {
	test("each is named in the result, and each one's end wakes the session with its own message", async () => {
		const s = await newSession();
		const work = workEvents(s);
		respond(
			bash("sleep 0.4 > /dev/null 2>&1 &\nsleep 1.4 > /dev/null 2>&1 &\necho started"),
			fauxAssistantMessage("Both run."),
			fauxAssistantMessage("The first ended."),
			fauxAssistantMessage("The second ended."),
		);
		await s.prompt("start them");
		assert.match(toolTexts(s)[0]!, /^started\n\n\nStill running in the background, left by this command \(2 processes\):\n- pid \d+: `sleep 0\.4`\n- pid \d+: `sleep 1\.4`\nEach one's end reaches you/);
		assert.equal(leftoversOf(s).size, 2);
		assert.deepEqual(groupFiles(), [], "the call's group file is gone once its leftovers are adopted");
		const call = s.messages.find((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall"));
		assert.doesNotMatch(JSON.stringify(call), /printf/, "the transcript keeps the original command");

		await until("both end messages", () => jobMessages(s).length === 2 && settled(s, "The second ended.")());
		const [first, second] = jobMessages(s);
		assert.match(first!, /^Background process pid \d+ `sleep 0\.4` ended \(running at least \d s since your command `sleep 0\.4 > \/dev\/null 2>&1 & sleep 1\.4 > \/dev\/null 2>&1 & echo started` returned\)\. Its exit code is not known/);
		assert.match(second!, /^Background process pid \d+ `sleep 1\.4` ended/);
		assert.equal(leftoversOf(s).size, 0);
		assert.equal(sessionJobs(s.sessionManager.getSessionId()).poll, undefined, "the check stops with the last leftover");
		assert.deepEqual(work, [2, 1, 0]);
	});

	test("a job that leaves a child when it ends: the child is tracked, and its end is reported too", async () => {
		const s = await newSession();
		respond(bash("bash -c 'sleep 0.3; sleep 0.8 > /dev/null 2>&1 & exit 0' > /dev/null 2>&1 &"), fauxAssistantMessage("Started."), fauxAssistantMessage("Parent ended."), fauxAssistantMessage("Child ended."));
		await s.prompt("go");
		assert.match(toolTexts(s)[0]!, /\(1 process\):\n- pid \d+: `bash -c sleep 0\.3; sleep 0\.8 > \/dev\/null 2>&1 & exit 0`/);
		await until("both end messages", () => jobMessages(s).length === 2 && settled(s, "Child ended.")());
		const [parent, child] = jobMessages(s);
		assert.match(parent!, /`bash -c sleep 0\.3; .*` ended .*\nIt left running, now tracked as well:\n- pid \d+: `sleep 0\.8`$/);
		assert.match(child!, /^Background process pid \d+ `sleep 0\.8` ended/);
	});

	test("one entry per job: a subshell and its children are one process; a failing command names its leftovers too", async () => {
		const s = await newSession();
		const done = marker();
		respond(bash(`(sleep 0.2; touch '${done}') > /dev/null 2>&1 &\nexit 3`), fauxAssistantMessage("Noted."), fauxAssistantMessage("Ended."));
		await s.prompt("go");
		const [result] = s.messages.filter((m) => m.role === "toolResult");
		assert.equal(result!.isError, true);
		assert.match(textOf(result!.content), /exited with code 3[\s\S]*\(1 process\):\n- pid \d+: /);
		await until("the end message", () => jobMessages(s).length === 1 && settled(s, "Ended.")());
		assert.ok(existsSync(done));
	});

	test("jobs the command waits for or stops leave nothing", async () => {
		const s = await newSession();
		respond(bash("sleep 0.2 & sleep 0.1 & wait; echo waited; sleep 30 & pid=$!; kill $pid; echo stopped"), fauxAssistantMessage("Done."));
		await s.prompt("go");
		assert.equal(toolTexts(s)[0], "waited\nstopped\n");
		assert.equal(leftoversOf(s).size, 0);
		assert.deepEqual(groupFiles(), []);
	});

	test("a script's command (ctx.executeTool) names its leftovers in its result, and their end wakes the session", async () => {
		const s = await newSession();
		respond(fauxAssistantMessage([fauxToolCall("script", { command: "sleep 0.3 > /dev/null 2>&1 & echo nested" })], { stopReason: "toolUse" }), fauxAssistantMessage("ok"), fauxAssistantMessage("Ended."));
		await s.prompt("go");
		assert.match(toolTexts(s)[0]!, /^nested\n\n\nStill running in the background, left by this command \(1 process\):\n- pid \d+: `sleep 0\.3`/);
		await until("the end message", () => jobMessages(s).length === 1 && settled(s, "Ended.")());
	});

	test("a job that moved to the background names what it left in its report", async () => {
		const s = await newSession();
		respond(bash("sleep 2 > /dev/null 2>&1 & sleep 1; echo done"), fauxAssistantMessage("In the background."), fauxAssistantMessage("Job ended."), fauxAssistantMessage("Leftover ended."));
		await s.prompt("go");
		await until("both reports", () => jobMessages(s).length === 2 && settled(s, "Leftover ended.")());
		const [job, leftover] = jobMessages(s);
		assert.match(job!, /^Your background command .* finished after \d s:\n\ndone\n\n\nStill running in the background, left by this command \(1 process\):\n- pid \d+: `sleep 2`/);
		assert.match(leftover!, /`sleep 2` ended/);
	});

	test("leftovers survive a reload and still report; the session's end stops them", async () => {
		const s = await newSession();
		respond(bash("sleep 0.8 > /dev/null 2>&1 & sleep 30 > /dev/null 2>&1 &"), fauxAssistantMessage("Started."), fauxAssistantMessage("Short one ended."));
		await s.prompt("go");
		const pids = [...leftoversOf(s).keys()];
		assert.equal(pids.length, 2);
		const provider = getApiProvider(faux.api);
		await s.reload();
		if (!getApiProvider(faux.api)) registerApiProvider(provider as never);
		await until("the short one's report", () => jobMessages(s).length === 1 && settled(s, "Short one ended.")());
		const [long] = [...leftoversOf(s).keys()];
		assert.ok(long !== undefined && pids.includes(long));
		await s.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await until("the long one stopped", () => {
			try {
				process.kill(long!, 0);
				return false;
			} catch {
				return true;
			}
		}, 3000);
	});
});

describe("setsid", () => {
	test("is refused before the command runs, also from a script; nohup and & run", async () => {
		const s = await newSession();
		const ran = marker();
		const nested = marker();
		const allowed = marker();
		respond(
			bash(`touch '${ran}'; setsid nohup bash -c 'sleep 30' > /dev/null 2>&1 &`),
			fauxAssistantMessage([fauxToolCall("script", { command: `touch '${nested}'; setsid sleep 30` })], { stopReason: "toolUse" }),
			bash(`nohup touch '${allowed}' > /dev/null 2>&1 & wait`),
			fauxAssistantMessage("ok"),
		);
		await s.prompt("embed everything");
		assert.ok(!existsSync(ran), "the refused command did not run");
		assert.ok(!existsSync(nested), "the refused nested command did not run");
		assert.ok(existsSync(allowed), "nohup and & run");
		const results = s.messages.filter((m) => m.role === "toolResult");
		assert.ok(results[0]?.isError, "the refusal is an error result");
		const [top, fromScript] = results.map((m) => textOf(m.content));
		assert.match(top!, /^Not run: this command uses `setsid`:\n- `setsid nohup bash -c 'sleep 30' > \/dev\/null 2>&1`\n/);
		assert.match(top!, /Start the job with `&` instead/);
		assert.match(fromScript!, /Not run: this command uses `setsid`:\n- `setsid sleep 30`/);
		assert.equal(sessionJobs(s.sessionManager.getSessionId()).calls.size, 0, "a refused call leaves no state");
	});
});

const textOf = (content: string | readonly { type: string; text?: string }[]) => (typeof content === "string" ? content : content.map((c) => c.text ?? "").join(""));
const jobMessages = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "custom" && m.customType === JOB_MESSAGE_TYPE ? [textOf(m.content)] : []));
const toolTexts = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((c) => (c.type === "text" ? c.text : "")).join("")] : []));
const lastText = (context: { messages: readonly unknown[] }) => JSON.stringify(context.messages.at(-1));
const jobsOf = (s: AgentSession) => sessionJobs(s.sessionManager.getSessionId()).jobs;
const alive = (pgid: number) => {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
};
async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}
const settled = (s: AgentSession, reply: string) => () => !s.isStreaming && s.messages.at(-1)?.role === "assistant" && JSON.stringify(s.messages.at(-1)).includes(reply);
function workEvents(s: AgentSession): number[] {
	const seen: number[] = [];
	s.subscribe((event) => {
		if (event.type === "background_work") seen.push(event.pending);
	});
	return seen;
}

describe("long commands move to the background", () => {
	test("after the limit: the tool returns the output so far, the run ends, and the job's end wakes the session with its result", async () => {
		const s = await newSession();
		const work = workEvents(s);
		let detachedSeen = "";
		let wakeSeen = "";
		respond(
			bash("echo first; sleep 2; echo second"),
			(context) => {
				detachedSeen = lastText(context);
				return fauxAssistantMessage("It runs in the background.");
			},
			(context) => {
				wakeSeen = lastText(context);
				return fauxAssistantMessage("It finished.");
			},
		);
		await s.prompt("build it");
		assert.match(detachedSeen, /It still ran after \d s, so it moved to the background/);
		assert.match(detachedSeen, /process group \d+; stop it with `kill -- -\d+`/);
		assert.match(detachedSeen, /Output so far:\\nfirst/);

		const [job] = [...jobsOf(s).values()];
		assert.ok(job?.pgid !== undefined && alive(job.pgid), "the run ended before the command");
		assert.match(readFileSync(job.log, "utf8"), /first/);
		assert.deepEqual(work, [1]);

		await until("the wake run", settled(s, "It finished."));
		assert.match(wakeSeen, /Your background command `echo first; sleep 2; echo second`/, "the wake run starts from the job's report");
		const [message] = jobMessages(s);
		assert.match(message!, /^Your background command `echo first; sleep 2; echo second` \(call [^)]+\) finished after \d s:\n\nfirst\nsecond\n$/);
		assert.equal(jobsOf(s).size, 0);
		assert.deepEqual(work, [1, 0]);
		assert.match(readFileSync(job.log, "utf8"), /first\nsecond/, "the log has the latest output");
	});

	test("a message arriving during the command: the tool returns at once, the agent reads the message, and the job's end still reports (killed: exit 143)", async () => {
		const s = await newSession();
		let steered = "";
		respond(
			bash("echo waiting; sleep 30"),
			(context) => {
				steered = JSON.stringify(context.messages.slice(-2));
				const [job] = [...jobsOf(s).values()];
				return bash(`kill -- -${job!.pgid}`);
			},
			fauxAssistantMessage("Stopped it."),
			fauxAssistantMessage("Noted."),
		);
		const t0 = Date.now();
		const run = s.prompt("build it");
		await new Promise((r) => setTimeout(r, 200));
		await s.steer("stop that, do something else");
		await run;
		const [detached] = toolTexts(s);
		assert.match(detached!, /^A new message arrived while it ran, so the command moved to the background/);
		assert.match(steered, /stop that, do something else/);
		assert.match(steered, /A new message arrived/, "the agent got the tool result and the message in one go");
		await until("the job's report", () => jobMessages(s).length === 1 && !s.isStreaming);
		assert.ok(Date.now() - t0 < 5000, "nothing waited for the 30 s sleep");
		assert.match(jobMessages(s)[0]!, /failed with exit code 143 after/);
		assert.match(jobMessages(s)[0]!, /waiting/);
	});

	test("an abort stops a foreground command, but not one already in the background", async () => {
		const s = await newSession();
		respond(bash("sleep 30"), bash("sleep 31"), fauxAssistantMessage("unused"));
		const run = s.prompt("go");
		await until("the first command in the background", () => jobsOf(s).size === 1);
		const [job] = [...jobsOf(s).values()];
		await new Promise((r) => setTimeout(r, 200));
		const ps = () => execFileSync("ps", ["-A", "-o", "command="], { encoding: "utf8" });
		assert.match(ps(), /^sleep 31$/m, "the second command runs in the foreground");
		await s.abort();
		await run;
		await until("the foreground command stopped", () => !/^sleep 31$/m.test(ps()), 3000);
		assert.ok(alive(job!.pgid!), "the background job survives the abort");
		assert.equal(jobsOf(s).size, 1);
	});

	test("a command's own timeout still ends it in the background, and the report says so", async () => {
		const s = await newSession();
		respond(bash("echo started; sleep 10", 1.5), fauxAssistantMessage("In the background."), fauxAssistantMessage("It timed out."));
		await s.prompt("go");
		await until("the wake run", settled(s, "It timed out."));
		assert.match(jobMessages(s)[0]!, /^Your background command `echo started; sleep 10` \(call [^)]+\) failed after \d s:\n\nstarted\n+Command timed out after 1\.5 seconds$/);
	});

	test("a command a script runs through ctx.executeTool stays in the foreground: the script needs its output", async () => {
		const s = await newSession();
		respond(fauxAssistantMessage([fauxToolCall("script", { command: "sleep 1.2; echo nested-done" })], { stopReason: "toolUse" }), fauxAssistantMessage("ok"));
		await s.prompt("go");
		assert.equal(toolTexts(s)[0], "nested-done\n");
		assert.equal(jobMessages(s).length, 0);
		assert.equal(jobsOf(s).size, 0);
	});

	test("a fast command returns as before", async () => {
		const s = await newSession();
		const work = workEvents(s);
		respond(bash("echo quick"), fauxAssistantMessage("ok"));
		await s.prompt("go");
		assert.equal(toolTexts(s)[0], "quick\n");
		assert.deepEqual(work, []);
	});

	test("a reload while a job runs (a harness release): its end reaches the reloaded extension and wakes the session", async () => {
		const s = await newSession();
		const work = workEvents(s);
		respond(bash("sleep 1.5; echo after-reload"), fauxAssistantMessage("In the background."), fauxAssistantMessage("Done after reload."));
		await s.prompt("go");
		assert.equal(jobsOf(s).size, 1);
		// reload() resets the API providers to the built-in ones; the faux one goes back, as an extension's would.
		const provider = getApiProvider(faux.api);
		await s.reload();
		if (!getApiProvider(faux.api)) registerApiProvider(provider as never);
		await until("the wake run", settled(s, "Done after reload."));
		assert.match(jobMessages(s)[0]!, /finished after \d s:\n\nafter-reload\n$/);
		assert.deepEqual(work, [1, 0]);
	});
});

/** A detach limit no bridge test reaches: several `tool` calls (each a Node start) can pass 600 ms under load. */
const FOREGROUND_MS = 30_000;
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const toolResults = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "toolResult" ? [m] : []));
const imagesOf = (content: string | readonly { type: string }[]) => (typeof content === "string" ? [] : content.filter((c): c is ImageContent => c.type === "image"));
const repoFile = (name: string) => join(dir, "repo", name);

describe("tools from bash", () => {
	test("a script chains a command and the tools that look at its output; images come with the bash result", async () => {
		writeFileSync(repoFile("shot.png"), PNG);
		const s = await newSession(FOREGROUND_MS);
		respond(bash("echo built > out.txt && tool read out.txt && tool read shot.png && echo after"), fauxAssistantMessage("ok"));
		await s.prompt("go");
		const [result] = toolResults(s);
		assert.equal(result!.isError, false);
		const text = textOf(result!.content);
		assert.match(text, /^built\n/);
		assert.match(text, /\[image 1 \(image\/png\) is attached to this bash call's result\]\nafter\n$/);
		assert.deepEqual(imagesOf(result!.content).map((c) => c.mimeType), ["image/png"]);
		assert.deepEqual(result!.nestedCalls?.calls.map((c) => [c.name, c.status]), [["read", "ok"], ["read", "ok"]], "recorded as nested calls of the bash call");
	});

	test("failures: a failed call exits 1 with its error on stderr, usage errors and unknown tools exit 2", async () => {
		const s = await newSession(FOREGROUND_MS);
		respond(bash("tool read missing.txt; echo \"read $?\"; tool read --bogus x; echo \"usage $?\"; tool nope; echo \"unknown $?\""), fauxAssistantMessage("ok"));
		await s.prompt("go");
		const text = textOf(toolResults(s)[0]!.content);
		assert.match(text, /ENOENT|not found|No such file/i);
		assert.match(text, /\nread 1\n/);
		assert.match(text, /tool read: unknown option --bogus; options: --path, --offset, --limit\nRun `tool read --help` for its arguments\.\nusage 2\n/);
		assert.match(text, /tool: unknown tool "nope"\. Tools: [^\n]*\bbash\b[^\n]*\nunknown 2\n$/);
	});

	test("set -e stops the script at a failed tool call", async () => {
		const s = await newSession(FOREGROUND_MS);
		respond(bash("set -e; tool read missing.txt; echo unreachable"), fauxAssistantMessage("ok"));
		await s.prompt("go");
		const [result] = toolResults(s);
		assert.equal(result!.isError, true);
		assert.doesNotMatch(textOf(result!.content), /unreachable/);
		assert.match(textOf(result!.content), /Command exited with code 1/);
	});

	test("JSON arguments from a heredoc, nested bash, and help", async () => {
		const s = await newSession(FOREGROUND_MS);
		respond(
			bash(`tool write --args - <<'EOF'\n{"path": "w.txt", "content": "from 'json'"}\nEOF\ntool bash 'cat w.txt'; echo; tool --help; tool read --help`),
			fauxAssistantMessage("ok"),
		);
		await s.prompt("go");
		const text = textOf(toolResults(s)[0]!.content);
		assert.equal(readFileSync(repoFile("w.txt"), "utf8"), "from 'json'");
		assert.match(text, /\nfrom 'json'\n/);
		assert.match(text, /Usage: tool <name> \[arguments\]/);
		assert.match(text, /^ {2}read {2,}\S/m);
		assert.match(text, /Usage: tool read <path> \[--offset <number>\] \[--limit <number>\]/);
	});

	test("tool edit - changes several files from blocks after a cd, as edit calls, and the check runs after it", async () => {
		mkdirSync(repoFile("sub"), { recursive: true });
		writeFileSync(repoFile("sub/a.txt"), "alpha $HOME `x`\n");
		writeFileSync(repoFile("b.txt"), "beta\n");
		const s = await newSession(FOREGROUND_MS);
		const blocks = ["a.txt", "<<<<<<< SEARCH", "alpha $HOME `x`", "=======", "ALPHA $HOME `x`", ">>>>>>> REPLACE", "../b.txt", "<<<<<<< SEARCH", "beta", "=======", "BETA", ">>>>>>> REPLACE"].join("\n");
		respond(
			bash(`cd sub && tool edit - <<'EOF'\n${blocks}\nEOF\ncat a.txt ../b.txt; tool edit - <<'EOF' || echo "refused $?"\na.txt\n<<<<<<< SEARCH\nnot there\n=======\nx\n>>>>>>> REPLACE\nEOF\ntool edit --help | grep -c 'SEARCH'`),
			fauxAssistantMessage("ok"),
		);
		await s.prompt("go");
		const [result] = toolResults(s);
		const text = textOf(result!.content);
		assert.match(text, /Successfully replaced 1 block\(s\) in \S*sub\/a\.txt\.\nSuccessfully replaced 1 block\(s\) in \S*b\.txt\.\n/);
		assert.match(text, /ALPHA \$HOME `x`\nBETA\n/);
		assert.match(text, /tool edit: nothing changed, 1 of 1 files do not match:\n\S*sub\/a\.txt: [^\n]+\nrefused 1\n/);
		assert.match(text, /\n[1-9]\n$/, "help shows the block format");
		assert.equal(readFileSync(repoFile("sub/a.txt"), "utf8"), "ALPHA $HOME `x`\n");
		assert.deepEqual(result!.nestedCalls?.calls.map((c) => [c.name, c.status]), [["edit", "ok"], ["edit", "ok"]], "a refused run makes no edit call");
	});

	test("a tool command killed by its caller aborts its call, while the script goes on", async () => {
		const s = await newSession(FOREGROUND_MS);
		const started = marker();
		const done = marker();
		respond(
			bash(`timeout 0.6 tool bash 'touch ${started}; sleep 1; touch ${done}'; echo "exit $?"; sleep 1.2; [ -e ${started} ] && echo started; [ -e ${done} ] && echo touched || echo stopped`),
			fauxAssistantMessage("ok"),
		);
		await s.prompt("go");
		assert.equal(textOf(toolResults(s)[0]!.content), "exit 124\nstarted\nstopped\n");
	});

	test("a command that moves to the background keeps its tools; its images come with the job's report", async () => {
		writeFileSync(repoFile("shot.png"), PNG);
		const s = await newSession();
		respond(bash("sleep 1; tool read shot.png"), fauxAssistantMessage("In the background."), fauxAssistantMessage("Seen it."));
		await s.prompt("go");
		await until("the wake run", settled(s, "Seen it."));
		const report = s.messages.find((m) => m.role === "custom" && m.customType === JOB_MESSAGE_TYPE);
		assert.ok(report?.role === "custom");
		assert.match(textOf(report.content), /finished after \d s:\n\nRead image file \[image\/png\]\n\[image 1 \(image\/png\) is attached to this bash call's result\]/);
		assert.equal(imagesOf(report.content).length, 1);
	});

	test("outside a bash call, and after it ended, the command says it cannot reach the agent", async () => {
		const client = new URL("../extensions/bash/cli.mjs", import.meta.url).pathname;
		const run = (env: NodeJS.ProcessEnv) => {
			try {
				execFileSync(process.execPath, [client, "read", "x"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
				return assert.fail("exits non-zero");
			} catch (error) {
				const { status, stderr } = error as { status: number; stderr: string };
				return { status, stderr };
			}
		};
		assert.deepEqual(run({ PATH: process.env.PATH }), { status: 2, stderr: "tool: works only inside the agent's bash tool\n" });
		const s = await newSession(FOREGROUND_MS);
		respond(bash("printf %s \"$PI_TOOL_SOCKET\""), fauxAssistantMessage("ok"));
		await s.prompt("go");
		const socket = textOf(toolResults(s)[0]!.content);
		assert.match(socket, /pi-tool-\d+-\d+\.sock$/);
		assert.equal(existsSync(socket), false, "the socket is removed with the call");
		const after = run({ PATH: process.env.PATH, PI_TOOL_SOCKET: socket });
		assert.equal(after.status, 2);
		assert.match(after.stderr, /cannot reach the agent/);
	});
});
