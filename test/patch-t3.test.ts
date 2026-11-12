import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { integrity, packedFiles, readFile, readHeader, replaceFiles } from "../scripts/lib/asar.ts";
import { EDITS, patchBundle } from "../scripts/patch-t3.ts";

const edits = EDITS;

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
	const bundle = edits.map(([anchor]) => `\t\t\t${anchor}\n`).join("const x = piRecordString;\n");

	test("applies every edit once and is idempotent", () => {
		const patched = patchBundle(bundle)!;
		for (const [, replacement] of edits) assert.ok(patched.includes(replacement));
		assert.ok(patched.includes('if (event["type"] === "cache_warming")'));
		assert.equal(patchBundle(patched), undefined);
	});

	test("refuses a bundle where an anchor is missing or ambiguous", () => {
		assert.throws(() => patchBundle(bundle.replace(edits[2]![0], "")), /found it 0 times/);
		assert.throws(() => patchBundle(bundle + edits[0]![0]), /found it 2 times/);
	});
});
