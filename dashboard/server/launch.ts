// Start the usage dashboard detached, so it outlives the Pi process that asked for it
// (`/harness dashboard`, `npm run dashboard -- --detach`), building the frontend first when its
// sources changed.
//
// The detached server logs to <agent dir>/dashboard.log. A running server is recognised by its
// /api/status answer and reused. When the harness runs from releases (extensions/lib/release.ts),
// the server starts from the deployed release, whatever release the caller runs, and
// `restartOutdated` replaces a server that still runs an older one.

import { execFile, spawn } from "node:child_process";
import { existsSync, openSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { currentLink } from "../../extensions/lib/release.ts";
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

/** Start the server detached unless one runs; resolves with its URL once it answers. */
export async function launch({ port = DEFAULT_PORT, agentDir = getAgentDir() } = {}): Promise<{ url: string; started: boolean }> {
	const url = `http://${HOST}:${port}`;
	if (await running(port)) return { url, started: false };
	const root = dashboardRoot(agentDir);
	await build(undefined, root);
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
		if (await running(port)) return { url, started: true };
		if (child.exitCode !== null) break;
		await new Promise((wait) => setTimeout(wait, 200));
	}
	throw new Error(`the dashboard did not start; see ${join(agentDir, "dashboard.log")}`);
}

/**
 * Replace a running dashboard that runs another release than the deployed one: stop it, then
 * start the deployed release's. Does nothing when none runs or it is current. Returns whether it
 * restarted one.
 */
export async function restartOutdated({ port = DEFAULT_PORT, agentDir = getAgentDir(), deployed }: { port?: number; agentDir?: string; deployed: string }): Promise<boolean> {
	const current = await status(port);
	// A server from before status carried its pid cannot be replaced from here.
	if (!current || current.release === deployed || typeof current.pid !== "number") return false;
	try {
		process.kill(current.pid, "SIGTERM");
	} catch {
		// Gone already.
	}
	const deadline = Date.now() + START_TIMEOUT_MS;
	while ((await running(port)) && Date.now() < deadline) await new Promise((wait) => setTimeout(wait, 200));
	await launch({ port, agentDir });
	return true;
}
