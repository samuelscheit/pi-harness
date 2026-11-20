import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { stripTypeScriptTypes } from "node:module";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Agent, getGlobalDispatcher, setGlobalDispatcher, fetch as undiciFetch } from "undici";
import { integrity, packedFiles, readFile, readHeader, replaceFiles } from "../scripts/lib/asar.ts";
import { withHugePs } from "./fixtures/huge-ps.ts";
import {
	afterPatch,
	elapsedSeconds,
	keepPatched,
	LAUNCH_AGENT,
	launchAgent,
	notPatchedMessage,
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
/** Each chunk holds the text that identifies its file, as t3's bundle does, and its patches' anchors. */
const chunks = Object.fromEntries(Object.entries(chunkPatches).map(([path, patches]) => [path, `${patchFile(patches[0]!)}\n${unpatched(patches)}`]));
/** What keepPatched posted to the user; a test never notifies the real desktop. */
let told: string[] = [];
const tell = (message: string) => void told.push(message);
beforeEach(() => {
	told = [];
});
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
		"handoff-waits-for-run",
		"handoff-ends-turn",
		"thread-identity-search",
		"connection-failure-resumable",
		"background-released",
		"background-released-contract",
		"between-turns-ordinal",
		"effect-slot-wait",
		"effect-slot-handback",
		"keyed-lock-contended",
		"background-tasks-from-pi",
		"followup-after-disposed-delivery",
		"question-descriptions",
		"task-id-resolution",
		"promoted-task-delivered",
		"promoted-run-wait",
		"thread-wait-description",
		"bridge-long-calls",
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
		assert.ok(text.includes('backgroundWork = piBackgroundTasks(event["items"], turnItemOfToolCall);\n\t\t\t\t\tyield* publishBackgroundWork();\n\t\t\t\t\treturn;'), "each item is published on the thread");
		assert.ok(text.includes("...patch,\n\t\t\t\t\tpendingBackgroundTasks: backgroundWork /* piTasksFromReport */,"), "every thread update carries Pi's last report");
		assert.ok(!text.includes("const others = (threadState.providerThread.pendingBackgroundTasks"), "a report replaces the list, it is not merged into an older one");
		assert.ok(text.includes("pendingWake = null;\n\t\t\t\tbackgroundWork = [];\n\t\t\t\tif (threadState !== null && (threadState.providerThread.pendingBackgroundTasks ?? []).length > 0) yield* updateProviderThread(threadState, {}).pipe(ignore);"), "closing the session clears the list");
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
		// A worktree handoff: the move leaves a running turn's session, the next turn start restarts it there.
		assert.ok(text.includes("runs.some(isActiveRun$1);\n\t\tconst detachSessionIds = new Set("), "the move checks for an active run before choosing what to detach");
		assert.ok(text.includes(".filter((session) => !workspaceMoveWaitsForRun || session.capabilities.sessions.supportsMultipleProviderThreadsPerSession).map((session) => session.id)"));
		assert.ok(text.includes("existingSessionProjection.cwd !== resolvedRuntimePolicy.cwd) yield* providerSessions.detach({"));
		assert.ok(text.includes("if (turn !== null && !turn.interrupted && piHandoffEndsTurn(event)) {\n\t\t\t\t\t\t\tturn.endedByHandoff = true;"), "Pi stops after the handoff call");
		assert.ok(text.includes("const interrupted = (turn.interrupted || turn.nativeAborted) && turn.endedByHandoff !== true;"), "the handoff's own abort settles as completed");
		// t3_thread_search: identity matches first, the tool reports them.
		assert.ok(text.includes("const identityHits = identity.needle === \"\" && identity.title === \"\" ? [] : yield* read(threadIdentityMatches(identity));"));
		assert.ok(text.includes('source: Literals([\n\t\t\t"id",\n\t\t\t"title",'));
		assert.ok(!text.includes("Skips subagent threads."), "the tool no longer says it skips delegated children");
		// A lost provider connection interrupts the turn instead of failing it.
		// Work an item releases holds no result.
		assert.ok(text.includes('awaited: piRecordField(item, "awaited") !== false /* releasedByItem */'));
		assert.ok(text.includes("\tawaited: optional(Boolean$2),\n\t/** The shell command the work runs, when it is one. */"), "the contract takes false");
		assert.ok(text.includes("task.awaited ?? backgroundWorkKindHoldsCompletion(task.kind)"));
		// A dialog shown between turns follows the last turn's items instead of ordinal 0.
		assert.ok(text.includes("state.activeTurn = activeTurn;\n\t\t\t\t\t\tstate.lastTurn = activeTurn;"));
		assert.ok(text.includes("ordinal: (turn ?? state?.lastTurn ?? null) === null ? 0 : itemOrdinal(turn ?? state.lastTurn, nativeRequestId)"));
		assert.ok(text.includes("const failure = connectionFailure === null ? reportedFailure : null;"));
		assert.ok(text.includes("}\n\t\t\t\tif (failure !== null) {\n\t\t\t\t\tconst failureItemId = `terminal-failure:${turn.providerTurn.id}`;\n\t\t\t\t\tyield* emit({\n\t\t\t\t\t\ttype: \"turn.terminal\","), "only a real failure fails the turn");
		// A follow-up whose queued message was steered into the running turn is delivered; a wait on its run follows the message.
		assert.ok(text.indexOf("function promotedIntoRun(") < text.indexOf("function delegatedTaskProgress("));
		assert.ok(text.includes('const outcome = promotedInto === void 0 ? runOutcome(childRun) : "completed";'));
		assert.ok(text.includes("});\n\t\tif (promotedInto !== void 0) result.text = promotedTaskResult(promotedInto);"), "the result names where the message went");
		assert.ok(text.includes("const current = selected === void 0 ? void 0 : promotedIntoRun(runs, movedMessages, selected) ?? selected;"));
		assert.ok(text.includes("stored.event.payload.id === selectedRun.id || stored.event.payload.id === followedRunId ||"), "the wait hears the followed run");
		assert.ok(text.includes("for a message you sent, pass the `runId` t3_thread_send returned"));
		assert.ok(text.includes("      signal,\n      ...bridgeDispatch(),\n    });"), "the bridge's calls lift Pi's idle timeout");
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
		// background-released and background-tasks-from-pi edit background-items' output: they come with them.
		const items = (patch: Patch) => patch.name.startsWith("background-items") || patch.name.startsWith("background-released") || patch.name === "background-tasks-from-pi";
		const before = patchBundle(bundle, PATCHES.filter((patch) => !items(patch)));
		assert.ok(before.text.includes("PI_BACKGROUND_WORK_TASK"));
		const { text, applied } = patchBundle(before.text);
		assert.deepEqual(applied, ["background-items", "background-items-contract", "background-items-caller", "background-released", "background-released-contract", "background-tasks-from-pi"]);
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
	/** The installed bundle's server files as patchApp patches them, the names applied, and the unpatched texts. */
	const patchInstalled = () => {
		const { texts, fileOf } = serverBundles(original);
		const patched = new Map<string, string>();
		const applied: string[] = [];
		for (const patch of PATCHES) {
			const path = fileOf(patch);
			const result = patchBundle(patched.get(path) ?? texts.get(path)!, [patch]);
			patched.set(path, result.text);
			applied.push(...result.applied);
		}
		return { texts, fileOf, patched, applied };
	};
	test("patches t3's installed server bundle into valid JavaScript", { skip: !existsSync(original) && "t3 not installed" }, () => {
		const { fileOf, patched, applied } = patchInstalled();
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
		const questions = piQuestions("r1", {
			questions: [{ title: "Area?", options: [{ label: "A", description: " pick A " }, { label: "" }, "not an option", { description: "no label" }] }, { title: " " }],
		});
		assert.deepEqual(questions, [
			{ id: "r1:0", header: "Question", question: "Area?", options: [{ label: "A", description: "pick A", value: "A" }, { label: "Empty value", description: "Empty value", value: "" }] },
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
				{ id: "toolu_4", kind: "call", label: "bash: cargo miri test", command: "cargo miri test", startedAt, toolCallId: "toolu_4", awaited: false },
				{ id: "", label: "no id" },
				null,
			],
			(toolCallId: string) => `item:${toolCallId}`,
		);
		assert.deepEqual(tasks, [
			{ taskId: "toolu_1", kind: "command", description: `bash: pytest -x · started ${clock} · process group 42 · log /tmp/j/toolu_1.log`, command: "pytest -x", itemId: "item:toolu_1", awaited: true },
			{ taskId: "process-7", kind: "command", description: `process: npm run dev · started ${clock} · pid 7 (group 5)`, command: "npm run dev", itemId: "item:toolu_2", awaited: true },
			{ taskId: "toolu_3", kind: "background_task", description: `workflow: inline run r1 · started ${clock} · log /tmp/j/toolu_3.log · http://127.0.0.1:4317/workflows/r1`, itemId: "item:toolu_3", awaited: true },
			{ taskId: "toolu_4", kind: "command", description: `bash: cargo miri test · started ${clock}`, command: "cargo miri test", itemId: "item:toolu_4", awaited: false },
		]);
		assert.deepEqual(piBackgroundTasks(undefined, String), []);
		assert.equal(piSameFlatRecords(tasks, tasks.map((task: object) => ({ ...task }))), true);
		assert.equal(piSameFlatRecords(tasks, tasks.slice(1)), false);
		assert.equal(piSameFlatRecords(tasks, tasks.map((task: { awaited: boolean }) => ({ ...task, awaited: true }))), false, "a release is a change");
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

		// The handoff and connection checks, run as bundled.
		const fnSource = (name: string) => {
			const start = text.indexOf(`function ${name}(`);
			return text.slice(start, text.indexOf("\n}\n", start) + 2);
		};
		const piHandoffEndsTurn = new Function(`${fnSource("piHandoffEndsTurn")}\nreturn piHandoffEndsTurn;`)();
		const handoff = { toolName: "mcp__t3-code__t3_worktree_handoff", toolCallId: "call_1" };
		assert.equal(piHandoffEndsTurn(handoff), true);
		assert.equal(piHandoffEndsTurn({ ...handoff, toolName: "t3_worktree_handoff" }), true);
		assert.equal(piHandoffEndsTurn({ ...handoff, isError: true }), false, "a refused handoff leaves the thread where it is");
		assert.equal(piHandoffEndsTurn({ ...handoff, parentToolCallId: "call_0" }), false, "a script's call (a workflow) is not the turn's last step");
		for (const toolName of ["mcp__t3-code__t3_worktree_status", "mcp__t3-code__t3_worktree_handoff_v2", "bash", undefined]) {
			assert.equal(piHandoffEndsTurn({ ...handoff, toolName }), false, String(toolName));
		}
		const piConnectionFailure = new Function(`${fnSource("piConnectionFailure")}\nreturn piConnectionFailure;`)();
		// The final errors of Pi turns that failed in November 2026, as t3 stored them.
		for (const lost of [
			"Request timed out.",
			"Connection error.: write EPIPE",
			"terminated: other side closed (UND_ERR_SOCKET)",
			"terminated: read ETIMEDOUT",
			"fetch failed",
			"getaddrinfo ENOTFOUND api.anthropic.com",
			"socket hang up",
			'502 {"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-502/","title":"Error 502: Bad gateway"}',
			"API Error: 524 A timeout occurred",
		]) {
			assert.equal(piConnectionFailure(lost), true, lost);
		}
		for (const real of [
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"A maximum of 4 blocks with cache_control may be provided. Found 27."}}',
			"Claude API rate limit reached. Try again later.",
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"all adapters are in cooldown; retry in 33s"}}',
			'503 {"type":"error","error":{"type":"api_error","message":"all adapters failed: credential validation failed"}}',
			"You’ve hit your usage limit. Upgrade to Pro",
			"401 authentication failed after timeout",
			"the prompt exceeds the model's context window (timed out compacting)",
			"Pi reported a model error.",
			"request req_5021abc failed validation",
			"tool output took 504ms and was rejected",
		]) {
			assert.equal(piConnectionFailure(real), false, real);
		}

		// Pi's turn end, run as bundled with recording stand-ins for its collaborators.
		const finalizeSource = source("const finalizeTurn = fnUntraced(function* (state, readUsage = true)", "const scheduleSettleProbe").replace("const finalizeTurn = ", "").trimEnd().replace(/;$/, "");
		const done = (value?: unknown) => ({ *[Symbol.iterator]() { return value; } });
		type Recorded = { events: Record<string, any>[]; retries: { status: string; failure: unknown }[]; sessions: unknown[][] };
		const endTurn = (fields: Record<string, unknown>): Recorded => {
			const seen: Recorded = { events: [], retries: [], sessions: [] };
			const step = (record: (...args: any[]) => void) => (...args: any[]) => (record(...args), done());
			const finalizeTurn = new Function("deps", `with (deps) { return ${finalizeSource}; }`)({
				fnUntraced: (body: unknown) => body,
				now: done("now"),
				PI_PROVIDER: "pi",
				piConnectionFailure,
				completeOpenStreamItems: step(() => {}),
				emitCompaction: step(() => {}),
				emitProviderRetry: step((_turn, retry, status) => seen.retries.push({ status, failure: retry.failure })),
				captureTurnTreeRefs: () => done(null),
				readTokenUsage: () => done(undefined),
				emit: step((event) => seen.events.push(event)),
				updateProviderThread: step(() => {}),
				providerRef: String,
				updateProviderSession: step((...args) => seen.sessions.push(args)),
				baseItemFields: (_turn: unknown, id: string) => ({ id }),
				itemOrdinal: () => 7,
			});
			const turn = { interrupted: false, nativeAborted: false, activeCompaction: null, activeProviderRetry: null, rejectedPromptFailure: null, failure: null, providerTurn: { id: "turn-1" }, turnInput: { threadId: "thread-1", runOrdinal: 3 }, ...fields };
			const state = { activeTurn: turn, providerThread: { id: "provider-thread-1" } };
			assert.equal(finalizeTurn(state, false).next().done, true);
			assert.equal(state.activeTurn, null);
			return seen;
		};
		const ofType = (seen: Recorded, type: string) => seen.events.filter((event) => event.type === type);
		const outcome = (seen: Recorded) => ({ turn: ofType(seen, "provider_turn.updated")[0]!.providerTurn.status, terminal: ofType(seen, "turn.terminal")[0] });
		const timedOut = { class: "provider_error", message: "Request timed out.", code: null, retryable: false };

		const lost = endTurn({ failure: timedOut });
		assert.equal(outcome(lost).turn, "interrupted");
		assert.deepEqual(outcome(lost).terminal, {
			type: "turn.terminal",
			driver: "pi",
			providerThreadId: "provider-thread-1",
			providerTurnId: "turn-1",
			runOrdinal: 3,
			status: "interrupted",
			failure: null,
			reason: "The connection to the model provider failed (Request timed out.). The conversation is intact: send a message to continue.",
			threadDisposition: "reusable",
		});
		assert.deepEqual(
			ofType(lost, "turn_item.updated").map((event) => event.turnItem),
			[{ id: "terminal-failure:turn-1", status: "failed", title: null, completedAt: "now", type: "error", failure: { ...timedOut, class: "transport_error", retryable: true } }],
			"the cause stays visible, as a retryable transport error",
		);
		assert.deepEqual(lost.sessions, [["ready", null]], "the session is not in error");

		const afterRetries = endTurn({ failure: { ...timedOut, message: "terminated: other side closed (UND_ERR_SOCKET)" }, activeProviderRetry: { retry: { attempt: 3, maxAttempts: 3, retryDelayMs: 8000 }, startedAt: "then" } });
		assert.equal(outcome(afterRetries).terminal.status, "interrupted");
		assert.equal(outcome(afterRetries).terminal.retry, undefined);
		assert.deepEqual(afterRetries.retries, [{ status: "failed", failure: { ...timedOut, message: "terminated: other side closed (UND_ERR_SOCKET)", class: "transport_error", retryable: true } }], "Pi's exhausted retries show on their card");
		assert.deepEqual(ofType(afterRetries, "turn_item.updated"), []);

		const invalid = { class: "provider_error", message: '400 {"type":"error","error":{"type":"invalid_request_error"}}', code: null, retryable: false };
		const real = endTurn({ failure: invalid });
		assert.equal(outcome(real).turn, "failed");
		assert.deepEqual(
			{ ...outcome(real).terminal, providerThreadId: undefined },
			{ type: "turn.terminal", driver: "pi", providerThreadId: undefined, providerTurnId: "turn-1", runOrdinal: 3, failureItemOrdinal: 7, status: "failed", failure: invalid, threadDisposition: "reusable" },
		);
		assert.deepEqual(ofType(real, "turn_item.updated")[0]!.turnItem.failure, invalid);
		assert.deepEqual(real.sessions, [["error", invalid.message]]);
		const rejected = endTurn({ rejectedPromptFailure: { ...timedOut, message: "Prompt timed out waiting for the previous turn." } });
		assert.equal(outcome(rejected).terminal.status, "failed", "t3's own refusal of a prompt is not a lost connection");

		assert.deepEqual(outcome(endTurn({ nativeAborted: true, endedByHandoff: true })), outcome(endTurn({})), "the abort after a handoff ends the turn as completed");
		assert.equal(outcome(endTurn({})).terminal.status, "completed");
		const stopped = endTurn({ interrupted: true, failure: timedOut });
		assert.equal(outcome(stopped).terminal.status, "interrupted");
		assert.equal(outcome(stopped).terminal.reason, undefined, "a Stop names no connection failure");
		assert.deepEqual(ofType(stopped, "turn_item.updated"), []);

		// The handoff's turn start: the stale session goes before the thread's session opens.
		const turnStart = source("const resolvedRuntimePolicy = resolvedPolicy.success;", "const sessionResult = ");
		assert.ok(turnStart.includes("/* workspaceMovedSessionRestarts */"), "the restart precedes providerSessions.open");
		assert.match(text, /const workspaceMoveWaitsForRun = [^\n]+\n\t\tconst detachSessionIds = new Set\([^\n]*thread\.worktreePath \? \(providerContext\?\.providerSessions \?\? \[\]\)\.filter\(\(session\) => !workspaceMoveWaitsForRun/);

		// t3_thread_search's identity matches: its query run as bundled on SQLite with t3's tables.
		const identity = new Function("findAll", "Struct", "NullOr", "String$1", "ThreadId", "ProjectId", "sql", `${between(server, "\tconst threadIdentityQuery = ", "\tconst titleCandidates = findAll({")}\nreturn { threadIdentityQuery, threadIdentityMatches };`)(
			(spec: { execute: (request: unknown) => unknown }) => (request: unknown) => spec.execute(request),
			(fields: unknown) => fields,
			(schema: unknown) => schema,
			"String",
			"ThreadId",
			"ProjectId",
			(strings: TemplateStringsArray, ...values: unknown[]) => ({ text: strings.join("?"), values }),
		);
		const db = new DatabaseSync(":memory:");
		db.exec(`
			CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL);
			CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, child_thread_id TEXT, origin TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
		`);
		const child = (uuid: string) => `thread:delegated-task:command%3Amcp%3A6cfe3118-00b2-411e-82e1-18f74c3f6773%3Adelegate-task%3A${uuid}`;
		const coordinator = "thread:project:p1:aaaa1111-0000-4000-8000-000000000001";
		const handoffChild = child("ffba61bd-d2aa-45f5-a9b8-eff026715971");
		const lensChild = child("7dedfc9f-eee1-4c73-bc29-1b85931bb2e8");
		const rows: [id: string, project: string, title: string, updated: string, subagent: boolean, archived?: boolean, deleted?: boolean][] = [
			[coordinator, "p1", "Dream run", "2026-11-14T09:00:00Z", false],
			[handoffChild, "p1", "t3 patches: worktree handoff mid-turn", "2026-11-14T10:00:00Z", true],
			[lensChild, "p1", "pi-lens: knip purge", "2026-11-14T11:00:00Z", true],
			[child("0ld0ld00-0000-4000-8000-000000000003"), "p1", "worktree handoff (old try)", "2026-11-13T10:00:00Z", true, true],
			[child("e15e0000-0000-4000-8000-000000000004"), "p2", "worktree handoff elsewhere", "2026-11-14T12:00:00Z", true],
			[child("deadbeef-0000-4000-8000-000000000005"), "p1", "deleted child", "2026-11-14T13:00:00Z", true, false, true],
			["thread:project:p1:bbbb2222-0000-4000-8000-000000000006", "p1", "worktree handoff design", "2026-11-14T14:00:00Z", false],
			[child("9a9a9a9a-0000-4000-8000-000000000007"), "p1", "notes on ffba61bd", "2026-11-14T15:00:00Z", true],
		];
		const insertThread = db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
		for (const [id, project, title, updated, subagent, archived, deleted] of rows) {
			const lineage = subagent ? { relationshipToParent: "subagent", parentThreadId: coordinator } : { relationshipToParent: null, parentThreadId: null };
			insertThread.run(id, project, title, updated, updated, archived ? updated : null, deleted ? updated : null, JSON.stringify({ id, title, lineage }));
		}
		const insertTask = db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES (?, ?, ?, 'app_owned', 'running', '2026-11-14T10:00:00Z', '{}')");
		insertTask.run("node:delegated-task:2f81460e-866e-45bc-82e0-f090d023f14f", coordinator, lensChild);
		insertTask.run("node:delegated-task:command%3Amcp%3A6cfe3118%3Adelegate-task%3Affba61bd-d2aa-45f5-a9b8-eff026715971", coordinator, handoffChild);
		insertTask.run("node:native:pending-0000-4000-8000-000000000009", coordinator, null);
		const find = (query: string, projectId: string | null = null) => {
			const { text: statement, values } = identity.threadIdentityMatches(identity.threadIdentityQuery(query, projectId));
			return db.prepare(statement).all(...values).map((row: Record<string, unknown>) => [row.threadId, row.source]);
		};
		assert.deepEqual(find("ffba61bd"), [[handoffChild, "id"], [child("9a9a9a9a-0000-4000-8000-000000000007"), "title"]], "8 characters of a child's id, then a newer child naming them in its title");
		assert.deepEqual(find(" FFBA61BD-D2AA "), [[handoffChild, "id"]], "in any case, trimmed");
		assert.deepEqual(find("2f81460e"), [[lensChild, "id"]], "part of a task id that differs from its child's");
		assert.deepEqual(find("node:delegated-task:2f81460e-866e-45bc-82e0-f090d023f14f"), [[lensChild, "id"]], "a whole taskId");
		assert.deepEqual(find(`[pi-lens](t3-thread://v2/env-1/${lensChild})`), [[lensChild, "id"]], "a thread link");
		assert.deepEqual(find(`t3-thread://v1/${handoffChild}`), [[handoffChild, "id"]], "a v1 thread link");
		assert.deepEqual(find("thread:delegated-task:command:mcp:6cfe3118-00b2"), [[child("9a9a9a9a-0000-4000-8000-000000000007"), "id"], [child("e15e0000-0000-4000-8000-000000000004"), "id"], [lensChild, "id"], [handoffChild, "id"], [child("0ld0ld00-0000-4000-8000-000000000003"), "id"]], "a decoded id, newest first, archived included, deleted not");
		assert.deepEqual(find("worktree handoff", "p1"), [[handoffChild, "title"]], "a delegated child's title in the project; not an archived child, not a top-level thread (the title search ranks those)");
		assert.deepEqual(find("Worktree Handoff"), [[child("e15e0000-0000-4000-8000-000000000004"), "title"], [handoffChild, "title"]], "without a project, every project's children");
		assert.deepEqual(find("ffba61bd", "p1"), [[handoffChild, "id"], [child("9a9a9a9a-0000-4000-8000-000000000007"), "title"]], "an id match ranks above a newer title match");
		assert.deepEqual(find("deadbeef"), [], "a deleted thread is gone, even by id");
		assert.deepEqual(find("handoff").map(([, source]) => source), ["title", "title"], "a word without a digit is not taken for an id");
		assert.deepEqual(find("delegate-task"), [], "nor a fragment every delegated id shares");
		assert.deepEqual(identity.threadIdentityQuery("ab", null), { needle: "", title: "", projectId: null }, "too short for either");
		assert.equal(identity.threadIdentityQuery("ffba 61bd", "p1").needle, "", "words are not an id");
		assert.equal(identity.threadIdentityQuery("thread%253Aproject%3Ap1", null).needle, "thread:project:p1", "encoded ids are compared decoded");
		// The tool lists them: ids first, then the title search, then delegated titles, then messages.
		assert.ok(server.includes('...identityHits.filter((hit) => hit.source === "id"),\n\t\t\t...titleHits.filter((hit) => !identified.has(hit.threadId)).slice(0, limit - messageSlots),\n\t\t\t...identityHits.filter((hit) => hit.source !== "id"),\n\t\t\t...messageHits'));

		// A parent's follow-up to its delegated child, run as bundled (recordSubagentFollowup) with stand-ins
		// for the projection store. The incident (2026-11-16): the parent's stop disposed the delivery of a
		// task whose child had failed without a result; the parent's later follow-ups stayed that task's.
		const effect = (value?: unknown) => ({
			*[Symbol.iterator]() {
				return value;
			},
			pipe() {
				return this;
			},
		});
		const followupStart = text.indexOf("const recordSubagentFollowup = ");
		const followupSource = text.slice(followupStart, text.indexOf("\n\t});\n", followupStart) + 4).replace("const recordSubagentFollowup = ", "");
		assert.ok(followupSource.includes('original.result === null && original.completionDelivery?.state !== "disposed"'));
		const pendingEvents = /yield\* ([\w$]+)\(events\);/.exec(followupSource)![1]!;
		const isActiveRun = /\.filter\(([\w$]+)\)\.toSorted/.exec(followupSource)![1]!;
		const mayStartSubagentFollowup = new Function(`${fnSource("mayStartSubagentFollowup")}\nreturn mayStartSubagentFollowup;`)();
		const parentId = "thread:parent";
		const childId = "thread:child";
		const originalId = "node:delegated-task:original";
		const childRun = { id: "run:child:5", status: "starting", providerInstanceId: "pi", providerThreadId: "provider-thread:child", modelSelection: { instanceId: "pi", model: "opus" } };
		const parentRuns = [
			{ id: "run:parent:9", status: "completed", ordinal: 9, rootNodeId: "node:9", providerThreadId: "provider-thread:parent" },
			{ id: "run:parent:14", status: "running", ordinal: 14, rootNodeId: "node:14", providerThreadId: "provider-thread:parent" },
		];
		const followUp = (original: Record<string, unknown>, command: Record<string, unknown> = {}) => {
			const emitted: Record<string, any>[] = [];
			const deps: Record<string, unknown> = {
				fnUntraced: (body: unknown) => body,
				mayStartSubagentFollowup,
				[pendingEvents]: () =>
					effect([
						{ type: "message.updated", payload: { id: "message:1", runId: childRun.id, createdAt: "2026-11-16T11:40:40.000Z" } },
						{ type: "run.created", payload: childRun },
					]),
				projectionStore: {
					getThread: () => effect({ id: childId, title: "Werkzeuge", lineage: { relationshipToParent: "subagent", parentThreadId: parentId }, forkedFrom: { type: "node", nodeId: originalId } }),
					getThreadRecords: (threadId: string) => {
						assert.equal(threadId, parentId, "the child's run comes from the pending events");
						return effect({ runs: parentRuns, subagents: [{ id: originalId, origin: "app_owned", childThreadId: childId, threadId: parentId, runId: "run:parent:9", ...original }], providerTurns: [], attempts: [] });
					},
				},
				mapDispatchError: () => (value: unknown) => value,
				[isActiveRun]: (run: { status: string }) => ["preparing", "starting", "running"].includes(run.status),
				latestExecutedRun: (runs: unknown[]) => runs.at(-1),
				providerAdapters: { get: () => effect({ driver: "pi" }) },
				idAllocator: { derive: { delegatedTaskNode: ({ commandId }: { commandId: string }) => `node:delegated-task:${commandId}`, delegatedTaskTurnItem: ({ commandId }: { commandId: string }) => `turn-item:${commandId}` } },
				providerTurnForRun: () => undefined,
				nextTurnItemOrdinal: () => effect(1400),
				emit: () => (event: Record<string, unknown>) => (emitted.push(event), effect()),
			};
			const record = new Function("deps", `with (deps) { return ${followupSource}; }`)(deps);
			const send = { type: "message.dispatch", commandId: "command:mcp:s1:thread-send:x", threadId: childId, messageId: "message:1", text: "Rebase onto main.", createdBy: "agent", creationSource: "mcp", senderThreadId: parentId, ...command };
			assert.equal(record(send, []).next().done, true);
			return emitted;
		};
		const disposed = { status: "running", result: null, completionWake: "always", completionDelivery: { state: "disposed", observedByRunId: null } };
		const created = followUp(disposed);
		assert.deepEqual(created.map((event) => event.type), ["run.updated", "node.updated", "subagent.updated", "turn-item.updated"]);
		const newTaskId = "node:delegated-task:command:mcp:s1:thread-send:x";
		assert.equal(created[0]!.payload.delegatedTaskId, newTaskId, "the follow-up run is the new task's");
		const newTask = created[2]!.payload;
		assert.deepEqual(
			{ id: newTask.id, threadId: newTask.threadId, childThreadId: newTask.childThreadId, runId: newTask.runId, completionWake: newTask.completionWake, completionDelivery: newTask.completionDelivery, status: newTask.status, result: newTask.result, prompt: newTask.prompt },
			{ id: newTaskId, threadId: parentId, childThreadId: childId, runId: "run:parent:14", completionWake: "always", completionDelivery: { state: "pending", observedByRunId: null }, status: "running", result: null, prompt: "Rebase onto main." },
			"owned by the sending run, its completion pending delivery",
		);
		assert.deepEqual(followUp({ ...disposed, completionDelivery: { state: "pending", observedByRunId: null } }), [], "a deliverable task without a result keeps its follow-ups: its own completion wakes the parent");
		assert.deepEqual(followUp({ ...disposed, completionDelivery: undefined }), [], "so does one with no delivery state yet");
		assert.equal(followUp({ ...disposed, status: "completed", result: "done", completionDelivery: { state: "delivered", observedByRunId: null } }).length, 4, "after a result a follow-up is a new task, as before");
		assert.equal(followUp(disposed, { createdBy: "user", creationSource: "web", senderThreadId: undefined }).length, 4, "also when the user continues the child");
		assert.deepEqual(followUp(disposed, { senderThreadId: "thread:coordinator" }), [], "another thread's agent message is no follow-up of the parent");
		assert.deepEqual(followUp(disposed, { notification: { source: { kind: "monitor" } } }), [], "nor a monitor's notification");
		assert.deepEqual(followUp(disposed, { restartContinuationOfRunId: "run:child:4" }), [], "nor a restart's continuation, which stays its run's task");

		// task_status and task_cancel resolve a task named by part of its id or by its child, run as bundled.
		const serverFn = (name: string) => {
			const start = server.indexOf(`function ${name}(`);
			return server.slice(start, server.indexOf("\n}\n", start) + 2);
		};
		const resolveSource = between(server, "\tconst resolveTaskId = ", "\tconst loadTaskParent = ");
		const failureName = /yield\* ([\w$]+)\("task_not_found"/.exec(resolveSource)![1]!;
		const threadTasks: Record<string, any>[] = [];
		const { delegatedTaskMatches, resolveTaskId } = new Function(
			"fn",
			"loadTasks",
			failureName,
			`${serverFn("delegatedTaskMatches")}\n${serverFn("newestDelegatedTasks")}\n${resolveSource}\nreturn { delegatedTaskMatches, resolveTaskId };`,
		)(
			() => (body: unknown) => body,
			(threadId: string, taskIds: unknown) => (assert.equal(taskIds, undefined, "every task of the thread"), effect(threadTasks.filter((task) => task.threadId === threadId || task.threadId === "elsewhere"))),
			(code: string, message: string) => ({
				*[Symbol.iterator]() {
					throw Object.assign(new Error(message), { code });
				},
			}),
		);
		const werkzeugeChild = "thread:delegated-task:command%3Amcp%3Aa1933538-3b98-47bc-852c-0358a6e42848%3Adelegate-task%3A06818319-12fa-48c5-9e63-e9d9e8b8edbe";
		const werkzeuge = { id: "node:delegated-task:command%3Amcp%3Aa1933538-3b98-47bc-852c-0358a6e42848%3Adelegate-task%3A06818319-12fa-48c5-9e63-e9d9e8b8edbe", origin: "app_owned", threadId: parentId, childThreadId: werkzeugeChild, title: "Werkzeuge", status: "completed", startedAt: "2026-11-16T10:23:22.811Z" };
		const rebase = { ...werkzeuge, id: "node:delegated-task:command%3Amcp%3Ab2c33702-2858-46c5-8773-90be22444b06%3Athread-send%3Aa330d203-4935-4bb0-953d-3f5991303e51", status: "running", startedAt: "2026-11-17T05:59:27.563Z" };
		const sibling = { ...werkzeuge, id: "node:delegated-task:command%3Amcp%3Aa1933538-3b98-47bc-852c-0358a6e42848%3Adelegate-task%3A11111111-0000-4000-8000-000000000001", childThreadId: "thread:delegated-task:command%3Amcp%3Aa1933538-3b98-47bc-852c-0358a6e42848%3Adelegate-task%3A11111111-0000-4000-8000-000000000001", title: "Kommentar", startedAt: "2026-11-16T09:00:00.000Z" };
		const remote = { ...werkzeuge, id: "node:delegated-task:remote-77777777", childThreadId: null, title: "Remote", startedAt: "2026-11-15T09:00:00.000Z" };
		const native = { ...werkzeuge, id: "node:native:55555555", origin: "provider_native", childThreadId: null };
		const foreign = { ...werkzeuge, id: "node:delegated-task:99999999-foreign", threadId: "elsewhere" };
		threadTasks.push(werkzeuge, rebase, sibling, remote, native, foreign);
		const ids = (query: string) => delegatedTaskMatches(threadTasks.slice(0, 4), query).map((task: { id: string }) => task.id);
		assert.deepEqual(ids("06818319-12fa-48c5-9e63-e9d9e8b8edbe"), [werkzeuge.id], "the incident's call: the last UUID of the task id");
		assert.deepEqual(ids(" A330D203 "), [rebase.id], "any case, trimmed");
		assert.deepEqual(ids("command%253Amcp%253Ab2c33702"), [rebase.id], "encoded parts are compared decoded");
		assert.deepEqual(ids(`[Werkzeuge](t3-thread://v2/env-1/${werkzeugeChild})`), [rebase.id], "the child's link names its newest task");
		assert.deepEqual(ids("thread:delegated-task:command:mcp:a1933538-3b98-47bc-852c-0358a6e42848:delegate-task:06818319"), [rebase.id], "so does part of the child's decoded id");
		assert.deepEqual(ids("thread:delegated-task:command:mcp:a1933538"), [werkzeuge.id, rebase.id, sibling.id], "a part two children share names all their tasks");
		assert.deepEqual(ids("a1933538"), [werkzeuge.id, sibling.id], "a part task ids share is ambiguous");
		assert.deepEqual(ids("remote-77777777"), [remote.id], "a remote task has no child thread");
		for (const vague of ["delegate-task", "06818", "0681 8319", "zzzz9999", ""]) assert.deepEqual(ids(vague), [], vague);
		const resolve = (taskId: string, scopeThread = parentId) => {
			try {
				return resolveTaskId({ thread: { threadId: scopeThread } }, taskId).next().value;
			} catch (error) {
				return error as Error & { code: string };
			}
		};
		assert.equal(resolve(werkzeuge.id), werkzeuge.id, "an exact id is taken as is");
		assert.equal(resolve("06818319-12fa-48c5-9e63-e9d9e8b8edbe"), werkzeuge.id);
		assert.equal(resolve(werkzeugeChild), rebase.id);
		const ambiguous = resolve("a1933538") as Error & { code: string };
		assert.equal(ambiguous.code, "task_not_found");
		assert.equal(ambiguous.message, `a1933538 names 2 delegated tasks of thread ${parentId}: ${werkzeuge.id} (Werkzeuge, completed); ${sibling.id} (Kommentar, completed). Pass one of their taskIds.`);
		const unknown = resolve("zzzz9999") as Error & { code: string };
		assert.equal(unknown.code, "task_not_found");
		assert.equal(unknown.message, `Thread ${parentId} has no delegated task zzzz9999. Its newest: ${rebase.id} (Werkzeuge, running); ${werkzeuge.id} (Werkzeuge, completed); ${sibling.id} (Kommentar, completed); ${remote.id} (Remote, completed).`, "newest first, only this thread's app-owned tasks");
		assert.match((resolve("55555555") as Error).message, /has no delegated task 55555555\./, "a native subagent is no delegated task");
		assert.match((resolve("99999999-foreign") as Error).message, /has no delegated task 99999999-foreign\./, "nor another thread's task");
		assert.equal((resolve("06818319", "thread:empty") as Error).message, "Thread thread:empty has no delegated task 06818319. It started none.");
		assert.ok(server.includes('requireThreadScope(callerScope, "task_status");\n\t\t\treturn yield* readTask(scope, yield* resolveTaskId(scope, taskId), false, true);'), "task_status resolves first");
		assert.ok(server.includes('requireThreadScope(callerScope, "task_cancel");\n\t\t\tinput = {\n\t\t\t\t...input,\n\t\t\t\ttaskId: yield* resolveTaskId(scope, input.taskId)\n\t\t\t};'), "task_cancel resolves before every use of its id");

		// A queued follow-up promoted to steer the running turn (thread 7761f101, 2026-11-19): runs 6 and 7
		// never started, ended cancelled, and their messages moved into run 5.
		const promotedIntoRun = new Function(`${fnSource("promotedIntoRun")}\nreturn promotedIntoRun;`)();
		const promotedTaskResult = new Function(`${fnSource("promotedTaskResult")}\nreturn promotedTaskResult;`)();
		const running = { id: "run:child:5", ordinal: 5, status: "running", startedAt: "2026-11-19T16:41:02.088Z", userMessageId: "message:5", delegatedTaskId: "node:delegated-task:first", providerInstanceId: "pi", providerThreadId: "provider-thread:child" };
		const promoted = { ...running, id: "run:child:6", ordinal: 6, status: "cancelled", startedAt: null, completedAt: "2026-11-19T16:46:39.082Z", userMessageId: "message:6", delegatedTaskId: "node:delegated-task:followup" };
		const childRuns = [running, promoted];
		const moved = [{ id: "message:5", role: "user", runId: running.id }, { id: "message:6", role: "user", runId: running.id }];
		const stayed = [{ id: "message:6", role: "user", runId: promoted.id }];
		assert.equal(promotedIntoRun(childRuns, moved, promoted), running, "the run its message was moved into");
		assert.equal(promotedIntoRun(childRuns, stayed, promoted), undefined, "a queued message removed from the queue stays with its run");
		assert.equal(promotedIntoRun(childRuns, moved, { ...promoted, startedAt: "2026-11-19T16:46:00.000Z" }), undefined, "a run that ran and was stopped is cancelled");
		assert.equal(promotedIntoRun(childRuns, moved, { ...promoted, status: "queued" }), undefined, "a queued run is still queued");
		assert.equal(promotedIntoRun(childRuns, moved, running), undefined);
		assert.equal(promotedIntoRun(childRuns, [], promoted), undefined, "its message not loaded: no guess");
		assert.equal(promotedIntoRun(childRuns, [{ id: "message:6", runId: null }], promoted), undefined);
		assert.equal(promotedIntoRun([promoted], moved, promoted), undefined, "the run it moved into is not in view");
		assert.equal(
			promotedTaskResult(running),
			"Delivered: the message was moved from the queue into the child's running turn (run run:child:5, task node:delegated-task:first), so it started no run of its own. The child's reply comes with that run: t3_thread_wait with runId run:child:5 waits for it.",
		);
		assert.match(promotedTaskResult({ ...running, delegatedTaskId: undefined }), /running turn \(run run:child:5\), so/, "a run no task owns");

		// The follow-up task's end, run as bundled with the bundle's own run helpers and recording stand-ins for the rest.
		const isAwaitedWork = /\.some\(([\w$]+)\)/.exec(fnSource("runOutcome"))![1]!;
		const runHelpers = new Function(
			isAwaitedWork,
			"latestProviderTurnForAttempt",
			"toEpochMillis",
			"withExecutedModelNote",
			`${fnSource("runOutcome")}\n${fnSource("delegatedTaskTerminalStatus")}\n${fnSource("subagentResultForRun")}\nreturn { runOutcome, delegatedTaskTerminalStatus, subagentResultForRun };`,
		)(() => true, () => undefined, Date.parse, (text: string) => text);
		const finalizeTaskSource = source('const finalizeAppOwnedSubagentTask = fn("Orchestrator.finalizeAppOwnedSubagentTask")', "\tconst finalizeAppOwnedSubagent = fn(").replace("const finalizeAppOwnedSubagentTask = ", "").trimEnd().replace(/;$/, "");
		const followupTask = { id: promoted.delegatedTaskId, origin: "app_owned", threadId: parentId, runId: "run:parent:175", childThreadId: childId, driver: "pi", providerInstanceId: "pi", status: "pending", result: null, completionWake: "always", completionDelivery: { state: "pending", observedByRunId: null } };
		const finalizeTask = (runs: Record<string, unknown>[], messages: Record<string, unknown>[]) => {
			const written: Record<string, any>[] = [];
			const finalize = new Function("deps", `with (deps) { return ${finalizeTaskSource}; }`)({
				...runHelpers,
				fn: () => (body: unknown) => body,
				now: effect("2026-11-19T16:46:39.100Z"),
				promotedIntoRun,
				promotedTaskResult,
				childAwaitsRestartContinuation: () => effect(false),
				projectionStore: {
					getThreadRecords: (threadId: string) =>
						effect(
							threadId === childId
								? { messages: [], turnItems: [] }
								: { thread: { id: parentId, providerInstanceId: "pi" }, runs: [{ id: "run:parent:175", providerInstanceId: "pi" }], subagents: [followupTask], nodes: [], turnItems: [], contextTransfers: [], messages: [] },
						),
				},
				planDelegatedCompletionDelivery: ({ updatedTask }: { updatedTask: unknown }) => effect({ task: updatedTask, offer: false }),
				idAllocator: { allocate: { contextTransfer: () => effect("transfer:1") } },
				contextSourcePointForRun: (_projection: unknown, run: { id: string }) => ({ threadId: childId, runId: run.id }),
				delegatedCompletionPlanEvents: () => [],
				writeSystemEvents: (events: Record<string, any>[]) => (written.push(...events), effect()),
				offerDelegatedCompletionDelivery: () => effect(),
			});
			const child = { thread: { id: childId, lineage: { relationshipToParent: "subagent", parentThreadId: parentId }, forkedFrom: { type: "node", nodeId: originalId } }, runs, messages };
			assert.equal(finalize(child, { task: followupTask, syncRunId: promoted.id }).next().done, true);
			return written;
		};
		const delivered = finalizeTask(childRuns, moved);
		const settled = delivered.find((event) => event.type === "subagent.updated")!.payload;
		assert.equal(settled.status, "completed", "not cancelled: its message reached the child");
		assert.equal(settled.result, promotedTaskResult(running));
		assert.equal(delivered.find((event) => event.type === "context-transfer.created")!.payload.sourcePoint.runId, promoted.id, "its result is its own run's: the task of run 5 delivers that run's");
		const removed = finalizeTask(childRuns, stayed).find((event) => event.type === "subagent.updated")!.payload;
		assert.deepEqual([removed.status, removed.result], ["cancelled", "Child task ended with status cancelled."], "a message removed from the queue still ends its task cancelled");
		const stoppedRun = finalizeTask([running, { ...promoted, startedAt: "2026-11-19T16:46:00.000Z" }], moved).find((event) => event.type === "subagent.updated")!.payload;
		assert.equal(stoppedRun.status, "cancelled", "so does a run that was stopped while it ran");

		// t3_thread_wait on such a run, run as bundled: it waits for the run the message was moved into.
		const waitSource = source('const waitForThread = fn("ThreadManagementService.waitForThread")', "\tconst settleAfterRun = ").replace("const waitForThread = ", "").trimEnd().replace(/;$/, "");
		const isTerminal = (status: string) => ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
		const waitFor = (runs: Record<string, any>[], messages: Record<string, unknown>[], runId: string) => {
			const loads: unknown[][] = [];
			const filters: ((stored: unknown) => boolean)[] = [];
			const stub = () => ({ pipe: () => effect({ _tag: "None" }) });
			const wait = new Function("deps", `with (deps) { return ${waitSource}; }`)({
				fn: () => (body: unknown) => body,
				fnUntraced: (body: unknown) => body,
				"gen$1": (body: unknown) => body,
				promotedIntoRun,
				isTerminalRunStatus: isTerminal,
				latestRun: (projection: { runs: { ordinal: number }[] }) => projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0],
				latestRestartContinuation: (_runs: unknown, run: unknown) => run,
				mapError: () => undefined,
				orchestrator: { getThreadEventSequence: () => effect(41), restartContinuationPending: () => effect(false), streamStoredEventsFrom: () => "stream" },
				getProjectThreadRecords: (_input: unknown, fields: string[], filter?: unknown) => (loads.push([fields, filter]), effect({ runs, messages })),
				mergeAll$1: stub,
				merge$3: stub,
				"filter$2": (predicate: (stored: unknown) => boolean) => (filters.push(predicate), "op"),
				"mapError$1": () => "op",
				mapEffect: () => "op",
				runHead: "op",
				timeoutOption: () => "op",
				"millis$1": () => "op",
				fromEffect: () => "op",
				"empty$8": "op",
				"flatten$1": (value: unknown) => value,
				isSome: (option: { _tag: string }) => option._tag === "Some",
			});
			const step = wait({ projectId: "project", threadId: childId, runId, timeoutMs: 1_000 }).next();
			assert.equal(step.done, true);
			return { result: step.value, loads, hears: (id: string) => filters[0]!({ event: { type: "run.updated", payload: { id } } }) };
		};
		const answered = waitFor([{ ...running, status: "completed" }, promoted], moved, promoted.id);
		assert.deepEqual([answered.result.run.id, answered.result.timedOut], [running.id, false], "the run its message joined, once that run ended");
		assert.deepEqual(answered.loads.filter(([fields]) => (fields as string[]).includes("messages")), [[["messages"], { messageIds: ["message:6"] }]], "only the selected run's message is read");
		const ongoing = waitFor(childRuns, moved, promoted.id);
		assert.deepEqual([ongoing.result.run.id, ongoing.result.timedOut], [running.id, true], "still running: the wait goes on with that run");
		assert.ok(ongoing.hears(running.id), "the followed run's updates end the wait");
		assert.ok(ongoing.hears(promoted.id));
		assert.ok(!ongoing.hears("run:child:7"), "another run's do not");
		const cancelled = waitFor(childRuns, stayed, promoted.id);
		assert.deepEqual([cancelled.result.run.id, cancelled.result.run.status, cancelled.result.timedOut], [promoted.id, "cancelled", false], "a message removed from the queue: its run, cancelled");
		const plain = waitFor([{ ...running, status: "completed" }], moved, running.id);
		assert.equal(plain.result.run.id, running.id);
		assert.deepEqual(plain.loads.filter(([fields]) => (fields as string[]).includes("messages")), [], "a run that ran reads no message");

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

	// t3's MCP bridge, as t3 writes it out for Pi, calling an MCP server that answers after the call's
	// tool ended, through a global dispatcher with Pi's idle timeouts (here 400 ms; undici's coarse timers
	// cut at about 1 s) and Pi's undici fetch (Pi installs it as the global one).
	test("t3's Pi bridge waits for a tool call longer than Pi's HTTP idle timeout, and its signal still ends it", { skip: !existsSync(original) && "t3 not installed" }, async () => {
		const { texts, fileOf, patched } = patchInstalled();
		const file = fileOf(PATCHES.find((patch) => patch.name === "bridge-long-calls")!);
		/** The bridge's client: its section of the extension source, the template literal evaluated as t3 writes the file, its types stripped. */
		const bridgeClient = (bundle: string, start: string) => {
			const section = bundle.slice(bundle.indexOf(start), bundle.indexOf("export default async function t3McpExtension("));
			const written = new Function(`return \`${section}\`;`)() as string;
			return new Function("fetch", "PROTOCOL", "parseSseOrJson", `${stripTypeScriptTypes(written)}\nreturn createMcpClient;`)(undiciFetch, "2025-06-18", (body: string) => JSON.parse(body));
		};
		const patchedClient = bridgeClient(patched.get(file)!, "// Pi's global HTTP dispatcher (undici)");
		const originalClient = bridgeClient(texts.get(file)!, "function createMcpClient(");
		const calls: string[] = [];
		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => {
				const { id, params } = JSON.parse(body);
				calls.push(`${params.name} ${req.headers.authorization}`);
				const timer = setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: { structuredContent: { status: "completed" } } })), 2_500);
				res.on("close", () => clearTimeout(timer));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
		const pi = getGlobalDispatcher();
		setGlobalDispatcher(new Agent({ headersTimeout: 400, bodyTimeout: 400 }));
		try {
			const wait = (client: (endpoint: string, token: string) => { callTool: Function }, signal?: AbortSignal) => client(endpoint, "secret").callTool("t3_thread_wait", { threadId: "thread-1", timeoutMs: 2_500 }, signal);
			await assert.rejects(wait(originalClient), /fetch failed/, "unpatched, Pi's idle timeout cuts the call");
			assert.deepEqual(await wait(patchedClient), { structuredContent: { status: "completed" } }, "patched, the call gets its answer");
			await assert.rejects(wait(patchedClient, AbortSignal.timeout(300)), { name: "TimeoutError" }, "the call's signal still ends it");
			assert.deepEqual(calls, ["t3_thread_wait Bearer secret", "t3_thread_wait Bearer secret", "t3_thread_wait Bearer secret"]);
			const other = await undiciFetch(endpoint, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 9, params: { name: "other" } }) }).catch((error: Error) => error);
			assert.match(String(other), /fetch failed/, "other requests keep Pi's idle timeout");
		} finally {
			setGlobalDispatcher(pi);
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
		// Without a global dispatcher (none set on this undici), the bridge sends its requests as before.
		const bare = new Function(`${stripTypeScriptTypes(new Function(`return \`${patched.get(file)!.slice(patched.get(file)!.indexOf("function bridgeDispatch()"), patched.get(file)!.indexOf("function createMcpClient("))}\`;`)() as string)}\nreturn bridgeDispatch;`)();
		const saved = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("undici.globalDispatcher.2"));
		assert.ok(saved?.writable, "undici's global dispatcher slot is writable");
		const slot = globalThis as unknown as Record<symbol, unknown>;
		const legacy = slot[Symbol.for("undici.globalDispatcher.1")];
		try {
			slot[Symbol.for("undici.globalDispatcher.2")] = undefined;
			slot[Symbol.for("undici.globalDispatcher.1")] = undefined;
			assert.deepEqual(bare(), {});
			slot[Symbol.for("undici.globalDispatcher.1")] = { compose: () => "legacy" };
			assert.deepEqual(bare(), { dispatcher: "legacy" }, "an older undici's slot");
		} finally {
			slot[Symbol.for("undici.globalDispatcher.2")] = saved!.value;
			slot[Symbol.for("undici.globalDispatcher.1")] = legacy;
		}
	});
});

describe("keeping t3 patched", () => {
	test("a failed run's notification names the App Management fix when macOS refused the write, else the error", () => {
		const refused = Object.assign(new Error("EPERM: operation not permitted, open '/Applications/T3.app/Contents/Resources/app.asar.rewrite'"), { code: "EPERM" });
		assert.equal(
			notPatchedMessage(refused, "/usr/local/bin/node"),
			"t3 is not patched for the harness: macOS blocked /usr/local/bin/node (App Management). Allow it in System Settings › Privacy & Security › App Management, or run `npm run patch-t3` in a terminal.",
		);
		assert.equal(notPatchedMessage(new Error(`t3 changed: ${"x".repeat(300)}`), "node"), `t3 is not patched for the harness: t3 changed: ${"x".repeat(148)}`);
		assert.equal(notPatchedMessage("odd", "node"), "t3 is not patched for the harness: odd");
	});

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

	test("finds the app's main process when the check runs inside it (a t3 session applying a patch)", async () => {
		// The main process is a shell started without arguments; the check runs in its child.
		const dir = mkdtempSync(join(tmpdir(), "t3-ancestor-"));
		const main = join(dir, "Fake T3 (Nightly)");
		symlinkSync("/bin/sh", main);
		try {
			const shell = spawn(main, [], { stdio: ["pipe", "pipe", "inherit"] });
			let out = "";
			shell.stdout.on("data", (chunk) => (out += chunk));
			const check = `import(${JSON.stringify(new URL("../scripts/patch-t3.ts", import.meta.url).href)}).then((m) => console.log(String(m.startedAgoS(${JSON.stringify(main)}))))`;
			shell.stdin.end(`${JSON.stringify(process.execPath)} -e '${check}'\n`);
			await new Promise((resolve) => shell.on("exit", resolve));
			const ago = Number(out.trim());
			assert.ok(Number.isFinite(ago) && ago >= 0 && ago < 30, `started ${out.trim()}s ago`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
				await keepPatched(app, tell),
				/^patched apps\/server\/dist\/chunk0\.mjs, apps\/server\/dist\/chunk1\.mjs, apps\/server\/dist\/chunk2\.mjs, apps\/server\/dist\/chunk3\.mjs \(cache-warming, dialogs, background-work, questions, questions-capability, background-caller, delegate-fork-runtime, delegate-fork-schema, delegate-fork-tool, delegate-template-schema, delegate-template-tool, delegate-template-runtime, session-questions, background-items, background-items-contract, background-items-caller, handoff-waits-for-run, handoff-ends-turn, thread-identity-search, connection-failure-resumable, background-released, background-released-contract, between-turns-ordinal, effect-slot-wait, effect-slot-handback, keyed-lock-contended, background-tasks-from-pi, followup-after-disposed-delivery, question-descriptions, task-id-resolution, promoted-task-delivered, promoted-run-wait, thread-wait-description, bridge-long-calls;/,
			);
			assert.deepEqual(readFileSync(`${archive}.pre-pi-harness`), original);
			for (const path of Object.keys(chunks)) assert.equal(readFile(archive, path).toString(), patchedChunk(path), path);
			assert.equal(readFile(archive, "apps/server/dist/other.mjs").toString(), "export {};\n");
			assert.equal(await keepPatched(app, tell), "already patched");
			assert.deepEqual(told, [], "t3 is not running: nothing to tell");
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
			const fork = (patch: Patch) => patch.name.startsWith("delegate-") || patch.name.startsWith("background-items") || patch.name.startsWith("background-released") || patch.name === "background-tasks-from-pi";
			const adapterChunk = "apps/server/dist/chunk0.mjs";
			const earlier = patchBundle(chunks[adapterChunk]!, chunkPatches[adapterChunk]!.filter((patch) => !fork(patch))).text;
			writeArchive(archive, { ...chunks, [adapterChunk]: earlier });
			const original = readFileSync(archive);
			assert.match(await keepPatched(app, tell), /\(delegate-fork-runtime, delegate-fork-schema, delegate-fork-tool, delegate-template-schema, delegate-template-tool, delegate-template-runtime, background-items, background-items-contract, background-items-caller, thread-identity-search, background-released, background-released-contract, keyed-lock-contended, background-tasks-from-pi, task-id-resolution, thread-wait-description;/);
			assert.ok(!existsSync(`${archive}.pre-pi-harness`), "an already patched archive is not t3's own");
			for (const path of Object.keys(chunks)) assert.equal(readFile(archive, path).toString(), patchedChunk(path), path);

			// t3 changed the MCP service: no chunk is patched, the adapter's included.
			const toolChunk = Object.keys(chunks).find((path) => chunks[path]!.includes("resolveTargetRechecking"))!;
			writeArchive(archive, { ...chunks, [toolChunk]: chunks[toolChunk]!.replace("task: taskPrompt(input),", "task: buildTask(input),") });
			const broken = readFileSync(archive);
			await assert.rejects(keepPatched(app, tell), /delegate-fork-tool patch\): expected the anchor once, found it 0 times/);
			assert.equal(told.length, 1);
			assert.match(told[0]!, /^t3 is not patched for the harness: t3 changed \(delegate-fork-tool patch\)/);
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
