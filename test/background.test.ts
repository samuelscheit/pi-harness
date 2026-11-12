// The background-work guard (extensions/background): parsing and messages, then real Pi sessions
// (faux model, real bash) where the agent ends a run with a background job still running.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import background, { backgroundMessage, MESSAGE_TYPE, processesInGroups, recordLine, scanGroups } from "../extensions/background/index.ts";

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
		assert.match(text, /wait for them in the foreground/);
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
	for (const session of open.splice(0)) session.dispose();
	// Stop whatever a test left running: every group the guard recorded (session dirs may be gone).
	const groups = join(dir, "groups");
	const ps = () => execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat=,etime=,command="], { encoding: "utf8" });
	for (const session of existsSync(groups) ? readdirSync(groups) : []) {
		for (const pgid of new Set(scanGroups(join(groups, session), ps).running.map((p) => p.pgid))) process.kill(-pgid, "SIGKILL");
	}
	rmSync(dir, { recursive: true, force: true });
});

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
		extensionFactories: [(pi: ExtensionAPI) => background(pi, { dir: join(dir, "groups") })],
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
	await session.bindExtensions({});
	open.push(session);
	return session;
}

const bash = (command: string) => fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
const respond = (...steps: FauxResponseStep[]) => faux.setResponses(steps);
const guardMessages = (s: AgentSession) => s.messages.filter((m) => m.role === "custom" && m.customType === MESSAGE_TYPE);
const marker = () => join(dir, `marker-${Math.random().toString(36).slice(2)}`);

describe("in a Pi session", () => {
	test("a run ending with a background job gets one more turn naming it; the agent's wait ends it", async () => {
		const s = await newSession();
		const done = marker();
		let seen = "";
		respond(
			bash(`(sleep 1; touch '${done}') > /dev/null 2>&1 &\necho started`),
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
		assert.match(seen, /from your bash command `\(sleep 1; touch/, "names the command as the agent wrote it");
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
