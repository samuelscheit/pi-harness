// The overview: KPIs against the previous period, spend over time, top sessions, and findings:
// what drove spend, ranked by dollars, each linking to the view that explains it.

import { coldResumes, pauses, rebuilds } from "./cache.ts";
import { compactionOpportunities } from "./compaction.ts";
import type { Scope } from "./scope.ts";
import { type SessionRow, sessionList } from "./sessions.ts";
import { breakdown, contentCosts, coverage, LARGE_CONTEXT, type Series, series, sideCalls, type Totals, totals } from "./spend.ts";
import { subagents } from "./subagents.ts";
import { tools } from "./tools.ts";

export type View = "drivers" | "context" | "sessions" | "waste" | "subagents" | "versions";

export interface Finding {
	id: string;
	severity: "critical" | "warning" | "info";
	title: string;
	detail: string;
	cost: number;
	/** Share of the spend in scope. */
	share: number;
	view: View;
	/** Search parameters for the view (such as a grouping). */
	params: Record<string, string>;
}

const money = (value: number) => (value >= 100 ? `$${value.toFixed(0)}` : `$${value.toFixed(2)}`);
const tokens = (value: number) => (value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(0)}k` : `${Math.round(value)}`);
const share = (part: number, whole: number) => `${whole ? Math.round((part / whole) * 100) : 0}%`;

// A finding is critical from this share of spend on, a warning from WARNING_SHARE.
const CRITICAL_SHARE = 0.1;
const WARNING_SHARE = 0.03;
// Findings below this share are noise.
const MIN_SHARE = 0.002;

/** What drove spend in scope, ranked by dollars. Findings overlap (a large context also carries tool output). */
export function findings(scope: Scope, kpis: Totals = totals(scope)): Finding[] {
	const total = kpis.cost;
	if (total <= 0) return [];
	const found: Finding[] = [];
	const add = (id: string, title: string, detail: string, cost: number, view: View, params: Record<string, string> = {}) => {
		if (cost / total < MIN_SHARE) return;
		const ratio = cost / total;
		found.push({ id, severity: ratio >= CRITICAL_SHARE ? "critical" : ratio >= WARNING_SHARE ? "warning" : "info", title, detail, cost, share: ratio, view, params });
	};

	const causes = rebuilds(scope).filter((c) => c.waste > 0);
	if (causes.length) {
		const top = causes[0]!;
		add(
			"cache-rebuilds",
			"Prompt cache rebuilt mid-session",
			`${causes.reduce((s, c) => s + c.requests, 0)} requests wrote again what the previous request had cached. Most of it: “${top.cause}” (${top.requests}×, ${money(top.waste)}).`,
			causes.reduce((s, c) => s + c.waste, 0),
			"waste",
		);
	}

	const cold = pauses(scope).find((p) => p.outcome === "cold");
	if (cold) {
		const largest = coldResumes(scope, 1)[0];
		add(
			"cold-resumes",
			"Pauses that let the cache expire",
			`${cold.pauses} sessions resumed after ${Math.round(cold.avgMinutes)} min on average and paid for ${tokens(cold.avgPromptTokens)} tokens of context again${largest ? `; the largest cost ${money(largest.resumeCost)}` : ""}.`,
			cold.resumeCost,
			"waste",
		);
	}

	const large = breakdown(scope, "context").rows.filter((r) => r.key === "200k–400k" || r.key === "400k and more");
	const largeCost = large.reduce((s, r) => s + r.cost, 0);
	if (largeCost / total >= CRITICAL_SHARE) {
		add(
			"large-context",
			`Contexts past ${tokens(LARGE_CONTEXT)} tokens`,
			`${share(large.reduce((s, r) => s + r.requests, 0), kpis.requests + kpis.sideRequests)} of requests carried more than ${tokens(LARGE_CONTEXT)} tokens; each one re-reads all of it.`,
			largeCost,
			"drivers",
			{ group: "context" },
		);
	}

	const content = contentCosts(scope);
	const results = content
		.filter((c) => c.category.startsWith("tool result: "))
		.map((c) => ({ tool: c.category.slice("tool result: ".length), cost: c.read + c.write + c.uncached }))
		.sort((a, b) => b.cost - a.cost);
	if (results.length) {
		add(
			"tool-output",
			"Tool output carried in context",
			`Results stay in every later request until a compaction. Most from ${results
				.slice(0, 3)
				.map((r) => `${r.tool} (${money(r.cost)})`)
				.join(", ")}.`,
			results.reduce((s, r) => s + r.cost, 0),
			"context",
		);
	}

	const toolStats = tools(scope);
	const unreferenced = toolStats.reduce((s, t) => s + t.unreferencedCost, 0);
	if (unreferenced > 0) {
		const withFiles = toolStats.reduce((s, t) => s + t.withFiles, 0);
		add(
			"never-referenced",
			"Results never referenced again",
			`${share(toolStats.reduce((s, t) => s + t.unreferenced, 0), withFiles)} of results that read files were never used again (no later call on the file, never named). An upper bound for context that could go.`,
			unreferenced,
			"context",
		);
	}

	const thinking = content.find((c) => c.category === "thinking");
	if (thinking) {
		const cost = thinking.read + thinking.write + thinking.uncached;
		add(
			"thinking",
			"Earlier thinking re-read every turn",
			`${tokens(thinking.tokens)} tokens of earlier thinking were carried, against ${money(kpis.output)} for everything the model wrote.`,
			cost,
			"drivers",
			{ group: "content" },
		);
	}

	const opportunities = compactionOpportunities(scope);
	if (opportunities.total > 0) {
		const top = opportunities.sessions[0]!;
		add(
			"compaction",
			"Compacting earlier would have paid off",
			`The best single compaction per session, knowing what came after, saves up to ${money(opportunities.total)} over ${opportunities.sessions.length} sessions; most in “${top.title}” (${money(top.saving)}). Quality loss not priced.`,
			opportunities.total,
			"waste",
		);
	}

	const side = sideCalls(scope);
	if (side.length) {
		add(
			"side-calls",
			"Side calls",
			`${side.map((s) => `${s.requests} ${s.kind} (${money(s.cost)})`).join(", ")}.`,
			side.reduce((s, c) => s + c.cost, 0),
			"waste",
		);
	}

	const agents = subagents(scope);
	if (agents.cost - agents.bestCost > 0) {
		add(
			"subagents",
			"Resuming a subagent would have been cheaper",
			`${agents.resumeWins} of ${agents.started} new subagents could have been done by an idle earlier one for less. Rediscovery (fetching what the parent had): ${money(agents.rediscoveryCost)}.`,
			agents.cost - agents.bestCost,
			"subagents",
		);
	}

	return found.sort((a, b) => b.cost - a.cost);
}

export interface Overview {
	window: { start: number | null; end: number | null };
	kpis: Totals;
	previous: Totals | null;
	series: Series;
	findings: Finding[];
	topSessions: SessionRow[];
	coverage: number;
}

export function overview(scope: Scope, now = Date.now()): Overview {
	const kpis = totals(scope);
	const previous = scope.previous(now);
	return {
		window: { start: scope.filters.start ?? null, end: scope.filters.end ?? null },
		kpis,
		previous: previous ? totals(previous) : null,
		series: series(scope, now),
		findings: findings(scope, kpis),
		topSessions: sessionList(scope, { pageSize: 8 }).rows,
		coverage: coverage(scope, kpis.cost),
	};
}

export interface Options {
	projects: { value: string; cost: number }[];
	models: { value: string; cost: number }[];
	sources: { value: string; sessions: number }[];
}

/** Values the filters can take in the window; each list ignores its own filter. */
export function options(scope: Scope): Options {
	const list = (s: Scope, key: string) =>
		s
			.all(`SELECT ${key} value, SUM(r.cost) cost FROM requests r JOIN sessions s ON s.id = r.session_id WHERE ${s.where("r", "ts", true)} GROUP BY 1 ORDER BY cost DESC`)
			.filter((row) => row.value !== null && row.value !== "")
			.map((row) => ({ value: String(row.value), cost: Number(row.cost) }));
	return {
		projects: list(scope.with({ project: undefined }), "s.cwd"),
		models: list(scope.with({ model: undefined }), "r.model"),
		sources: scope
			.with({ source: "all" })
			.all(`SELECT s.source value, COUNT(DISTINCT r.session_id) n FROM requests r JOIN sessions s ON s.id = r.session_id WHERE ${scope.with({ source: "all" }).where("r", "ts", true)} GROUP BY 1`)
			.map((row) => ({ value: String(row.value), sessions: Number(row.n) })),
	};
}
