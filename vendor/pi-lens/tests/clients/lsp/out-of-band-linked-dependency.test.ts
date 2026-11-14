/**
 * A rebuilt LINKED dependency restarts the root's primary language servers.
 *
 * Recurrence it prevents (2026-11-12): the harness's `node_modules` is a
 * symbolic link into a vendored checkout, and its `@earendil-works/*` entries
 * link on to `packages/<name>`, which the vendored checkout builds in place.
 * Rebuilding it rewrote `packages/coding-agent/dist/*.d.ts`. No install stamp
 * moved (no lockfile, no install marker), and the declaration walk skipped
 * both `node_modules` and `dist`, so no look published anything: the
 * TypeScript server kept the old `CompactionEntry` and reported ts(2339)
 * "Property 'provider' does not exist" as a blocker, even through
 * `lens_diagnostics source=lsp`, while `tsc --noEmit -p .` passed.
 *
 * | Cell | Disk change between two looks | Published | Restart |
 * |---|---|---|---|
 * | the incident layout: `node_modules` itself a link, a scoped package linking into the root | `dist/x.d.ts` rewritten | `linked-dependency`, paths `unknown`, the file's event | the root |
 * | a linked package outside the root | `dist/index.d.ts` rewritten | `linked-dependency`, the real path | the root |
 * | a linked package's declaration deleted | `dist/old.d.ts` removed | `linked-dependency`, `deleted` | the root |
 * | control: the root's own declaration | `types/globals.d.ts` rewritten | `declarations` only | none |
 * | a link into a package store (`node_modules` in its real path) | its `index.d.ts` rewritten | nothing | none |
 * | a link back to the root | `dist/app.d.ts` rewritten (an excluded dir) | nothing | none |
 *
 * Real: the out-of-band look, the disk-change publisher and both subscribers,
 * the diagnostics-cache refusal clock. Doubled only at the process boundary:
 * the language-server service behind the real lifecycle seam, so the restart is
 * observed as the call production makes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDegradationLedger } from "../../../clients/degradation-ledger.js";
import {
	type DiskChange,
	subscribeDiskChange,
} from "../../../clients/disk-changes.js";
import {
	getLSPService,
	resetLSPService,
} from "../../../clients/lsp/capabilities.js";
import { workspaceFileCreatedAtFor } from "../../../clients/lsp/workspace-diagnostics-session.js";
import { lookForOutOfBandChanges } from "../../../clients/out-of-band-changes.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { makeLspServiceDouble } from "../../support/lsp-service-double.js";
import { installLspService } from "../../support/lsp-service-seam.js";
import { setupTestEnvironment } from "../test-utils.js";

let env: { tmpDir: string; cleanup: () => void };
let root: string;
let restarts: string[];
let notified: string[];
let published: DiskChange[];
const cleanups: Array<() => void> = [];
const previousInterval = process.env.PI_LENS_DECLARATION_LOOK_MS;

function write(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

/** Rewrite a file so its stat fingerprint moves, as a rebuild does. */
function rebuild(file: string, text: string): void {
	write(file, text);
	const later = new Date(Date.now() + 5_000);
	fs.utimesSync(file, later, later);
}

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-linked-dep-");
	root = path.join(env.tmpDir, "harness");
	write(path.join(root, "package.json"), "{}\n");
	write(path.join(root, "types", "globals.d.ts"), "declare const A: 1;\n");
	restarts = [];
	notified = [];
	published = [];
	process.env.PI_LENS_DECLARATION_LOOK_MS = "0";
	resetDegradationLedger();
	resetLSPService();
	installLspService(
		makeLspServiceDouble({
			livePrimaryClientRoots: () => [],
			restartPrimaryClientsUnder: async (at: string) => {
				restarts.push(normalizeMapKey(at));
				return 1;
			},
			notifyOutOfBandFileChanges: (
				events: ReadonlyArray<{ filePath: string; type: number }>,
			) => {
				for (const event of events)
					notified.push(`${event.type}:${event.filePath}`);
			},
			getOpenDocumentPaths: () => [],
		}),
	);
	getLSPService();
	cleanups.push(
		subscribeDiskChange("linked-dependency-observer", (change) => {
			published.push(change);
		}),
	);
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	if (previousInterval === undefined)
		delete process.env.PI_LENS_DECLARATION_LOOK_MS;
	else process.env.PI_LENS_DECLARATION_LOOK_MS = previousInterval;
	resetLSPService();
	env.cleanup();
});

/** The harness layout: `node_modules` -> `vendor/pi/node_modules`, scoped links into `packages/`. */
function plantIncidentLayout(): string {
	const vendor = path.join(root, "vendor", "pi");
	const pkg = path.join(vendor, "packages", "coding-agent");
	write(path.join(pkg, "package.json"), '{"types":"dist/index.d.ts"}\n');
	write(
		path.join(pkg, "dist", "core", "session-manager.d.ts"),
		"export interface CompactionEntry { summary: string }\n",
	);
	fs.mkdirSync(path.join(vendor, "node_modules", "@earendil-works"), {
		recursive: true,
	});
	fs.symlinkSync(
		path.join("..", "..", "packages", "coding-agent"),
		path.join(vendor, "node_modules", "@earendil-works", "pi-coding-agent"),
	);
	fs.symlinkSync(
		path.join("vendor", "pi", "node_modules"),
		path.join(root, "node_modules"),
	);
	return path.join(pkg, "dist", "core", "session-manager.d.ts");
}

describe("a declaration change inside a linked dependency", () => {
	it("restarts the root's primaries when a scoped package linked through a linked node_modules is rebuilt", async () => {
		const declaration = plantIncidentLayout();
		await lookForOutOfBandChanges(root, "tool_result");
		expect(published).toEqual([]);

		rebuild(
			declaration,
			"export interface CompactionEntry { summary: string; provider: string }\n",
		);
		await lookForOutOfBandChanges(root, "tool_result");

		expect(restarts).toEqual([normalizeMapKey(root)]);
		expect(published).toHaveLength(1);
		const [change] = published;
		expect(change?.sources).toEqual(["declarations", "linked-dependency"]);
		// Every importer's analysis moved, so the cache refuses every entry
		// scanned before the rebuild, not just the declaration's own.
		expect(change?.paths).toBe("unknown");
		expect(
			workspaceFileCreatedAtFor(
				() => true,
				() => true,
			),
		).toBeGreaterThan(0);
		// The event names the file under the root, the path the server read.
		expect(notified).toEqual([`2:${declaration}`]);
	});

	it("reads a linked package whose real path is outside the root", async () => {
		const outside = path.join(env.tmpDir, "sibling-pkg");
		const declaration = path.join(outside, "dist", "index.d.ts");
		write(declaration, "export type V = 1;\n");
		fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
		fs.symlinkSync(outside, path.join(root, "node_modules", "sibling-pkg"));
		await lookForOutOfBandChanges(root, "tool_result");

		rebuild(declaration, "export type V = 2;\n");
		await lookForOutOfBandChanges(root, "tool_result");

		expect(restarts).toEqual([normalizeMapKey(root)]);
		expect(notified).toEqual([`2:${fs.realpathSync.native(declaration)}`]);
	});

	it("restarts when a rebuild deletes a linked declaration", async () => {
		const declaration = plantIncidentLayout();
		const stale = path.join(path.dirname(declaration), "old.d.ts");
		write(stale, "export {};\n");
		await lookForOutOfBandChanges(root, "tool_result");

		fs.rmSync(stale);
		await lookForOutOfBandChanges(root, "tool_result");

		expect(restarts).toEqual([normalizeMapKey(root)]);
		expect(published[0]?.sources).toContain("linked-dependency");
		expect(notified).toEqual([`3:${stale}`]);
	});

	it("sends the root's own declaration change as an event, with no restart (control)", async () => {
		plantIncidentLayout();
		await lookForOutOfBandChanges(root, "tool_result");

		const own = path.join(root, "types", "globals.d.ts");
		rebuild(own, "declare const A: 2;\n");
		await lookForOutOfBandChanges(root, "tool_result");

		expect(restarts).toEqual([]);
		expect(published[0]?.sources).toEqual(["declarations"]);
		expect(published[0]?.paths).toEqual([normalizeMapKey(own)]);
		expect(notified).toEqual([`2:${own}`]);
	});

	it("leaves a link into a package store to the install stamp", async () => {
		const store = path.join(
			root,
			"node_modules",
			".pnpm",
			"dep@1.0.0",
			"node_modules",
			"dep",
		);
		const declaration = path.join(store, "index.d.ts");
		write(declaration, "export type D = 1;\n");
		fs.symlinkSync(store, path.join(root, "node_modules", "dep"));
		await lookForOutOfBandChanges(root, "tool_result");

		rebuild(declaration, "export type D = 2;\n");
		await lookForOutOfBandChanges(root, "tool_result");

		expect(published).toEqual([]);
		expect(restarts).toEqual([]);
	});

	it("does not walk a link back to the root without the shared exclusions", async () => {
		const built = path.join(root, "dist", "app.d.ts");
		write(built, "export {};\n");
		fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
		fs.symlinkSync(root, path.join(root, "node_modules", "self"));
		await lookForOutOfBandChanges(root, "tool_result");

		rebuild(built, "export type B = 1;\n");
		await lookForOutOfBandChanges(root, "tool_result");

		expect(published).toEqual([]);
		expect(restarts).toEqual([]);
	});
});
