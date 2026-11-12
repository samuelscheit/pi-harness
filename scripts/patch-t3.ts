#!/usr/bin/env node
// Patch the installed t3 app so a Pi session stays loaded while Pi's prompt cache warming is pending.
//
// t3 unloads a provider session after 30 idle minutes unless its runtime reports background work;
// its Pi adapter only reported native wakes, so the refresh Pi schedules before a one-hour cache
// expires (54 min) never ran. Pi (vendor/pi) emits `cache_warming` events; this applies the same
// change as t3code commit "fix(provider-pi): keep a Pi session loaded while its prompt cache warming
// is pending" (prepared in ../t3code, branch pi-cache-warming-keeps-session) to the bundled server.
//
// Usage: node scripts/patch-t3.ts [path/to/T3 Code.app]   (default: T3 Code (Nightly))
// Idempotent: an already patched app is left alone. The original archive is kept next to it as
// app.asar.pre-pi-harness. Every t3 update replaces the archive, so the installer runs this again.
// Takes effect when t3 restarts.

import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { packedFiles, readFile, readHeader, replaceFiles } from "./lib/asar.ts";

const MARKER = "cacheWarmingPending";

/** [anchor, replacement]: each anchor must occur exactly once in the bundled Pi adapter. */
export const EDITS: [anchor: string, replacement: string][] = [
	["let pendingWake = null;", `let pendingWake = null;\n\t\t\tlet ${MARKER} = false;`],
	[
		'if (event["type"] === "extension_ui_request" && event["method"] === "setStatus") {',
		`if (event["type"] === "cache_warming") {\n\t\t\t\t\tconst warmingState = piRecordString(event, "state");\n\t\t\t\t\t${MARKER} = warmingState === "scheduled" || warmingState === "refreshing";\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tif (event["type"] === "extension_ui_request" && event["method"] === "setStatus") {`,
	],
	["hasPendingBackgroundWork: sync(() => pendingWake !== null),", `hasPendingBackgroundWork: sync(() => pendingWake !== null || ${MARKER}),`],
	[
		"hasPendingBackgroundWorkForThread: (providerThread) => sync(() => pendingWake !== null && pendingWake.state.providerThread.id === providerThread.id),",
		`hasPendingBackgroundWorkForThread: (providerThread) => sync(() => pendingWake !== null && pendingWake.state.providerThread.id === providerThread.id || ${MARKER} && threadState?.providerThread.id === providerThread.id),`,
	],
];

const count = (text: string, anchor: string): number => text.split(anchor).length - 1;

/** The patched bundle text, `undefined` when already patched; throws when an anchor is missing or ambiguous. */
export function patchBundle(text: string): string | undefined {
	if (text.includes(MARKER)) return undefined;
	for (const [anchor] of EDITS) {
		const found = count(text, anchor);
		if (found !== 1) throw new Error(`t3 changed: expected the anchor once, found it ${found} times: ${anchor}`);
	}
	return EDITS.reduce((patched, [anchor, replacement]) => patched.replace(anchor, () => replacement), text);
}

export function patchApp(app: string): string {
	const archive = join(app, "Contents/Resources/app.asar");
	if (!existsSync(archive)) throw new Error(`${archive}: not found`);
	const { header } = readHeader(archive);
	const candidates = packedFiles(header)
		.map((f) => f.path)
		.filter((path) => path.startsWith("apps/server/dist/") && path.endsWith(".mjs"));
	const bundle = candidates.find((path) => readFile(archive, path).includes("hasPendingBackgroundWork: sync(() => pendingWake !== null"));
	if (!bundle) {
		const patched = candidates.some((path) => readFile(archive, path).includes(MARKER));
		return patched ? "already patched" : "Pi adapter not found (t3 changed); nothing patched";
	}
	const patched = patchBundle(readFile(archive, bundle).toString("utf8"));
	if (patched === undefined) return "already patched";
	const backup = `${archive}.pre-pi-harness`;
	copyFileSync(archive, backup);
	replaceFiles(archive, { [bundle]: Buffer.from(patched, "utf8") });
	return `patched ${bundle} (original kept as ${backup}); restart t3 to apply`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	console.log(patchApp(process.argv[2] ?? "/Applications/T3 Code (Nightly).app"));
}
