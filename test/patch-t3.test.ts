import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { integrity, packedFiles, readFile, readHeader, replaceFiles } from "../scripts/lib/asar.ts";
import { withHugePs } from "./fixtures/huge-ps.ts";
import {
	afterPatch,
	elapsedSeconds,
	keepPatched,
	LAUNCH_AGENT,
	launchAgent,
	type Patch,
	PATCHES,
	patchApp,
	patchBundle,
	patchFile,
	RESTART_WINDOW_S,
	serverBundles,
	startedAgoS,
} from "../scripts/patch-t3.ts";

/** An unpatched bundle for these patches: every anchor once, except those an earlier patch produces. */
const unpatched = (patches: Patch[]) =>
	patches
		.flatMap((patch, i) =>
			patch.edits
				.map(([anchor]) => anchor)
				.filter((anchor) => !patches.slice(0, i).some((earlier) => earlier.edits.some(([, replacement]) => replacement.includes(anchor)))),
		)
		.map((anchor) => `\t\t\t${anchor}\n`)
		.join("const x = piRecordString;\n");
const bundle = unpatched(PATCHES);
/** t3's server bundle split as the real one is: one chunk per file the patches edit, each holding its patches' anchors. */
const chunkPatches = Object.fromEntries(
	[...new Set(PATCHES.map(patchFile))].map((id, i) => [`apps/server/dist/chunk${i}.mjs`, PATCHES.filter((patch) => patchFile(patch) === id)]),
);
const chunks = Object.fromEntries(Object.entries(chunkPatches).map(([path, patches]) => [path, unpatched(patches)]));
/** The chunk as patchApp leaves it. */
const patchedChunk = (path: string) => patchBundle(chunks[path]!, chunkPatches[path]).text;

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
	const ALL = [
		"cache-warming",
		"dialogs",
		"background-work",
		"questions",
		"questions-capability",
		"background-caller",
		"delegate-fork-runtime",
		"delegate-fork-schema",
		"delegate-fork-tool",
		"delegate-template-schema",
		"delegate-template-tool",
		"delegate-template-runtime",
		"session-questions",
		"background-items",
		"background-items-contract",
		"background-items-caller",
	];

	test("applies every patch in order, each edit once, and is idempotent", () => {
		const { text, applied } = patchBundle(bundle);
		assert.deepEqual(applied, ALL);
		for (const patch of PATCHES) assert.ok(text.includes(patch.marker), patch.name);
		assert.ok(text.includes('providerTurnId: method === "confirm" ? providerTurnId : null'), "a question still belongs to its turn");
		assert.ok(text.includes('if (event["type"] === "cache_warming")'));
		assert.ok(text.includes('if (method === "dismiss")'));
		assert.ok(!text.includes("cancelPendingPrompts(completedAt)"), "turn end still cancels dialogs");
		assert.ok(text.includes("cacheWarmingPending || backgroundWork.length > 0 || pendingPrompts.size > 0"));
		assert.ok(text.includes('if (event["type"] === "background_work")'));
		assert.ok(text.includes("(cacheWarmingPending || backgroundWork.length > 0) && threadState?.providerThread.id === providerThread.id"));
		assert.ok(text.includes('method !== "editor" && method !== "questions") {'), "a questions dialog is still ignored");
		assert.ok(text.includes('"dismiss",\n\t\t\t\t\t"questions"\n\t\t\t\t].includes'), "a questions dialog waits for a turn owner");
		assert.ok(text.includes('questions: method === "questions" ? piQuestions(nativeRequestId, event)'));
		assert.ok(text.includes('\t\t\t...environment,\n\t\t\tPI_RPC_DIALOGS: "questions",\n'), "Pi learns that t3 renders questions dialogs");
		assert.ok(text.includes('backgroundWork = piBackgroundTasks(event["items"], turnItemOfToolCall);\n\t\t\t\t\tyield* publishBackgroundWork(previous);\n\t\t\t\t\treturn;'), "each item is published on the thread");
		assert.ok(text.includes("forkedFrom: null,\n\t\t\t\t\tpendingBackgroundTasks: backgroundWork,"), "a thread attached during background work lists its items");
		assert.ok(text.includes('status: "idle",\n\t\t\t\t\tpendingBackgroundTasks: backgroundWork,'), "an existing thread lists this process's items, not an earlier one's");
		assert.ok(!text.includes("PI_BACKGROUND_WORK_TASK") && !text.includes("backgroundWorkPending"), "no fixed task, no count flag");
		assert.ok(text.includes("\titemId: optional(TurnItemId),\n"), "the contract takes a task's turn item");
		assert.ok(text.includes("...providerThread.providerInstanceId === void 0 ? {} : { providerInstanceId: providerThread.providerInstanceId },"), "every reported task carries its instance");
		assert.ok(text.includes("(task) => task.providerInstanceId === providerInstanceId /* providerOwnedWorkIsLive */"), "any provider-reported task keeps the caller live");
		assert.ok(text.indexOf("const publishBackgroundWork") < text.indexOf("const updateProviderThread"));
		// delegate_task with fork: the tool, its command, the child's spawn transfer and its turn start.
		assert.ok(text.includes("forkThreadId: optional(ThreadId.annotate("), "the tool takes forkThreadId");
		assert.ok(text.includes("fork: optional(Boolean$2.annotate("), "the tool takes fork");
		assert.ok(text.includes("forkSource: optional(Struct({\n\t\t\tthreadId: ThreadId,\n\t\t\trunId: RunId\n\t\t})),"), "the command carries its source");
		assert.ok(text.includes("const forkSource = fork ? yield* resolveForkSource(parent.thread.id, parentRun, input.forkThreadId) : void 0;"));
		assert.ok(text.includes("modelSelection: forkSource.run.modelSelection\n\t\t\t};"), "a fork takes its source run's selection");
		assert.ok(text.includes('(transfer.type === "fork" || transfer.type === "subagent_spawn") && transfer.targetThreadId'));
		assert.ok(text.includes("getThreadRecords(nativeForkTransfer.sourcePoint.threadId, ["), "a fork of a delegated thread reads that thread");
		assert.ok(text.includes('...nativeForkTransfer.type === "subagent_spawn" || sourceProviderTurn === void 0 ? {} : {'), "a delegated fork copies up to now");
		// delegate_task with forkSessionFile: the tool, its command, the source point, the check and the turn start.
		assert.ok(text.includes("forkSessionFile: optional(TrimmedNonEmptyString.annotate("), "the tool takes forkSessionFile");
		assert.ok(text.includes("\t\tforkSessionFile: optional(String$2),\n\t\tcreatedAt: optional(DateTimeUtc)"), "the command carries the file");
		assert.ok(text.includes("\tsessionFile: optional(String$2)\n});\nconst OrchestrationV2ThreadForkSourcePoint"), "a source point can name a file");
		assert.ok(text.includes("const templateFile = input.forkSessionFile === void 0 ? void 0 : resolveTemplateSessionFile(input.forkSessionFile);"));
		assert.ok(text.includes("...templateFile === void 0 ? {} : { forkSessionFile: templateFile.file },\n\t\t\t\tcompletionWake:"), "the checked real path is dispatched");
		assert.ok(text.includes('status: forkSource === void 0 && forkSessionFile === void 0 ? "consumed" : "pending",'), "a fork's or a template's spawn waits for its turn start");
		assert.ok(text.includes("const templateFile = nativeForkTransfer?.sourcePoint.sessionFile;\n\t\t\tif (templateFile !== void 0) return yield* loadFromProvider(session.forkThread({"));
		assert.ok(text.includes("No parent history, unless `fork:true` starts it from a copy of this conversation, or `forkSessionFile` from a Pi session template (Pi only)."));
		assert.deepEqual(patchBundle(text), { text, applied: [] });
	});

	test("applies only the patches a bundle lacks", () => {
		const once = patchBundle(bundle, [cacheWarming]);
		assert.deepEqual(once.applied, ["cache-warming"]);
		const { text, applied } = patchBundle(once.text);
		assert.deepEqual(applied, ALL.slice(1));
		assert.equal(text, patchBundle(bundle).text);
	});

	test("a bundle patched before background-items (the fixed task) gets only those, and loses the fixed task", () => {
		const items = (patch: Patch) => patch.name.startsWith("background-items");
		const before = patchBundle(bundle, PATCHES.filter((patch) => !items(patch)));
		assert.ok(before.text.includes("PI_BACKGROUND_WORK_TASK"));
		const { text, applied } = patchBundle(before.text);
		assert.deepEqual(applied, ["background-items", "background-items-contract", "background-items-caller"]);
		assert.equal(text, patchBundle(bundle).text);
		assert.ok(!text.includes("PI_BACKGROUND_WORK_TASK") && !text.includes("pi-background-work"));
		assert.deepEqual(patchBundle(text).applied, [], "the earlier patches' markers survive it");
	});

	test("refuses a bundle where an anchor is missing or ambiguous, naming the patch", () => {
		assert.throws(() => patchBundle(bundle.replace(cacheWarming.edits[0]![0], "")), /cache-warming patch\): expected the anchor once, found it 0 times/);
		assert.throws(() => patchBundle(bundle + dialogs.edits[3]![0]), /dialogs patch\): expected the anchor once, found it 2 times/);
	});

	// t3's real bundle (the unpatched original the installer keeps), when this machine has it.
	const original = "/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar.pre-pi-harness";
	test("patches t3's installed server bundle into valid JavaScript", { skip: !existsSync(original) && "t3 not installed" }, () => {
		const { texts, fileOf } = serverBundles(original);
		const patched = new Map<string, string>();
		const applied: string[] = [];
		for (const patch of PATCHES) {
			const path = fileOf(patch);
			const result = patchBundle(patched.get(path) ?? texts.get(path)!, [patch]);
			patched.set(path, result.text);
			applied.push(...result.applied);
		}
		assert.deepEqual(applied, ALL);
		// The fork spans three chunks: contracts, the MCP service, and the orchestrator with the Pi adapter.
		assert.equal(patched.size, 3);
		const text = patched.get(fileOf(PATCHES[0]!))!;
		const server = patched.get(fileOf(PATCHES.find((patch) => patch.name === "delegate-fork-tool")!))!;

		// The patched questions card and its response, run as bundled (with the bundle's own helpers).
		const between = (body: string, start: string, end: string) => body.slice(body.indexOf(start), body.indexOf(end, body.indexOf(start)));
		const source = (start: string, end: string) => between(text, start, end);
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

		// Each Pi background item as a pending task, run as bundled (with the bundle's record helpers).
		const recordHelpers = source("function piRecordField(", "function parsePiModelSlug(");
		const isNumber = /return ([\w$]+)\(value\) && Number\.isFinite/.exec(recordHelpers)![1]!;
		const { piBackgroundTasks, piSameFlatRecords } = new Function(
			isObject,
			isString,
			isNumber,
			`${recordHelpers}\n${source("const piBackgroundClock", "const STREAM_FLUSH_MS")}\nreturn { piBackgroundTasks, piSameFlatRecords };`,
		)((v: unknown) => typeof v === "object" && v !== null, (v: unknown) => typeof v === "string", (v: unknown) => typeof v === "number");
		const startedAt = Date.UTC(2026, 10, 14, 13, 2, 11);
		const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(startedAt);
		const tasks = piBackgroundTasks(
			[
				{ id: "toolu_1", kind: "call", label: "bash: pytest -x", command: "pytest -x", startedAt, processGroup: 42, logPath: "/tmp/j/toolu_1.log", toolCallId: "toolu_1" },
				{ id: "process-7", kind: "process", label: "process: npm run dev", command: "npm run dev", startedAt, pid: 7, processGroup: 5, toolCallId: "toolu_2" },
				{ id: "toolu_3", kind: "call", label: "workflow: inline run r1", startedAt, logPath: "/tmp/j/toolu_3.log", url: "http://127.0.0.1:4317/workflows/r1", toolCallId: "toolu_3" },
				{ id: "", label: "no id" },
				null,
			],
			(toolCallId: string) => `item:${toolCallId}`,
		);
		assert.deepEqual(tasks, [
			{ taskId: "toolu_1", kind: "command", description: `bash: pytest -x · started ${clock} · process group 42 · log /tmp/j/toolu_1.log`, command: "pytest -x", itemId: "item:toolu_1", awaited: true },
			{ taskId: "process-7", kind: "command", description: `process: npm run dev · started ${clock} · pid 7 (group 5)`, command: "npm run dev", itemId: "item:toolu_2", awaited: true },
			{ taskId: "toolu_3", kind: "background_task", description: `workflow: inline run r1 · started ${clock} · log /tmp/j/toolu_3.log · http://127.0.0.1:4317/workflows/r1`, itemId: "item:toolu_3", awaited: true },
		]);
		assert.deepEqual(piBackgroundTasks(undefined, String), []);
		assert.equal(piSameFlatRecords(tasks, tasks.map((task: object) => ({ ...task }))), true);
		assert.equal(piSameFlatRecords(tasks, tasks.slice(1)), false);
		assert.equal(piSameFlatRecords([{ a: 1 }], [{ a: 1, b: 2 }]), false);

		// The forked task's first message, as the patched MCP service writes it.
		const taskPrompt = new Function(`${between(server, "function taskPrompt(", "// src/mcp/")}\nreturn taskPrompt;`)();
		const link = "[Research](t3-thread://v2/env/thread%3Aparent)";
		assert.equal(taskPrompt({ task: "Spike A" }, link), `Forked from ${link}.\n\nSpike A`);
		assert.equal(taskPrompt({ task: "Spike A", role: "research" }, link), `Forked from ${link}.\n\nAct as the research sub-agent for this task.\n\nSpike A`);
		assert.equal(taskPrompt({ task: "Spike A", role: "general" }), "Spike A", "a task without fork is unchanged");

		// The template check, run as bundled with the chunk's own node imports (which the patch requires).
		assert.ok(server.includes('import * as NodeFS from "node:fs";\nimport * as NodePath from "node:path";\nimport * as NodeOS from "node:os";\n'));
		const { piTemplatesDir, resolveTemplateSessionFile } = new Function("NodeFS", "NodePath", "NodeOS", "process", `${between(server, "function piTemplatesDir(", "function taskPrompt(")}\nreturn { piTemplatesDir, resolveTemplateSessionFile };`)(
			{ realpathSync, statSync },
			{ join, isAbsolute, sep },
			{ homedir },
			{ env: {} },
		);
		assert.equal(piTemplatesDir({}), join(homedir(), ".pi", "agent", "templates"));
		assert.equal(piTemplatesDir({ PI_CODING_AGENT_DIR: "~/agent" }), join(homedir(), "agent", "templates"));
		const agent = realpathSync(mkdtempSync(join(tmpdir(), "t3-templates-")));
		try {
			mkdirSync(join(agent, "templates", "review", "repo"), { recursive: true });
			const session = join(agent, "templates", "review", "repo", "session.jsonl");
			writeFileSync(session, "{}\n");
			writeFileSync(join(agent, "elsewhere.jsonl"), "{}\n");
			symlinkSync(join(agent, "elsewhere.jsonl"), join(agent, "templates", "escape.jsonl"));
			const templates = join(agent, "templates");
			assert.deepEqual(resolveTemplateSessionFile(join(templates, "review", "..", "review", "repo", "session.jsonl"), templates), { file: session });
			for (const outside of [join(agent, "elsewhere.jsonl"), join(templates, "escape.jsonl"), "review/repo/session.jsonl", join(templates, "review")]) {
				assert.match(resolveTemplateSessionFile(outside, templates).problem, /must be a Pi session template file under/, outside);
			}
			assert.match(resolveTemplateSessionFile(join(templates, "gone.jsonl"), templates).problem, /does not exist/);
		} finally {
			rmSync(agent, { recursive: true, force: true });
		}

		// The forked child's Pi process, as the patched adapter launches it: its launch-argument code run
		// as bundled, composed as `PiAdapter.forkThread` composes it.
		const forkThread = source("forkThread: fn(\"PiAdapter.forkThread\")", "forkScoped);");
		assert.match(forkThread, /args: \[\n\t+\.\.\.forkLaunch\.args,\n\t+"--fork",\n\t+sourceFile\n\t+\],\n\t+cwd,/, "the fork runs `pi … --fork <source session file>` in the child's checkout");
		assert.match(forkThread, /const boundary = target === void 0 \? \{ type: "nothing" \}/, "without a turn the whole branch is copied");
		const launchModule = source("const RESERVED_PI_LAUNCH_ARGUMENTS", "const materializePiT3McpExtension") + source("function buildPiRpcLaunch(", "// ../../packages/provider-pi/src/server/usage.ts");
		const { resolvePiLaunchArgs, buildPiRpcLaunch } = new Function(
			"tokenizeCliArgs",
			"T3_MCP_URL_ENV",
			"T3_MCP_BEARER_ENV",
			"T3_PI_RUNTIME_MODE_ENV",
			"T3_PI_MCP_EXTENSION_PATH_ENV",
			`${launchModule}\nreturn { resolvePiLaunchArgs, buildPiRpcLaunch };`,
		)((args: string) => args.split(/\s+/).filter(Boolean), "T3_MCP_URL", "T3_MCP_BEARER_TOKEN", "T3_PI_RUNTIME_MODE", "T3_PI_MCP_EXTENSION_PATH");
		// `--fork` is t3's own: a user's launch arguments cannot set it.
		assert.deepEqual(resolvePiLaunchArgs("--fork /tmp/other.jsonl"), { ok: false, message: "Pi launch argument '--fork' is controlled by T3 Code and cannot be overridden." });
		const launchArgs = resolvePiLaunchArgs("--model anthropic/claude-opus --thinking high --extension /harness/ext.ts --tools read,bash");
		assert.ok(launchArgs.ok);
		const forkLaunch = buildPiRpcLaunch({
			launchArgs: launchArgs.args,
			environment: { HOME: "/home/u", T3_MCP_URL: "http://stale" },
			mcpSession: undefined,
			extensionPath: undefined,
			shortLived: true,
			disableExtensions: true,
			disableTools: true,
		});
		const sessionFile = "/home/u/.pi/agent/sessions/--parent--/2026-11-14T10-00-00-000Z_abc.jsonl";
		const args = [...forkLaunch.args, "--fork", sessionFile];
		assert.deepEqual(args, ["--mode", "rpc", "--model", "anthropic/claude-opus", "--thinking", "high", "--offline", "--no-extensions", "--no-tools", "--fork", sessionFile]);
		assert.deepEqual(forkLaunch.env, { HOME: "/home/u", PI_RPC_DIALOGS: "questions" });

		const dir = mkdtempSync(join(tmpdir(), "t3-bundle-"));
		try {
			for (const [path, patchedText] of patched) {
				const file = join(dir, path.replaceAll("/", "_"));
				writeFileSync(file, patchedText);
				execFileSync(process.execPath, ["--check", file]);
			}
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

	test("finds the app's main process by its executable, not a helper started with arguments, also with more than 1 MB of ps output", async () => {
		// A symlink to a signed system binary, outside any `.app` bundle: a copy is killed at launch, and
		// a bundle makes Gatekeeper ask about a damaged app. `ps` shows the path it was started by.
		const dir = mkdtempSync(join(tmpdir(), "t3-running-"));
		// Characters a regular expression would read as syntax, as in "T3 Code (Nightly).app".
		const main = join(dir, "Fake T3 (Nightly) [x]+.*");
		symlinkSync("/usr/bin/yes", main);
		const helper = spawn(main, ["--type=helper"], { stdio: "ignore" });
		await withHugePs(async () => {
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
			writeArchive(archive, { ...chunks, "apps/server/dist/other.mjs": "export {};\n" });
			const original = readFileSync(archive);
			assert.match(
				await keepPatched(app),
				/^patched apps\/server\/dist\/chunk0\.mjs, apps\/server\/dist\/chunk1\.mjs, apps\/server\/dist\/chunk2\.mjs \(cache-warming, dialogs, background-work, questions, questions-capability, background-caller, delegate-fork-runtime, delegate-fork-schema, delegate-fork-tool, delegate-template-schema, delegate-template-tool, delegate-template-runtime, session-questions, background-items, background-items-contract, background-items-caller;/,
			);
			assert.deepEqual(readFileSync(`${archive}.pre-pi-harness`), original);
			for (const path of Object.keys(chunks)) assert.equal(readFile(archive, path).toString(), patchedChunk(path), path);
			assert.equal(readFile(archive, "apps/server/dist/other.mjs").toString(), "export {};\n");
			assert.equal(await keepPatched(app), "already patched");
			assert.deepEqual(readFileSync(`${archive}.pre-pi-harness`), original, "the backup stays t3's own archive");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("patches an archive whose earlier patches are applied, and changes nothing when one file's anchor broke", async () => {
		const dir = mkdtempSync(join(tmpdir(), "t3-app-"));
		try {
			const app = join(dir, "T3 Test.app");
			const archive = join(app, "Contents/Resources/app.asar");
			mkdirSync(dirname(archive), { recursive: true });
			// An archive patched before the delegate_task and background-items patches existed: only the adapter chunk is patched.
			const fork = (patch: Patch) => patch.name.startsWith("delegate-") || patch.name.startsWith("background-items");
			const adapterChunk = "apps/server/dist/chunk0.mjs";
			const earlier = patchBundle(chunks[adapterChunk]!, chunkPatches[adapterChunk]!.filter((patch) => !fork(patch))).text;
			writeArchive(archive, { ...chunks, [adapterChunk]: earlier });
			const original = readFileSync(archive);
			assert.match(await keepPatched(app), /\(delegate-fork-runtime, delegate-fork-schema, delegate-fork-tool, delegate-template-schema, delegate-template-tool, delegate-template-runtime, background-items, background-items-contract, background-items-caller;/);
			assert.ok(!existsSync(`${archive}.pre-pi-harness`), "an already patched archive is not t3's own");
			for (const path of Object.keys(chunks)) assert.equal(readFile(archive, path).toString(), patchedChunk(path), path);

			// t3 changed the MCP service: no chunk is patched, the adapter's included.
			const toolChunk = Object.keys(chunks).find((path) => chunks[path]!.includes("resolveTargetRechecking"))!;
			writeArchive(archive, { ...chunks, [toolChunk]: chunks[toolChunk]!.replace("task: taskPrompt(input),", "task: buildTask(input),") });
			const broken = readFileSync(archive);
			// patchApp, not keepPatched: that one also posts the failure as a macOS notification.
			assert.throws(() => patchApp(app), /delegate-fork-tool patch\): expected the anchor once, found it 0 times/);
			assert.deepEqual(readFileSync(archive), broken);
			assert.notDeepEqual(broken, original);

			// A file a patch edits that is found twice (or not at all) is not guessed.
			writeArchive(archive, { ...chunks, "apps/server/dist/copy.mjs": chunks[toolChunk]! });
			const ambiguous = readFileSync(archive);
			assert.throws(() => patchApp(app), /expected one bundled server file containing fn\("OrchestratorMcpService\.delegateTask"\), found 2; nothing patched/);
			assert.deepEqual(readFileSync(archive), ambiguous);
			writeArchive(archive, Object.fromEntries(Object.entries(chunks).filter(([path]) => path !== toolChunk)));
			assert.throws(() => patchApp(app), /found 0; nothing patched/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
