// Token efficiency of how work is split and how much context is carried.
//
// Every request pays for its whole context: cached tokens at the read rate, new ones at the write
// rate. So two decisions dominate cost beyond the work itself:
//
// - Subagents. A new subagent writes its base prompt and tools once and re-reads whatever its
//   parent already knew (rediscovery). Resuming an earlier subagent instead carries that agent's
//   whole context in every request, and rewrites it once if its cache expired. `resumeCost`
//   prices the alternative (applied per delegation in queries/subagents.ts).
// - Context size. Carried tokens cost the read rate on every later request. `bestCompaction` is an
//   upper bound for what one well-timed compaction would have saved (quality loss not included;
//   applied per session in queries/compaction.ts).

import { compactionCost, DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";

// The harness summarizes with Haiku, a fifth of Opus's price; output costs five times input.
const SUMMARY_PRICE_SHARE = 0.2;
const OUTPUT_TO_INPUT = 5;
const SHORT_CACHE_MS = 5 * 60_000;
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
