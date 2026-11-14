#!/usr/bin/env node
// Patch the installed t3 app's bundled Pi adapter with fixes prepared in ../t3code that t3 has not
// shipped yet. Each patch mirrors a t3code commit:
//
// - cache-warming (branch pi-cache-warming-keeps-session, "fix(provider-pi): keep a Pi session loaded
//   while its prompt cache warming is pending"): t3 unloads a provider session after 30 idle minutes
//   unless its runtime reports background work; its Pi adapter only reported native wakes, so the
//   refresh Pi schedules before a one-hour cache expires (54 min) never ran. Pi (vendor/pi) emits
//   `cache_warming` events.
// - dialogs (branch pi-dialogs-outlive-turns, "fix(provider-pi): keep Pi dialogs open past the turn
//   that showed them"): t3 cancelled every open Pi dialog when a turn ended, so an `ask_user`
//   question (which returns at once and is answered later) vanished moments after it appeared and
//   reached the agent as dismissed. Dialogs now live until answered, until Pi reports closing one
//   itself (`dismiss`, sent by vendor/pi), or until the process exits; an open dialog keeps the
//   session loaded.
// - session-questions (same branch, "fix(provider-pi): a Pi question belongs to the session, so a
//   turn's end leaves it open"): the orchestrator also closes a turn's pending questions when the
//   turn ends (ProviderEventIngestor.dismissNativeUserInputs, matched by the request's turn), so the
//   card still vanished, silently: Pi never heard of it and kept the dialog open. A select, input or
//   editor dialog's runtime request now carries no turn; its card keeps the turn for display.
//   Approvals (confirm) stay the turn's: that sweep never closes them.
// - background-work (same branch, "fix(provider-pi): keep a Pi session loaded while its extensions
//   have background work"): a bash command the harness moved to the background wakes the session
//   when it ends, so the session must outlive t3's 30-minute idle unload and the run must not
//   settle early (a delegated child would report done while its build still runs). Pi (vendor/pi)
//   emits `background_work` with the pending count (`pi.setBackgroundWork`).
// - questions (same branch, "feat(provider-pi): show a Pi questions dialog as one card"): Pi's
//   dialogs carried one question each, so an `ask_user` call with four questions became four cards
//   shown one after another. Pi (vendor/pi) now has a `questions` dialog (`ctx.ui.questions`): one
//   card holding every question, each with its options or free text, answered as `values` in order.
// - questions-capability (same branch, "feat(provider-pi): tell Pi which dialogs t3 renders"): t3
//   starts Pi with `PI_RPC_DIALOGS=questions`. Pi (vendor/pi) sends a questions dialog only to a
//   client that declares it, and otherwise one select or input per question. A t3 still running
//   code from before its `questions` patch (patches take effect on restart) dropped the unknown
//   dialog silently, so `ask_user` reported its questions shown while no card appeared
//   (2026-11-14, three reports).
// - background-caller (same branch, "fix(provider-pi): an idle Pi thread with background work stays
//   a live MCP caller"): t3 takes MCP tool calls from a thread only while it has an active run or a
//   pending `subagent` background task. A harness workflow runs in the background after its run
//   ended, so its agent() calls (`delegate_task`, `t3_thread_wait`) and its page (`html_render`)
//   failed with `parent_not_active` (2026-11-14, a real thread). While Pi reports background work,
//   the thread now lists the pending subagent task `pi-background-work`.
//
// Usage: node scripts/patch-t3.ts [path/to/T3 Code.app]   (default: T3 Code (Nightly))
// Idempotent per patch: one already applied (its marker present) is skipped. The original archive
// is kept next to it as app.asar.pre-pi-harness. A patch takes effect when t3 restarts.
//
// Kept applied automatically: t3 updates through Squirrel (ShipIt swaps in the new bundle and
// relaunches it), which drops every patch. The installer adds a LaunchAgent (`launchAgent`) that runs
// this whenever /Applications changes and at login. The relaunched t3 usually starts before the
// patch lands; then it is restarted at once when it launched less than RESTART_WINDOW_S ago (the
// updater just started it, nothing is in flight), and otherwise asked to restart by a notification.
// A t3 update that breaks a patch is reported by a notification too.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { packedFiles, readFile, readHeader, replaceFiles } from "./lib/asar.ts";

export interface Patch {
	name: string;
	/** Present in the bundle once the patch is applied. */
	marker: string;
	/** [anchor, replacement]: each anchor must occur exactly once when the patch is applied. */
	edits: [anchor: string, replacement: string][];
}

/** In order: a later patch's anchors may contain an earlier one's result. */
export const PATCHES: Patch[] = [
	{
		name: "cache-warming",
		marker: "cacheWarmingPending",
		edits: [
			["let pendingWake = null;", "let pendingWake = null;\n\t\t\tlet cacheWarmingPending = false;"],
			[
				'if (event["type"] === "extension_ui_request" && event["method"] === "setStatus") {',
				'if (event["type"] === "cache_warming") {\n\t\t\t\t\tconst warmingState = piRecordString(event, "state");\n\t\t\t\t\tcacheWarmingPending = warmingState === "scheduled" || warmingState === "refreshing";\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tif (event["type"] === "extension_ui_request" && event["method"] === "setStatus") {',
			],
			["hasPendingBackgroundWork: sync(() => pendingWake !== null),", "hasPendingBackgroundWork: sync(() => pendingWake !== null || cacheWarmingPending),"],
			[
				"hasPendingBackgroundWorkForThread: (providerThread) => sync(() => pendingWake !== null && pendingWake.state.providerThread.id === providerThread.id),",
				"hasPendingBackgroundWorkForThread: (providerThread) => sync(() => pendingWake !== null && pendingWake.state.providerThread.id === providerThread.id || cacheWarmingPending && threadState?.providerThread.id === providerThread.id),",
			],
		],
	},
	{
		name: "dialogs",
		marker: "closedByPi",
		edits: [
			[
				'const cancelPrompt = fn("PiAdapter.cancelPrompt")(function* (pending, resolvedAt) {',
				'const cancelPrompt = fn("PiAdapter.cancelPrompt")(function* (pending, resolvedAt, closedByPi = false) {',
			],
			[
				'yield* connection.send({\n\t\t\t\t\ttype: "extension_ui_response",\n\t\t\t\t\tid: pending.nativeRequestId,\n\t\t\t\t\tcancelled: true\n',
				'if (!closedByPi) yield* connection.send({\n\t\t\t\t\ttype: "extension_ui_response",\n\t\t\t\t\tid: pending.nativeRequestId,\n\t\t\t\t\tcancelled: true\n',
			],
			[
				'if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") {',
				'if (method === "dismiss") {\n\t\t\t\t\tconst entry = Array.from(pendingPrompts).find(([, pending]) => pending.nativeRequestId === nativeRequestId);\n\t\t\t\t\tif (entry === void 0) return;\n\t\t\t\t\tpendingPrompts.delete(entry[0]);\n\t\t\t\t\tyield* cancelPrompt(entry[1], yield* now, true);\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tif (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") {',
			],
			["\t\t\t\tyield* cancelPendingPrompts(completedAt);\n", ""],
			['"editor"\n\t\t\t\t].includes(String(event["method"]));', '"editor",\n\t\t\t\t\t"dismiss"\n\t\t\t\t].includes(String(event["method"]));'],
			[
				"hasPendingBackgroundWork: sync(() => pendingWake !== null || cacheWarmingPending),",
				"hasPendingBackgroundWork: sync(() => pendingWake !== null || cacheWarmingPending || pendingPrompts.size > 0),",
			],
		],
	},
	{
		name: "background-work",
		marker: "backgroundWorkPending",
		edits: [
			["let cacheWarmingPending = false;", "let cacheWarmingPending = false;\n\t\t\tlet backgroundWorkPending = false;"],
			[
				'cacheWarmingPending = warmingState === "scheduled" || warmingState === "refreshing";\n\t\t\t\t\treturn;\n\t\t\t\t}',
				'cacheWarmingPending = warmingState === "scheduled" || warmingState === "refreshing";\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tif (event["type"] === "background_work") {\n\t\t\t\t\tconst pending = event["pending"];\n\t\t\t\t\tbackgroundWorkPending = typeof pending === "number" && pending > 0;\n\t\t\t\t\treturn;\n\t\t\t\t}',
			],
			["cacheWarmingPending || pendingPrompts.size > 0", "cacheWarmingPending || backgroundWorkPending || pendingPrompts.size > 0"],
			[
				"cacheWarmingPending && threadState?.providerThread.id === providerThread.id",
				"(cacheWarmingPending || backgroundWorkPending) && threadState?.providerThread.id === providerThread.id",
			],
		],
	},
	{
		name: "questions",
		marker: "piQuestions",
		edits: [
			[
				'if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") {',
				'if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor" && method !== "questions") {',
			],
			[
				"questions: [piQuestion(nativeRequestId, method, title, event)]",
				'questions: method === "questions" ? piQuestions(nativeRequestId, event) : [piQuestion(nativeRequestId, method, title, event)]',
			],
			['"dismiss"\n\t\t\t\t].includes(String(event["method"]));', '"dismiss",\n\t\t\t\t\t"questions"\n\t\t\t\t].includes(String(event["method"]));'],
			[
				"function piUiResponse(pending, decision, answers) {",
				[
					"function piQuestions(nativeRequestId, event) {",
					'\tconst questions = piRecordField(event, "questions");',
					"\treturn (Array.isArray(questions) ? questions : []).map((question, index) => {",
					'\t\tconst options = piRecordField(question, "options");',
					"\t\treturn {",
					"\t\t\tid: `${nativeRequestId}:${index}`,",
					'\t\t\theader: "Question",',
					'\t\t\tquestion: piRecordString(question, "title")?.trim() || "Question",',
					'\t\t\toptions: Array.isArray(options) ? options.filter((option) => typeof option === "string").map((option) => ({ label: option || "Empty value", description: option || "Empty value", value: option })) : []',
					"\t\t};",
					"\t});",
					"}",
					"function piUiResponse(pending, decision, answers) {",
					'\tif (pending.method === "questions") {',
					'\t\tif (answers === void 0 || pending.turnItem.type !== "user_input_request") return { cancelled: true };',
					'\t\treturn { values: pending.turnItem.questions.map((question) => typeof answers[question.id] === "string" ? answers[question.id] : null) };',
					"\t}",
				].join("\n"),
			],
		],
	},
	{
		name: "questions-capability",
		marker: "PI_RPC_DIALOGS",
		edits: [["\treturn {\n\t\targs,\n\t\tenv: {\n\t\t\t...environment,\n", '\treturn {\n\t\targs,\n\t\tenv: {\n\t\t\t...environment,\n\t\t\tPI_RPC_DIALOGS: "questions",\n']],
	},
	{
		name: "background-caller",
		marker: "pi-background-work",
		edits: [
			[
				'const PI_INHERIT_MODEL_SLUG = "default";',
				'const PI_INHERIT_MODEL_SLUG = "default";\nconst PI_BACKGROUND_WORK_TASK = {\n\ttaskId: "pi-background-work",\n\tkind: "subagent",\n\tdescription: "Pi background work (a workflow or a command that moved to the background)"\n};',
			],
			[
				"const updateProviderThread = fnUntraced(function* (state, patch, retainedNativeTurnIds) {",
				[
					"const publishBackgroundWork = fnUntraced(function* () {",
					"\t\t\t\tif (threadState === null) return;",
					"\t\t\t\tconst current = threadState.providerThread.pendingBackgroundTasks ?? [];",
					"\t\t\t\tif (current.some((task) => task.taskId === PI_BACKGROUND_WORK_TASK.taskId) === backgroundWorkPending) return;",
					"\t\t\t\tconst others = current.filter((task) => task.taskId !== PI_BACKGROUND_WORK_TASK.taskId);",
					"\t\t\t\tyield* updateProviderThread(threadState, { pendingBackgroundTasks: backgroundWorkPending ? [...others, PI_BACKGROUND_WORK_TASK] : others });",
					"\t\t\t});",
					"\t\t\tconst updateProviderThread = fnUntraced(function* (state, patch, retainedNativeTurnIds) {",
				].join("\n"),
			],
			[
				'backgroundWorkPending = typeof pending === "number" && pending > 0;\n\t\t\t\t\treturn;',
				'backgroundWorkPending = typeof pending === "number" && pending > 0;\n\t\t\t\t\tyield* publishBackgroundWork();\n\t\t\t\t\treturn;',
			],
			[
				"forkedFrom: null,\n\t\t\t\t\tpendingBackgroundTasks: [],\n\t\t\t\t\tcreatedAt,\n\t\t\t\t\tupdatedAt: createdAt\n\t\t\t\t};\n\t\t\t\tthreadState = {",
				"forkedFrom: null,\n\t\t\t\t\tpendingBackgroundTasks: backgroundWorkPending ? [PI_BACKGROUND_WORK_TASK] : [],\n\t\t\t\t\tcreatedAt,\n\t\t\t\t\tupdatedAt: createdAt\n\t\t\t\t};\n\t\t\t\tthreadState = {",
			],
		],
	},
	{
		name: "session-questions",
		marker: "questionOwnedBySession",
		edits: [
			[
				'nodeId,\n\t\t\t\t\tproviderTurnId,\n\t\t\t\t\tnativeRequestRef: providerRef(nativeRequestId),\n\t\t\t\t\tkind: method === "confirm" ? "command" : "user_input",',
				'nodeId,\n\t\t\t\t\tproviderTurnId: method === "confirm" ? providerTurnId : null /* questionOwnedBySession */,\n\t\t\t\t\tnativeRequestRef: providerRef(nativeRequestId),\n\t\t\t\t\tkind: method === "confirm" ? "command" : "user_input",',
			],
		],
	},
];

/** Identifies the bundled Pi adapter, patched or not. */
const ADAPTER = '"PiAdapter.cancelPrompt"';

const count = (text: string, anchor: string): number => text.split(anchor).length - 1;

/** The bundle with every missing patch applied, and the names applied; throws when an anchor is missing or ambiguous. */
export function patchBundle(text: string, patches: Patch[] = PATCHES): { text: string; applied: string[] } {
	const applied: string[] = [];
	for (const patch of patches) {
		if (text.includes(patch.marker)) continue;
		for (const [anchor] of patch.edits) {
			const found = count(text, anchor);
			if (found !== 1) throw new Error(`t3 changed (${patch.name} patch): expected the anchor once, found it ${found} times: ${anchor}`);
		}
		text = patch.edits.reduce((patched, [anchor, replacement]) => patched.replace(anchor, () => replacement), text);
		if (!text.includes(patch.marker)) throw new Error(`${patch.name} patch: its marker ${patch.marker} is missing after applying it`);
		applied.push(patch.name);
	}
	return { text, applied };
}

/** Applies the missing patches to the app's archive; `applied` names them (empty when there were none). */
export function patchApp(app: string): { applied: string[]; message: string } {
	const archive = join(app, "Contents/Resources/app.asar");
	if (!existsSync(archive)) throw new Error(`${archive}: not found`);
	const { header } = readHeader(archive);
	const bundle = packedFiles(header)
		.map((f) => f.path)
		.filter((path) => path.startsWith("apps/server/dist/") && path.endsWith(".mjs"))
		.find((path) => readFile(archive, path).includes(ADAPTER));
	if (!bundle) throw new Error("t3 changed: its Pi adapter was not found; nothing patched");
	const original = readFile(archive, bundle).toString("utf8");
	const { text, applied } = patchBundle(original);
	if (applied.length === 0) return { applied, message: "already patched" };
	const backup = `${archive}.pre-pi-harness`;
	// The backup is t3's own archive: taken when none of the patches is applied yet (a fresh install
	// or update), kept when an earlier run already patched this archive.
	if (PATCHES.every((patch) => !original.includes(patch.marker))) copyFileSync(archive, backup);
	// Written to a new file and renamed over the archive: a running t3 keeps reading the old one.
	replaceFiles(archive, { [bundle]: Buffer.from(text, "utf8") });
	return { applied, message: `patched ${bundle} (${applied.join(", ")}; original kept as ${backup})` };
}

/** A t3 launched this recently was started by its updater: restarting it loses no work. */
export const RESTART_WINDOW_S = 120;

/**
 * What the running t3 needs after a patch run, given how long ago its main process started (undefined:
 * not running), measured right after patching. Running then, it may have loaded the old bundle.
 */
export function afterPatch(applied: string[], startedAgoS: number | undefined): "none" | "restart" | "notify" {
	if (applied.length === 0 || startedAgoS === undefined) return "none";
	return startedAgoS < RESTART_WINDOW_S ? "restart" : "notify";
}

/** Seconds in a `ps` elapsed time, `[[dd-]hh:]mm:ss`. */
export function elapsedSeconds(etime: string): number {
	const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
	return clock!.split(":").reduce((total, part) => total * 60 + Number(part), 0) + Number(days) * 86_400;
}

/** The app's main executable (bundle name without `.app`). */
const executable = (app: string) => join(app, "Contents/MacOS", basename(app, ".app"));

/**
 * Seconds since a process started from `main` without arguments did (an app's main process; its
 * helpers carry arguments), or undefined when none runs.
 */
export function startedAgoS(main: string): number | undefined {
	const line = execFileSync("ps", ["-axo", "etime=,args="], { encoding: "utf8" })
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.slice(l.indexOf(" ") + 1) === main);
	return line === undefined ? undefined : elapsedSeconds(line.slice(0, line.indexOf(" ")));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function notify(message: string): void {
	const quoted = (text: string) => JSON.stringify(text);
	execFileSync("osascript", ["-e", `display notification ${quoted(message)} with title "pi-harness" sound name "Funk"`]);
}

/** Quits the app and opens it again; false when it did not quit within a minute. */
async function restart(app: string): Promise<boolean> {
	const id = execFileSync("defaults", ["read", join(app, "Contents/Info"), "CFBundleIdentifier"], { encoding: "utf8" }).trim();
	execFileSync("osascript", ["-e", `tell application id ${JSON.stringify(id)} to quit`]);
	for (let waited = 0; startedAgoS(executable(app)) !== undefined; waited += 500) {
		if (waited >= 60_000) return false;
		await sleep(500);
	}
	execFileSync("open", [app]);
	return true;
}

/** Patches the app (waiting out an update that is still swapping the bundle) and brings the running t3 onto the patches. */
export async function keepPatched(app: string): Promise<string> {
	const archive = join(app, "Contents/Resources/app.asar");
	// ShipIt moves the old bundle out before moving the new one in.
	for (let waited = 0; !existsSync(archive); waited += 1_000) {
		if (waited >= 60_000) return `${app} not installed; nothing to patch`;
		await sleep(1_000);
	}
	let result: ReturnType<typeof patchApp>;
	try {
		result = patchApp(app);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notify(`t3 is not patched for the harness: ${message.slice(0, 160)}`);
		throw error;
	}
	switch (afterPatch(result.applied, startedAgoS(executable(app)))) {
		case "none":
			return result.message;
		case "restart":
			if (await restart(app)) return `${result.message}; restarted t3, which its update had just started`;
			break;
		case "notify":
			break;
	}
	notify(`t3 was patched for the harness (${result.applied.join(", ")}). Restart t3 to apply.`);
	return `${result.message}; asked to restart t3`;
}

export const LAUNCH_AGENT = "com.pi-harness.patch-t3";

/** The LaunchAgent that runs `keepPatched` at login and whenever the app's folder changes (an update swaps the bundle). */
export function launchAgent(options: { node: string; script: string; app: string; log: string }): string {
	const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	const string = (text: string) => `<string>${xml(text)}</string>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>${string(LAUNCH_AGENT)}
	<key>ProgramArguments</key>
	<array>${[options.node, options.script, options.app].map(string).join("")}</array>
	<key>WatchPaths</key>
	<array>${string(dirname(options.app))}</array>
	<key>RunAtLoad</key><true/>
	<key>StandardOutPath</key>${string(options.log)}
	<key>StandardErrorPath</key>${string(options.log)}
</dict>
</plist>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const app = process.argv[2] ?? "/Applications/T3 Code (Nightly).app";
	console.log(`${new Date().toISOString()} ${await keepPatched(app)}`);
}
