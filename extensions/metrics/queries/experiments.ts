// A/B experiments (see extensions/lib/experiments.ts): the randomly assigned sessions of each
// arm compared over the same time and the same projects, for one experiment or for a combination
// of experiments whose arms cross (a factorial comparison: cells AA, AB, BA, BB for two).
//
// A session counts with what happened while it was in every experiment of the comparison (from
// its latest assignment to its earliest end) and inside the scope's window. Sessions whose arm was
// ever set by hand are reported but left out, and so are projects without sessions in every cell,
// so a project's task mix weighs on all cells. Every metric is a ratio of sums over sessions (tool
// calls / turns, cost / sessions, …). The effect is the factorial contrast of the cells: B − A for
// one experiment, the interaction (BB − BA) − (AB − AA) for two, that is how much the second
// experiment's effect changes with the first one's arm. Its uncertainty is a 95% bootstrap
// interval, resampling sessions within each cell.

import { type Arm, ARMS } from "../../lib/experiments.ts";
import type { Scope } from "./scope.ts";

export interface ArmSession {
	session: string;
	project: string;
	/** The session's arms, one letter per experiment of the comparison (in its order). */
	cell: string;
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
	/** Calls that changed files (see tool_results.mutates), and those made with the edit/write tools. */
	mutatingCalls: number;
	toolMutatingCalls: number;
	/** Edit tool calls, and the distinct files they wrote. */
	editCalls: number;
	editedFiles: number;
}

interface MetricDef {
	key: string;
	label: string;
	unit: "count" | "share" | "usd";
	numerator: (s: ArmSession) => number;
	denominator: (s: ArmSession) => number;
}

const perSession = () => 1;

/** The metrics of a comparison. */
export const EXPERIMENT_METRICS: readonly MetricDef[] = [
	{ key: "toolCallsPerTurn", label: "tool calls per turn", unit: "count", numerator: (s) => s.toolCalls, denominator: (s) => s.turns },
	{ key: "batchedTurns", label: "turns with 2+ tool calls", unit: "share", numerator: (s) => s.batchedTurns, denominator: (s) => s.turns },
	{ key: "toolMutationShare", label: "file changes via edit/write", unit: "share", numerator: (s) => s.toolMutatingCalls, denominator: (s) => s.mutatingCalls },
	{ key: "editCallsPerFile", label: "edit calls per edited file", unit: "count", numerator: (s) => s.editCalls, denominator: (s) => s.editedFiles },
	{ key: "turnsPerPackage", label: "turns per package", unit: "count", numerator: (s) => s.turns, denominator: (s) => s.packages },
	{ key: "turnsPerSession", label: "turns per session", unit: "count", numerator: (s) => s.turns, denominator: perSession },
	{ key: "costPerSession", label: "cost per session", unit: "usd", numerator: (s) => s.cost, denominator: perSession },
	{ key: "readCostPerSession", label: "cache-read cost per session", unit: "usd", numerator: (s) => s.readCost, denominator: perSession },
	{ key: "costPerTurn", label: "cost per turn", unit: "usd", numerator: (s) => s.cost, denominator: (s) => s.turns },
	{ key: "readCostPerTurn", label: "cache-read cost per turn", unit: "usd", numerator: (s) => s.readCost, denominator: (s) => s.turns },
	{ key: "toolErrorRate", label: "tool error rate", unit: "share", numerator: (s) => s.toolErrors, denominator: (s) => s.toolResults },
];

export interface CellMetric {
	key: string;
	label: string;
	unit: MetricDef["unit"];
	/** The metric per cell (null without sessions or with a zero denominator). */
	values: Record<string, number | null>;
	/** The factorial contrast of the cells (B − A, or the interaction), and its 95% bootstrap interval (null with fewer than two sessions in a cell). */
	effect: number | null;
	ci: [number, number] | null;
}

export interface ExperimentComparison {
	/** The experiments compared; one, or several whose arms cross. */
	experiments: string[];
	/** The cells, one arm letter per experiment: A, B, or AA, AB, BA, BB. */
	cells: string[];
	/** Sessions compared, per cell. */
	sessions: Record<string, number>;
	/** Turns compared, per cell. */
	turns: Record<string, number>;
	/** Sessions left out because an arm was set by hand. */
	forced: number;
	/** Random sessions left out because their project has no sessions in some cell. */
	unmatched: number;
	/** Projects with sessions in every cell. */
	projects: string[];
	metrics: CellMetric[];
}

/** Every combination of arms for `n` experiments, in order (A, B; AA, AB, BA, BB; …). */
export const cellsOf = (n: number): string[] => (n === 0 ? [""] : cellsOf(n - 1).flatMap((cell) => ARMS.map((arm: Arm) => cell + arm)));

/** A cell's weight in the factorial contrast: the product of −1 for A and +1 for B. */
export const contrastWeight = (cell: string): number => [...cell].reduce((w, arm) => (arm === "B" ? w : -w), 1);

/** Experiments with recorded arms in scope. */
export function experimentNames(scope: Scope): string[] {
	return scope
		.all<{ experiment: string }>(`SELECT DISTINCT a.experiment FROM experiment_arms a WHERE ${scope.where("a", undefined)} ORDER BY a.experiment`)
		.map((r) => r.experiment);
}

/**
 * The sessions in every one of `experiments` (as table `a`: session_id, cell, forced and the time
 * they were in all of them, [assigned_at, ended_at)), with the parameters naming the experiments.
 */
function armsTable(experiments: string[]): { sql: string; params: Record<string, string> } {
	const aliases = experiments.map((_, i) => `a${i}`);
	const latest = (column: string) => (aliases.length === 1 ? `a0.${column}` : `MAX(${aliases.map((x) => `${x}.${column}`).join(", ")})`);
	// The earliest end; NULL (still running) only when no experiment ended.
	const open = "9223372036854775807";
	const ended = aliases.length === 1 ? "a0.ended_at" : `NULLIF(MIN(${aliases.map((x) => `COALESCE(${x}.ended_at, ${open})`).join(", ")}), ${open})`;
	const joins = aliases.slice(1).map((x, i) => `JOIN experiment_arms ${x} ON ${x}.session_id = a0.session_id AND ${x}.experiment = $experiment${i + 1}`);
	return {
		sql: `(SELECT a0.session_id, ${aliases.map((x) => `${x}.arm`).join(" || ")} cell, ${latest("forced")} forced,
			${latest("assigned_at")} assigned_at, ${ended} ended_at
			FROM experiment_arms a0 ${joins.join(" ")} WHERE a0.experiment = $experiment0)`,
		params: Object.fromEntries(experiments.map((name, i) => [`$experiment${i}`, name])),
	};
}

/** Every session in all of `experiments` with turns in scope, with its numbers while in all of them. */
export function armSessions(scope: Scope, experiments: string[]): ArmSession[] {
	// Rows of table `alias` (timestamp `ts`) inside the session's time in the experiments and the window.
	const during = (alias: string) =>
		`${alias}.session_id = a.session_id AND ${alias}.ts >= a.assigned_at AND (a.ended_at IS NULL OR ${alias}.ts < a.ended_at) AND ${scope.window(`${alias}.ts`)}`;
	const model = scope.filters.model === undefined ? "" : "AND r.model = $model";
	const arms = armsTable(experiments);
	return scope
		.all(
			`SELECT a.session_id, s.cwd, a.cell, a.forced,
				(SELECT COUNT(*) FROM requests r WHERE ${during("r")} AND r.kind = 'turn' ${model}) turns,
				(SELECT COALESCE(SUM(r.tool_calls), 0) FROM requests r WHERE ${during("r")} AND r.kind = 'turn' ${model}) tool_calls,
				(SELECT COUNT(*) FROM requests r WHERE ${during("r")} AND r.kind = 'turn' AND r.tool_calls >= 2 ${model}) batched,
				(SELECT COALESCE(SUM(r.cost), 0) FROM requests r WHERE ${during("r")} ${model}) cost,
				(SELECT COALESCE(SUM(r.cost_read), 0) FROM requests r WHERE ${during("r")} ${model}) read_cost,
				(SELECT COUNT(*) FROM user_messages u WHERE ${during("u")} AND u.kind != 'steer') packages,
				(SELECT COUNT(*) FROM tool_results t WHERE ${during("t")}) results,
				(SELECT COALESCE(SUM(t.is_error), 0) FROM tool_results t WHERE ${during("t")}) errors,
				(SELECT COUNT(*) FROM tool_results t WHERE ${during("t")} AND t.mutates = 1) mutating,
				(SELECT COUNT(*) FROM tool_results t WHERE ${during("t")} AND t.mutates = 1 AND t.tool IN ('edit', 'write')) tool_mutating,
				(SELECT COUNT(*) FROM tool_results t WHERE ${during("t")} AND t.tool = 'edit') edits,
				(SELECT COUNT(DISTINCT f.file) FROM tool_results t JOIN tool_files f ON f.session_id = t.session_id AND f.call_id = t.call_id
					WHERE ${during("t")} AND t.tool = 'edit' AND f.write = 1) edited_files
			FROM ${arms.sql} a JOIN sessions s ON s.id = a.session_id
			WHERE ${scope.where("a", undefined)}
			ORDER BY a.session_id`,
			arms.params,
		)
		.map((r) => ({
			session: String(r.session_id),
			project: String(r.cwd),
			cell: String(r.cell),
			forced: Number(r.forced) === 1,
			turns: Number(r.turns),
			toolCalls: Number(r.tool_calls),
			batchedTurns: Number(r.batched),
			packages: Number(r.packages),
			cost: Number(r.cost),
			readCost: Number(r.read_cost),
			toolResults: Number(r.results),
			toolErrors: Number(r.errors),
			mutatingCalls: Number(r.mutating),
			toolMutatingCalls: Number(r.tool_mutating),
			editCalls: Number(r.edits),
			editedFiles: Number(r.edited_files),
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

export type Pairs = [number, number][];

/**
 * 95% percentile interval of Σ weight × ratio(group), resampling each group's [numerator,
 * denominator] pairs with replacement. Null when a group has fewer than two sessions. Resamples
 * where a ratio is undefined (all denominators zero) are skipped.
 */
export function bootstrapContrast(groups: { pairs: Pairs; weight: number }[], resamples = 2000, seed = 1): [number, number] | null {
	if (groups.some((g) => g.pairs.length < 2)) return null;
	const next = prng(seed);
	const resample = (pairs: Pairs) => {
		let num = 0;
		let den = 0;
		for (let i = 0; i < pairs.length; i++) {
			const [n, d] = pairs[Math.floor(next() * pairs.length)]!;
			num += n;
			den += d;
		}
		return ratio(num, den);
	};
	const contrasts: number[] = [];
	for (let i = 0; i < resamples; i++) {
		let total = 0;
		let defined = true;
		for (const g of groups) {
			const r = resample(g.pairs);
			if (r === null) defined = false;
			else total += g.weight * r;
		}
		if (defined) contrasts.push(total);
	}
	if (contrasts.length === 0) return null;
	contrasts.sort((x, y) => x - y);
	const at = (p: number) => contrasts[Math.min(contrasts.length - 1, Math.max(0, Math.round(p * (contrasts.length - 1))))]!;
	return [at(0.025), at(0.975)];
}

/** Compare the cells of one or more experiments from their sessions (see the module comment for what counts). */
export function compareCells(experiments: string[], sessions: ArmSession[]): ExperimentComparison {
	const cells = cellsOf(experiments.length);
	const random = sessions.filter((s) => !s.forced);
	const cellsIn = new Map<string, Set<string>>();
	for (const s of random) cellsIn.set(s.project, (cellsIn.get(s.project) ?? new Set()).add(s.cell));
	const projects = [...cellsIn].filter(([, seen]) => seen.size === cells.length).map(([project]) => project).sort();
	const compared = random.filter((s) => projects.includes(s.project));
	const byCell = new Map(cells.map((cell) => [cell, compared.filter((s) => s.cell === cell)]));
	const sum = (list: ArmSession[], f: (s: ArmSession) => number) => list.reduce((total, s) => total + f(s), 0);
	const perCell = <T>(f: (list: ArmSession[]) => T) => Object.fromEntries(cells.map((cell) => [cell, f(byCell.get(cell)!)]));
	return {
		experiments,
		cells,
		sessions: perCell((list) => list.length),
		turns: perCell((list) => sum(list, (s) => s.turns)),
		forced: sessions.length - random.length,
		unmatched: random.length - compared.length,
		projects,
		metrics: EXPERIMENT_METRICS.map((m) => {
			const values = perCell((list) => ratio(sum(list, m.numerator), sum(list, m.denominator)));
			const effect = cells.some((cell) => values[cell] === null) ? null : cells.reduce((total, cell) => total + contrastWeight(cell) * values[cell]!, 0);
			const groups = cells.map((cell) => ({
				pairs: byCell.get(cell)!.map((s): [number, number] => [m.numerator(s), m.denominator(s)]),
				weight: contrastWeight(cell),
			}));
			return { key: m.key, label: m.label, unit: m.unit, values, effect, ci: bootstrapContrast(groups) };
		}),
	};
}

/**
 * Comparisons of the given groups of experiments (each one experiment, or several whose arms
 * cross), or of every recorded experiment alone. Pi sessions only: only Pi assigns arms.
 */
export function experiments(input: Scope, groups?: string[][]): ExperimentComparison[] {
	const scope = input.with({ source: "pi" });
	return (groups ?? experimentNames(scope).map((name) => [name])).map((group) => compareCells(group, armSessions(scope, group)));
}
