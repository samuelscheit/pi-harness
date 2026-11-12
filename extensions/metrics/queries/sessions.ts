// Sessions ranked by what they cost in scope, and one session in full: its requests over time
// with cache rebuilds, compactions, pauses and subagent starts, its subagents and largest results.

import type { DatabaseSync } from "node:sqlite";
import { type RebuildCause, rebuilds } from "./cache.ts";
import { type CompactionOpportunity, compactionOpportunities } from "./compaction.ts";
import { Scope, titleOf, titleSql } from "./scope.ts";
import { type BreakdownRow, breakdown, type Totals, totals } from "./spend.ts";
import { DELEGATED_CHILD } from "./subagents.ts";
import { largestResults, type ToolResult } from "./tools.ts";

export const SESSION_SORTS = ["cost", "waste", "peak", "duration", "requests", "recent"] as const;
export type SessionSort = (typeof SESSION_SORTS)[number];
const ORDER: Record<SessionSort, string> = {
	cost: "cost DESC",
	waste: "waste DESC, cost DESC",
	peak: "peak DESC",
	duration: "last - first DESC",
	requests: "requests DESC",
	recent: "last DESC",
};
// Sparklines show the prompt size over at most this many points (the largest in each slice).
const SPARK_POINTS = 48;

export interface SessionRow {
	id: string;
	title: string;
	cwd: string;
	source: string;
	requests: number;
	cost: number;
	waste: number;
	sideCost: number;
	peakTokens: number;
	first: number;
	last: number;
	compactions: number;
	subagents: number;
	/** Prompt size of the turns, downsampled. */
	spark: number[];
}

export interface SessionPage {
	total: number;
	page: number;
	pageSize: number;
	rows: SessionRow[];
}

export function downsample(values: number[], points = SPARK_POINTS): number[] {
	if (values.length <= points) return values;
	return Array.from({ length: points }, (_, i) => Math.max(...values.slice(Math.floor((i * values.length) / points), Math.floor(((i + 1) * values.length) / points))));
}

/** Sessions with requests in scope, by what they spent in it. */
export function sessionList(scope: Scope, { sort = "cost", page = 1, pageSize = 25 }: { sort?: SessionSort; page?: number; pageSize?: number } = {}): SessionPage {
	const grouped = `SELECT r.session_id id, COALESCE(SUM(r.kind = 'turn'), 0) requests, SUM(r.cost) cost, SUM(r.cache_waste) waste,
		COALESCE(SUM(CASE WHEN r.kind != 'turn' THEN r.cost END), 0) side_cost, COALESCE(MAX(CASE WHEN r.kind = 'turn' THEN r.prompt_tokens END), 0) peak,
		MIN(r.ts) first, MAX(r.ts) last FROM requests r WHERE ${scope.where("r", "ts", true)} GROUP BY r.session_id`;
	const total = Number(scope.get(`SELECT COUNT(*) n FROM (${grouped})`).n);
	const rows = scope.all(
		`SELECT g.*, s.cwd, s.source, ${titleSql()} title,
		(SELECT COUNT(*) FROM compactions c WHERE c.session_id = g.id AND ${scope.window("c.ts")}) compactions,
		(SELECT COUNT(*) FROM delegations d WHERE d.session_id = g.id AND d.kind = 'delegate' AND ${scope.window("d.ts")}) subagents
		FROM (${grouped}) g JOIN sessions s ON s.id = g.id ORDER BY ${ORDER[sort]} LIMIT $limit OFFSET $offset`,
		{ $limit: pageSize, $offset: (Math.max(1, page) - 1) * pageSize },
	);
	return {
		total,
		page,
		pageSize,
		rows: rows.map((row) => {
			const id = String(row.id);
			const prompts = scope.all(`SELECT r.prompt_tokens p FROM requests r WHERE r.session_id = $id AND r.kind = 'turn' AND ${scope.where("r", "ts", true)} ORDER BY r.ts`, { $id: id });
			return {
				id,
				title: titleOf(row.title, id),
				cwd: String(row.cwd),
				source: String(row.source),
				requests: Number(row.requests),
				cost: Number(row.cost),
				waste: Number(row.waste),
				sideCost: Number(row.side_cost),
				peakTokens: Number(row.peak),
				first: Number(row.first),
				last: Number(row.last),
				compactions: Number(row.compactions),
				subagents: Number(row.subagents),
				spark: downsample(prompts.map((p) => Number(p.p))),
			};
		}),
	};
}

export interface SessionNode {
	id: string;
	title: string;
	source: string;
	startedAt: number;
	requests: number;
	cost: number;
	children: SessionNode[];
}

const MAX_DEPTH = 4;

/** Sessions this one started: subagents by delegation, and sessions naming it as their parent. */
function childrenOf(db: DatabaseSync, id: string, depth: number, seen: Set<string>): SessionNode[] {
	if (depth >= MAX_DEPTH) return [];
	const scope = new Scope(db, { source: "all" });
	const rows = scope.all(
		`SELECT c.id, c.source, c.started_at, c.requests, c.cost, ${titleSql("c")} title FROM sessions c WHERE c.id IN (
			SELECT ${DELEGATED_CHILD} FROM delegations d WHERE d.session_id = $id AND d.kind = 'delegate'
			UNION SELECT p.id FROM sessions p WHERE p.parent_session = $id) ORDER BY c.started_at`,
		{ $id: id },
	);
	const nodes: SessionNode[] = [];
	for (const row of rows) {
		const child = String(row.id);
		if (seen.has(child)) continue;
		seen.add(child);
		nodes.push({
			id: child,
			title: titleOf(row.title, child),
			source: String(row.source),
			startedAt: Number(row.started_at),
			requests: Number(row.requests),
			cost: Number(row.cost),
			children: childrenOf(db, child, depth + 1, seen),
		});
	}
	return nodes;
}

export interface TimelinePoint {
	entry: string;
	ts: number;
	kind: string;
	model: string;
	promptTokens: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	cost: number;
	cacheEvent: string | null;
	waste: number;
	trigger: string | null;
	stopReason: string | null;
}

export interface SessionDetail {
	session: {
		id: string;
		title: string;
		cwd: string;
		source: string;
		startedAt: number;
		endedAt: number;
		/** What the client itself reported (Claude Code), to check ours. */
		reportedCost: number | null;
		parent: { id: string; title: string } | null;
		models: string[];
	};
	totals: Totals;
	peakTokens: number;
	timeline: TimelinePoint[];
	compactions: { ts: number; reason: string; tokensBefore: number; cost: number }[];
	pauses: { start: number; end: number | null; minutes: number; outcome: string; warms: number; warmCost: number; resumeCost: number }[];
	delegations: { ts: number; kind: string; title: string | null; child: string | null }[];
	userMessages: { ts: number; kind: string; text: string }[];
	children: SessionNode[];
	composition: BreakdownRow[];
	coverage: number;
	rebuilds: RebuildCause[];
	results: ToolResult[];
	bestCompaction: CompactionOpportunity | null;
}

const USER_TEXT_PREVIEW = 160;

/** One session in full, whatever the filters (undefined when unknown). */
export function sessionDetail(db: DatabaseSync, id: string): SessionDetail | undefined {
	const scope = new Scope(db, { source: "all", session: id });
	const s = scope.get(`SELECT s.*, ${titleSql()} title FROM sessions s WHERE s.id = $session`);
	if (!s) return undefined;
	const parentId =
		(s.parent_session as string | null) ??
		(s.prompt_digest
			? (scope.get<{ parent?: string } | undefined>(
					`SELECT d.session_id parent FROM delegations d WHERE d.kind = 'delegate' AND d.task_digest = $digest AND ${DELEGATED_CHILD} = $session LIMIT 1`,
					{ $digest: String(s.prompt_digest) },
				)?.parent ?? null)
			: null);
	const parentRow = parentId ? scope.get<{ title: unknown } | undefined>(`SELECT ${titleSql()} title FROM sessions s WHERE s.id = $id`, { $id: parentId }) : undefined;
	const timeline = scope
		.all(`SELECT * FROM requests r WHERE r.session_id = $session ORDER BY r.ts`)
		.map((r) => ({
			entry: String(r.entry_id),
			ts: Number(r.ts),
			kind: String(r.kind),
			model: String(r.model),
			promptTokens: Number(r.prompt_tokens),
			cacheRead: Number(r.cache_read),
			cacheWrite: Number(r.cache_write),
			output: Number(r.output),
			cost: Number(r.cost),
			cacheEvent: (r.cache_event as string | null) ?? null,
			waste: Number(r.cache_waste),
			trigger: (r.trigger as string | null) ?? null,
			stopReason: (r.stop_reason as string | null) ?? null,
		}));
	const content = breakdown(scope, "content");
	return {
		session: {
			id,
			title: titleOf(s.title, id),
			cwd: String(s.cwd),
			source: String(s.source),
			startedAt: Number(s.started_at),
			endedAt: Number(s.ended_at),
			reportedCost: s.reported_cost === null ? null : Number(s.reported_cost),
			parent: parentId ? { id: parentId, title: titleOf(parentRow?.title, parentId) } : null,
			models: [...new Set(timeline.filter((t) => t.kind === "turn").map((t) => t.model))],
		},
		totals: totals(scope),
		peakTokens: Math.max(0, ...timeline.filter((t) => t.kind === "turn").map((t) => t.promptTokens)),
		timeline,
		compactions: scope
			.all("SELECT ts, COALESCE(reason, 'extension') reason, tokens_before, cost FROM compactions WHERE session_id = $session ORDER BY ts")
			.map((c) => ({ ts: Number(c.ts), reason: String(c.reason), tokensBefore: Number(c.tokens_before), cost: Number(c.cost) })),
		pauses: scope.all("SELECT * FROM idle_pauses WHERE session_id = $session ORDER BY start_ts").map((p) => ({
			start: Number(p.start_ts),
			end: p.end_ts === null ? null : Number(p.end_ts),
			minutes: Number(p.minutes),
			outcome: String(p.outcome),
			warms: Number(p.warms),
			warmCost: Number(p.warm_cost),
			resumeCost: Number(p.resume_cost),
		})),
		delegations: scope
			.all(`SELECT d.ts, d.kind, d.title, CASE WHEN d.kind = 'delegate' THEN ${DELEGATED_CHILD} ELSE d.thread_id END child FROM delegations d WHERE d.session_id = $session ORDER BY d.ts`)
			.map((d) => ({ ts: Number(d.ts), kind: String(d.kind), title: (d.title as string | null) ?? null, child: (d.child as string | null) ?? null })),
		userMessages: scope
			.all("SELECT ts, kind, text FROM user_messages WHERE session_id = $session ORDER BY ts")
			.map((u) => ({ ts: Number(u.ts), kind: String(u.kind), text: String(u.text).slice(0, USER_TEXT_PREVIEW) })),
		children: childrenOf(db, id, 0, new Set([id])),
		composition: content.rows,
		coverage: content.coverage,
		rebuilds: rebuilds(scope),
		results: largestResults(scope, 15),
		bestCompaction: compactionOpportunities(scope).sessions[0] ?? null,
	};
}
