// The best single compaction per session in scope, knowing its later requests (see
// bestCompaction): an upper bound for what compacting earlier would have saved.

import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import { bestCompaction, type Turn } from "../efficiency.ts";
import { type Scope, titleOf, titleSql } from "./scope.ts";

export const KEEP_TOKENS = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;

export interface CompactionOpportunity {
	session: string;
	title: string;
	cwd: string;
	requests: number;
	cost: number;
	peakTokens: number;
	/** 1-based turn after which to compact, its time and its context size. */
	after: number;
	ts: number;
	tokens: number;
	saving: number;
}

export interface CompactionOpportunities {
	total: number;
	sessions: CompactionOpportunity[];
}

export function compactionOpportunities(scope: Scope): CompactionOpportunities {
	// All turns in scope in one pass, grouped by session.
	const bySession = new Map<string, (Turn & { ts: number; cost: number })[]>();
	for (const row of scope.all(
		`SELECT r.session_id, r.ts, r.prompt_tokens, r.input_rate, r.read_rate, r.write_rate, r.cost FROM requests r
		WHERE r.kind = 'turn' AND ${scope.where("r", "ts", true)} ORDER BY r.session_id, r.ts`,
	)) {
		const id = String(row.session_id);
		const turns = bySession.get(id) ?? [];
		turns.push({
			ts: Number(row.ts),
			cost: Number(row.cost),
			promptTokens: Number(row.prompt_tokens),
			inputRate: Number(row.input_rate),
			readRate: Number(row.read_rate),
			writeRate: Number(row.write_rate),
		});
		bySession.set(id, turns);
	}
	const found: CompactionOpportunity[] = [];
	for (const [session, turns] of bySession) {
		if (turns.length < 2) continue;
		const best = bestCompaction(turns, KEEP_TOKENS);
		if (!best) continue;
		const at = turns[best.index]!;
		found.push({
			session,
			title: "",
			cwd: "",
			requests: turns.length,
			cost: turns.reduce((sum, t) => sum + t.cost, 0),
			peakTokens: Math.max(...turns.map((t) => t.promptTokens)),
			after: best.index + 1,
			ts: at.ts,
			tokens: at.promptTokens,
			saving: best.saving,
		});
	}
	found.sort((a, b) => b.saving - a.saving);
	// Titles only for the sessions anyone will see.
	for (const item of found.slice(0, 50)) {
		const row = scope.get(`SELECT s.cwd, ${titleSql()} title FROM sessions s WHERE s.id = $id`, { $id: item.session });
		item.title = titleOf(row.title, item.session);
		item.cwd = String(row.cwd);
	}
	return { total: found.reduce((sum, s) => sum + s.saving, 0), sessions: found.slice(0, 50) };
}
