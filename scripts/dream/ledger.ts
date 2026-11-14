// Dreaming, step 5: what each run decided, kept in the harness repository so it is reviewable and
// versioned with the rules it changed:
//
//   .agents/dreams/ledger.jsonl   one record per correction a run considered: its label, the rule
//                                 derived from it, the delta (recur, add, update, skip), the rule it
//                                 concerns (id and text: line ids move, texts identify) and the commit
//   .agents/dreams/state.json     the time up to which messages were read
//   .agents/dreams/<date>.md      the run's report
//
// The recurrence metric (docs/research/context-engineering/05): a correction matched to a rule that
// already existed. A rule that keeps recurring after it was written does not work as text; it is a
// candidate for a mechanical guard (like extensions/bash) instead of more wording.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
	skipped?: string;
	reason?: string;
}

export const dreamsDir = (source: string) => join(source, ".agents", "dreams");
export const ledgerFile = (source: string) => join(dreamsDir(source), "ledger.jsonl");
export const stateFile = (source: string) => join(dreamsDir(source), "state.json");

export function readLedger(source: string): LedgerRecord[] {
	if (!existsSync(ledgerFile(source))) return [];
	return readFileSync(ledgerFile(source), "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as LedgerRecord);
}

export function appendLedger(source: string, records: readonly LedgerRecord[]): void {
	if (records.length === 0) return;
	mkdirSync(dreamsDir(source), { recursive: true });
	appendFileSync(ledgerFile(source), records.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

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
	for (const r of ledger) if ((r.op === "add" || r.op === "update") && r.commit && r.targetText) written.set(normalize(r.targetText), Math.min(written.get(normalize(r.targetText)) ?? Infinity, r.ts));
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
const clip = (text: string, max = 160) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export interface RunSummary {
	run: Date;
	since: number;
	until: number;
	messages: number;
	labelled: Record<string, number>;
	records: readonly LedgerRecord[];
	/** Every open improvement note, per backlog. */
	notes: readonly OpenNote[];
}

/** A note still in a backlog: fixing it removes it there, so every note listed is open. */
export interface OpenNote {
	backlog: string;
	/** `YYYY-MM-DD HH:MM` (UTC), the note's heading. */
	at: string;
	observation: string;
	/** Written after the run's start position. */
	new: boolean;
}

/** The run's report in Markdown. */
export function report(summary: RunSummary, ledger: readonly LedgerRecord[]): string {
	const ops = (op: LedgerRecord["op"]) => summary.records.filter((r) => r.op === op);
	/** Deltas, not corrections: several corrections can make one rule. */
	const rules = (op: "add" | "update") => new Set(ops(op).map((r) => r.targetText)).size;
	const changed = summary.records.filter((r) => r.commit);
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
			? [...new Map(summary.records.filter((r) => r.commit || r.skipped).map((r) => [`${r.op}\0${r.targetText ?? r.derived}`, r])).values()].map((r) => `- ${r.op} ${r.target ?? ""}: ${clip(r.targetText ?? r.derived)}${r.commit ? ` (${r.commit.slice(0, 9)})` : ` — not applied: ${r.skipped}`}`)
			: ["None."]),
		"",
		"## Recurrences this run",
		"",
		...(ops("recur").length ? ops("recur").map((r) => `- ${r.target}: ${clip(r.targetText ?? "")} — "${clip(r.derived, 100)}"`) : ["None."]),
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
		"## Open improvement notes",
		"",
		"Friction agents noted (`note_improvement`). Each one stays here until a fix removes it from its backlog.",
		"",
		...(summary.notes.length
			? [...Map.groupBy(summary.notes, (n) => n.backlog)].flatMap(([backlog, notes]) => [
					`### ${backlog} (${notes.length} open, ${notes.filter((n) => n.new).length} new)`,
					"",
					...notes.map((n) => `- ${n.at}${n.new ? " (new)" : ""}: ${clip(n.observation, 200)}`),
					"",
				])
			: ["None."]),
		"",
	]
		.filter((line, i, all) => !(line === "" && all[i - 1] === ""))
		.join("\n");
}

/** The notes in improvement backlogs (`.agents/improvements.md`), oldest first per backlog; missing files have none. */
export function openNotes(backlogs: readonly string[], since: number): OpenNote[] {
	return backlogs.filter((file) => existsSync(file)).flatMap((backlog) =>
		readFileSync(backlog, "utf8")
			.split(/\n(?=## \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC)/)
			.flatMap((block) => {
				const when = /^## (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC/.exec(block);
				if (!when) return [];
				const observation = /\*\*Observation:\*\* (.*)/.exec(block)?.[1] ?? "";
				return [{ backlog, at: `${when[1]} ${when[2]}`, observation, new: Date.parse(`${when[1]}T${when[2]}:00Z`) > since }];
			}),
	);
}
