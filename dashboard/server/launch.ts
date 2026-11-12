// Start the usage dashboard detached, so it outlives the Pi process that asked for it
// (`/harness dashboard`, `npm run dashboard -- --detach`), building the frontend first when its
// sources changed.
//
// The detached server logs to <agent dir>/dashboard.log. A running server is recognised by its
// /api/status answer and reused.

import { execFile, spawn } from "node:child_process";
import { existsSync, openSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { APP, DEFAULT_PORT, HOST } from "./server.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const START_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 1_000;

/** Whether a dashboard answers on `port`. */
export async function running(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://${HOST}:${port}/api/status`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
		return response.ok && ((await response.json()) as { app?: string }).app === APP;
	} catch {
		return false;
	}
}

function newest(path: string): number {
	const stat = statSync(path);
	if (!stat.isDirectory()) return stat.mtimeMs;
	return Math.max(stat.mtimeMs, ...readdirSync(path).map((name) => newest(join(path, name))));
}

// What the build reads besides src/.
const BUILD_INPUTS = ["src", "index.html", "package.json", "vite.config.ts", "tailwind.config.ts", "postcss.config.js", "tsconfig.json"];

/** Whether dist is missing or older than a build input (the server's own types included). */
export function stale(root = ROOT): boolean {
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
export async function build(log: (line: string) => void = () => {}): Promise<void> {
	if (!stale()) return;
	const run = (args: string[]) => promisify(execFile)(npm(), args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
	if (!existsSync(join(ROOT, "node_modules"))) {
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
	await build();
	const log = openSync(join(agentDir, "dashboard.log"), "a");
	const child = spawn(process.execPath, [MAIN, "--port", String(port)], {
		cwd: resolve(ROOT, ".."),
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
