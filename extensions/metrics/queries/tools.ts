// Tools and context: what each tool's results cost while carried, which results were never
// referenced again, the largest single results, and how large prompts get.

import { CONTEXT_BANDS } from "./spend.ts";
import { percentile, type Scope, titleSql, titleOf } from "./scope.ts";

export interface ToolStats {
	tool: string;
	calls: number;
	errors: number;
	/** Durations in ms (Pi records them; imported sessions do not). */
	p50Ms: number | null;
	p95Ms: number | null;
	/** Average result size and requests it stayed in context. */
	tokensPerResult: number;
	requestsKept: number;
	/** What its results cost in every request that carried them. */
	carryCost: number;
	/** Results touching files (whether they were referenced later is known for them). */
	withFiles: number;
	unreferenced: number;
	unreferencedCost: number;
}

export function tools(scope: Scope): ToolStats[] {
	const where = scope.where("t", "ts");
	const durations = new Map<string, number[]>();
	for (const row of scope.all<{ tool: string; duration_ms: number }>(
		`SELECT t.tool, t.duration_ms FROM tool_results t WHERE t.duration_ms IS NOT NULL AND ${where} ORDER BY t.tool, t.duration_ms`,
	)) {
		const list = durations.get(row.tool) ?? [];
		list.push(Number(row.duration_ms));
		durations.set(row.tool, list);
	}
	return scope
		.all(
			`SELECT t.tool, COUNT(*) calls, SUM(t.is_error) errors, AVG(t.tokens) tokens, AVG(t.requests_in_context) kept, SUM(t.lifetime_cost) cost,
			SUM(t.referenced_later IS NOT NULL) with_files, COALESCE(SUM(t.referenced_later = 0), 0) unused,
			COALESCE(SUM(CASE WHEN t.referenced_later = 0 THEN t.lifetime_cost END), 0) unused_cost
			FROM tool_results t WHERE ${where} GROUP BY t.tool ORDER BY cost DESC`,
		)
		.map((row) => {
			const sorted = durations.get(String(row.tool));
			return {
				tool: String(row.tool),
				calls: Number(row.calls),
				errors: Number(row.errors),
				p50Ms: sorted ? percentile(sorted, 0.5) : null,
				p95Ms: sorted ? percentile(sorted, 0.95) : null,
				tokensPerResult: Number(row.tokens),
				requestsKept: Number(row.kept),
				carryCost: Number(row.cost),
				withFiles: Number(row.with_files),
				unreferenced: Number(row.unused),
				unreferencedCost: Number(row.unused_cost),
			};
		});
}

export interface ToolResult {
	session: string;
	title: string;
	call: string;
	ts: number;
	tool: string;
	/** The call's input, shortened (command, path, query). */
	summary: string;
	files: string[];
	isError: boolean;
	tokens: number;
	requestsKept: number;
	carryCost: number;
	/** Whether a later call or the agent referenced one of its files again (null: no files). */
	referencedLater: boolean | null;
}

/** Single tool results by what they cost while carried, most expensive first. */
export function largestResults(scope: Scope, limit = 20): ToolResult[] {
	return scope
		.all(
			`SELECT t.*, ${titleSql()} title, (SELECT GROUP_CONCAT(f.file, char(10)) FROM tool_files f WHERE f.session_id = t.session_id AND f.call_id = t.call_id) files
			FROM tool_results t JOIN sessions s ON s.id = t.session_id WHERE ${scope.where("t", "ts")} ORDER BY t.lifetime_cost DESC LIMIT $limit`,
			{ $limit: limit },
		)
		.map((row) => ({
			session: String(row.session_id),
			title: titleOf(row.title, String(row.session_id)),
			call: String(row.call_id),
			ts: Number(row.ts),
			tool: String(row.tool),
			summary: String(row.summary),
			files: row.files ? String(row.files).split("\n") : [],
			isError: Number(row.is_error) === 1,
			tokens: Number(row.tokens),
			requestsKept: Number(row.requests_in_context),
			carryCost: Number(row.lifetime_cost),
			referencedLater: row.referenced_later === null ? null : Number(row.referenced_later) === 1,
		}));
}

export interface ContextSizes {
	requests: number;
	median: number;
	p90: number;
	max: number;
	bands: { band: string; requests: number; cost: number }[];
}

/** How large the prompts of the turns in scope were. */
export function contextSizes(scope: Scope): ContextSizes {
	const rows = scope.all<{ prompt_tokens: number; cost: number }>(
		`SELECT r.prompt_tokens, r.cost FROM requests r WHERE r.kind = 'turn' AND ${scope.where("r", "ts", true)} ORDER BY r.prompt_tokens`,
	);
	const sizes = rows.map((r) => Number(r.prompt_tokens));
	const bands = CONTEXT_BANDS.map(([, band]) => ({ band, requests: 0, cost: 0 }));
	for (const row of rows) {
		const index = CONTEXT_BANDS.findIndex(([limit]) => Number(row.prompt_tokens) < limit);
		bands[index]!.requests += 1;
		bands[index]!.cost += Number(row.cost);
	}
	return { requests: sizes.length, median: percentile(sizes, 0.5), p90: percentile(sizes, 0.9), max: sizes.at(-1) ?? 0, bands };
}
