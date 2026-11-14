// flake-shape: real-process-spawn — the behavior under test is a real host process dying and taking its real detached language-server child with it; no double can stand in for the OS process group.
// flake-shape: raw-timer-wait — polls the real child's liveness after its host died; only the OS can say when the killed group is gone.
/**
 * A language server dies with the pi process that spawned it.
 *
 * Recurrence this file prevents: language servers are spawned `detached` (their
 * own process group, so the shutdown ladder can kill grandchildren), which
 * also cuts them off from the terminal's signals. When pi exited without its
 * session shutdown (SIGTERM, SIGHUP, a crash in a handler), a server that
 * ignores stdin EOF kept running with nobody to stop it.
 *
 * The server here ignores SIGTERM and stdin EOF, so only the host's own
 * exit-time group SIGKILL (`coupleChildToHostLifetime`) can end it.
 */

import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCH = pathToFileURL(
	path.join(__dirname, "../../../clients/lsp/launch.js"),
).href;

const STUBBORN_SERVER =
	"process.on('SIGTERM',()=>{});process.stdin.on('end',()=>{});process.stdin.resume();setInterval(()=>{},1e9);";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return check();
}

/** A host that launches the stubborn server and then ends the given way. */
function host(end: "sigterm" | "exit"): Promise<number> {
	// The keep-alive stands in for pi's own loop: launchLSP unrefs the child.
	const script = `
		const keepAlive = setInterval(() => {}, 1e9);
		const { launchLSP } = await import(${JSON.stringify(LAUNCH)});
		const lsp = await launchLSP(process.execPath, ["-e", ${JSON.stringify(STUBBORN_SERVER)}]);
		process.stdout.write(String(lsp.pid) + "\\n");
		${end === "exit" ? "setTimeout(() => process.exit(0), 100);" : "void keepAlive;"}
	`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	return new Promise((resolve, reject) => {
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
			const line = out.split("\n")[0];
			if (out.includes("\n")) {
				const pid = Number(line);
				if (end === "sigterm") child.kill("SIGTERM");
				resolve(pid);
			}
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (!out.includes("\n")) reject(new Error(`host exited ${code}`));
		});
	});
}

describe.skipIf(process.platform === "win32")(
	"a language server dies with its host",
	() => {
		for (const end of ["sigterm", "exit"] as const) {
			it(`host ${end}: the detached server is killed`, async () => {
				const pid = await host(end);
				expect(Number.isInteger(pid) && pid > 0).toBe(true);
				try {
					expect(await waitUntil(() => !isAlive(pid), 5_000)).toBe(true);
				} finally {
					if (isAlive(pid)) spawnSync("kill", ["-9", `-${pid}`]);
				}
			}, 30_000);
		}
	},
);
