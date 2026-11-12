// Keep the usage dashboard running: `ensureDashboard` starts it detached (it outlives the Pi
// process that started it) when none answers, and replaces one that runs another release than the
// deployed one. Every Pi process running the installed harness calls it periodically
// (extensions/metrics) and right after deploying a release (extensions/release), so the dashboard
// runs while Pi does, also after a crash, and follows each release. `/harness dashboard` and
// `npm run dashboard -- --detach` call it too.
//
// The detached server logs to <agent dir>/dashboard.log. A running server is recognised by its
// /api/status answer. When the harness runs from releases (extensions/lib/release.ts), the server
// starts from the deployed release, whatever release the caller runs. Starting and replacing hold
// a lock (several Pi processes check at once), and the new release's frontend is built before the
// old server stops, so a replacement is down only while the new server starts.

import { execFile, spawn } from "node:child_process";
import { existsSync, openSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { acquireLock } from "../../extensions/lib/lock.ts";
import { currentLink, currentRelease } from "../../extensions/lib/release.ts";
import { RELEASE } from "../../extensions/lib/repository.ts";
import { APP, DEFAULT_PORT, HOST, type IndexStatus } from "./server.ts";

/** The dashboard directory to run: the deployed release's when running from releases, else this one. */
const dashboardRoot = (agentDir = getAgentDir()) => (RELEASE ? join(realpathSync(currentLink(agentDir)), "dashboard") : fileURLToPath(new URL("..", import.meta.url)));
const START_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 1_000;

/** The status of the dashboard answering on `port`, if one does. */
async function status(port: number): Promise<IndexStatus | undefined> {
	try {
		const response = await fetch(`http://${HOST}:${port}/api/status`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
		const body = response.ok ? ((await response.json()) as IndexStatus) : undefined;
		return body?.app === APP ? body : undefined;
	} catch {
		return undefined;
	}
}

/** Whether a dashboard answers on `port`. */
export const running = async (port: number) => (await status(port)) !== undefined;

function newest(path: string): number {
	const stat = statSync(path);
	if (!stat.isDirectory()) return stat.mtimeMs;
	return Math.max(stat.mtimeMs, ...readdirSync(path).map((name) => newest(join(path, name))));
}

// What the build reads besides src/.
const BUILD_INPUTS = ["src", "index.html", "package.json", "vite.config.ts", "tailwind.config.ts", "postcss.config.js", "tsconfig.json"];

/** Whether dist is missing or older than a build input (the server's own types included). */
export function stale(root = dashboardRoot()): boolean {
	const built = join(root, "dist", "index.html");
	if (!existsSync(built)) return true;
	const inputs = [...BUILD_INPUTS.map((name) => join(root, name)), join(root, "..", "extensions", "metrics", "queries")].filter((path) => existsSync(path));
	return Math.max(...inputs.map(newest)) > statSync(built).mtimeMs;
}

// npm next to the running node, else from PATH (t3 starts Pi without the shell's PATH).
const npm = () => {
	const sibling = join(dirname(process.execPath), "npm");
	return existsSync(sibling) ? sibling : "npm";
};

/** Install the frontend's dependencies when missing and build it when stale. */
export async function build(log: (line: string) => void = () => {}, root = dashboardRoot()): Promise<void> {
	if (!stale(root)) return;
	const run = (args: string[]) => promisify(execFile)(npm(), args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
	if (!existsSync(join(root, "node_modules"))) {
		log("Installing the dashboard's dependencies…");
		await run(["ci", "--no-audit", "--no-fund"]);
	}
	log("Building the dashboard…");
	await run(["run", "build"]);
}

/** Start the server from `root` detached; resolves once it answers. */
async function start(root: string, port: number, agentDir: string): Promise<void> {
	const log = openSync(join(agentDir, "dashboard.log"), "a");
	const child = spawn(process.execPath, [join(root, "server", "main.ts"), "--port", String(port)], {
		cwd: resolve(root, ".."),
		detached: true,
		stdio: ["ignore", log, log],
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	});
	child.unref();
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await running(port)) return;
		if (child.exitCode !== null) break;
		await new Promise((wait) => setTimeout(wait, 200));
	}
	throw new Error(`the dashboard did not start; see ${join(agentDir, "dashboard.log")}`);
}

/** Stop the server answering on `port` (by the pid its status reports); resolves once it no longer answers. */
async function stop(pid: number, port: number): Promise<void> {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Gone already.
	}
	const deadline = Date.now() + START_TIMEOUT_MS;
	while ((await running(port)) && Date.now() < deadline) await new Promise((wait) => setTimeout(wait, 200));
}

/** running: it answers on the deployed release; started / replaced: it does now; busy: another process is starting it. */
export type EnsureResult = { url: string; state: "running" | "started" | "replaced" | "busy" };

/**
 * Make the dashboard run on the deployed release (this checkout's outside releases): start it
 * when none answers, replace one on another release. A server that does not report its pid (older
 * than that field) is left running.
 */
export async function ensureDashboard({ port = DEFAULT_PORT, agentDir = getAgentDir() } = {}): Promise<EnsureResult> {
	const url = `http://${HOST}:${port}`;
	const wanted = RELEASE ? (currentRelease(agentDir)?.commit ?? null) : null;
	const current = (now: IndexStatus | undefined) => now !== undefined && (now.release === wanted || typeof now.pid !== "number");
	if (current(await status(port))) return { url, state: "running" };
	const unlock = acquireLock(join(agentDir, "dashboard.lock"));
	if (!unlock) return { url, state: "busy" };
	try {
		const found = await status(port);
		if (current(found)) return { url, state: "running" };
		const root = dashboardRoot(agentDir);
		await build(undefined, root);
		if (found) await stop(found.pid, port);
		await start(root, port, agentDir);
		return { url, state: found ? "replaced" : "started" };
	} finally {
		unlock();
	}
}
