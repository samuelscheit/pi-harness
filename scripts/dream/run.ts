// Dreaming: learn working rules from the corrections the user typed since the last run.
//
//   1. collect  the user's messages in Pi sessions since the last run (collect.ts)
//   2. label    each one with a cheap model: kind, the reusable rule it implies, its scope (lib/labels.ts)
//   3. curate   the corrections with a rule into small deltas against the known rules (curate.ts)
//   4. apply    each delta as its own commit, live at once (apply.ts)
//   5. record   the ledger, the read position and the report, committed together (ledger.ts)
//
// Runs nightly as a t3 scheduled task. Usage:
//   node scripts/dream/run.ts [--dry-run] [--since <ISO date>]
// --dry-run labels and curates but changes and commits nothing, and prints the deltas.

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { SOURCE_ROOT } from "../../extensions/lib/repository.ts";
import { indexAll, metricsPath } from "../../extensions/metrics/stats.ts";
import { openStore } from "../../extensions/metrics/store.ts";
import { type Ask, askJson, isNegative, labelMessages } from "../lib/labels.ts";
import { type Applied, applyDelta } from "./apply.ts";
import { collect } from "./collect.ts";
import { type Candidate, curate, type Delta } from "./curate.ts";
import { appendLedger, dreamsDir, type LedgerRecord, ledgerFile, notesSince, readLedger, readSince, report, stateFile, writeSince } from "./ledger.ts";
import { globalRules, type KnownRule, projectRules } from "./rules.ts";

export const LABEL_MODEL = "claude-sonnet-5-5";
export const CURATE_MODEL = "claude-opus-5-5";

export interface DreamOptions {
	/** The harness repository: rules, ledger and reports live here. */
	source: string;
	db: DatabaseSync;
	now?: Date;
	/** Read messages after this time instead of the stored position. */
	since?: number;
	ask?: Ask;
	dryRun?: boolean;
	log?: (line: string) => void;
}

export interface DreamResult {
	deltas: Delta[];
	applied: Applied[];
	records: LedgerRecord[];
	/** The report file, unless a dry run. */
	reportFile?: string;
	text: string;
}

/** Updates before additions: a project rule's id is its line, and an addition can move later lines. */
const ORDER: Record<Delta["op"], number> = { update: 0, add: 1, recur: 2, skip: 3 };

export async function dream({ source, db, now = new Date(), since = readSince(source), ask = askJson, dryRun = false, log = () => {} }: DreamOptions): Promise<DreamResult> {
	const until = now.getTime();
	const observations = collect(db, since).filter((o) => o.ts <= until);
	log(`${observations.length} messages since ${new Date(since).toISOString()}`);
	const labels = observations.length ? await labelMessages(observations, LABEL_MODEL, { ask }) : [];
	const labelled: Record<string, number> = {};
	for (const l of labels) labelled[l.label] = (labelled[l.label] ?? 0) + 1;

	const candidates: (Candidate & { observation: (typeof observations)[number] })[] = [];
	observations.forEach((o, i) => {
		const l = labels[i]!;
		if (isNegative(l.label) && l.rule && l.scope) candidates.push({ ref: `c${candidates.length + 1}`, label: l.label, text: o.text, rule: l.rule, scope: l.scope, repo: o.repo, ...(o.before ? { before: o.before } : {}), observation: o });
	});
	const global = globalRules(join(source, "prompt"));
	const projects = new Map([...new Set(candidates.map((c) => c.repo))].map((repo) => [repo, projectRules(repo)] as const));
	const deltas = (await curate(candidates, { global, projects }, CURATE_MODEL, ask)).sort((a, b) => ORDER[a.op] - ORDER[b.op]);
	log(`${candidates.length} corrections with a rule, ${deltas.length} deltas`);

	const known = new Map<string, KnownRule>([...global, ...[...projects.values()].flat()].map((r) => [r.id, r]));
	const byRef = new Map(candidates.map((c) => [c.ref, c]));
	const applied: Applied[] = deltas.map((delta) => {
		if (dryRun) return { delta, ...("rule" in delta ? { target: delta.rule } : {}) };
		try {
			return applyDelta(delta, { source, now, rules: known, evidence: (ref) => byRef.get(ref)!.observation });
		} catch (error) {
			return { delta, skipped: `failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
		}
	});

	const run = now.toISOString();
	const records: LedgerRecord[] = applied.flatMap(({ delta, target, commit, skipped }) =>
		delta.evidence.map((ref) => {
			const c = byRef.get(ref)!;
			const targetText = delta.op === "add" || delta.op === "update" ? delta.text : target ? known.get(target)?.text : undefined;
			return {
				run,
				ts: c.observation.ts,
				session: c.observation.sessionId,
				entry: c.observation.entryId,
				repo: c.repo,
				label: c.label,
				derived: c.rule,
				op: delta.op,
				...(target ? { target } : {}),
				...(targetText ? { targetText } : {}),
				...(commit ? { commit } : {}),
				...(skipped ? { skipped } : {}),
				...(delta.op === "skip" || delta.op === "update" ? { reason: delta.reason } : {}),
			};
		}),
	);
	const summary = { run: now, since, until, messages: observations.length, labelled, records, notes: notesSince(join(source, ".agents", "improvements.md"), since) };
	if (dryRun) return { deltas, applied, records, text: report(summary, [...readLedger(source), ...records]) };

	appendLedger(source, records);
	writeSince(source, until);
	const text = report(summary, readLedger(source));
	let reportFile = join(dreamsDir(source), `${run.slice(0, 10)}.md`);
	if (existsSync(reportFile)) reportFile = join(dreamsDir(source), `${run.slice(0, 16).replace(":", "")}.md`);
	writeFileSync(reportFile, text);
	const files = [ledgerFile(source), stateFile(source), reportFile].filter(existsSync).map((f) => relative(source, f));
	execFileSync("git", ["-C", source, "add", "--", ...files]);
	execFileSync("git", ["-C", source, "commit", "--only", "-m", `chore(dream): report ${run.slice(0, 10)}`, "--", ...files], { stdio: "pipe" });
	return { deltas, applied, records, reportFile, text };
}

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { "dry-run": { type: "boolean" }, since: { type: "string" } } });
	const since = values.since === undefined ? undefined : Date.parse(values.since);
	if (since !== undefined && Number.isNaN(since)) throw new Error(`--since: not a date: ${values.since}`);
	const db = openStore(metricsPath());
	try {
		indexAll(db);
		const result = await dream({ source: SOURCE_ROOT, db, ...(since === undefined ? {} : { since }), dryRun: values["dry-run"] === true, log: (line) => console.error(line) });
		if (values["dry-run"]) console.log(JSON.stringify(result.deltas, null, 2));
		console.log(result.text);
		if (result.reportFile) console.log(`\nReport: ${result.reportFile}`);
	} finally {
		db.close();
	}
}

if (import.meta.main) await main();
