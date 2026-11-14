// flake-shape: real-process-spawn — the closes under test are real didClose notifications on a real JSON-RPC wire to the fake-server child; the timer layer uses fake timers.
// flake-shape: raw-timer-wait — one 50 ms real tick lets the queued didClose reach the real wire; fake timers would stall the child's I/O.
/**
 * Open-document bound (`clients/lsp/open-document-limit.ts`).
 *
 * Recurrence this file prevents: pi-lens opened every document it read
 * diagnostics for and never closed it. `lake serve` runs one ~700 MB
 * `lean --worker` per open document, so parallel agents reached 50 GB.
 *
 * Three layers: the pure selection, the REAL client over a real JSON-RPC wire
 * (`createLSPClient` + the fake server; the wire is only spied on), and the
 * REAL notify queue over a connection double for the timer path.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLSPClient,
	handleNotifyOpen,
	type LSPClientInfo,
} from "../../../clients/lsp/client.js";
import { stopLSP } from "../../../clients/lsp/launch.js";
import {
	DEFAULT_OPEN_DOCUMENT_LIMIT,
	type OpenDocumentUse,
	READ_DOCUMENT_HOLD_MS,
	selectOpenDocumentEvictions,
	UNREAD_DOCUMENT_GRACE_MS,
} from "../../../clients/lsp/open-document-limit.js";
import { getStrategy } from "../../../clients/lsp/wait-policy/index.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { removeTempDirSync } from "../test-utils.js";
import { createMockState } from "./mock-client-state.js";

describe("selectOpenDocumentEvictions", () => {
	const NOW = 1_000_000;
	const read = (sentAt: number, readAt: number): OpenDocumentUse => ({
		sentAt,
		readAt,
	});
	const select = (
		use: Record<string, OpenDocumentUse | undefined>,
		limit: number,
		busy: string[] = [],
	) =>
		selectOpenDocumentEvictions({
			open: new Set(Object.keys(use)),
			use: new Map(
				Object.entries(use).filter(
					(entry): entry is [string, OpenDocumentUse] => entry[1] !== undefined,
				),
			),
			limit,
			busy: (p) => busy.includes(p),
			now: NOW,
		});
	const longAgo = NOW - UNREAD_DOCUMENT_GRACE_MS - 1;

	it("closes nothing at or under the limit", () => {
		expect(select({ a: read(longAgo, longAgo) }, 1)).toEqual({ evict: [] });
		expect(select({}, 0)).toEqual({ evict: [] });
	});

	it("closes the least recently sent documents first, only as many as exceed the limit", () => {
		expect(
			select(
				{
					c: read(longAgo + 2, longAgo + 2),
					a: read(longAgo, longAgo),
					b: read(longAgo + 1, longAgo + 1),
				},
				1,
			),
		).toEqual({ evict: ["a", "b"] });
	});

	it("limit 0 closes every read document; a negative limit reads as 0", () => {
		const use = { a: read(longAgo, longAgo), b: read(longAgo, longAgo) };
		expect(select(use, 0).evict.sort()).toEqual(["a", "b"]);
		expect(select(use, -3).evict.sort()).toEqual(["a", "b"]);
	});

	it("never closes a busy document, and does not wait for it either", () => {
		const result = select(
			{ a: read(longAgo, longAgo), b: read(longAgo, longAgo) },
			0,
			["a"],
		);
		expect(result).toEqual({ evict: ["b"] });
	});

	it("holds a read document for the read hold, then closes it", () => {
		const readAt = NOW - READ_DOCUMENT_HOLD_MS + 10;
		expect(select({ a: read(readAt - 1, readAt) }, 0)).toEqual({
			evict: [],
			retryAt: readAt + READ_DOCUMENT_HOLD_MS,
		});
		const expired = NOW - READ_DOCUMENT_HOLD_MS;
		expect(select({ a: read(expired - 1, expired) }, 0)).toEqual({
			evict: ["a"],
		});
	});

	it("holds an unread document for the unread grace, even when a read predates its last send", () => {
		const sentAt = NOW - 1_000;
		expect(select({ a: { sentAt } }, 0)).toEqual({
			evict: [],
			retryAt: sentAt + UNREAD_DOCUMENT_GRACE_MS,
		});
		// A read of the previous content does not cover the new send.
		expect(select({ a: read(sentAt, sentAt - 1) }, 0)).toEqual({
			evict: [],
			retryAt: sentAt + UNREAD_DOCUMENT_GRACE_MS,
		});
		expect(select({ a: { sentAt: longAgo } }, 0)).toEqual({ evict: ["a"] });
	});

	it("closes an open document with no recorded send (a failed open write)", () => {
		expect(select({ a: undefined }, 0)).toEqual({ evict: ["a"] });
	});

	it("reports the earliest time a held document becomes closable", () => {
		const late = NOW - 100;
		const early = NOW - 4_000;
		expect(
			select({ a: read(late, late), b: read(early, early) }, 0).retryAt,
		).toBe(early + READ_DOCUMENT_HOLD_MS);
	});

	it("Lean closes every document once read; other servers keep the default", () => {
		expect(getStrategy("lean").openDocumentLimit).toBe(0);
		// A command override runs another binary but keeps the lower limit.
		expect(getStrategy("lean", "override").openDocumentLimit).toBe(0);
		expect(getStrategy("typescript").openDocumentLimit).toBeUndefined();
		expect(DEFAULT_OPEN_DOCUMENT_LIMIT).toBe(16);
	});
});

describe("the client closes read documents over its server's limit", () => {
	let root: string;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-open-limit-"));
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {});
		removeTempDirSync(root);
	});

	async function client(serverId: string) {
		const proc = await spawnFakeLspServer({ cwd: root });
		const c = await createLSPClient({ serverId, process: proc, root });
		cleanups.push(async () => {
			await c.shutdown().catch(() => {});
			await stopLSP(proc).catch(() => {});
		});
		const wire: string[] = [];
		const send = c.connection.sendNotification.bind(c.connection);
		vi.spyOn(c.connection, "sendNotification").mockImplementation(((
			method: string,
			params: { textDocument?: { uri?: string } },
		) => {
			const uri = params?.textDocument?.uri;
			if (/^textDocument\/did(Open|Close)$/.test(method) && uri)
				wire.push(
					`${method.slice("textDocument/".length)} ${path.basename(new URL(uri).pathname)}`,
				);
			return send(method, params);
		}) as typeof c.connection.sendNotification);
		return { c, wire };
	}

	function file(name: string): string {
		const p = path.join(root, name);
		fs.writeFileSync(p, `-- ${name}\n`);
		return p;
	}

	async function touch(c: LSPClientInfo, p: string) {
		expect(await c.notify.open(p, fs.readFileSync(p, "utf8"), "lean")).toBe(
			true,
		);
		await c.waitForDiagnostics(p, 100);
	}

	/** Let queued notify runs (the closes) reach the wire. */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

	function advanceClock(ms: number) {
		const real = Date.now.bind(Date);
		vi.spyOn(Date, "now").mockImplementation(() => real() + ms);
	}

	it("limit 0: a read document stays for the hold, then the next send closes it", async () => {
		const { c, wire } = await client("lean");
		const a = file("A.lean");
		const b = file("B.lean");
		await touch(c, a);
		await settle();
		// Held: the touch that read it may still read again.
		expect(c.isDocumentOpen(a)).toBe(true);
		expect(wire).toEqual(["didOpen A.lean"]);

		advanceClock(READ_DOCUMENT_HOLD_MS + 1);
		expect(await c.notify.open(b, fs.readFileSync(b, "utf8"), "lean")).toBe(
			true,
		);
		await settle();
		expect(c.isDocumentOpen(a)).toBe(false);
		// B is unread: its open stays for the caller's wait.
		expect(c.isDocumentOpen(b)).toBe(true);
		expect(wire).toEqual([
			"didOpen A.lean",
			"didOpen B.lean",
			"didClose A.lean",
		]);

		// A touch after the close re-opens it, with fresh content.
		await touch(c, a);
		expect(wire.at(-1)).toBe("didOpen A.lean");
		expect(c.isDocumentOpen(a)).toBe(true);
	});

	it("never closes a document whose diagnostics wait is running", async () => {
		const { c, wire } = await client("lean");
		const a = file("A.lean");
		const b = file("B.lean");
		await touch(c, a);
		advanceClock(READ_DOCUMENT_HOLD_MS + 1);
		const waiting = c.waitForDiagnostics(a, 400);
		await c.notify.open(b, fs.readFileSync(b, "utf8"), "lean");
		await settle();
		expect(c.isDocumentOpen(a)).toBe(true);
		expect(wire).not.toContain("didClose A.lean");
		await waiting;
		// The wait just read A again: it is held from now on.
		await settle();
		expect(c.isDocumentOpen(a)).toBe(true);
	});

	it("the default limit keeps the 16 most recently sent documents", async () => {
		const { c, wire } = await client("fake-default-limit");
		const paths = Array.from(
			{ length: DEFAULT_OPEN_DOCUMENT_LIMIT + 2 },
			(_, i) => file(`F${String(i).padStart(2, "0")}.lean`),
		);
		for (const p of paths.slice(0, -1)) await touch(c, p);
		await settle();
		// 17 open, all within their read hold.
		expect(c.openDocumentPaths?.()).toHaveLength(
			DEFAULT_OPEN_DOCUMENT_LIMIT + 1,
		);

		advanceClock(READ_DOCUMENT_HOLD_MS + 1);
		await c.notify.open(paths.at(-1)!, "x", "lean");
		await settle();
		expect(wire.filter((w) => w.startsWith("didClose"))).toEqual([
			"didClose F00.lean",
			"didClose F01.lean",
		]);
		expect(c.openDocumentPaths?.()).toHaveLength(DEFAULT_OPEN_DOCUMENT_LIMIT);
	});
});

describe("a held document is closed by the timer when nothing else runs", () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-open-limit-timer-"));
	});
	afterEach(() => {
		vi.useRealTimers();
		removeTempDirSync(root);
	});

	it("an unread open is closed when its grace ends, not before", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const state = createMockState({ root, serverId: "lean" });
		const p = path.join(root, "Main.lean");
		fs.writeFileSync(p, "def x := 1\n");
		const closes = () =>
			vi
				.mocked(state.connection.sendNotification)
				.mock.calls.filter(([m]) => m === "textDocument/didClose");

		expect(await handleNotifyOpen(state, p, "def x := 1\n", "lean")).toBe(true);
		await vi.advanceTimersByTimeAsync(UNREAD_DOCUMENT_GRACE_MS - 1_000);
		expect(closes()).toHaveLength(0);
		expect(state.openDocuments.has(normalizeMapKey(p))).toBe(true);

		await vi.advanceTimersByTimeAsync(1_001);
		expect(closes()).toEqual([
			[
				"textDocument/didClose",
				{ textDocument: { uri: pathToFileURL(p).href } },
			],
		]);
		expect(state.openDocuments.has(normalizeMapKey(p))).toBe(false);
		expect(state.openDocumentTrimTimer).toBeUndefined();
	});
});
