// Dreaming: learn working rules from the corrections the user typed since the last run, and spend
// less on models without working worse.
//
//   1. collect    the user's messages in Pi sessions since the last run (collect.ts)
//   2. label      each one with a cheap model: kind, the reusable rule it implies, its scope
//                 (lib/labels.ts); every label is kept (metrics/labels.ts) as the quality signal of
//                 the A/B comparison
//   3. curate     the corrections with a rule into small deltas against the known rules (curate.ts)
//   4. apply      each delta as its own commit, live at once (apply.ts)
//   5. judge      the spend experiments dreaming started: promote, stop or keep each, on cost and
//                 quality including blind reviews of sampled sessions (judge.ts, review.ts)
//   6. economize  the spend facts since the last run (spend.ts) to an economist model, whose
//                 measurable proposals start as A/B experiments (economize.ts)
//   7. record     the ledgers, the read position and the report in .agents/dreams (ledger.ts); local
//                 state, git-ignored, never committed
//
// Runs nightly as a t3 scheduled task. Usage:
//   node scripts/dream/run.ts [--dry-run] [--since <ISO date>]
// --dry-run labels, curates, reviews, judges and asks the economist, but changes, commits and
// records nothing, and prints the deltas.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { BACKLOG, readNotes, takeNotes } from "../../extensions/improvements/index.ts";
import { SOURCE_ROOT } from "../../extensions/lib/repository.ts";
import { indexAll, metricsPath } from "../../extensions/metrics/stats.ts";
import { openStore } from "../../extensions/metrics/store.ts";
import { appendLabels, indexLabels, isNegative, LABELS_FILE_NAME } from "../../extensions/metrics/labels.ts";
import { type Ask, askJson, labelMessages } from "../lib/labels.ts";
import { type Applied, applyDelta, plannedTarget } from "./apply.ts";
import { collect, repositories } from "./collect.ts";
import { type Candidate, curate, type Delta } from "./curate.ts";
import { type Economy, economize, type Started, spendSection } from "./economize.ts";
import { type Judged, judge } from "./judge.ts";
import { appendEconomy, appendLedger, dreamsDir, type EconomyRecord, type LedgerRecord, readLedger, readSince, report, writeSince } from "./ledger.ts";
import { globalRules, type KnownRule, projectRules } from "./rules.ts";
import { spendFacts, windows } from "./spend.ts";

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
	verdicts: Judged[];
	economy: Economy;
	started: Started[];
	/** The report file, unless a dry run. */
	reportFile?: string;
	text: string;
}

/** Updates before additions: a project rule's id is its line, and an addition can move later lines. */
const ORDER: Record<Delta["op"], number> = { update: 0, add: 1, recur: 2, skip: 3 };

export async function dream({ source, db, now = new Date(), since = readSince(source), ask = askJson, dryRun = false, log = () => {} }: DreamOptions): Promise<DreamResult> {
	const labelsFile = join(dreamsDir(source), LABELS_FILE_NAME);
	const until = now.getTime();
	const observations = collect(db, since).filter((o) => o.ts <= until);
	log(`${observations.length} messages since ${new Date(since).toISOString()}`);
	const labels = observations.length ? await labelMessages(observations, LABEL_MODEL, { ask }) : [];
	if (!dryRun) {
		appendLabels(
			observations.map((o, i) => ({ session: o.sessionId, entry: o.entryId, ts: o.ts, label: labels[i]!.label })),
			labelsFile,
		);
		indexLabels(db, labelsFile);
	}
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
		const target = plannedTarget(delta);
		return dryRun ? { delta, ...(target ? { target } : {}) } : applyDelta(delta, { source, now, rules: known, evidence: (ref) => byRef.get(ref)!.observation });
	});

	const run = now.toISOString();
	const records: LedgerRecord[] = applied.flatMap(({ delta, target, commit, branch, refused, skipped }) =>
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
				...(branch ? { branch, refused } : {}),
				...(skipped ? { skipped } : {}),
				...(delta.op === "skip" || delta.op === "update" ? { reason: delta.reason } : {}),
			};
		}),
	);
	const verdicts = await judge({ source, db, now, ask, dryRun, log });
	const { window, baseline } = windows(since, until);
	const facts = spendFacts(db, window, baseline);
	// Without requests in the window there is nothing to economize on.
	const { economy, started } = facts.requests ? await economize({ source, db, now, facts: facts.text, ask, dryRun }) : { economy: { proposals: [], notes: [], refused: [] }, started: [] };
	log(`${verdicts.length} dream experiments judged, ${started.length} started`);
	const spend = spendSection({ facts: facts.text, verdicts, started, economy });

	const backlogs = [...new Set([source, ...repositories(db)])].map((repo) => join(repo, BACKLOG));
	const summary = { run: now, since, until, messages: observations.length, labelled, records, notes: dryRun ? readNotes(backlogs) : takeNotes(backlogs), spend };
	const outcome = { deltas, applied, records, verdicts, economy, started };
	if (dryRun) return { ...outcome, text: report(summary, [...readLedger(source), ...records]) };

	appendLedger(source, records);
	appendEconomy(source, economyRecords(run, verdicts, started, economy));
	writeSince(source, until);
	const text = report(summary, readLedger(source));
	let reportFile = join(dreamsDir(source), `${run.slice(0, 10)}.md`);
	if (existsSync(reportFile)) reportFile = join(dreamsDir(source), `${run.slice(0, 16).replace(":", "")}.md`);
	writeFileSync(reportFile, text);
	return { ...outcome, reportFile, text };
}

/** The spend decisions of a run as ledger records. */
function economyRecords(run: string, verdicts: readonly Judged[], started: readonly Started[], economy: Economy): EconomyRecord[] {
	const landed = (r: { commit?: string; branch?: string }) => ({ ...(r.commit ? { commit: r.commit } : {}), ...(r.branch ? { branch: r.branch } : {}) });
	return [
		...verdicts.map((v): EconomyRecord => ({ run, kind: "verdict", experiment: v.experiment, decision: v.decision, reasons: v.reasons, ...landed(v) })),
		...started.map((s): EconomyRecord => ({ run, kind: "started", experiment: s.proposal.name, text: s.proposal.hypothesis, ...landed(s), ...(s.skipped ? { reasons: [s.skipped] } : {}) })),
		...economy.refused.map((r): EconomyRecord => ({ run, kind: "refused", experiment: r.name, reasons: [r.reason] })),
		...economy.notes.map((n): EconomyRecord => ({ run, kind: "note", text: `${n.title}: ${n.body}` })),
	];
}

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { "dry-run": { type: "boolean" }, since: { type: "string" } } });
	const since = values.since === undefined ? undefined : Date.parse(values.since);
	if (since !== undefined && Number.isNaN(since)) throw new Error(`--since: not a date: ${values.since}`);
	const db = openStore(metricsPath());
	try {
		indexAll(db, { agy: true });
		const result = await dream({ source: SOURCE_ROOT, db, ...(since === undefined ? {} : { since }), dryRun: values["dry-run"] === true, log: (line) => console.error(line) });
		if (values["dry-run"]) console.log(JSON.stringify(result.deltas, null, 2));
		console.log(result.text);
		if (result.reportFile) console.log(`\nReport: ${result.reportFile}`);
	} finally {
		db.close();
	}
}

if (import.meta.main) await main();
