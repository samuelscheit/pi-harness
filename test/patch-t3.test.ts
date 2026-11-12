import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { integrity, packedFiles, readFile, readHeader, replaceFiles } from "../scripts/lib/asar.ts";
import { PATCHES, patchBundle } from "../scripts/patch-t3.ts";

/** A minimal asar writer (the format Electron reads), independent of the code under test. */
function writeArchive(path: string, tree: Record<string, string | { unpacked: true }>): void {
	const header: { files: Record<string, unknown> } = { files: {} };
	const chunks: Buffer[] = [];
	let offset = 0;
	for (const [filePath, content] of Object.entries(tree)) {
		const parts = filePath.split("/");
		let node = header;
		for (const dir of parts.slice(0, -1)) node = ((node.files[dir] ??= { files: {} }) as typeof header);
		if (typeof content === "string") {
			const bytes = Buffer.from(content);
			node.files[parts.at(-1)!] = { size: bytes.length, offset: String(offset), integrity: integrity(bytes) };
			chunks.push(bytes);
			offset += bytes.length;
		} else {
			node.files[parts.at(-1)!] = { size: 7, unpacked: true };
		}
	}
	const json = Buffer.from(JSON.stringify(header));
	const payload = Buffer.alloc(4 + ((json.length + 3) & ~3));
	payload.writeUInt32LE(json.length, 0);
	json.copy(payload, 4);
	const headerPickle = Buffer.concat([Buffer.alloc(4), payload]);
	headerPickle.writeUInt32LE(payload.length, 0);
	const sizePickle = Buffer.alloc(8);
	sizePickle.writeUInt32LE(4, 0);
	sizePickle.writeUInt32LE(headerPickle.length, 4);
	writeFileSync(path, Buffer.concat([sizePickle, headerPickle, ...chunks]));
}

describe("asar rewrite", () => {
	let dir: string;
	let archive: string;
	const tree = {
		"package.json": '{"name":"t3"}',
		"apps/server/dist/a.mjs": "export const a = 1;\n",
		"apps/server/dist/runtime.mjs": "let pendingWake = null;\n".repeat(50),
		"apps/server/dist/z.mjs": "z".repeat(10_000),
		"node_modules/native/addon.node": { unpacked: true } as const,
		"README.md": "",
	};
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "asar-"));
		archive = join(dir, "app.asar");
		writeArchive(archive, tree);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("reads the files written by an independent writer, unpacked ones excluded", () => {
		const { header } = readHeader(archive);
		assert.deepEqual(packedFiles(header).map((f) => f.path).sort(), ["README.md", "apps/server/dist/a.mjs", "apps/server/dist/runtime.mjs", "apps/server/dist/z.mjs", "package.json"]);
		assert.equal(readFile(archive, "apps/server/dist/z.mjs").toString(), tree["apps/server/dist/z.mjs"]);
		assert.equal(readFile(archive, "README.md").length, 0);
	});

	test("replacing a file in the middle keeps every other file, shifts offsets and updates integrity", () => {
		const replacement = Buffer.from("let pendingWake = null;\nlet cacheWarmingPending = false;\n");
		replaceFiles(archive, { "apps/server/dist/runtime.mjs": replacement });
		const { header } = readHeader(archive);
		for (const [path, content] of Object.entries(tree)) {
			if (typeof content !== "string") continue;
			const expected = path === "apps/server/dist/runtime.mjs" ? replacement : Buffer.from(content);
			assert.deepEqual(readFile(archive, path), expected, path);
		}
		const files = packedFiles(header);
		let next = 0;
		for (const { node } of files) {
			assert.equal(Number(node.offset), next);
			next += node.size;
		}
		const node = files.find((f) => f.path === "apps/server/dist/runtime.mjs")!.node;
		assert.equal(node.integrity?.hash, createHash("sha256").update(replacement).digest("hex"));
		const modules = header.files.node_modules as { files: { native: { files: Record<string, unknown> } } };
		assert.deepEqual(modules.files.native.files["addon.node"], { size: 7, unpacked: true });
		assert.equal(readFileSync(archive).length, readHeader(archive).dataOffset + next);
	});

	test("an unknown path is rejected before anything is written", () => {
		const before = readFileSync(archive);
		assert.throws(() => replaceFiles(archive, { "nope.mjs": Buffer.from("x") }), /not a packed file/);
		assert.throws(() => replaceFiles(archive, { "node_modules/native/addon.node": Buffer.from("x") }), /not a packed file/);
		assert.deepEqual(readFileSync(archive), before);
	});
});

describe("patchBundle", () => {
	const [cacheWarming, dialogs] = PATCHES as [(typeof PATCHES)[0], (typeof PATCHES)[0]];
	const ALL = ["cache-warming", "dialogs", "session-questions"];
	// An unpatched bundle: every anchor once, except those an earlier patch produces.
	const bundle = PATCHES.flatMap((patch, i) =>
		patch.edits
			.map(([anchor]) => anchor)
			.filter((anchor) => !PATCHES.slice(0, i).some((earlier) => earlier.edits.some(([, replacement]) => replacement.includes(anchor)))),
	)
		.map((anchor) => `\t\t\t${anchor}\n`)
		.join("const x = piRecordString;\n");

	test("applies every patch in order, each edit once, and is idempotent", () => {
		const { text, applied } = patchBundle(bundle);
		assert.deepEqual(applied, ALL);
		for (const patch of PATCHES) assert.ok(text.includes(patch.marker), patch.name);
		assert.ok(text.includes('providerTurnId: method === "confirm" ? providerTurnId : null'), "a question still belongs to its turn");
		assert.ok(text.includes('if (event["type"] === "cache_warming")'));
		assert.ok(text.includes('if (method === "dismiss")'));
		assert.ok(!text.includes("cancelPendingPrompts(completedAt)"), "turn end still cancels dialogs");
		assert.ok(text.includes("cacheWarmingPending || pendingPrompts.size > 0"));
		assert.deepEqual(patchBundle(text), { text, applied: [] });
	});

	test("applies only the patches a bundle lacks", () => {
		const once = patchBundle(bundle, [cacheWarming]);
		assert.deepEqual(once.applied, ["cache-warming"]);
		const { text, applied } = patchBundle(once.text);
		assert.deepEqual(applied, ["dialogs", "session-questions"]);
		assert.equal(text, patchBundle(bundle).text);
	});

	test("refuses a bundle where an anchor is missing or ambiguous, naming the patch", () => {
		assert.throws(() => patchBundle(bundle.replace(cacheWarming.edits[0]![0], "")), /cache-warming patch\): expected the anchor once, found it 0 times/);
		assert.throws(() => patchBundle(bundle + dialogs.edits[3]![0]), /dialogs patch\): expected the anchor once, found it 2 times/);
	});

	// t3's real bundle (the unpatched original the installer keeps), when this machine has it.
	const original = "/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar.pre-pi-harness";
	test("patches t3's installed Pi adapter into valid JavaScript", { skip: !existsSync(original) && "t3 not installed" }, () => {
		const bundle = packedFiles(readHeader(original).header)
			.map((f) => f.path)
			.filter((path) => path.startsWith("apps/server/dist/") && path.endsWith(".mjs"))
			.map((path) => readFile(original, path).toString("utf8"))
			.find((text) => text.includes('"PiAdapter.cancelPrompt"'));
		assert.ok(bundle, "no Pi adapter in t3's archive");
		const { text, applied } = patchBundle(bundle);
		assert.deepEqual(applied, ALL);
		const dir = mkdtempSync(join(tmpdir(), "t3-bundle-"));
		try {
			writeFileSync(join(dir, "bundle.mjs"), text);
			execFileSync(process.execPath, ["--check", join(dir, "bundle.mjs")]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
