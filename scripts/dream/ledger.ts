// Dreaming, step 5: what each run decided, kept next to the harness repository's improvement
// backlog in `.agents/` (local state: git-ignored, never committed; the rules a run changed are
// commits of their own, see apply.ts):
//
//   .agents/dreams/ledger.jsonl   one record per correction a run considered: its label, the rule
//                                 derived from it, the delta (recur, add, update, skip), the rule it
//                                 concerns (id and text: line ids move, texts identify), the commit
//                                 and, when its repository refused it, the branch that holds it
//   .agents/dreams/state.json     the time up to which messages were read
//   .agents/dreams/<date>.md      the run's report
//
// The recurrence metric (docs/research/context-engineering/05): a correction matched to a rule that
// already existed. A rule that keeps recurring after it was written does not work as text; it is a
// candidate for a mechanical guard (like extensions/bash) instead of more wording.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BacklogNote } from "../../extensions/improvements/index.ts";
import { appendJsonl, readJsonl } from "../../extensions/lib/jsonl.ts";
import { clip } from "../../extensions/metrics/format.ts";

export interface LedgerRecord {
	/** When the run happened (ISO). */
	run: string;
	ts: number;
	session: string;
	entry: string;
	repo: string;
	label: string;
	derived: string;
	op: "recur" | "add" | "update" | "skip";
	target?: string;
	targetText?: string;
	commit?: string;
	/** The branch holding the commit when the checked-out branch refused it: committed, not landed. */
	branch?: string;
	refused?: string;
	skipped?: string;
	reason?: string;
}

export const dreamsDir = (source: string) => join(source, ".agents", "dreams");
const ledgerFile = (source: string) => join(dreamsDir(source), "ledger.jsonl");
const stateFile = (source: string) => join(dreamsDir(source), "state.json");

export const readLedger = (source: string): LedgerRecord[] => readJsonl(ledgerFile(source));
export const appendLedger = (source: string, records: readonly LedgerRecord[]) => appendJsonl(ledgerFile(source), records);

/** What dreaming decided about spend: one record per started experiment, verdict, refused proposal and note (`economy.jsonl`). */
export interface EconomyRecord {
	run: string;
	kind: "started" | "verdict" | "note" | "refused";
	experiment?: string;
	decision?: string;
	reasons?: string[];
	commit?: string;
	/** The branch holding the commit when the checked-out branch refused it: decided, not landed. */
	branch?: string;
	text?: string;
}

const economyFile = (source: string) => join(dreamsDir(source), "economy.jsonl");
export const readEconomy = (source: string): EconomyRecord[] => readJsonl(economyFile(source), (r) => typeof (r as EconomyRecord).kind === "string");
export const appendEconomy = (source: string, records: readonly EconomyRecord[]) => appendJsonl(economyFile(source), records);

/** Experiments whose start, promotion or stop is committed on a branch that did not land yet, with the branch. */
export function pendingBranches(economy: readonly EconomyRecord[]): Map<string, string> {
	const pending = new Map<string, string>();
	for (const r of economy) if (r.experiment && r.branch && (r.kind === "started" || (r.kind === "verdict" && r.decision !== "continue"))) pending.set(r.experiment, r.branch);
	return pending;
}

/** The harness repository's prompt directories that dreaming writes to. */
export const experimentsDir = (source: string) => join(source, "prompt", "experiments");
export const rulesDir = (source: string) => join(source, "prompt", "rules");
export const DAY_MS = 86_400_000;

/** The time up to which messages were read; 0 before the first run. */
export const readSince = (source: string): number => (existsSync(stateFile(source)) ? (JSON.parse(readFileSync(stateFile(source), "utf8")) as { since: number }).since : 0);

export function writeSince(source: string, since: number): void {
	mkdirSync(dreamsDir(source), { recursive: true });
	writeFileSync(stateFile(source), `${JSON.stringify({ since, sinceIso: new Date(since).toISOString() }, null, "\t")}\n`);
}

export interface Recurrence {
	text: string;
	ids: string[];
	count: number;
	sessions: number;
	last: number;
	/** When dreaming wrote the rule, if it did. */
	written?: number;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Recurrences per rule over the whole ledger, the most repeated first. */
export function recurrences(ledger: readonly LedgerRecord[]): Recurrence[] {
	const written = new Map<string, number>();
	for (const r of ledger) if ((r.op === "add" || r.op === "update") && r.commit && !r.branch && r.targetText) written.set(normalize(r.targetText), Math.min(written.get(normalize(r.targetText)) ?? Infinity, r.ts));
	const groups = new Map<string, { text: string; ids: Set<string>; sessions: Set<string>; count: number; last: number }>();
	for (const r of ledger) {
		if (r.op !== "recur" || !r.targetText) continue;
		const key = normalize(r.targetText);
		const group = groups.get(key) ?? groups.set(key, { text: r.targetText, ids: new Set(), sessions: new Set(), count: 0, last: 0 }).get(key)!;
		if (r.target) group.ids.add(r.target);
		group.sessions.add(r.session);
		group.count++;
		group.last = Math.max(group.last, r.ts);
	}
	return [...groups]
		.map(([key, g]) => ({ text: g.text, ids: [...g.ids], count: g.count, sessions: g.sessions.size, last: g.last, ...(written.has(key) ? { written: written.get(key)! } : {}) }))
		.sort((a, b) => b.sessions - a.sessions || b.count - a.count);
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

export interface RunSummary {
	run: Date;
	since: number;
	until: number;
	messages: number;
	labelled: Record<string, number>;
	records: readonly LedgerRecord[];
	/** The improvement notes the run took out of the backlogs. */
	notes: readonly BacklogNote[];
	/** The spend section (economize.ts `spendSection`). */
	spend?: string;
}

/** The run's report in Markdown. */
export function report(summary: RunSummary, ledger: readonly LedgerRecord[]): string {
	const ops = (op: LedgerRecord["op"]) => summary.records.filter((r) => r.op === op);
	/** Deltas, not corrections: several corrections can make one rule. */
	const rules = (op: "add" | "update") => new Set(ops(op).map((r) => r.targetText)).size;
	const changed = summary.records.filter((r) => r.commit);
	const outcome = (r: LedgerRecord) =>
		r.commit ? ` (${r.commit.slice(0, 9)})${r.branch ? ` — committed on branch ${r.branch}, not landed: ${r.refused}` : ""}` : ` — not applied: ${r.skipped}`;
	const runs = new Map<string, LedgerRecord[]>();
	for (const r of ledger) runs.set(r.run, [...(runs.get(r.run) ?? []), r]);
	const rate = (records: LedgerRecord[]) => {
		const decided = records.filter((r) => r.op !== "skip").length;
		return decided ? `${Math.round((100 * records.filter((r) => r.op === "recur").length) / decided)}%` : "–";
	};
	const recurring = recurrences(ledger);
	const stubborn = recurring.filter((r) => r.sessions >= 2);
	const labelled = Object.entries(summary.labelled).sort((a, b) => b[1] - a[1]);
	return [
		`# Dream ${day(summary.run.getTime())}`,
		"",
		`Messages the user typed between ${new Date(summary.since).toISOString()} and ${new Date(summary.until).toISOString()}: ${summary.messages}.`,
		labelled.length ? `Labels: ${labelled.map(([label, n]) => `${label} ${n}`).join(", ")}.` : "",
		`Corrections with a rule: ${summary.records.length}: ${ops("recur").length} recurring an existing rule, ${ops("add").length} making ${rules("add")} new rules, ${ops("update").length} making ${rules("update")} updates, ${ops("skip").length} skipped.`,
		"",
		"## Changes",
		"",
		...(changed.length || summary.records.some((r) => r.skipped)
			? [...new Map(summary.records.filter((r) => r.commit || r.skipped).map((r) => [`${r.op}\0${r.targetText ?? r.derived}`, r])).values()].map((r) => `- ${r.op} ${r.target ?? r.repo}: ${clip(r.targetText ?? r.derived, 160)}${outcome(r)}`)
			: ["None."]),
		"",
		"## Recurrences this run",
		"",
		...(ops("recur").length ? ops("recur").map((r) => `- ${r.target}: ${clip(r.targetText ?? "", 160)} — "${clip(r.derived, 100)}"`) : ["None."]),
		"",
		"## Rules that keep recurring (2+ sessions, all runs)",
		"",
		"Written down and still broken: candidates for a mechanical guard rather than more wording.",
		"",
		...(stubborn.length
			? ["| rule | corrections | sessions | last | written by dreaming |", "|---|---|---|---|---|", ...stubborn.map((r) => `| ${clip(r.text, 120).replaceAll("|", "/")} | ${r.count} | ${r.sessions} | ${day(r.last)} | ${r.written ? day(r.written) : "–"} |`)]
			: ["None yet."]),
		"",
		"## Recurrence rate by run",
		"",
		"Share of decided corrections (not skipped) that an existing rule already covered.",
		"",
		"| run | corrections | recurrence |",
		"|---|---|---|",
		...[...runs].map(([run, records]) => `| ${run.slice(0, 16).replace("T", " ")} | ${records.length} | ${rate(records)} |`),
		"",
		...(summary.spend ? [summary.spend, ""] : []),
		"## Improvement notes",
		"",
		"Friction agents noted (`note_improvement`), moved here from their backlogs: fix each, or put it back into its backlog to read it again next run.",
		"",
		"Fix a note of a project repository the way its AGENTS.md or CLAUDE.md prescribes: in a worktree made with its own worktree tool, landed with its own landing tool. Never edit or commit in its main checkout: on 16.11.2026 a fixing pass committed on law-formalization's `main` past `tools/kernel/land.py`, and its changes to tracked files blocked every landing.",
		"",
		...(summary.notes.length ? [...Map.groupBy(summary.notes, (n) => n.backlog)].flatMap(([backlog, notes]) => [`### ${backlog}`, "", ...notes.flatMap((n) => [`#### ${n.at} UTC`, "", n.body, ""])]) : ["None."]),
		"",
	]
		.filter((line, i, all) => !(line === "" && all[i - 1] === ""))
		.join("\n");
}


