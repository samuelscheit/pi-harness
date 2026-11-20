// Dreaming, spend: where the money went since the last run, next to the week before, as Markdown
// for the economist (economize.ts) and the run's report. Computed from the metrics index with the
// same queries as `/harness stats` and the dashboard; no model call.
//
// Besides cost it states the quality signals of the same windows (the share of the user's messages
// that correct the agent or report a failure, interrupted turns, tool errors), so a saving is
// never read without what it may have cost in quality.

import type { DatabaseSync } from "node:sqlite";
import { DELEGATED_SQL } from "../../extensions/lib/variants.ts";
import { clip, count, money, percent, table } from "../../extensions/metrics/format.ts";
import { NEGATIVE_SQL } from "../../extensions/metrics/labels.ts";
import { breakdown, categoryGroup, compactions, contentCosts, pauses, rebuilds, Scope, sessionList, subagents, tools, totals } from "../../extensions/metrics/queries/index.ts";

/** The baseline: this many days before the window. */
export const BASELINE_DAYS = 7;
/** A first run (no read position) looks at this many hours. */
export const FIRST_WINDOW_HOURS = 24;
const DAY = 86_400_000;

export interface Window {
	start: number;
	end: number;
}

/** The window since the last run and the baseline before it. */
export function windows(since: number, until: number): { window: Window; baseline: Window } {
	const start = since > 0 ? since : until - FIRST_WINDOW_HOURS * 3_600_000;
	return { window: { start, end: until }, baseline: { start: start - BASELINE_DAYS * DAY, end: start } };
}

interface Headline {
	cost: number;
	sessions: number;
	packages: number;
	requests: number;
	labelled: number;
	negatives: number;
	interrupts: number;
	toolResults: number;
	toolErrors: number;
	cacheShare: number;
}

function headline(scope: Scope): Headline {
	const t = totals(scope);
	const q = scope.get(
		`SELECT (SELECT COUNT(*) FROM user_messages u WHERE ${scope.where("u", "ts")} AND u.kind != 'steer') packages,
			(SELECT COUNT(*) FROM message_labels l WHERE ${scope.where("l", "ts")}) labelled,
			(SELECT COUNT(*) FROM message_labels l WHERE ${scope.where("l", "ts")} AND l.label IN (${NEGATIVE_SQL})) negatives,
			(SELECT COUNT(*) FROM tool_results t WHERE ${scope.where("t", "ts")}) results,
			(SELECT COALESCE(SUM(t.is_error), 0) FROM tool_results t WHERE ${scope.where("t", "ts")}) errors`,
	);
	return {
		cost: t.cost,
		sessions: t.sessions,
		packages: Number(q.packages),
		requests: t.requests,
		labelled: Number(q.labelled),
		negatives: Number(q.negatives),
		interrupts: t.aborted,
		toolResults: Number(q.results),
		toolErrors: Number(q.errors),
		cacheShare: t.cacheReadTokens / Math.max(1, t.promptTokens),
	};
}

const perDay = (value: number, w: Window) => value / Math.max(1 / 24, (w.end - w.start) / DAY);
const change = (now: number, before: number) => (before > 0 ? `${now >= before ? "+" : ""}${percent(now / before - 1)}` : "–");
const share = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const shareText = (value: number | null) => (value === null ? "–" : percent(value));
const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
/** A titled table, fenced so Markdown keeps its columns. */
const block = (title: string, headers: string[], rows: string[][]) => `${title}\n\n\`\`\`\n${table(headers, rows)}\n\`\`\``;

/** Cost by session kind: delegated (a parent's delegate_task started it, as enrollment tells it) or top-level. */
function byKind(scope: Scope): string[][] {
	return scope
		.all(
			`SELECT CASE WHEN ${DELEGATED_SQL("s.id")} THEN 'delegated' ELSE 'top-level' END kind, COUNT(DISTINCT r.session_id) sessions, SUM(r.kind = 'turn') turns, SUM(r.cost) cost
			FROM requests r JOIN sessions s ON s.id = r.session_id WHERE ${scope.where("r", "ts", true)} GROUP BY 1 ORDER BY cost DESC`,
		)
		.map((r) => [String(r.kind), String(r.sessions), String(r.turns), money(Number(r.cost)), money(Number(r.cost) / Math.max(1, Number(r.sessions)))]);
}

/** Cost by model and thinking level (turns). */
function byModel(scope: Scope): string[][] {
	return scope
		.all(
			`SELECT r.model, COALESCE(r.thinking, '-') thinking, COUNT(*) turns, SUM(r.cost) cost, SUM(r.cost_output) output, AVG(r.prompt_tokens) prompt
			FROM requests r WHERE r.kind = 'turn' AND ${scope.where("r", "ts", true)} GROUP BY 1, 2 ORDER BY cost DESC LIMIT 8`,
		)
		.map((r) => [String(r.model), String(r.thinking), String(r.turns), money(Number(r.cost)), money(Number(r.output)), count(Number(r.prompt))]);
}

/** The tool calls whose results cost the most while carried in later requests. */
function costlyResults(scope: Scope): string[][] {
	return scope
		.all(
			`SELECT t.tool, t.summary, t.tokens, t.requests_in_context, t.lifetime_cost FROM tool_results t
			WHERE ${scope.where("t", "ts")} ORDER BY t.lifetime_cost DESC LIMIT 10`,
		)
		.map((r) => [String(r.tool), clip(String(r.summary), 70), count(Number(r.tokens)), String(r.requests_in_context), money(Number(r.lifetime_cost))]);
}

/** The spend facts of the window against the baseline, as Markdown, with the window's model turns. */
export function spendFacts(db: DatabaseSync, window: Window, baseline: Window): { text: string; requests: number } {
	const now = new Scope(db, window);
	const before = new Scope(db, baseline);
	const n = headline(now);
	const b = headline(before);
	if (n.requests === 0) return { text: `No model requests between ${day(window.start)} and ${day(window.end)} UTC.`, requests: 0 };
	return { text: factsText(now, window, baseline, n, b), requests: n.requests };
}

function factsText(now: Scope, window: Window, baseline: Window, n: Headline, b: Headline): string {
	const rows: [string, string, string, string][] = [
		["cost per day", money(perDay(n.cost, window)), money(perDay(b.cost, baseline)), change(perDay(n.cost, window), perDay(b.cost, baseline))],
		["sessions", String(n.sessions), String(b.sessions), ""],
		["packages (user requests)", String(n.packages), String(b.packages), ""],
		["cost per package", money(n.cost / Math.max(1, n.packages)), money(b.cost / Math.max(1, b.packages)), change(n.cost / Math.max(1, n.packages), b.cost / Math.max(1, b.packages))],
		["cost per turn", money(n.cost / Math.max(1, n.requests)), money(b.cost / Math.max(1, b.requests)), change(n.cost / Math.max(1, n.requests), b.cost / Math.max(1, b.requests))],
		["prompt tokens read from cache", percent(n.cacheShare), percent(b.cacheShare), ""],
		["quality: user messages correcting or reporting failures", `${shareText(share(n.negatives, n.labelled))} of ${n.labelled}`, `${shareText(share(b.negatives, b.labelled))} of ${b.labelled}`, ""],
		["quality: interrupted turns per package", (n.interrupts / Math.max(1, n.packages)).toFixed(3), (b.interrupts / Math.max(1, b.packages)).toFixed(3), ""],
		["quality: tool error rate", shareText(share(n.toolErrors, n.toolResults)), shareText(share(b.toolErrors, b.toolResults)), ""],
	];

	const content = new Map<string, number>();
	for (const c of contentCosts(now)) content.set(categoryGroup(c.category), (content.get(categoryGroup(c.category)) ?? 0) + c.read + c.write + c.uncached);
	const analyzed = [...content.values()].reduce((s, v) => s + v, 0) || 1;
	const contexts = breakdown(now, "context").rows;
	const toolRows = tools(now).slice(0, 8);
	const causes = rebuilds(now).slice(0, 5);
	const pauseRows = pauses(now);
	const compactionRows = compactions(now);
	const agents = subagents(now);
	const top = sessionList(now, { sort: "cost", pageSize: 8 }).rows;

	return [
		`Window ${day(window.start)} to ${day(window.end)} UTC, against the ${BASELINE_DAYS} days before (per day where it says so).`,
		`\`\`\`\n${table(["", "window", "baseline", "change"], rows)}\n\`\`\``,
		block("By session kind", ["kind", "sessions", "turns", "cost", "per session"], byKind(now)),
		block("By model and thinking level (turns)", ["model", "thinking", "turns", "cost", "of it output", "avg prompt"], byModel(now)),
		block("By context size of the request", ["context", "requests", "cost", "share"], contexts.map((r) => [r.key, String(r.requests), money(r.cost), percent(r.cost / Math.max(1e-9, n.cost))])),
		block(
			"Where the cost goes (prompt content)",
			["content", "cost", "share"],
			[...content]
				.sort((x, y) => y[1] - x[1])
				.slice(0, 10)
				.map(([name, cost]) => [name, money(cost), percent(cost / analyzed)]),
		),
		block(
			"Tools (cost: their results in every later request that carried them)",
			["tool", "calls", "errors", "tokens per result", "requests kept", "cost"],
			toolRows.map((t) => [t.tool, String(t.calls), percent(t.errors / Math.max(1, t.calls)), count(t.tokensPerResult), t.requestsKept.toFixed(0), money(t.carryCost)]),
		),
		block("The costliest single tool results", ["tool", "call", "tokens", "requests kept", "cost"], costlyResults(now)),
		...(causes.length ? [block("Cache rebuilds", ["cause", "times", "extra cost"], causes.map((c) => [c.cause, String(c.requests), money(c.waste)]))] : []),
		...(pauseRows.length ? [block("Pauses over 5 min", ["outcome", "pauses", "warming cost", "paid on resume"], pauseRows.map((p) => [p.outcome, String(p.pauses), money(p.warmCost), money(p.resumeCost)]))] : []),
		...(compactionRows.length ? [block("Compactions", ["reason", "times", "avg tokens before", "cost"], compactionRows.map((c) => [c.reason, String(c.count), count(c.avgTokensBefore), money(c.cost)]))] : []),
		`Subagents: ${agents.started} started for ${money(agents.cost)}; results they fetched again that their parent already had: ${money(agents.rediscoveryCost)}; resuming an idle earlier subagent would have been cheaper ${agents.resumeWins} of ${agents.compared} times.`,
		block(
			"Costliest sessions",
			["session", "requests", "cost", "peak context", "compactions", "subagents"],
			top.map((s) => [clip(s.title, 60), String(s.requests), money(s.cost), count(s.peakTokens), String(s.compactions), String(s.subagents)]),
		),
	].join("\n\n");
}
