// flake-shape: real-process-spawn — the per-document `lean --worker` processes Lake starts and stops are the behavior under test; no double reproduces the Lake/elan process tree.
// flake-shape: elapsed-time-assertion — the read hold is the behavior: a real worker must outlive its read by the hold; a fake clock cannot time another process's exit.
/**
 * pi-lens's Lean server releases each `lean --worker` once it has read the
 * document's diagnostics, and leaves no process behind at shutdown.
 *
 * Recurrence this file prevents: every `.lean` document pi-lens opened stayed
 * open, and `lake serve` keeps one ~700 MB `lean --worker` per open document
 * (in its own process group, out of reach of the client's group kill).
 * Parallel agents reached 50 GB. The Lean strategy's open-document limit of 0
 * closes each document after its read hold, which ends the worker.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLSPClient } from "../../../clients/lsp/client.js";
import { launchLSP, stopLSP } from "../../../clients/lsp/launch.js";
import { READ_DOCUMENT_HOLD_MS } from "../../../clients/lsp/open-document-limit.js";
import { removeTempDirSync } from "../test-utils.js";
import { installedLeanToolchain } from "./lean-toolchain.js";

const lean = installedLeanToolchain();

interface Proc {
	pid: number;
	command: string;
}

/** Every live descendant of `rootPid`, by parent pid (workers leave the group). */
function descendants(rootPid: number): Proc[] {
	const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.map((line) => {
			const [pid, ppid, ...command] = line.trim().split(/\s+/);
			return {
				pid: Number(pid),
				ppid: Number(ppid),
				command: command.join(" "),
			};
		});
	const ids = new Set([rootPid]);
	for (let grew = true; grew;) {
		grew = false;
		for (const row of rows)
			if (!ids.has(row.pid) && ids.has(row.ppid)) {
				ids.add(row.pid);
				grew = true;
			}
	}
	return rows
		.filter((row) => ids.has(row.pid))
		.map(({ pid, command }) => ({ pid, command }));
}

const workers = (rootPid: number) =>
	descendants(rootPid).filter((p) => p.command.includes("--worker"));

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

let root: string | undefined;
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	await cleanup?.().catch(() => {});
	cleanup = undefined;
	if (root) removeTempDirSync(root);
	root = undefined;
});

describe("Lean worker lifecycle (real lake serve)", () => {
	it.skipIf(lean === undefined)(
		"a worker runs while a document is read, exits after the read hold, and shutdown leaves no process",
		async () => {
			root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lean-workers-"));
			fs.writeFileSync(
				path.join(root, "lean-toolchain"),
				`${lean?.toolchain}\n`,
			);
			fs.writeFileSync(
				path.join(root, "lakefile.lean"),
				"import Lake\nopen Lake DSL\npackage leanWorkers\nlean_lib A\nlean_lib B\n",
			);
			const a = path.join(root, "A.lean");
			const b = path.join(root, "B.lean");
			fs.writeFileSync(a, 'def wrong : Nat := "not a natural number"\n');
			fs.writeFileSync(b, "def fine : Nat := 1\n");

			const server = await launchLSP("lake", ["serve"], {
				cwd: root,
				env: lean?.env,
			});
			const client = await createLSPClient({
				serverId: "lean",
				process: server,
				root,
			});
			const seen = new Map<number, string>();
			const record = () => {
				for (const p of descendants(server.pid)) seen.set(p.pid, p.command);
			};
			cleanup = async () => {
				await client.shutdown().catch(() => {});
				await stopLSP(server).catch(() => {});
				for (const pid of seen.keys())
					if (isAlive(pid)) spawnSync("kill", ["-9", String(pid)]);
			};

			for (const file of [a, b]) {
				expect(
					await client.notify.open(file, fs.readFileSync(file, "utf8"), "lean"),
				).toBe(true);
			}
			// Both documents open and unread: one worker each.
			await expect
				.poll(() => (record(), workers(server.pid).length), {
					interval: 100,
					timeout: 30_000,
				})
				.toBe(2);

			// Each document is read with the budget the service gives Lean; its
			// worker stays for the read hold, then the hold timer closes it, with
			// no further touch.
			const workerFor = (file: string) =>
				workers(server.pid).some((w) =>
					w.command.includes(path.basename(file)),
				);
			for (const file of [a, b]) {
				await client.waitForDiagnostics(file, 1_500);
				const readAt = Date.now();
				expect(client.isDocumentOpen(file)).toBe(true);
				expect(workerFor(file)).toBe(true);
				await expect
					.poll(() => (record(), workerFor(file)), {
						interval: 100,
						timeout: READ_DOCUMENT_HOLD_MS + 10_000,
					})
					.toBe(false);
				expect(Date.now() - readAt).toBeGreaterThanOrEqual(
					READ_DOCUMENT_HOLD_MS - 200,
				);
				expect(client.isDocumentOpen(file)).toBe(false);
			}
			expect(workers(server.pid)).toEqual([]);
			expect(client.openDocumentPaths?.()).toEqual([]);
			// The server itself stays for the next touch.
			expect(isAlive(server.pid)).toBe(true);

			// A touch after the close re-opens it and gets the answer: the type
			// error, while the read holds the document.
			await client.notify.open(a, fs.readFileSync(a, "utf8"), "lean");
			await client.waitForDiagnostics(a, 30_000);
			await expect
				.poll(
					() =>
						client
							.getDiagnostics(a)
							.map((d) => d.message)
							.join("\n"),
					{
						interval: 100,
						timeout: 30_000,
					},
				)
				.toContain("String");
			record();

			await client.shutdown();
			await stopLSP(server);
			const survivors = () =>
				[...seen]
					.filter(([pid]) => isAlive(pid))
					.map(([pid, c]) => `${pid} ${c}`);
			await expect
				.poll(survivors, { interval: 100, timeout: 5_000 })
				.toEqual([]);
			expect([...seen.values()].some((c) => c.includes("--worker"))).toBe(true);
		},
		120_000,
	);
});
