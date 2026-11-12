// Keeping the dashboard running: ensureDashboard against real servers (this checkout's, on a free
// port, with an empty agent dir), a fake server on another release that must be replaced, a crashed
// server, a lock held by another process; and the metrics extension's periodic check.

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { ensureDashboard } from "../dashboard/server/launch.ts";
import { APP } from "../dashboard/server/server.ts";
import metrics from "../extensions/metrics/index.ts";

let dir: string;
let agentDir: string;
let port: number;
const started: number[] = [];

const freePort = () =>
	new Promise<number>((resolve) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});

const status = async () => {
	try {
		return (await (await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1000) })).json()) as { pid: number; release: string | null };
	} catch {
		return undefined;
	}
};
const until = async (condition: () => Promise<boolean> | boolean, ms = 15_000) => {
	const deadline = Date.now() + ms;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 100));
	}
};

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "dashboard-keeper-"));
	agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
});
/** Kill a process that may have exited already. */
const kill = (pid: number) => {
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
};
afterEach(async () => {
	const now = await status();
	if (now) kill(now.pid);
	for (const pid of started.splice(0)) kill(pid);
	rmSync(join(agentDir, "dashboard.lock"), { recursive: true, force: true });
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** A server that answers /api/status as a dashboard on another release would. */
function fakeOldDashboard(): ChildProcess {
	const script = `require("node:http").createServer((q, s) => { s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ app: ${JSON.stringify(APP)}, release: "old-release", pid: process.pid })); }).listen(${port}, "127.0.0.1");`;
	const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
	started.push(child.pid!);
	return child;
}

describe("ensureDashboard", () => {
	test("starts one when none runs; afterwards reports it running; the server outlives nothing but itself", async () => {
		port = await freePort();
		const first = await ensureDashboard({ port, agentDir });
		assert.deepEqual(first, { url: `http://127.0.0.1:${port}`, state: "started" });
		const running = await status();
		assert.ok(running && running.release === null, "a checkout's server reports no release");
		assert.deepEqual(await ensureDashboard({ port, agentDir }), { url: `http://127.0.0.1:${port}`, state: "running" });
		assert.equal((await status())!.pid, running!.pid, "the same server");
	});

	test("after a crash the next check starts it again", async () => {
		port = await freePort();
		await ensureDashboard({ port, agentDir });
		process.kill((await status())!.pid, "SIGKILL");
		await until(async () => (await status()) === undefined);
		assert.equal((await ensureDashboard({ port, agentDir })).state, "started");
		assert.ok(await status());
	});

	test("a server on another release is stopped and replaced", async () => {
		port = await freePort();
		const old = fakeOldDashboard();
		await until(async () => (await status())?.release === "old-release");
		assert.equal((await ensureDashboard({ port, agentDir })).state, "replaced");
		await until(() => old.exitCode !== null || old.signalCode !== null);
		assert.equal((await status())!.release, null, "now the deployed (here: checkout) server");
	});

	test("while another live process holds the lock it starts nothing", async () => {
		port = await freePort();
		mkdirSync(join(agentDir, "dashboard.lock"), { recursive: true });
		writeFileSync(join(agentDir, "dashboard.lock", "pid"), String(process.ppid));
		assert.equal((await ensureDashboard({ port, agentDir })).state, "busy");
		assert.equal(await status(), undefined);
	});

	test("concurrent checks start one server", async () => {
		port = await freePort();
		const results = await Promise.all([ensureDashboard({ port, agentDir }), ensureDashboard({ port, agentDir }), ensureDashboard({ port, agentDir })]);
		assert.deepEqual(results.map((r) => r.state).sort(), ["busy", "busy", "started"]);
	});
});

describe("metrics extension keeps the dashboard running", () => {
	type Handler = (event: unknown, ctx: unknown) => unknown;
	const load = (ensure: () => Promise<never | { url: string; state: "running" }>) => {
		const handlers = new Map<string, Handler>();
		const notes: string[] = [];
		metrics({ on: (name: string, handler: Handler) => handlers.set(name, handler), registerCommand: () => {} } as never, { keepDashboard: true, ensure, checkMs: 30 });
		const ctx = { ui: { notify: (text: string) => notes.push(text) } };
		return { notes, start: () => handlers.get("session_start")!({ reason: "startup" }, ctx), stop: () => handlers.get("session_shutdown")!({}, ctx) };
	};

	test("checks at session start and periodically, until the session shuts down", async () => {
		let calls = 0;
		const session = load(async () => {
			calls++;
			return { url: "u", state: "running" };
		});
		session.start();
		assert.equal(calls, 1, "at once");
		await until(() => calls >= 4, 2000);
		session.stop();
		const stopped = calls;
		await new Promise((r) => setTimeout(r, 120));
		assert.equal(calls, stopped);
		assert.deepEqual(session.notes, []);
	});

	test("a failure is said once until it changes or the dashboard recovers", async () => {
		const outcomes = ["a", "a", "a", "b", "ok", "a"];
		let i = 0;
		const session = load(async () => {
			const outcome = outcomes[Math.min(i++, outcomes.length - 1)]!;
			if (outcome === "ok") return { url: "u", state: "running" };
			throw new Error(`broken ${outcome}`);
		});
		session.start();
		await until(() => i >= outcomes.length + 1, 3000);
		session.stop();
		assert.deepEqual(session.notes, ["Usage dashboard: broken a", "Usage dashboard: broken b", "Usage dashboard: broken a"]);
	});

	test("checks never overlap", async () => {
		let active = 0;
		let peak = 0;
		const session = load(async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 100));
			active--;
			return { url: "u", state: "running" };
		});
		session.start();
		await new Promise((r) => setTimeout(r, 350));
		session.stop();
		assert.equal(peak, 1);
	});
});
