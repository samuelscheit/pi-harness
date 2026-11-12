// What was spent, split by billing rate, and by what: prompt content, tool, model, project,
// source, context size, request kind or day.

import { type Scope, SPEND, type Spend, spendOf } from "./scope.ts";

export interface Totals extends Spend {
	/** Sessions with a request in scope. */
	sessions: number;
	/** Model turns (requests of the agent itself). */
	requests: number;
	/** Pi's own calls besides turns: compactions, cache warming, tools' own model calls. */
	sideRequests: number;
	sideCost: number;
	promptTokens: number;
	cacheReadTokens: number;
	outputTokens: number;
	/** What cache rebuilds paid over reading from cache. */
	waste: number;
	aborted: number;
	errors: number;
}

export function totals(scope: Scope): Totals {
	const row = scope.get(
		`SELECT COUNT(DISTINCT r.session_id) sessions, COALESCE(SUM(r.kind = 'turn'), 0) requests, COALESCE(SUM(r.kind != 'turn'), 0) side_requests,
		COALESCE(SUM(CASE WHEN r.kind != 'turn' THEN r.cost END), 0) side_cost,
		COALESCE(SUM(CASE WHEN r.kind = 'turn' THEN r.prompt_tokens END), 0) prompt, COALESCE(SUM(CASE WHEN r.kind = 'turn' THEN r.cache_read END), 0) cache_read,
		COALESCE(SUM(r.output), 0) output_tokens, COALESCE(SUM(r.cache_waste), 0) waste,
		COALESCE(SUM(r.stop_reason = 'aborted'), 0) aborted, COALESCE(SUM(r.stop_reason = 'error'), 0) errors, ${SPEND}
		FROM requests r WHERE ${scope.where("r", "ts", true)}`,
	);
	return {
		...spendOf(row),
		sessions: Number(row.sessions),
		requests: Number(row.requests),
		sideRequests: Number(row.side_requests),
		sideCost: Number(row.side_cost),
		promptTokens: Number(row.prompt),
		cacheReadTokens: Number(row.cache_read),
		outputTokens: Number(row.output_tokens),
		waste: Number(row.waste),
		aborted: Number(row.aborted),
		errors: Number(row.errors),
	};
}

export interface SeriesPoint extends Spend {
	/** Bucket start, local time without zone (`2026-11-12` or `2026-11-12T14:00:00`). */
	t: string;
	waste: number;
	requests: number;
}

export interface Series {
	unit: "hour" | "day";
	points: SeriesPoint[];
}

// Windows up to three days are shown by hour, longer ones by day.
const HOURLY_MAX_MS = 72 * 3_600_000;
const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const bucketKey = (ms: number, unit: "hour" | "day") => {
	const d = new Date(ms);
	return unit === "day" ? localDay(d) : `${localDay(d)}T${pad(d.getHours())}:00:00`;
};

/** Spend per hour or day over the window, every bucket present (empty ones as zero). */
export function series(scope: Scope, now = Date.now()): Series {
	const bounds = scope.get<{ first: number | null; last: number | null }>(`SELECT MIN(r.ts) first, MAX(r.ts) last FROM requests r WHERE ${scope.where("r", "ts", true)}`);
	if (bounds.first === null || bounds.last === null) return { unit: "day", points: [] };
	const start = scope.filters.start ?? bounds.first;
	const end = scope.filters.end ?? Math.max(now, bounds.last + 1);
	const unit = end - start <= HOURLY_MAX_MS ? "hour" : "day";
	const format = unit === "day" ? "%Y-%m-%d" : "%Y-%m-%dT%H:00:00";
	const rows = scope.all(
		`SELECT strftime('${format}', r.ts / 1000, 'unixepoch', 'localtime') t, COUNT(*) requests, SUM(r.cache_waste) waste, ${SPEND}
		FROM requests r WHERE ${scope.where("r", "ts", true)} GROUP BY 1`,
	);
	const byBucket = new Map(rows.map((row) => [String(row.t), row]));
	const points: SeriesPoint[] = [];
	const cursor = new Date(start);
	if (unit === "day") cursor.setHours(0, 0, 0, 0);
	else cursor.setMinutes(0, 0, 0);
	for (; cursor.getTime() < end; unit === "day" ? cursor.setDate(cursor.getDate() + 1) : cursor.setHours(cursor.getHours() + 1)) {
		const t = bucketKey(cursor.getTime(), unit);
		const row = byBucket.get(t) ?? {};
		points.push({ t, ...spendOf(row), waste: Number(row.waste ?? 0), requests: Number(row.requests ?? 0) });
	}
	return { unit, points };
}

/** Context size bands of a request's prompt, as `[upper bound, label]`. */
export const CONTEXT_BANDS: [number, string][] = [
	[50_000, "under 50k"],
	[100_000, "50k–100k"],
	[200_000, "100k–200k"],
	[400_000, "200k–400k"],
	[Infinity, "400k and more"],
];
/** Requests from this size on count as a large context. */
export const LARGE_CONTEXT = 200_000;
const BAND_SQL = `CASE ${CONTEXT_BANDS.slice(0, -1)
	.map(([limit, label]) => `WHEN r.prompt_tokens < ${limit} THEN '${label}'`)
	.join(" ")} ELSE '${CONTEXT_BANDS.at(-1)![1]}' END`;

export const GROUPS = ["content", "tool", "model", "project", "source", "context", "kind", "day"] as const;
export type Group = (typeof GROUPS)[number];

export interface BreakdownRow extends Spend {
	key: string;
	/** Requests (request-based groups) or blocks in prompts (content and tool groups). */
	requests: number;
	sessions: number;
	/** Prompt tokens of the requests, or tokens of the content carried in prompts. */
	tokens: number;
	/** Content tokens new in their request (content and tool groups). */
	newTokens: number;
	waste: number;
	/** Tool group: what its definition, its calls and its results cost. */
	parts?: { definition: number; call: number; result: number };
}

export interface Breakdown {
	group: Group;
	rows: BreakdownRow[];
	/** Share of the spend whose prompt content was analyzed (imported Claude Code sessions are not). */
	coverage: number;
}

const REQUEST_GROUPS: Record<Exclude<Group, "content" | "tool">, string> = {
	model: "COALESCE(NULLIF(r.model, ''), r.kind || ' (model not recorded)')",
	project: "s.cwd",
	source: "s.source",
	context: BAND_SQL,
	kind: "r.kind",
	day: "date(r.ts / 1000, 'unixepoch', 'localtime')",
};

/** Group a cost category for the overview: one row per tool's definitions and calls. */
export function categoryGroup(category: string): string {
	if (category.startsWith("tool definition: ")) return "tool definitions";
	if (category.startsWith("tool call: ")) return "tool calls";
	return category;
}

/** Cost by prompt content category, as recorded per request (turns of analyzed sessions only). */
export function contentCosts(scope: Scope): { category: string; blocks: number; tokens: number; newTokens: number; read: number; write: number; uncached: number }[] {
	return scope
		.all(
			`SELECT c.category, SUM(c.blocks) blocks, SUM(c.tokens) tokens, SUM(c.new_tokens) new_tokens, SUM(c.read_cost) read, SUM(c.write_cost) write, SUM(c.uncached_cost) uncached
			FROM request_costs c JOIN requests r ON r.session_id = c.session_id AND r.entry_id = c.entry_id
			WHERE ${scope.where("r", "ts", true)} GROUP BY c.category`,
		)
		.map((row) => ({
			category: String(row.category),
			blocks: Number(row.blocks),
			tokens: Number(row.tokens),
			newTokens: Number(row.new_tokens),
			read: Number(row.read),
			write: Number(row.write),
			uncached: Number(row.uncached),
		}));
}

/** Analyzed share of the spend in scope. */
export function coverage(scope: Scope, total = totals(scope).cost): number {
	if (total <= 0) return 1;
	const analyzed = contentCosts(scope).reduce((sum, c) => sum + c.read + c.write + c.uncached, 0);
	return Math.min(1, analyzed / total);
}

const emptyRow = (key: string): BreakdownRow => ({ key, requests: 0, sessions: 0, tokens: 0, newTokens: 0, waste: 0, cost: 0, read: 0, write: 0, uncached: 0, output: 0 });
const TOOL_CATEGORY = /^tool (definition|call|result): (.+)$/;

function contentBreakdown(scope: Scope, group: "content" | "tool"): BreakdownRow[] {
	const rows = new Map<string, BreakdownRow>();
	for (const c of contentCosts(scope)) {
		const tool = TOOL_CATEGORY.exec(c.category);
		if (group === "tool" && !tool) continue;
		const key = group === "tool" ? tool![2]! : categoryGroup(c.category);
		const row = rows.get(key) ?? emptyRow(key);
		row.requests += c.blocks;
		row.tokens += c.tokens;
		row.newTokens += c.newTokens;
		row.read += c.read;
		row.write += c.write;
		// What the model wrote is recorded as the uncached part of "model output".
		if (c.category === "model output") row.output += c.uncached;
		else row.uncached += c.uncached;
		row.cost += c.read + c.write + c.uncached;
		if (tool) {
			const part = tool[1] as "definition" | "call" | "result";
			row.parts ??= { definition: 0, call: 0, result: 0 };
			row.parts[part] += c.read + c.write + c.uncached;
		}
		rows.set(key, row);
	}
	return [...rows.values()];
}

export function breakdown(scope: Scope, group: Group): Breakdown {
	let rows: BreakdownRow[];
	if (group === "content" || group === "tool") rows = contentBreakdown(scope, group);
	else {
		rows = scope
			.all(
				`SELECT ${REQUEST_GROUPS[group]} key, COUNT(*) requests, COUNT(DISTINCT r.session_id) sessions, SUM(r.prompt_tokens) tokens, SUM(r.cache_waste) waste, ${SPEND}
				FROM requests r JOIN sessions s ON s.id = r.session_id WHERE ${scope.where("r", "ts", true)} GROUP BY 1`,
			)
			.map((row) => ({ ...emptyRow(String(row.key)), ...spendOf(row), requests: Number(row.requests), sessions: Number(row.sessions), tokens: Number(row.tokens), waste: Number(row.waste) }));
	}
	if (group === "day") rows.sort((a, b) => a.key.localeCompare(b.key));
	else if (group === "context") rows.sort((a, b) => CONTEXT_BANDS.findIndex(([, l]) => l === a.key) - CONTEXT_BANDS.findIndex(([, l]) => l === b.key));
	else rows.sort((a, b) => b.cost - a.cost);
	const spent = totals(scope).cost;
	return { group, rows, coverage: coverage(scope, spent) };
}

export interface SideCall {
	kind: string;
	model: string;
	requests: number;
	sessions: number;
	avgPrompt: number;
	cost: number;
}

/** Pi's calls besides turns: compactions, cache warming, tools' own model calls. */
export function sideCalls(scope: Scope): SideCall[] {
	return scope
		.all(
			`SELECT r.kind, COALESCE(NULLIF(MAX(r.model), ''), 'not recorded') model, COUNT(*) requests, COUNT(DISTINCT r.session_id) sessions,
			AVG(r.prompt_tokens) avg_prompt, SUM(r.cost) cost FROM requests r WHERE r.kind != 'turn' AND ${scope.where("r", "ts", true)}
			GROUP BY r.kind ORDER BY cost DESC`,
		)
		.map((row) => ({
			kind: String(row.kind),
			model: String(row.model),
			requests: Number(row.requests),
			sessions: Number(row.sessions),
			avgPrompt: Number(row.avg_prompt),
			cost: Number(row.cost),
		}));
}

/** User messages by where they fell: first, follow-up, steer, after interrupt, after error. */
export function userMessages(scope: Scope): { kind: string; count: number }[] {
	return scope
		.all(`SELECT u.kind, COUNT(*) n FROM user_messages u WHERE ${scope.where("u", "ts")} GROUP BY u.kind ORDER BY n DESC`)
		.map((row) => ({ kind: String(row.kind), count: Number(row.n) }));
}
