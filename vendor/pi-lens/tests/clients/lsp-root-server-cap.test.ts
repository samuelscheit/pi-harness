/**
 * The per-root cap on primary language servers across pi processes
 * (`clients/lsp-budget.ts` `decideRootServerAdmission`, `admitRootServerSpawn`).
 *
 * Recurrence it prevents (2026-11-14): eight delegated agents edited one
 * worktree, each its own pi process with its own LSP service, and each started
 * its own TypeScript server for the same root: 51 tsserver processes, about
 * 10.9 GB RSS. The machine-wide budget sheds only auxiliaries, so nothing
 * bounded a primary per root.
 *
 * | Cell | Other live hosts at `(typescript, root)` | Verdict |
 * |---|---|---|
 * | below the cap | 1 | admitted |
 * | the cap reached | 2 | refused, row names the holders |
 * | other root, other server, a legacy row without a root | 0 counted | admitted |
 * | this process's own child | not counted | admitted |
 * | a host that exited | not counted | admitted |
 * | a foreign pid namespace, stale heartbeat | not counted | admitted |
 * | a session exit through the real registry | counted, then 0 after `deregisterInstance` | refused, then admitted |
 * | a server exit through the real registry | counted, then 0 after `removeLspChild` | refused, then admitted |
 *
 * Liveness is injected for the pure cells. The real-registry cells pin
 * `PI_LENS_HOME` and use this process's own entry, read by a peer
 * (`selfPid` of another process), because the registry writes only its own
 * pid's entry.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetInstanceRegistryEnabledForTests,
	deregisterInstance,
	type InstanceEntry,
	type LspChildEntry,
	readInstanceRegistry,
	recordLspChild,
	registerInstance,
	removeLspChild,
} from "../../clients/instance-registry.js";
import { STALE_HEARTBEAT_MS } from "../../clients/instance-reaper.js";
import {
	_setRecentPhasesForTest,
	getRecentLoggedPhases,
} from "../../clients/latency-logger.js";
import {
	admitRootServerSpawn,
	DEFAULT_LSP_SERVERS_PER_ROOT,
	decideRootServerAdmission,
	getLspServersPerRoot,
} from "../../clients/lsp-budget.js";
import { removeTempDirSync } from "./test-utils.js";

const ROOT = "/work/myrodex";
const NOW = Date.parse("2026-11-14T20:00:00.000Z");

function child(overrides: Partial<LspChildEntry> = {}): LspChildEntry {
	return {
		pid: 5000,
		serverId: "typescript",
		command: "typescript-language-server",
		spawnedAt: new Date(NOW).toISOString(),
		root: ROOT,
		...overrides,
	};
}

function host(pid: number, children: LspChildEntry[]): InstanceEntry {
	return {
		pid,
		startedAt: new Date(NOW).toISOString(),
		projectRoot: ROOT,
		lspChildren: children,
		lspChildCount: children.length,
		rssBytes: 0,
		heartbeatAt: new Date(NOW).toISOString(),
	};
}

const everyPidAlive = () => true;
const ask = { serverId: "typescript", root: ROOT, selfPid: 1 };

describe("decideRootServerAdmission", () => {
	it("admits while other hosts hold fewer servers than the cap", () => {
		const verdict = decideRootServerAdmission(
			[host(11, [child()])],
			ask,
			everyPidAlive,
			2,
			NOW,
		);
		expect(verdict).toEqual({ admitted: true, live: 1, cap: 2, holders: [11] });
	});

	it("refuses once the cap is reached", () => {
		const verdict = decideRootServerAdmission(
			[host(11, [child()]), host(12, [child({ pid: 5001 })])],
			ask,
			everyPidAlive,
			2,
			NOW,
		);
		expect(verdict).toEqual({
			admitted: false,
			live: 2,
			cap: 2,
			holders: [11, 12],
		});
	});

	it("counts only the same server at the same root identity", () => {
		const verdict = decideRootServerAdmission(
			[
				host(11, [child({ root: "/work/other" })]),
				host(12, [child({ serverId: "deno" })]),
				// A row written before the cap carries no root.
				host(13, [child({ root: undefined })]),
				host(14, [child()]),
			],
			// The ask spells the root another way; the record is normalized.
			{ ...ask, root: `${ROOT}/./` },
			everyPidAlive,
			2,
			NOW,
		);
		expect(verdict.holders).toEqual([14]);
		expect(verdict.admitted).toBe(true);
	});

	it("does not count this process's own servers", () => {
		const verdict = decideRootServerAdmission(
			[host(1, [child()]), host(11, [child({ pid: 5001 })])],
			ask,
			everyPidAlive,
			2,
			NOW,
		);
		expect(verdict.holders).toEqual([11]);
		expect(verdict.admitted).toBe(true);
	});

	it("releases the servers of a host that exited", () => {
		const exited = 13;
		const verdict = decideRootServerAdmission(
			[host(exited, [child()]), host(12, [child({ pid: 5001 })])],
			ask,
			(pid) => pid !== exited,
			2,
			NOW,
		);
		expect(verdict).toEqual({ admitted: true, live: 1, cap: 2, holders: [12] });
	});

	it("does not count a foreign namespace's host whose heartbeat went stale", () => {
		const stale = {
			...host(11, [child()]),
			pidNamespace: "pid:[4026531836]",
			heartbeatAt: new Date(NOW - STALE_HEARTBEAT_MS - 1).toISOString(),
		};
		const fresh = {
			...stale,
			pid: 12,
			heartbeatAt: new Date(NOW).toISOString(),
		};
		const verdict = decideRootServerAdmission(
			[stale, fresh],
			ask,
			() => false,
			1,
			NOW,
			"pid:[1]",
		);
		expect(verdict.holders).toEqual([12]);
		expect(verdict.admitted).toBe(false);
	});
});

describe("getLspServersPerRoot", () => {
	const previous = process.env.PI_LENS_LSP_SERVERS_PER_ROOT;
	afterEach(() => {
		if (previous === undefined) delete process.env.PI_LENS_LSP_SERVERS_PER_ROOT;
		else process.env.PI_LENS_LSP_SERVERS_PER_ROOT = previous;
	});

	it("reads a positive integer override and ignores anything else", () => {
		delete process.env.PI_LENS_LSP_SERVERS_PER_ROOT;
		expect(getLspServersPerRoot()).toBe(DEFAULT_LSP_SERVERS_PER_ROOT);
		process.env.PI_LENS_LSP_SERVERS_PER_ROOT = "4";
		expect(getLspServersPerRoot()).toBe(4);
		for (const bad of ["0", "-1", "1.5", "abc", ""]) {
			process.env.PI_LENS_LSP_SERVERS_PER_ROOT = bad;
			expect(getLspServersPerRoot()).toBe(DEFAULT_LSP_SERVERS_PER_ROOT);
		}
	});
});

describe("the per-root cap over the real registry", () => {
	let home: string;
	let root: string;
	const previousHome = process.env.PI_LENS_HOME;
	const previousCap = process.env.PI_LENS_LSP_SERVERS_PER_ROOT;

	beforeEach(() => {
		home = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-root-cap-")),
		);
		root = path.join(home, "project");
		fs.mkdirSync(root);
		process.env.PI_LENS_HOME = home;
		process.env.PI_LENS_LSP_SERVERS_PER_ROOT = "1";
		_resetInstanceRegistryEnabledForTests();
		_setRecentPhasesForTest([]);
	});

	afterEach(() => {
		deregisterInstance();
		_resetInstanceRegistryEnabledForTests();
		if (previousHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = previousHome;
		if (previousCap === undefined)
			delete process.env.PI_LENS_LSP_SERVERS_PER_ROOT;
		else process.env.PI_LENS_LSP_SERVERS_PER_ROOT = previousCap;
		removeTempDirSync(home);
	});

	/** What a peer process (any pid but ours) is told for this root. */
	async function peerVerdict() {
		return decideRootServerAdmission(
			await readInstanceRegistry(),
			{ serverId: "typescript", root, selfPid: -1 },
			(pid) => pid === process.pid,
			1,
		);
	}

	async function holdServer(pid: number): Promise<void> {
		await registerInstance(root);
		await recordLspChild({
			pid,
			serverId: "typescript",
			command: "typescript-language-server",
			root,
		});
	}

	it("frees the slot when the session that held it ends", async () => {
		await holdServer(process.pid + 100_000);
		expect(await peerVerdict()).toMatchObject({
			admitted: false,
			holders: [process.pid],
		});

		deregisterInstance();

		expect(await peerVerdict()).toMatchObject({ admitted: true, live: 0 });
	});

	it("frees the slot when the server itself exits", async () => {
		const serverPid = process.pid + 100_000;
		await holdServer(serverPid);
		expect((await peerVerdict()).admitted).toBe(false);

		await removeLspChild(serverPid);

		expect(await peerVerdict()).toMatchObject({ admitted: true, live: 0 });
	});

	it("writes one cap row naming the holders when a spawn is refused", async () => {
		const registry = [host(11, [child({ root })]), host(12, [child({ root })])];
		const verdict = admitRootServerSpawn("typescript", root, {
			registry,
			isPidAlive: everyPidAlive,
		});
		expect(verdict.admitted).toBe(false);
		const rows = getRecentLoggedPhases().filter(
			(row) => row.phase === "lsp_root_server_cap_reached",
		);
		expect(rows.map((row) => row.metadata)).toEqual([
			{ serverId: "typescript", live: 2, cap: 1, holders: [11, 12] },
		]);
	});

	it("admits without a row when the registry is disabled", async () => {
		process.env.PI_LENS_INSTANCE_REGISTRY = "0";
		_resetInstanceRegistryEnabledForTests();
		try {
			const verdict = admitRootServerSpawn("typescript", root, {
				registry: [host(11, [child({ root })])],
				isPidAlive: everyPidAlive,
			});
			expect(verdict.admitted).toBe(true);
			expect(
				getRecentLoggedPhases().filter(
					(row) => row.phase === "lsp_root_server_cap_reached",
				),
			).toEqual([]);
		} finally {
			delete process.env.PI_LENS_INSTANCE_REGISTRY;
			_resetInstanceRegistryEnabledForTests();
		}
	});
});
