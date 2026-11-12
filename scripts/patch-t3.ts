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
//
// Usage: node scripts/patch-t3.ts [path/to/T3 Code.app]   (default: T3 Code (Nightly))
// Idempotent per patch: one already applied (its marker present) is skipped. The original archive
// is kept next to it as app.asar.pre-pi-harness. Every t3 update replaces the archive, so the
// installer runs this again. Takes effect when t3 restarts.

import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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

export function patchApp(app: string): string {
	const archive = join(app, "Contents/Resources/app.asar");
	if (!existsSync(archive)) throw new Error(`${archive}: not found`);
	const { header } = readHeader(archive);
	const bundle = packedFiles(header)
		.map((f) => f.path)
		.filter((path) => path.startsWith("apps/server/dist/") && path.endsWith(".mjs"))
		.find((path) => readFile(archive, path).includes(ADAPTER));
	if (!bundle) return "Pi adapter not found (t3 changed); nothing patched";
	const original = readFile(archive, bundle).toString("utf8");
	const { text, applied } = patchBundle(original);
	if (applied.length === 0) return "already patched";
	const backup = `${archive}.pre-pi-harness`;
	// The backup is t3's own archive: taken when none of the patches is applied yet (a fresh install
	// or update), kept when an earlier run already patched this archive.
	if (PATCHES.every((patch) => !original.includes(patch.marker))) copyFileSync(archive, backup);
	replaceFiles(archive, { [bundle]: Buffer.from(text, "utf8") });
	return `patched ${bundle} (${applied.join(", ")}; original kept as ${backup}); restart t3 to apply`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	console.log(patchApp(process.argv[2] ?? "/Applications/T3 Code (Nightly).app"));
}
