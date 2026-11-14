import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { integrity, packedFiles, readFile, readHeader, replaceFiles } from "../scripts/lib/asar.ts";
import { afterPatch, elapsedSeconds, keepPatched, LAUNCH_AGENT, launchAgent, PATCHES, patchBundle, RESTART_WINDOW_S, startedAgoS } from "../scripts/patch-t3.ts";

// An unpatched bundle: every anchor once, except those an earlier patch produces.
const bundle = PATCHES.flatMap((patch, i) =>
	patch.edits
		.map(([anchor]) => anchor)
		.filter((anchor) => !PATCHES.slice(0, i).some((earlier) => earlier.edits.some(([, replacement]) => replacement.includes(anchor)))),
)
	.map((anchor) => `\t\t\t${anchor}\n`)
	.join("const x = piRecordString;\n");

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
	const ALL = ["cache-warming", "dialogs", "background-work", "questions", "questions-capability", "session-questions"];

	test("applies every patch in order, each edit once, and is idempotent", () => {
		const { text, applied } = patchBundle(bundle);
		assert.deepEqual(applied, ALL);
		for (const patch of PATCHES) assert.ok(text.includes(patch.marker), patch.name);
		assert.ok(text.includes('providerTurnId: method === "confirm" ? providerTurnId : null'), "a question still belongs to its turn");
		assert.ok(text.includes('if (event["type"] === "cache_warming")'));
		assert.ok(text.includes('if (method === "dismiss")'));
		assert.ok(!text.includes("cancelPendingPrompts(completedAt)"), "turn end still cancels dialogs");
		assert.ok(text.includes("cacheWarmingPending || backgroundWorkPending || pendingPrompts.size > 0"));
		assert.ok(text.includes('if (event["type"] === "background_work")'));
		assert.ok(text.includes("(cacheWarmingPending || backgroundWorkPending) && threadState?.providerThread.id === providerThread.id"));
		assert.ok(text.includes('method !== "editor" && method !== "questions") {'), "a questions dialog is still ignored");
		assert.ok(text.includes('"dismiss",\n\t\t\t\t\t"questions"\n\t\t\t\t].includes'), "a questions dialog waits for a turn owner");
		assert.ok(text.includes('questions: method === "questions" ? piQuestions(nativeRequestId, event)'));
		assert.ok(text.includes('\t\t\t...environment,\n\t\t\tPI_RPC_DIALOGS: "questions",\n'), "Pi learns that t3 renders questions dialogs");
		assert.deepEqual(patchBundle(text), { text, applied: [] });
	});

	test("applies only the patches a bundle lacks", () => {
		const once = patchBundle(bundle, [cacheWarming]);
		assert.deepEqual(once.applied, ["cache-warming"]);
		const { text, applied } = patchBundle(once.text);
		assert.deepEqual(applied, ["dialogs", "background-work", "questions", "questions-capability", "session-questions"]);
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

		// The patched questions card and its response, run as bundled (with the bundle's own helpers).
		const source = (start: string, end: string) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
		const helpers = source("function piRecordField(", "function piRecordNumber(");
		// The helpers call Effect's predicates under the bundler's (build-specific) names.
		const isObject = /return ([\w$]+)\(input\)/.exec(helpers)![1]!;
		const isString = /return ([\w$]+)\(value\)/.exec(helpers)![1]!;
		const { piQuestions, piUiResponse } = new Function(
			isObject,
			isString,
			`${helpers}\n${source("function piQuestions(", "const PiAdapterV2Driver")}\nreturn { piQuestions, piUiResponse };`,
		)((v: unknown) => typeof v === "object" && v !== null, (v: unknown) => typeof v === "string");
		const questions = piQuestions("r1", { questions: [{ title: "Area?", options: ["A", ""] }, { title: " " }] });
		assert.deepEqual(questions, [
			{ id: "r1:0", header: "Question", question: "Area?", options: [{ label: "A", description: "A", value: "A" }, { label: "Empty value", description: "Empty value", value: "" }] },
			{ id: "r1:1", header: "Question", question: "Question", options: [] },
		]);
		const pending = { method: "questions", turnItem: { type: "user_input_request", questions } };
		assert.deepEqual(piUiResponse(pending, undefined, { "r1:1": "typed", "r1:0": ["A"] }), { values: [null, "typed"] });
		assert.deepEqual(piUiResponse(pending, undefined, undefined), { cancelled: true });
		assert.deepEqual(piUiResponse({ method: "select", questionId: "q" }, undefined, { q: "A" }), { value: "A" });

		const dir = mkdtempSync(join(tmpdir(), "t3-bundle-"));
		try {
			writeFileSync(join(dir, "bundle.mjs"), text);
			execFileSync(process.execPath, ["--check", join(dir, "bundle.mjs")]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("keeping t3 patched", () => {
	test("restarts a t3 its update just started, asks one running longer, leaves others alone", () => {
		assert.equal(afterPatch(["questions"], undefined), "none", "not running: it loads the patches when it starts");
		assert.equal(afterPatch([], 5), "none", "nothing applied: the running t3 has the patches");
		assert.equal(afterPatch(["questions"], 0), "restart");
		assert.equal(afterPatch(["questions"], RESTART_WINDOW_S - 1), "restart");
		assert.equal(afterPatch(["questions"], RESTART_WINDOW_S), "notify", "it may be in the middle of work");
		assert.equal(afterPatch(["dialogs", "questions"], 86_400), "notify");
	});

	test("reads ps elapsed times", () => {
		assert.equal(elapsedSeconds("00:07"), 7);
		assert.equal(elapsedSeconds("01:59"), 119);
		assert.equal(elapsedSeconds("21:13:15"), 21 * 3600 + 13 * 60 + 15);
		assert.equal(elapsedSeconds("3-00:00:01"), 3 * 86_400 + 1);
	});

	test("finds the app's main process by its executable, not a helper started with arguments", async () => {
		// A symlink to a signed system binary, outside any `.app` bundle: a copy is killed at launch, and
		// a bundle makes Gatekeeper ask about a damaged app. `ps` shows the path it was started by.
		const dir = mkdtempSync(join(tmpdir(), "t3-running-"));
		const main = join(dir, "Fake T3");
		symlinkSync("/usr/bin/yes", main);
		const helper = spawn(main, ["--type=helper"], { stdio: "ignore" });
		try {
			await new Promise((resolve) => setTimeout(resolve, 200));
			assert.equal(startedAgoS(main), undefined, "only a helper with arguments runs");
			const running = spawn(main, [], { stdio: "ignore" });
			try {
				await new Promise((resolve) => setTimeout(resolve, 200));
				const ago = startedAgoS(main);
				assert.ok(ago !== undefined && ago >= 0 && ago < 5, `started ${ago}s ago`);
			} finally {
				running.kill();
			}
		} finally {
			helper.kill();
			rmSync(dir, { recursive: true, force: true });
		}
		assert.equal(startedAgoS("/Applications/Not Installed.app/Contents/MacOS/Not Installed"), undefined);
	});

	test("the LaunchAgent is a valid plist that watches the app's folder and runs at load", () => {
		const dir = mkdtempSync(join(tmpdir(), "launch-agent-"));
		try {
			const plist = join(dir, "agent.plist");
			const app = "/Applications/T3 Code & <Beta>.app";
			writeFileSync(plist, launchAgent({ node: "/usr/bin/node", script: "/repo/scripts/patch-t3.ts", app, log: "/logs/patch-t3.log" }));
			execFileSync("plutil", ["-lint", plist]);
			const parsed = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" }));
			assert.deepEqual(parsed, {
				Label: LAUNCH_AGENT,
				ProgramArguments: ["/usr/bin/node", "/repo/scripts/patch-t3.ts", app],
				WatchPaths: ["/Applications"],
				RunAtLoad: true,
				StandardOutPath: "/logs/patch-t3.log",
				StandardErrorPath: "/logs/patch-t3.log",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("patches an app that is not running, keeps t3's original once, and is idempotent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "t3-app-"));
		try {
			const app = join(dir, "T3 Test.app");
			const archive = join(app, "Contents/Resources/app.asar");
			mkdirSync(dirname(archive), { recursive: true });
			writeArchive(archive, { "apps/server/dist/runtime.mjs": bundle, "apps/server/dist/other.mjs": "export {};\n" });
			const original = readFileSync(archive);
			assert.match(await keepPatched(app), /^patched apps\/server\/dist\/runtime\.mjs \(cache-warming, dialogs, background-work, questions, questions-capability, session-questions;/);
			assert.deepEqual(readFileSync(`${archive}.pre-pi-harness`), original);
			const patched = readFile(archive, "apps/server/dist/runtime.mjs").toString();
			assert.equal(patched, patchBundle(bundle).text);
			assert.equal(await keepPatched(app), "already patched");
			assert.deepEqual(readFileSync(`${archive}.pre-pi-harness`), original, "the backup stays t3's own archive");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
