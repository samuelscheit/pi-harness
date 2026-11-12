// Token efficiency of how work is split and how much context is carried.
//
// Every request pays for its whole context: cached tokens at the read rate, new ones at the write
// rate. So two decisions dominate cost beyond the work itself:
//
// - Subagents. A new subagent writes its base prompt and tools once and re-reads whatever its
//   parent already knew (rediscovery). Resuming an earlier subagent instead carries that agent's
//   whole context in every request, and rewrites it once if its cache expired. `subagentReport`
//   prices both for every delegation.
// - Context size. Carried tokens cost the read rate on every later request. `contextReport` shows
//   how big contexts get, what share of carried tool results was never referenced again, and an upper
//   bound for what one well-timed compaction would have saved (quality loss not included).

import type { DatabaseSync } from "node:sqlite";
import { compactionCost, DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import { count, minutes, money, percent, percentile, type Row, table } from "./format.ts";

// The harness summarizes with Haiku, a fifth of Opus's price; output costs five times input.
const SUMMARY_PRICE_SHARE = 0.2;
const OUTPUT_TO_INPUT = 5;
const SHORT_CACHE_MS = 5 * 60_000;
// A subagent with a request this soon after a delegation was still working, so it could not take it.
const BUSY_MS = 2 * 60_000;
const MAX_ROWS = 12;
const LONG_CACHE_MS = 60 * 60_000;

export interface AgentState {
	/** Context tokens of the agent's last request. */
	contextTokens: number;
	/** Time of that request. */
	lastTs: number;
	/** Whether it wrote its cache for one hour. */
	longRetention: boolean;
}

export interface Child {
	cost: number;
	requests: number;
	/** Context tokens of its first request: base prompt, tools and brief. */
	baseTokens: number;
	/** What its first request paid to write that context. */
	startupCost: number;
	/** What the results it fetched again (rediscovery) cost while carried. */
	rediscoveryCost: number;
	readRate: number;
	writeRate: number;
}

/** Whether an agent's cache is still alive at `at`. */
export const cacheWarm = (agent: AgentState, at: number) => at - agent.lastTs <= (agent.longRetention ? LONG_CACHE_MS : SHORT_CACHE_MS);

/**
 * What the new child's work would have cost in `agent` instead: the child's own cost without its
 * startup write and rediscovery, plus the agent's extra context on every request, plus rewriting
 * that context once if its cache had expired.
 */
export function resumeCost(child: Child, agent: AgentState, at: number): number {
	const extra = Math.max(0, agent.contextTokens - child.baseTokens);
	const rewrite = cacheWarm(agent, at) ? 0 : agent.contextTokens * child.writeRate;
	return child.cost - child.startupCost - child.rediscoveryCost + child.requests * extra * child.readRate + rewrite;
}

export interface Turn {
	promptTokens: number;
	inputRate: number;
	readRate: number;
	writeRate: number;
}

/**
 * The one compaction that would have saved the most, knowing the later requests: after request
 * `index` the context shrinks to what Pi's compaction keeps, so each later request reads the
 * dropped tokens less, but never more than it actually carried beyond the kept size (a later real
 * compaction already shrank it). Against the compaction's own cost, priced like Pi's economic one.
 */
export function bestCompaction(turns: Turn[], keepTokens = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens): { index: number; saving: number } | undefined {
	let best: { index: number; saving: number } | undefined;
	turns.forEach((turn, index) => {
		const summaryInput = turn.inputRate * SUMMARY_PRICE_SHARE;
		const compaction = compactionCost(turn.promptTokens, keepTokens, {
			read: turn.readRate,
			write: turn.writeRate,
			summaryInput,
			summaryOutput: summaryInput * OUTPUT_TO_INPUT,
		});
		if (!compaction) return;
		const dropped = turn.promptTokens - compaction.keptTokens;
		let saving = -compaction.cost;
		for (let later = index + 1; later < turns.length; later++) {
			const next = turns[later]!;
			saving += Math.min(dropped, Math.max(0, next.promptTokens - compaction.keptTokens)) * next.readRate;
		}
		if (saving > 0 && (!best || saving > best.saving)) best = { index, saving };
	});
	return best;
}

type All = (sql: string) => Row[];

/** Resume-versus-new for every subagent started in scope. */
export function subagentReport(db: DatabaseSync, all: All, scoped: string): string | undefined {
	// Each call starts the first session with its task that began after it (the same task can run twice).
	const delegations = all(
		`SELECT d.session_id parent, d.ts, d.title, c.id child, c.started_at, c.ended_at, c.requests, c.cost
		FROM delegations d JOIN sessions c ON c.id = (
			SELECT id FROM sessions WHERE prompt_digest = d.task_digest AND started_at >= d.ts - 60000 ORDER BY started_at LIMIT 1)
		WHERE d.kind = 'delegate' AND d.session_id IN (${scoped}) ORDER BY d.ts`,
	);
	if (delegations.length === 0) return undefined;
	const resumes = Number(all(`SELECT COUNT(*) n FROM delegations WHERE kind = 'send' AND session_id IN (${scoped})`)[0]!.n);
	const turnsOf = db.prepare(
		`SELECT ts, prompt_tokens, cache_write, input, input_rate, read_rate, write_rate, long_retention FROM requests
		WHERE session_id = ? AND kind = 'turn' ORDER BY ts`,
	);
	const filesBefore = db.prepare("SELECT DISTINCT file FROM tool_files WHERE session_id = ? AND ts < ?");
	const childCalls = db.prepare(
		`SELECT r.call_id, r.tokens, r.lifetime_cost, GROUP_CONCAT(f.file, char(10)) files FROM tool_results r
		JOIN tool_files f ON f.session_id = r.session_id AND f.call_id = r.call_id WHERE r.session_id = ? GROUP BY r.call_id`,
	);

	const earlier = new Map<string, { title: string; child: string }[]>();
	const seen = new Set<string>();
	const rows: { cells: string[]; difference: number }[] = [];
	const totals = { count: 0, cost: 0, best: 0, rediscovery: 0, resumeWins: 0, compared: 0 };
	for (const d of delegations) {
		const child = String(d.child);
		if (seen.has(child)) continue;
		seen.add(child);
		const turns = turnsOf.all(child) as Row[];
		if (turns.length === 0) continue;
		const first = turns[0]!;
		const siblings = earlier.get(String(d.parent)) ?? [];
		earlier.set(String(d.parent), [...siblings, { title: String(d.title ?? child.slice(0, 8)), child }]);

		const start = Number(d.started_at);
		const known = new Set<string>();
		for (const session of [String(d.parent), ...siblings.map((s) => s.child)]) {
			for (const row of filesBefore.all(session, start) as Row[]) known.add(String(row.file));
		}
		let rediscovered = { calls: 0, tokens: 0, cost: 0 };
		for (const call of childCalls.all(child) as Row[]) {
			if (!String(call.files).split("\n").every((file) => known.has(file))) continue;
			rediscovered = { calls: rediscovered.calls + 1, tokens: rediscovered.tokens + Number(call.tokens), cost: rediscovered.cost + Number(call.lifetime_cost) };
		}
		const spec: Child = {
			cost: Number(d.cost),
			requests: turns.length,
			baseTokens: Number(first.prompt_tokens),
			startupCost: Number(first.cache_write) * Number(first.write_rate) + Number(first.input) * Number(first.input_rate),
			rediscoveryCost: rediscovered.cost,
			readRate: Number(first.read_rate),
			writeRate: Number(first.write_rate),
		};

		// The cheapest earlier subagent of the same parent to have resumed instead.
		const at = Number(d.ts);
		let alternative: { title: string; agent: AgentState; cost: number } | undefined;
		for (const sibling of siblings) {
			const turns = turnsOf.all(sibling.child) as Row[];
			const last = turns.filter((t) => Number(t.ts) <= at).at(-1);
			// A sibling still working at that moment could not have taken the task.
			if (!last || turns.some((t) => Number(t.ts) > at && Number(t.ts) <= at + BUSY_MS)) continue;
			const agent = { contextTokens: Number(last.prompt_tokens), lastTs: Number(last.ts), longRetention: Number(last.long_retention) === 1 };
			const cost = resumeCost(spec, agent, at);
			if (!alternative || cost < alternative.cost) alternative = { title: sibling.title, agent, cost };
		}
		totals.count += 1;
		totals.cost += spec.cost;
		totals.best += Math.min(spec.cost, alternative?.cost ?? Infinity);
		totals.rediscovery += rediscovered.cost;
		if (alternative) totals.compared += 1;
		if (alternative && alternative.cost < spec.cost) totals.resumeWins += 1;
		rows.push({ difference: alternative ? Math.abs(alternative.cost - spec.cost) : 0, cells: [
			String(d.title ?? child.slice(0, 8)).slice(0, 36),
			String(turns.length),
			money(spec.cost),
			minutes(Number(d.ended_at) - start),
			money(spec.startupCost),
			rediscovered.calls ? `${rediscovered.calls} / ${count(rediscovered.tokens)} / ${money(rediscovered.cost)}` : "none",
			alternative
				? `${alternative.title.slice(0, 24)} (${count(alternative.agent.contextTokens)}, idle ${minutes(at - alternative.agent.lastTs)}, ${cacheWarm(alternative.agent, at) ? "warm" : "cold"})`
				: "none",
			alternative ? money(alternative.cost) : "",
			alternative ? (alternative.cost < spec.cost ? `resume saves ${money(spec.cost - alternative.cost)}` : `new saved ${money(alternative.cost - spec.cost)}`) : "",
		] });
	}
	if (rows.length === 0) return undefined;
	const shown = rows.length > MAX_ROWS ? [...rows].sort((a, b) => b.difference - a.difference).slice(0, MAX_ROWS) : rows;
	return [
		`Subagents: ${totals.count} started, ${money(totals.cost)}; ${resumes} resumes by message. Rediscovery (results the parent or an earlier subagent already had): ${money(totals.rediscovery)}.`,
		`Resuming an idle earlier subagent instead was possible ${totals.compared} times and cheaper ${totals.resumeWins} times; the cheaper choice each time: ${money(totals.best)} (${percent(1 - totals.best / Math.max(totals.cost, 1e-9))} less).`,
		`${rows.length > MAX_ROWS ? `The ${MAX_ROWS} largest differences` : "Per subagent"} (rediscovered = calls / tokens / cost):`,
		table(["subagent", "requests", "cost", "wall", "startup", "rediscovered", "resume instead (context, idle)", "est. resume", "verdict"], shown.map((r) => r.cells)),
	].join("\n");
}

/** Context sizes, never-referenced results and the best single compaction per session, in scope. */
export function contextReport(db: DatabaseSync, all: All, scoped: string): string | undefined {
	const turnsOf = db.prepare("SELECT prompt_tokens, input_rate, read_rate, write_rate FROM requests WHERE session_id = ? AND kind = 'turn' ORDER BY ts");
	const sessions = all(`SELECT id, cwd, name, requests, cost FROM sessions s WHERE id IN (${scoped}) AND requests > 1`);
	const sizes: number[] = [];
	const savings: { label: string; requests: number; cost: number; peak: number; at: number; tokens: number; saving: number }[] = [];
	for (const s of sessions) {
		const turns = (turnsOf.all(String(s.id)) as Row[]).map((t) => ({
			promptTokens: Number(t.prompt_tokens),
			inputRate: Number(t.input_rate),
			readRate: Number(t.read_rate),
			writeRate: Number(t.write_rate),
		}));
		for (const t of turns) sizes.push(t.promptTokens);
		const best = bestCompaction(turns);
		if (!best) continue;
		savings.push({
			label: String(s.name ?? `${String(s.cwd).split("/").at(-1)} ${String(s.id).slice(0, 8)}`).slice(0, 36),
			requests: turns.length,
			cost: Number(s.cost),
			peak: Math.max(...turns.map((t) => t.promptTokens)),
			at: best.index + 1,
			tokens: turns[best.index]!.promptTokens,
			saving: best.saving,
		});
	}
	if (sizes.length === 0) return undefined;
	sizes.sort((a, b) => a - b);
	const unused = all(
		`SELECT tool, COUNT(*) n, SUM(referenced_later = 0) unused, SUM(lifetime_cost) cost, SUM(CASE WHEN referenced_later = 0 THEN lifetime_cost ELSE 0 END) unused_cost
		FROM tool_results WHERE referenced_later IS NOT NULL AND session_id IN (${scoped}) GROUP BY tool ORDER BY unused_cost DESC`,
	);
	const out = [
		`Context per request: median ${count(percentile(sizes, 0.5))}, p90 ${count(percentile(sizes, 0.9))}, max ${count(sizes.at(-1)!)} tokens`,
	];
	if (unused.length) {
		out.push(
			`Tool results with files never referenced again (no later call on the same file, file never named again: an upper bound for unused context)\n${table(
				["tool", "results", "not referenced", "carried cost", "of which not referenced"],
				unused.slice(0, 8).map((u) => [String(u.tool), String(u.n), percent(Number(u.unused) / Number(u.n)), money(Number(u.cost)), money(Number(u.unused_cost))]),
			)}`,
		);
	}
	if (savings.length) {
		savings.sort((a, b) => b.saving - a.saving);
		const total = savings.reduce((sum, s) => sum + s.saving, 0);
		out.push(
			`Best single compaction per session (knowing the later requests; keeps ${count(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens)} + summary, quality loss not priced): ${money(total)} over ${savings.length} sessions\n${table(
				["session", "requests", "cost", "peak context", "compact after", "at context", "saving"],
				savings.slice(0, 8).map((s) => [s.label, String(s.requests), money(s.cost), count(s.peak), `#${s.at}`, count(s.tokens), money(s.saving)]),
			)}`,
		);
	}
	return out.join("\n\n");
}
