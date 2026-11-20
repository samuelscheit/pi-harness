// Dreaming, judge: decide each running experiment dreaming started (frontmatter `source: dream`,
// economize.ts): promote it to a rule, stop it, or let it run. Experiments people started are left
// to them (`/harness experiment`).
//
// The rule is "cheaper, and quality not worse", measured on the random sessions of both arms
// (queries/experiments.ts). The judge looks every night, up to MAX_DAYS times, so each look uses
// 99% intervals (LEVEL) instead of 95%: repeated looks at 95% would promote by chance far more
// often than one in twenty.
//
//   promote   at least MIN_SESSIONS sessions and REVIEWS_PER_ARM blind reviews in each arm; cost
//             per package lower (the whole interval below 0); and every quality guard
//             non-inferior: the interval's worse end within the guard's margin. A guard counts
//             only with enough data in each arm (its `minData`, of its own denominator: labelled
//             messages, tool results, packages, sessions), so a guard resting on two messages
//             never vouches for quality; a guard without enough data is not counted, except the
//             review, which always must hold.
//   stop      as soon as each arm has MIN_EARLY_SESSIONS sessions: a guard with enough data is
//             worse (the whole interval on the worse side) or cost per package is higher; or the
//             experiment has a problem (it no longer runs); or MAX_DAYS passed without promotion.
//   continue  otherwise, with what is still missing; also while an earlier decision waits on a
//             branch that did not land.
//
// The guards: the share of the user's messages correcting the agent or reporting failures (dream
// labels), the tool error rate, interrupted turns per package, the blind review score (review.ts),
// and for delegated sessions, which have no human messages, the rework their parent asked for:
// follow-up requests to the subagent and tasks the parent delegated again.
//
// Promoting or stopping commits the experiment's files (commit.ts) and, once landed, logs the
// result in the changelog, as `/harness experiment <name> promote|stop` does.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type Experiment, type FileChange, listExperiments, stoppedExperiment } from "../../extensions/lib/experiments.ts";
import { promotedExperiment } from "../../extensions/lib/rules.ts";
import { describeSettings, hasSettings, type SessionKind } from "../../extensions/lib/variants.ts";
import { endEntry, renderComparison } from "../../extensions/metrics/experiment.ts";
import { money } from "../../extensions/metrics/format.ts";
import { armSessions, compareCells, type ExperimentComparison, Scope } from "../../extensions/metrics/queries/index.ts";
import type { Ask } from "../lib/labels.ts";
import { fallbackBranch } from "./apply.ts";
import { type Committed, commitFiles, dirty } from "./commit.ts";
import { DAY_MS, experimentsDir, pendingBranches, readEconomy, rulesDir } from "./ledger.ts";
import { appendReviews, type Review, type ReviewCandidate, readReviews, REVIEWS_PER_ARM, reviewSessions, SETTLED_MS, sample } from "./review.ts";

export const MIN_SESSIONS = 30;
export const MIN_EARLY_SESSIONS = 10;
/** Reviews per arm before the review can stop an experiment. */
export const MIN_STOP_REVIEWS = 10;
export const MAX_DAYS = 14;
/** Confidence of every interval the judge decides on. */
export const LEVEL = 0.99;
/** The cost metric that has to improve. */
export const COST_METRIC = "costPerPackage";

export interface Guard {
	key: string;
	label: string;
	/** Which direction is worse. */
	worse: "higher" | "lower";
	/** How far the interval's worse end may reach for the arm to count as not worse. */
	margin: number;
	/** The least data (the metric's denominator) each arm needs for the guard to count. */
	minData: number;
	/** The sessions the guard is about; absent: every experiment. */
	kinds?: readonly SessionKind[];
}

export const GUARDS: readonly Guard[] = [
	{ key: "negativeShare", label: "user messages correcting or reporting failures", worse: "higher", margin: 0.02, minData: 30 },
	{ key: "toolErrorRate", label: "tool error rate", worse: "higher", margin: 0.01, minData: 200 },
	{ key: "interruptsPerPackage", label: "interrupted turns per package", worse: "higher", margin: 0.05, minData: 30 },
	{ key: "followUpsPerSession", label: "follow-up requests per session", worse: "higher", margin: 0.1, minData: MIN_EARLY_SESSIONS, kinds: ["delegated"] },
	{ key: "retriedShare", label: "subagent tasks delegated again", worse: "higher", margin: 0.05, minData: MIN_EARLY_SESSIONS },
];
export const REVIEW_GUARD: Guard = { key: "reviewScore", label: "review score (1-10)", worse: "lower", margin: 0.75, minData: MIN_STOP_REVIEWS };

export interface ReviewStats {
	n: Record<"A" | "B", number>;
	mean: Record<"A" | "B", number | null>;
	effect: number | null;
	ci: [number, number] | null;
}

/** The standard normal quantile (Acklam's approximation), for the t quantile below. */
function normalQuantile(p: number): number {
	const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
	const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
	const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
	const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
	const q = Math.min(p, 1 - p);
	const r = Math.sqrt(-2 * Math.log(q));
	const z = (((((c[0]! * r + c[1]!) * r + c[2]!) * r + c[3]!) * r + c[4]!) * r + c[5]!) / ((((d[0]! * r + d[1]!) * r + d[2]!) * r + d[3]!) * r + 1);
	if (q < 0.02425) return p < 0.5 ? z : -z;
	const s = p - 0.5;
	const t = s * s;
	return ((((((a[0]! * t + a[1]!) * t + a[2]!) * t + a[3]!) * t + a[4]!) * t + a[5]!) * s) / (((((b[0]! * t + b[1]!) * t + b[2]!) * t + b[3]!) * t + b[4]!) * t + 1);
}

/** Student's t quantile from the normal one (Cornish-Fisher expansion; good for df above 3). */
export function tQuantile(p: number, df: number): number {
	const z = normalQuantile(p);
	return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2) + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * df ** 3);
}

/**
 * The least standard deviation a score sample counts with: a grader that gives every session the
 * same score does not make the difference certain.
 */
export const MIN_SCORE_SD = 1;

/** Review scores per arm with B − A and its Welch t-interval at `level` (null with fewer than two reviews in an arm). */
export function reviewStats(reviews: readonly Review[], level = LEVEL): ReviewStats {
	const scores = (arm: string) => reviews.filter((r) => r.arm === arm).map((r) => r.score);
	const a = scores("A");
	const b = scores("B");
	const mean = (list: number[]) => (list.length ? list.reduce((s, x) => s + x, 0) / list.length : null);
	const variance = (list: number[], m: number) => Math.max(MIN_SCORE_SD ** 2, list.reduce((s, x) => s + (x - m) ** 2, 0) / (list.length - 1));
	const ma = mean(a);
	const mb = mean(b);
	const effect = ma === null || mb === null ? null : mb - ma;
	let ci: [number, number] | null = null;
	if (effect !== null && a.length >= 2 && b.length >= 2) {
		const va = variance(a, ma!) / a.length;
		const vb = variance(b, mb!) / b.length;
		const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
		const half = tQuantile(1 - (1 - level) / 2, df) * Math.sqrt(va + vb);
		ci = [effect - half, effect + half];
	}
	return { n: { A: a.length, B: b.length }, mean: { A: ma, B: mb }, effect, ci };
}

export type Decision = "promote" | "stop" | "continue";

export interface Verdict {
	experiment: string;
	decision: Decision;
	reasons: string[];
}

const fmt = (value: number | null) => (value === null ? "–" : Math.abs(value) >= 1 ? value.toFixed(2) : value.toFixed(4));
const interval = (ci: [number, number] | null) => (ci ? `[${fmt(ci[0])}, ${fmt(ci[1])}]` : "no interval");

type GuardState = "worse" | "held" | "open" | "no data";

/** A guard's state from its effect interval and the data each arm has. */
function guardState(guard: Guard, ci: [number, number] | null, data: number): GuardState {
	if (!ci || data < guard.minData) return "no data";
	const [low, high] = ci;
	if (guard.worse === "higher" ? low > 0 : high < 0) return "worse";
	if (guard.worse === "higher" ? high <= guard.margin : low >= -guard.margin) return "held";
	return "open";
}

/** The decision for one experiment (enrolling `kind` sessions) from its comparison at LEVEL, its reviews and its age in days. */
export function decide(comparison: ExperimentComparison, reviews: ReviewStats, ageDays: number, kind: SessionKind = "all"): Verdict {
	const name = comparison.experiments[0]!;
	const sessions = Math.min(comparison.sessions.A ?? 0, comparison.sessions.B ?? 0);
	const metric = (key: string) => comparison.metrics.find((m) => m.key === key);
	const cost = metric(COST_METRIC);
	const guards = [
		...GUARDS.filter((g) => !g.kinds || g.kinds.includes(kind)).map((g) => {
			const m = metric(g.key);
			return { guard: g, effect: m?.effect ?? null, ci: m?.ci ?? null, data: Math.min(m?.denominators.A ?? 0, m?.denominators.B ?? 0) };
		}),
		{ guard: REVIEW_GUARD, effect: reviews.effect, ci: reviews.ci, data: Math.min(reviews.n.A, reviews.n.B) },
	].map((g) => ({ ...g, state: guardState(g.guard, g.ci, g.data) }));
	const describe = (g: (typeof guards)[number]) => `${g.guard.label} B − A ${fmt(g.effect)} ${interval(g.ci)}`;

	if (sessions >= MIN_EARLY_SESSIONS) {
		const worse = guards.filter((g) => g.state === "worse");
		if (worse.length) return { experiment: name, decision: "stop", reasons: worse.map((g) => `quality worse: ${describe(g)}`) };
		if (cost?.ci && cost.ci[0] > 0) return { experiment: name, decision: "stop", reasons: [`costs more: cost per package B − A ${money(cost.effect ?? 0)} ${interval(cost.ci)}`] };
	}

	const missing: string[] = [];
	if (sessions < MIN_SESSIONS) missing.push(`${sessions} of ${MIN_SESSIONS} sessions in the smaller arm`);
	const reviewed = Math.min(reviews.n.A, reviews.n.B);
	if (reviewed < REVIEWS_PER_ARM) missing.push(`${reviewed} of ${REVIEWS_PER_ARM} reviews in the smaller arm`);
	if (!(cost?.ci && cost.ci[1] < 0)) missing.push(`no significant saving yet: cost per package B − A ${cost?.effect === null || cost?.effect === undefined ? "–" : money(cost.effect)} ${interval(cost?.ci ?? null)}`);
	for (const g of guards) {
		if (g.state === "open") missing.push(`not shown not worse: ${describe(g)} (margin ${g.guard.margin})`);
		if (g.state === "no data" && g.guard === REVIEW_GUARD) missing.push("no review interval yet");
	}
	if (missing.length === 0) {
		return {
			experiment: name,
			decision: "promote",
			reasons: [`cheaper: cost per package B − A ${money(cost!.effect!)} ${interval(cost!.ci)}`, ...guards.filter((g) => g.state === "held").map((g) => `not worse: ${describe(g)}`)],
		};
	}
	if (ageDays >= MAX_DAYS) return { experiment: name, decision: "stop", reasons: [`no promotion after ${MAX_DAYS} days`, ...missing] };
	return { experiment: name, decision: "continue", reasons: missing };
}

/**
 * The random sessions of an experiment's comparison that settled (idle for SETTLED_MS), with their
 * files and time in it; none until each arm has MIN_SESSIONS of them, so the review sample is drawn
 * from the arms' whole population at that point, not from whichever sessions ended first.
 */
function reviewCandidates(db: DatabaseSync, comparison: ExperimentComparison, sessions: readonly { session: string; project: string; forced: boolean }[], now: number): ReviewCandidate[] {
	const compared = new Set(sessions.filter((s) => !s.forced && comparison.projects.includes(s.project)).map((s) => s.session));
	const rows = db
		.prepare(
			`SELECT a.session_id, a.arm, a.assigned_at, a.ended_at, s.file FROM experiment_arms a JOIN sessions s ON s.id = a.session_id
			WHERE a.experiment = ? AND s.ended_at <= ? ORDER BY a.session_id`,
		)
		.all(comparison.experiments[0]!, now - SETTLED_MS) as { session_id: string; arm: string; assigned_at: number; ended_at: number | null; file: string }[];
	const candidates = rows
		.filter((r) => compared.has(r.session_id))
		.map((r) => ({ session: r.session_id, arm: r.arm, file: r.file, from: r.assigned_at, ...(r.ended_at === null ? {} : { to: r.ended_at }) }));
	const smaller = Math.min(...["A", "B"].map((arm) => candidates.filter((c) => c.arm === arm).length));
	return smaller >= MIN_SESSIONS ? candidates : [];
}

export interface Judged extends Verdict, Partial<Committed> {
	comparison?: ExperimentComparison;
	reviews?: ReviewStats;
	/** Why a decision was not applied. */
	skipped?: string;
}

export interface JudgeOptions {
	source: string;
	db: DatabaseSync;
	now: Date;
	ask: Ask;
	dryRun: boolean;
	log?: (line: string) => void;
}

export const changelogFile = (source: string) => join(source, ".agents", "changelog.md");

/** The running experiments dreaming started, also those with a problem (which the judge stops). */
export const dreamExperiments = (source: string): Experiment[] => listExperiments(experimentsDir(source)).filter((e) => e.status === "running" && e.frontmatter.source === "dream");

/** The commit message of a decision. */
function message(e: Experiment, verdict: Verdict, comparison: ExperimentComparison | undefined, reviews: ReviewStats | undefined, now: Date): string {
	const title = verdict.decision === "promote" ? `feat(rules): promote dreamed experiment ${e.name}` : `chore(experiments): stop dreamed experiment ${e.name}`;
	return [
		title,
		"",
		`Dreaming (scripts/dream/judge.ts) on ${now.toISOString().slice(0, 10)} ${verdict.decision === "promote" ? "promoted" : "stopped"} the experiment it started on ${String(e.frontmatter.started ?? "?")}.`,
		"",
		...(e.frontmatter.hypothesis ? [`Hypothesis: ${String(e.frontmatter.hypothesis)}`, ""] : []),
		...(hasSettings(e.settings) ? [`Settings of arm B: ${describeSettings(e.settings)} (${e.sessions} sessions).`, ""] : []),
		"## Why",
		"",
		...verdict.reasons.map((r) => `- ${r}`),
		"",
		...(comparison && reviews
			? [
					`## Result (${LEVEL * 100}% intervals)`,
					"",
					"```",
					renderComparison(comparison),
					`review score: A ${fmt(reviews.mean.A)} (${reviews.n.A}), B ${fmt(reviews.mean.B)} (${reviews.n.B}), B − A ${fmt(reviews.effect)} ${interval(reviews.ci)}`,
					"```",
					"",
				]
			: []),
		"## Revert",
		"",
		verdict.decision === "promote" ? `Delete prompt/rules/${e.name}.md, or move it back to prompt/experiments/ with status: running.` : `Set status: running in prompt/experiments/${e.name}.md.`,
	].join("\n");
}

/** Judge every running dream experiment; review what each needs first; apply promotions and stops unless a dry run. */
export async function judge({ source, db, now, ask, dryRun, log = () => {} }: JudgeOptions): Promise<Judged[]> {
	const scope = new Scope(db, { source: "pi" });
	const reviews = readReviews(source);
	const pending = pendingBranches(readEconomy(source));
	const results: Judged[] = [];
	for (const e of dreamExperiments(source)) {
		const branch = pending.get(e.name);
		if (branch) {
			results.push({ experiment: e.name, decision: "continue", reasons: [`waiting for branch ${branch} to land`] });
			continue;
		}
		let judged: Judged;
		if (e.problem) judged = { experiment: e.name, decision: "stop", reasons: [`the experiment does not run: ${e.problem}`] };
		else {
			const sessions = armSessions(scope, [e.name], e.tools);
			const comparison = compareCells([e.name], sessions, e.tools, LEVEL);
			const mine = reviews.filter((r) => r.experiment === e.name);
			const next = sample(e.name, reviewCandidates(db, comparison, sessions, now.getTime()), new Set(mine.map((r) => r.session)));
			const fresh = next.length ? await reviewSessions(e.name, next, { ask, now }) : [];
			if (!dryRun) appendReviews(source, fresh);
			log(`${e.name}: ${fresh.length} sessions reviewed`);
			const stats = reviewStats([...mine, ...fresh]);
			const started = Date.parse(String(e.frontmatter.started ?? ""));
			judged = { ...decide(comparison, stats, Number.isNaN(started) ? 0 : (now.getTime() - started) / DAY_MS, e.sessions), comparison, reviews: stats };
		}
		results.push(judged);
		if (dryRun || judged.decision === "continue") continue;

		let changes: FileChange[];
		try {
			changes = judged.decision === "promote" ? promotedExperiment(e, rulesDir(source), now, (p) => p) : [stoppedExperiment(e, now, (p) => p)];
		} catch (error) {
			judged.skipped = error instanceof Error ? error.message : String(error);
			continue;
		}
		const busy = changes.find((c) => dirty(source, c.path));
		if (busy) {
			judged.skipped = `${busy.path} has uncommitted changes`;
			continue;
		}
		Object.assign(judged, commitFiles(source, changes, message(e, judged, judged.comparison, judged.reviews, now), fallbackBranch({ now }, `${judged.decision}-${e.name}`)));
		if (judged.branch) continue;
		const changelog = changelogFile(source);
		mkdirSync(dirname(changelog), { recursive: true });
		appendFileSync(changelog, endEntry(judged.comparison ? [judged.comparison] : [], e.name, now, judged.decision, `dreaming (scripts/dream/judge.ts): ${judged.reasons.join("; ")}`));
	}
	return results;
}
