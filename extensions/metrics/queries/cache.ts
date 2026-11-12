// What the prompt cache cost beyond reading it: rebuilds by cause, pauses that let it expire,
// warm refreshes, and compactions by reason.

import { type Scope, titleSql, titleOf } from "./scope.ts";

export interface RebuildCause {
	cause: string;
	requests: number;
	sessions: number;
	/** Previously cached tokens the requests did not read. */
	lostTokens: number;
	/** What the rebuilds paid over reading from cache (0 for unavoidable ones such as compaction). */
	waste: number;
}

export function rebuilds(scope: Scope): RebuildCause[] {
	return scope
		.all(
			`SELECT r.cache_event cause, COUNT(*) n, COUNT(DISTINCT r.session_id) sessions, SUM(r.cache_lost) lost, SUM(r.cache_waste) waste
			FROM requests r WHERE r.cache_event IS NOT NULL AND ${scope.where("r", "ts", true)} GROUP BY r.cache_event ORDER BY waste DESC, n DESC`,
		)
		.map((row) => ({ cause: String(row.cause), requests: Number(row.n), sessions: Number(row.sessions), lostTokens: Number(row.lost), waste: Number(row.waste) }));
}

export interface DroppedThinking {
	/** Replayed thinking blocks the provider dropped without billing them (prefix binding mismatch). */
	blocks: number;
	requests: number;
	sessions: number;
}

/** Thinking the model silently lost: blocks Anthropic dropped from requests (see payload.ts). A quality signal, not a cost. */
export function droppedThinking(scope: Scope): DroppedThinking {
	const row = scope.get(
		`SELECT COALESCE(SUM(r.thinking_dropped), 0) blocks, COUNT(*) n, COUNT(DISTINCT r.session_id) sessions
		FROM requests r WHERE r.thinking_dropped > 0 AND ${scope.where("r", "ts", true)}`,
	);
	return { blocks: Number(row.blocks), requests: Number(row.n), sessions: Number(row.sessions) };
}

export interface RebuildExample {
	session: string;
	title: string;
	entry: string;
	ts: number;
	cause: string;
	promptTokens: number;
	lostTokens: number;
	waste: number;
}

export function largestRebuilds(scope: Scope, limit = 12): RebuildExample[] {
	return scope
		.all(
			`SELECT r.session_id, r.entry_id, r.ts, r.cache_event, r.prompt_tokens, r.cache_lost, r.cache_waste, ${titleSql()} title
			FROM requests r JOIN sessions s ON s.id = r.session_id
			WHERE r.cache_waste > 0 AND ${scope.where("r", "ts", true)} ORDER BY r.cache_waste DESC LIMIT $limit`,
			{ $limit: limit },
		)
		.map((row) => ({
			session: String(row.session_id),
			title: titleOf(row.title, String(row.session_id)),
			entry: String(row.entry_id),
			ts: Number(row.ts),
			cause: String(row.cache_event),
			promptTokens: Number(row.prompt_tokens),
			lostTokens: Number(row.cache_lost),
			waste: Number(row.cache_waste),
		}));
}

export const PAUSE_OUTCOMES: Record<string, string> = {
	warm: "resumed, cache warm",
	compacted: "resumed, compacted (cold)",
	cold: "resumed, cache rebuilt",
	open: "not resumed yet",
};

export interface PauseOutcome {
	outcome: string;
	pauses: number;
	avgMinutes: number;
	warms: number;
	warmCost: number;
	avgPromptTokens: number;
	/** What the request after the pause paid to write its cache. */
	resumeCost: number;
}

/** Pauses longer than the short cache lifetime, by how the session resumed. */
export function pauses(scope: Scope): PauseOutcome[] {
	return scope
		.all(
			`SELECT p.outcome, COUNT(*) n, AVG(p.minutes) minutes, SUM(p.warms) warms, SUM(p.warm_cost) warm_cost, AVG(p.prompt_tokens) tokens,
			SUM(p.resume_cost) write_cost FROM idle_pauses p WHERE ${scope.where("p", "start_ts")} GROUP BY p.outcome ORDER BY n DESC`,
		)
		.map((row) => ({
			outcome: String(row.outcome),
			pauses: Number(row.n),
			avgMinutes: Number(row.minutes),
			warms: Number(row.warms),
			warmCost: Number(row.warm_cost),
			avgPromptTokens: Number(row.tokens),
			resumeCost: Number(row.write_cost),
		}));
}

export interface ColdResume {
	session: string;
	title: string;
	start: number;
	end: number | null;
	minutes: number;
	promptTokens: number;
	resumeCost: number;
}

/** Resumes that wrote the whole context again after the cache expired, most expensive first. */
export function coldResumes(scope: Scope, limit = 12): ColdResume[] {
	return scope
		.all(
			`SELECT p.session_id, p.start_ts, p.end_ts, p.minutes, p.prompt_tokens, p.resume_cost, ${titleSql()} title
			FROM idle_pauses p JOIN sessions s ON s.id = p.session_id
			WHERE p.outcome = 'cold' AND ${scope.where("p", "start_ts")} ORDER BY p.resume_cost DESC LIMIT $limit`,
			{ $limit: limit },
		)
		.map((row) => ({
			session: String(row.session_id),
			title: titleOf(row.title, String(row.session_id)),
			start: Number(row.start_ts),
			end: row.end_ts === null ? null : Number(row.end_ts),
			minutes: Number(row.minutes),
			promptTokens: Number(row.prompt_tokens),
			resumeCost: Number(row.resume_cost),
		}));
}

export interface CompactionReason {
	reason: string;
	count: number;
	avgTokensBefore: number;
	cost: number;
}

/** Compactions by what triggered them (manual, threshold, overflow, cold, economic; Claude Code's auto/manual). */
export function compactions(scope: Scope): CompactionReason[] {
	return scope
		.all(
			`SELECT COALESCE(c.reason, 'extension') reason, COUNT(*) n, AVG(c.tokens_before) tokens, SUM(c.cost) cost
			FROM compactions c WHERE ${scope.where("c", "ts")} GROUP BY 1 ORDER BY n DESC`,
		)
		.map((row) => ({ reason: String(row.reason), count: Number(row.n), avgTokensBefore: Number(row.tokens), cost: Number(row.cost) }));
}
