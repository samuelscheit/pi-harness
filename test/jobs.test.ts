// Background work as items (extensions/background/work.ts) and /jobs: the texts, then real Pi
// sessions (faux model, real bash, the workflow extension) where every kind of job reports an item
// with its label and details, items disappear when their jobs end, /jobs lists them with the
// processes programs left, and /jobs stop stops each kind.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { type Context, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	type BackgroundWorkItem,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import background from "../extensions/background/index.ts";
import { JOB_MESSAGE_TYPE, sessionJobs } from "../extensions/background/jobs.ts";
import { BACKGROUND_WORK_KEY, jobsText, reportWork } from "../extensions/background/work.ts";
import bashExtension from "../extensions/bash/index.ts";
import workflow from "../extensions/workflow/index.ts";

const item = (extra: Partial<BackgroundWorkItem>): BackgroundWorkItem => ({ id: "c1", kind: "call", label: "bash: make", startedAt: 0, ...extra });

describe("texts", () => {
	test("/jobs numbers the items with how long each runs, its process, log and live view, then the processes programs left", () => {
		const text = jobsText(
			[
				item({ processGroup: 42, logPath: "/tmp/c1.log", command: "make" }),
				item({ id: "process-7", kind: "process", label: "process: npm run dev", pid: 7, processGroup: 5, startedAt: 60_000 }),
				item({ id: "c2", label: "workflow: inline run r1", url: "http://dash/workflows/r1", logPath: "/tmp/c2.log", startedAt: 120_000 }),
			],
			[{ pid: 9, pgid: 5, command: "git fsmonitor--daemon run", startedBy: "git status", namedAt: 0 }],
			125_000,
		);
		assert.equal(
			text,
			[
				"Background work of this session (3):",
				"1. bash: make · 2 min 5 s · process group 42 · log /tmp/c1.log",
				"2. process: npm run dev · 1 min 5 s · pid 7 (group 5)",
				"3. workflow: inline run r1 · 5 s · log /tmp/c2.log · http://dash/workflows/r1",
				"Stop one with /jobs stop <number>.",
				"",
				"Left running by programs, not tracked (nothing waits for them; stop one with `kill <pid>`):",
				"- pid 9 (group 5): git fsmonitor--daemon run · 2 min 5 s · left by `git status`",
			].join("\n"),
		);
		assert.equal(jobsText([], [], 0), "No background work in this session.");
	});

	test("a Pi build from before items gets the count: it refuses items with exactly its count message", () => {
		const jobs = sessionJobs(`old-pi-${process.pid}`);
		const calls: unknown[] = [];
		jobs.api = {
			setBackgroundWork: (key: string, pending: unknown) => {
				calls.push([key, pending]);
				if (!Number.isInteger(pending)) throw new Error(`Invalid background work: ${pending}`);
			},
		} as unknown as ExtensionAPI;
		try {
			jobs.leftovers.set(7, { pid: 7, pgid: 5, command: "sleep 9", startedBy: "sleep 9 &", adoptedAt: 0 });
			reportWork(jobs);
			assert.equal(calls.length, 2);
			assert.deepEqual(calls[1], [BACKGROUND_WORK_KEY, 1]);
			jobs.leftovers.clear();
			reportWork(jobs);
			assert.deepEqual(calls.slice(2), [[BACKGROUND_WORK_KEY, []], [BACKGROUND_WORK_KEY, 0]], "an empty list too");
		} finally {
			jobs.api = undefined;
			sessionJobs(`old-pi-${process.pid}`).leftovers.clear();
		}
	});
});

const DETACH_MS = 400;
let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
let dir: string;
const open: AgentSession[] = [];
const extensionErrors: string[] = [];
/** Calls of the `slow` tool, by text: aborted with what reason. */
const slowCalls = new Map<string, { aborted?: unknown }>();

before(async () => {
	faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	runtime = await ModelRuntime.create({ authPath: join(mkdtempSync(join(tmpdir(), "jobs-runtime-")), "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "faux-1", name: "Faux", api: faux.api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8000 }],
	});
});
after(() => faux.unregister());
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jobs-"));
	mkdirSync(join(dir, "repo"));
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

function slowTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "slow",
		label: "slow",
		description: "Sleeps, then answers.",
		parameters: Type.Object({ ms: Type.Number(), text: Type.String() }),
		async execute(_id, params, signal) {
			const call: { aborted?: unknown } = {};
			slowCalls.set(params.text, call);
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, params.ms);
				signal?.addEventListener("abort", () => (clearTimeout(timer), (call.aborted = signal.reason), reject(signal.reason)), { once: true });
			});
			return { content: [{ type: "text", text: `slept: ${params.text}` }], details: undefined };
		},
	});
}

interface Session {
	s: AgentSession;
	/** The items of each `background_work` event. */
	events: BackgroundWorkItem[][];
	notices: string[];
}

async function newSession(): Promise<Session> {
	const cwd = join(dir, "repo");
	const agentDir = join(dir, "agent");
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		extensionFactories: [
			(pi: ExtensionAPI) => background(pi, { detachAfterMs: DETACH_MS, logRoot: join(dir, "logs") }),
			(pi: ExtensionAPI) => bashExtension(pi, { dir: join(dir, "groups"), detachAfterMs: DETACH_MS, pollMs: 100 }),
			(pi: ExtensionAPI) => workflow(pi, { experimentsDir: join(dir, "experiments"), workflowDirs: () => [], modelRuntime: async () => runtime, agentDir, dashboardUrl: "http://dash" }),
			slowTool,
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir, model: runtime.getModel("faux", "faux-1"), modelRuntime: runtime, resourceLoader, sessionManager: SessionManager.create(cwd, join(dir, "sessions")), settingsManager });
	const notices: string[] = [];
	const methods = { notify: (text: string) => notices.push(text) };
	const uiContext = new Proxy(methods, { get: (target, name) => (name in target ? target[name as keyof typeof target] : () => undefined) }) as unknown as ExtensionUIContext;
	await session.bindExtensions({ uiContext, onError: (error) => extensionErrors.push(`${error.event}: ${error.error}`) });
	session.setActiveToolsByName([...session.getActiveToolNames(), "slow", "workflow"]);
	const events: BackgroundWorkItem[][] = [];
	session.subscribe((event) => {
		if (event.type === "background_work") {
			assert.equal(event.pending, event.items.length);
			events.push(event.items);
		}
	});
	open.push(session);
	return { s: session, events, notices };
}

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const bash = (command: string) => call("bash", { command });
/** The model makes `first` call, then answers every message with "ok". */
const model = (first: ReturnType<typeof call>) => faux.setResponses([first, ...Array.from({ length: 20 }, () => (_: Context) => fauxAssistantMessage("ok"))]);
const textOf = (content: string | readonly { type: string; text?: string }[]) => (typeof content === "string" ? content : content.map((c) => c.text ?? "").join(""));
const jobMessages = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "custom" && m.customType === JOB_MESSAGE_TYPE ? [textOf(m.content)] : []));
const toolCallIds = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : []));
const latest = (x: Session) => x.events.at(-1) ?? [];
async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}
const idle = (x: Session) => () => !x.s.isStreaming;
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("every job is an item", () => {
	test("a bash call in the background: its command, process group, log and call; gone when it ends", async () => {
		const x = await newSession();
		model(bash("sleep 1; echo done"));
		await x.s.prompt("go");
		const [bashItem] = latest(x);
		const [callId] = toolCallIds(x.s);
		assert.deepEqual({ ...bashItem, startedAt: 0, processGroup: 0, logPath: "" }, { id: callId, kind: "call", label: "bash: sleep 1; echo done", command: "sleep 1; echo done", startedAt: 0, processGroup: 0, logPath: "", toolCallId: callId });
		assert.ok(bashItem!.processGroup! > 1 && alive(-bashItem!.processGroup!), "the call's live process group");
		assert.match(bashItem!.logPath!, /\.log$/);
		await until("its end", () => jobMessages(x.s).length === 1 && latest(x).length === 0);
		assert.deepEqual(x.events.map((items) => items.length), [1, 0]);
	});

	test("another tool's call: the tool and its arguments, its log and call; no command or process", async () => {
		const x = await newSession();
		model(call("slow", { ms: 900, text: "index" }));
		await x.s.prompt("go");
		const [slow] = latest(x);
		assert.equal(slow!.label, 'slow: {"ms":900,"text":"index"}');
		assert.deepEqual(Object.keys(slow!).sort(), ["id", "kind", "label", "logPath", "startedAt", "toolCallId"]);
		await until("its end", () => latest(x).length === 0 && jobMessages(x.s).length === 1);
	});

	test("an `&` job: a process with its pid and group, from the bash call that left it; gone when it ends", async () => {
		const x = await newSession();
		model(bash("sleep 0.8 > /dev/null 2>&1 &"));
		await x.s.prompt("go");
		const [process] = latest(x);
		const [callId] = toolCallIds(x.s);
		assert.equal(process!.kind, "process");
		assert.equal(process!.label, "process: sleep 0.8");
		assert.equal(process!.id, `process-${process!.pid}`);
		assert.equal(process!.toolCallId, callId);
		assert.ok(process!.processGroup! > 1);
		await until("its end", () => latest(x).length === 0 && jobMessages(x.s).length === 1);
		assert.match(jobMessages(x.s)[0]!, /^Background process pid \d+ `sleep 0\.8` ended/);
	});

	test("a `tool … &` job: the tool command with its pid; gone when its call answers", async () => {
		const x = await newSession();
		model(bash("tool slow --ms 800 --text a > a.out 2>&1 &"));
		await x.s.prompt("go");
		await until("idle", idle(x));
		const [tool] = latest(x);
		assert.equal(tool!.kind, "tool");
		assert.equal(tool!.label, "tool slow --ms 800 --text a");
		assert.equal(tool!.command, "tool slow --ms 800 --text a");
		assert.equal(tool!.toolCallId, toolCallIds(x.s)[0]);
		await until("its end", () => latest(x).length === 0 && jobMessages(x.s).length === 1);
		assert.match(jobMessages(x.s)[0]!, /exited with code 0/);
	});

	test("a workflow: its run with the live view, one item for the call that runs it; gone when it ends", async () => {
		const x = await newSession();
		model(call("workflow", { code: "await new Promise((r) => setTimeout(r, 900));\nreturn 'finished';", budget: 1 }));
		await x.s.prompt("go");
		const [callId] = toolCallIds(x.s);
		const [run] = latest(x);
		const id = /^workflow: inline run (\S+)$/.exec(run!.label)?.[1];
		assert.ok(id, run!.label);
		assert.equal(run!.kind, "call");
		assert.equal(run!.id, callId);
		assert.equal(run!.url, `http://dash/workflows/${id}`);
		assert.match(run!.logPath!, /\.log$/);
		// Before the call moved to the background (its first seconds), the run was an item of its own.
		assert.deepEqual(
			x.events.slice(0, 2).map((items) => items.map((i) => [i.kind, i.id])),
			[[["workflow", `workflow-${id}`]], [["call", callId]]],
		);
		await until("its end", () => latest(x).length === 0 && jobMessages(x.s).length === 1);
		assert.ok(x.events.every((items) => items.length <= 1), "never the run and its call as two items");
	});
});

describe("/jobs", () => {
	test("lists the items oldest first, and the processes programs left running apart", async () => {
		const x = await newSession();
		model(bash("sleep 30 > /dev/null 2>&1 &\nbash -c 'sleep 31 > /dev/null 2>&1 &'\necho started"));
		await x.s.prompt("go");
		await until("idle", idle(x));
		model(bash("sleep 32"));
		await x.s.prompt("again");
		await x.s.prompt("/jobs");
		const text = x.notices.at(-1)!;
		const lines = text.split("\n");
		assert.equal(lines[0], "Background work of this session (2):");
		assert.match(lines[1]!, /^1\. process: sleep 30 · \d+ s · pid \d+ \(group \d+\)$/);
		assert.match(lines[2]!, /^2\. bash: sleep 32 · \d+ s · process group \d+ · log \S+\.log$/);
		assert.equal(lines[3], "Stop one with /jobs stop <number>.");
		assert.equal(lines[5], "Left running by programs, not tracked (nothing waits for them; stop one with `kill <pid>`):");
		assert.match(lines[6]!, /^- pid (\d+) \(group \d+\): sleep 31 · \d+ s · left by `sleep 30 > \/dev\/null 2>&1 & bash -c 'sleep 31 > \/dev\/null 2…`$/);
		const untracked = Number(/pid (\d+)/.exec(lines[6]!)![1]);
		process.kill(untracked, "SIGKILL");
		await until("the daemon gone", () => !alive(untracked));
		await x.s.prompt("/jobs");
		assert.doesNotMatch(x.notices.at(-1)!, /Left running by programs/, "one that exited is no longer listed");
		await x.s.prompt("/jobs stop 9");
		assert.equal(x.notices.at(-1), "No background item 9: /jobs lists items 1 to 2.");
		await x.s.prompt("/jobs halt 1");
		assert.equal(x.notices.at(-1), "Usage: /jobs (list) | /jobs stop <number>");
	});

	test("stop: a bash call's process group is killed and its call aborted; its end reaches the agent", async () => {
		const x = await newSession();
		model(bash("sleep 30"));
		await x.s.prompt("go");
		const [job] = latest(x);
		await x.s.prompt("/jobs stop 1");
		assert.equal(x.notices.at(-1), `Stopped bash: sleep 30: killed process group ${job!.processGroup} and aborted its call ${job!.id}.`);
		await until("its end", () => latest(x).length === 0 && jobMessages(x.s).length === 1);
		assert.match(jobMessages(x.s)[0]!, /^Your background `bash` call `sleep 30` \(call [^)]+\) failed after/);
		await until("the group gone", () => !alive(-job!.processGroup!));
	});

	test("stop: a `tool … &` job's process is killed, which aborts its call", async () => {
		const x = await newSession();
		model(bash("tool slow --ms 30000 --text t > t.out 2>&1 &"));
		await x.s.prompt("go");
		await until("idle", idle(x));
		const [tool] = latest(x);
		await x.s.prompt("/jobs stop 1");
		assert.equal(x.notices.at(-1), `Stopped tool slow --ms 30000 --text t: sent SIGTERM to pid ${tool!.pid}. Its end reaches the agent as a message.`);
		await until("its end", () => latest(x).length === 0 && jobMessages(x.s).length === 1);
		assert.match(jobMessages(x.s)[0]!, /^Your background `tool slow --ms 30000 --text t` \(pid \d+, .*\) was killed after \d+ s, so its call was aborted\.$/);
		await until("the call aborted", () => slowCalls.get("t")?.aborted !== undefined);
	});

	test("stop: an `&` job and what it started are killed; the others of the same command keep running", async () => {
		const x = await newSession();
		model(bash("bash -c 'sleep 30; true' > /dev/null 2>&1 &\nsleep 33 > /dev/null 2>&1 &"));
		await x.s.prompt("go");
		await until("idle", idle(x));
		const [first, second] = latest(x);
		assert.equal(first!.label, "process: bash -c sleep 30; true");
		await until("its child sleep", () => sessionJobs(x.s.sessionManager.getSessionId()).leftovers.size === 2);
		await x.s.prompt(`/jobs stop ${first!.id}`);
		assert.equal(x.notices.at(-1), `Stopped process: bash -c sleep 30; true: sent SIGTERM to pid ${first!.pid} and 1 process it started. Its end reaches the agent as a message.`);
		await until("its end", () => latest(x).length === 1 && jobMessages(x.s).length === 1);
		assert.match(jobMessages(x.s)[0]!, new RegExp(`^Background process pid ${first!.pid} \`bash -c sleep 30; true\` ended`));
		assert.equal(latest(x)[0]!.id, second!.id);
		assert.ok(alive(second!.pid!), "the other job of the same command still runs");
		await x.s.prompt("/jobs stop 2");
		assert.equal(x.notices.at(-1), "No background item 2: /jobs lists 1 item.");
	});

	test("stop: another tool's background call is aborted; its end names the stop", async () => {
		const x = await newSession();
		model(call("slow", { ms: 30_000, text: "s" }));
		await x.s.prompt("go");
		const [job] = latest(x);
		await x.s.prompt("/jobs stop 1");
		assert.equal(x.notices.at(-1), `Stopped slow: {"ms":30000,"text":"s"}: aborted its call ${job!.id}.`);
		await until("its end", () => latest(x).length === 0 && jobMessages(x.s).length === 1);
		assert.match(jobMessages(x.s)[0]!, /failed after \d+ s:\n\nstopped by the user with \/jobs stop$/);
	});

	test("stop: a workflow stops through its stop request and ends as stopped", async () => {
		const x = await newSession();
		model(call("workflow", { code: "await shell('sleep 30');\nreturn 'finished';", budget: 1 }));
		await x.s.prompt("go");
		const [run] = latest(x);
		const id = /run (\S+)$/.exec(run!.label)![1];
		await x.s.prompt("/jobs stop 1");
		assert.match(x.notices.at(-1)!, new RegExp(`^Stopped workflow run ${id}; its result arrives as a message\\.`));
		await until("its end", () => latest(x).length === 0 && jobMessages(x.s).length === 1);
		assert.match(jobMessages(x.s)[0]!, /^Your background `workflow` call .* finished after \d s:\n\nWorkflow stopped/);
	});
});
