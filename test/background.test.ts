// The background-work guard and the detachable bash (extensions/background): parsing and messages,
// then real Pi sessions (faux model, real bash) where the agent ends a run with a background job
// still running, and where a long command moves to the background and its end wakes the session.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, getApiProvider, registerApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import background, { backgroundMessage, MESSAGE_TYPE, processesInGroups, readGroup, recordLine, scanGroups } from "../extensions/background/index.ts";
import { detachedText, finishedText, JOB_MESSAGE_TYPE, sessionJobs } from "../extensions/background/jobs.ts";

const PS = [
	"  101   101 Ss       01:00 /bin/bash -c sleep 300 &",
	"  102   101 S        00:59 sleep 300",
	"  103   101 Z        00:59 (defunct)",
	"  201   200 S     1-02:03:04 node server.js --port 3000",
	"  301   300 R        00:01 ps -A",
	"garbage line",
].join("\n");

describe("parsing and messages", () => {
	test("processesInGroups keeps live processes of the given groups only", () => {
		assert.deepEqual(processesInGroups(PS, new Set([101, 200])), [
			{ pid: 101, pgid: 101, elapsed: "01:00", command: "/bin/bash -c sleep 300 &" },
			{ pid: 102, pgid: 101, elapsed: "00:59", command: "sleep 300" },
			{ pid: 201, pgid: 200, elapsed: "1-02:03:04", command: "node server.js --port 3000" },
		]);
		assert.deepEqual(processesInGroups(PS, new Set([999])), []);
	});

	test("the message groups processes by the bash command that started them", () => {
		const text = backgroundMessage(processesInGroups(PS, new Set([101, 200])), (pgid) => (pgid === 101 ? "sleep 300 &\n  echo started" : undefined));
		assert.match(text, /^Your run is about to end/);
		assert.match(text, /- from your bash command `sleep 300 & echo started`:\n {2}- pid 101, running 01:00: `\/bin\/bash -c sleep 300 &`\n {2}- pid 102, running 00:59: `sleep 300`\n- process group 200:\n {2}- pid 201, running 1-02:03:04: `node server\.js --port 3000`/);
		assert.match(text, /wait for them with a bash command/);
		assert.match(text, /moves to the background, and its end wakes you/);
		const long = backgroundMessage([{ pid: 1, pgid: 1, elapsed: "00:01", command: "x".repeat(400) }], () => undefined);
		assert.match(long, /`x{159}…`/);
	});

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

	test("scanGroups drops files of finished groups and unreadable ones", () => {
		const dir = mkdtempSync(join(tmpdir(), "bg-scan-"));
		try {
			writeFileSync(join(dir, "call-live"), "101");
			writeFileSync(join(dir, "call-done"), "500");
			writeFileSync(join(dir, "call-bad"), "");
			const { running, fileOf } = scanGroups(dir, () => PS);
			assert.deepEqual(running.map((p) => p.pid), [101, 102]);
			assert.equal(fileOf.get(101), "call-live");
			assert.deepEqual(readdirSync(dir), ["call-live"]);
			assert.deepEqual(scanGroups(join(dir, "missing"), () => assert.fail("no ps without groups")), { running: [], fileOf: new Map() });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

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
		models: [{ id: "faux-1", name: "Faux", api: faux.api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8000 }],
	});
});
after(() => faux.unregister());
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "bg-"));
	mkdirSync(join(dir, "repo"));
});
afterEach(() => {
	assert.deepEqual(extensionErrors.splice(0), [], "no extension errors");
	for (const session of open.splice(0)) session.dispose();
	// Stop whatever a test left running: every group the guard recorded (session dirs may be gone).
	const groups = join(dir, "groups");
	const ps = () => execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat=,etime=,command="], { encoding: "utf8" });
	for (const session of existsSync(groups) ? readdirSync(groups) : []) {
		for (const pgid of new Set(scanGroups(join(groups, session), ps).running.map((p) => p.pgid))) process.kill(-pgid, "SIGKILL");
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

async function newSession(): Promise<AgentSession> {
	const cwd = join(dir, "repo");
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: dir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		extensionFactories: [(pi: ExtensionAPI) => background(pi, { dir: join(dir, "groups"), detachAfterMs: DETACH_MS }), nestedBash],
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
const guardMessages = (s: AgentSession) => s.messages.filter((m) => m.role === "custom" && m.customType === MESSAGE_TYPE);
const marker = () => join(dir, `marker-${Math.random().toString(36).slice(2)}`);

describe("in a Pi session", () => {
	test("a run ending with a background job gets one more turn naming it; the agent's wait ends it", async () => {
		const s = await newSession();
		const done = marker();
		let seen = "";
		respond(
			bash(`(sleep 0.3; touch '${done}') > /dev/null 2>&1 &\necho started`),
			fauxAssistantMessage("Started it; I'll report when it finishes."),
			(context) => {
				seen = JSON.stringify(context.messages.at(-1));
				return bash(`for i in $(seq 50); do [ -e '${done}' ] && break; sleep 0.1; done; ls '${done}'`);
			},
			fauxAssistantMessage("It finished."),
		);
		await s.prompt("run it");
		assert.equal(guardMessages(s).length, 1);
		assert.match(seen, /still running in the background/);
		assert.match(seen, /from your bash command `\(sleep 0\.3; touch/, "names the command as the agent wrote it");
		assert.ok(existsSync(done));
		const call = s.messages.find((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall"));
		assert.doesNotMatch(JSON.stringify(call), /printf/, "the transcript keeps the original command");
		assert.equal(s.messages.at(-1)?.role, "assistant");
	});

	test("the same processes are reported once: the agent may end its turn on purpose", async () => {
		const s = await newSession();
		respond(bash("sleep 30 > /dev/null 2>&1 &"), fauxAssistantMessage("Started."), fauxAssistantMessage("The server keeps running, as you asked."));
		await s.prompt("start the server");
		assert.equal(guardMessages(s).length, 1);
		respond(fauxAssistantMessage("Still running."));
		await s.prompt("ok");
		assert.equal(guardMessages(s).length, 1, "no second report for the same process");
	});

	test("a command without background jobs, and a finished job, change nothing", async () => {
		const s = await newSession();
		respond(bash("echo hi; (sleep 0.1) & wait"), fauxAssistantMessage("Done."));
		await s.prompt("go");
		assert.equal(guardMessages(s).length, 0);
		assert.deepEqual(readdirSync(readdirSync(join(dir, "groups")).map((d) => join(dir, "groups", d))[0]!), [], "finished groups are forgotten");
	});
});

const jobMessages = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "custom" && m.customType === JOB_MESSAGE_TYPE ? [String(m.content)] : []));
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
		assert.equal(guardMessages(s).length, 0, "the guard leaves tracked jobs alone");
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
