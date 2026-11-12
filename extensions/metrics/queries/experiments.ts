// A/B experiments (see extensions/lib/experiments.ts): per experiment, the randomly assigned
// sessions of each arm compared over the same time and the same projects.
//
// A session counts with what happened while it was in the experiment ([assigned_at, ended_at))
// and inside the scope's window. Sessions whose arm was ever set by hand are reported but left
// out, and so are projects that have sessions in only one arm, so a project's task mix weighs on
// both arms. Every metric is a ratio of sums over sessions (tool calls / turns, cost / sessions,
// …); its uncertainty is a 95% bootstrap interval of the difference B − A, resampling sessions
// within each arm.

import { type Arm, ARMS } from "../../lib/experiments.ts";
import type { Scope } from "./scope.ts";

export interface ArmSession {
	session: string;
	project: string;
	arm: Arm;
	forced: boolean;
	turns: number;
	toolCalls: number;
	/** Turns with two or more tool calls. */
	batchedTurns: number;
	/** Runs the user started: user messages other than steers. */
	packages: number;
	cost: number;
	readCost: number;
	toolResults: number;
	toolErrors: number;
}

interface MetricDef {
	key: string;
	label: string;
	unit: "count" | "share" | "usd";
	numerator: (s: ArmSession) => number;
	denominator: (s: ArmSession) => number;
}

const perSession = () => 1;

/** The metrics of a comparison, the primary one first. */
export const EXPERIMENT_METRICS: readonly MetricDef[] = [
	{ key: "toolCallsPerTurn", label: "tool calls per turn", unit: "count", numerator: (s) => s.toolCalls, denominator: (s) => s.turns },
	{ key: "batchedTurns", label: "turns with 2+ tool calls", unit: "share", numerator: (s) => s.batchedTurns, denominator: (s) => s.turns },
	{ key: "turnsPerPackage", label: "turns per package", unit: "count", numerator: (s) => s.turns, denominator: (s) => s.packages },
	{ key: "turnsPerSession", label: "turns per session", unit: "count", numerator: (s) => s.turns, denominator: perSession },
	{ key: "costPerSession", label: "cost per session", unit: "usd", numerator: (s) => s.cost, denominator: perSession },
	{ key: "readCostPerSession", label: "cache-read cost per session", unit: "usd", numerator: (s) => s.readCost, denominator: perSession },
	{ key: "costPerTurn", label: "cost per turn", unit: "usd", numerator: (s) => s.cost, denominator: (s) => s.turns },
	{ key: "readCostPerTurn", label: "cache-read cost per turn", unit: "usd", numerator: (s) => s.readCost, denominator: (s) => s.turns },
	{ key: "toolErrorRate", label: "tool error rate", unit: "share", numerator: (s) => s.toolErrors, denominator: (s) => s.toolResults },
];

export interface ArmMetric {
	key: string;
	label: string;
	unit: MetricDef["unit"];
	a: number | null;
	b: number | null;
	/** b − a, and its 95% bootstrap interval (null with fewer than two sessions in an arm). */
	diff: number | null;
	ci: [number, number] | null;
}

export interface ExperimentComparison {
	experiment: string;
	/** Sessions compared, per arm. */
	sessions: Record<Arm, number>;
	/** Turns compared, per arm. */
	turns: Record<Arm, number>;
	/** Sessions left out because their arm was set by hand. */
	forced: number;
	/** Random sessions left out because their project has sessions in one arm only. */
	unmatched: number;
	/** Projects with sessions in both arms. */
	projects: string[];
	metrics: ArmMetric[];
}

/** Experiments with recorded arms in scope. */
export function experimentNames(scope: Scope): string[] {
	return scope
		.all<{ experiment: string }>(`SELECT DISTINCT a.experiment FROM experiment_arms a WHERE ${scope.where("a", undefined)} ORDER BY a.experiment`)
		.map((r) => r.experiment);
}

/** Every session of an experiment with turns in scope, with its numbers while in the experiment. */
export function armSessions(scope: Scope, experiment: string): ArmSession[] {
	// Rows of table `alias` (timestamp `ts`) inside the session's time in the experiment and the window.
	const during = (alias: string) =>
		`${alias}.session_id = a.session_id AND ${alias}.ts >= a.assigned_at AND (a.ended_at IS NULL OR ${alias}.ts < a.ended_at) AND ${scope.window(`${alias}.ts`)}`;
	const model = scope.filters.model === undefined ? "" : "AND r.model = $model";
	return scope
		.all(
			`SELECT a.session_id, s.cwd, a.arm, a.forced,
				(SELECT COUNT(*) FROM requests r WHERE ${during("r")} AND r.kind = 'turn' ${model}) turns,
				(SELECT COALESCE(SUM(r.tool_calls), 0) FROM requests r WHERE ${during("r")} AND r.kind = 'turn' ${model}) tool_calls,
				(SELECT COUNT(*) FROM requests r WHERE ${during("r")} AND r.kind = 'turn' AND r.tool_calls >= 2 ${model}) batched,
				(SELECT COALESCE(SUM(r.cost), 0) FROM requests r WHERE ${during("r")} ${model}) cost,
				(SELECT COALESCE(SUM(r.cost_read), 0) FROM requests r WHERE ${during("r")} ${model}) read_cost,
				(SELECT COUNT(*) FROM user_messages u WHERE ${during("u")} AND u.kind != 'steer') packages,
				(SELECT COUNT(*) FROM tool_results t WHERE ${during("t")}) results,
				(SELECT COALESCE(SUM(t.is_error), 0) FROM tool_results t WHERE ${during("t")}) errors
			FROM experiment_arms a JOIN sessions s ON s.id = a.session_id
			WHERE a.experiment = $experiment AND ${scope.where("a", undefined)}
			ORDER BY a.session_id`,
			{ $experiment: experiment },
		)
		.map((r) => ({
			session: String(r.session_id),
			project: String(r.cwd),
			arm: r.arm as Arm,
			forced: Number(r.forced) === 1,
			turns: Number(r.turns),
			toolCalls: Number(r.tool_calls),
			batchedTurns: Number(r.batched),
			packages: Number(r.packages),
			cost: Number(r.cost),
			readCost: Number(r.read_cost),
			toolResults: Number(r.results),
			toolErrors: Number(r.errors),
		}))
		.filter((s) => s.turns > 0);
}

/** A seeded PRNG (mulberry32), so the same data gives the same interval. */
function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ratio = (num: number, den: number) => (den > 0 ? num / den : null);

/**
 * 95% percentile interval of ratio(B) − ratio(A), resampling each arm's [numerator, denominator]
 * pairs with replacement. Null when an arm has fewer than two sessions. Resamples where a ratio
 * is undefined (all denominators zero) are skipped.
 */
export function bootstrapDiff(a: [number, number][], b: [number, number][], resamples = 2000, seed = 1): [number, number] | null {
	if (a.length < 2 || b.length < 2) return null;
	const next = prng(seed);
	const resample = (pairs: [number, number][]) => {
		let num = 0;
		let den = 0;
		for (let i = 0; i < pairs.length; i++) {
			const [n, d] = pairs[Math.floor(next() * pairs.length)]!;
			num += n;
			den += d;
		}
		return ratio(num, den);
	};
	const diffs: number[] = [];
	for (let i = 0; i < resamples; i++) {
		const ra = resample(a);
		const rb = resample(b);
		if (ra !== null && rb !== null) diffs.push(rb - ra);
	}
	if (diffs.length === 0) return null;
	diffs.sort((x, y) => x - y);
	const at = (p: number) => diffs[Math.min(diffs.length - 1, Math.max(0, Math.round(p * (diffs.length - 1))))]!;
	return [at(0.025), at(0.975)];
}

/** Compare the arms of one experiment from its sessions (see the module comment for what counts). */
export function compareArms(experiment: string, sessions: ArmSession[]): ExperimentComparison {
	const random = sessions.filter((s) => !s.forced);
	const armsOf = new Map<string, Set<Arm>>();
	for (const s of random) armsOf.set(s.project, (armsOf.get(s.project) ?? new Set()).add(s.arm));
	const projects = [...armsOf].filter(([, arms]) => arms.size === ARMS.length).map(([project]) => project).sort();
	const compared = random.filter((s) => projects.includes(s.project));
	const byArm = (arm: Arm) => compared.filter((s) => s.arm === arm);
	const [a, b] = [byArm("A"), byArm("B")];
	const sum = (list: ArmSession[], f: (s: ArmSession) => number) => list.reduce((total, s) => total + f(s), 0);
	return {
		experiment,
		sessions: { A: a.length, B: b.length },
		turns: { A: sum(a, (s) => s.turns), B: sum(b, (s) => s.turns) },
		forced: sessions.length - random.length,
		unmatched: random.length - compared.length,
		projects,
		metrics: EXPERIMENT_METRICS.map((m) => {
			const pairs = (list: ArmSession[]) => list.map((s): [number, number] => [m.numerator(s), m.denominator(s)]);
			const va = ratio(sum(a, m.numerator), sum(a, m.denominator));
			const vb = ratio(sum(b, m.numerator), sum(b, m.denominator));
			return {
				key: m.key,
				label: m.label,
				unit: m.unit,
				a: va,
				b: vb,
				diff: va === null || vb === null ? null : vb - va,
				ci: bootstrapDiff(pairs(a), pairs(b)),
			};
		}),
	};
}

/** Every experiment in scope (or the one named), compared. Pi sessions only: only Pi assigns arms. */
export function experiments(input: Scope, name?: string): ExperimentComparison[] {
	const scope = input.with({ source: "pi" });
	return (name === undefined ? experimentNames(scope) : [name]).map((experiment) => compareArms(experiment, armSessions(scope, experiment)));
}
