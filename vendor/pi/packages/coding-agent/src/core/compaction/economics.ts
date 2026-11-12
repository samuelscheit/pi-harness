/**
 * Whether compacting before the next run pays for itself.
 *
 * Every request pays for its whole context: tokens cached by an earlier request at the read
 * price, tokens written to the cache at the write price. Compaction trades a one-time cost (a
 * cheap model reads the context and writes a summary; the kept tokens and the summary are written
 * to the cache once) for a smaller context on every later request. When the cache has expired,
 * not compacting also costs writing the whole context again.
 */

/**
 * Requests a run is expected to be followed by before the session ends or compacts. Measured over
 * 6,320 prompts in Claude Code and Pi sessions (Oct–Nov 2026): the remainder does not depend on
 * how long the session already ran (25th percentile ~30, median ~100, at every length). The 25th
 * percentile keeps the saving an underestimate while the quality a summary loses is not priced.
 */
export const EXPECTED_REQUESTS = 30;
/** A summary is at most this long, and at most this share of what it summarizes. */
const SUMMARY_MAX_TOKENS = 3_000;
const SUMMARY_SHARE = 0.25;

/** Dollars per token. */
export interface CompactionPrices {
	/** Session model: reading cached tokens. */
	read: number;
	/** Session model: writing tokens to the cache, at the retention the session uses. */
	write: number;
	/** Summary model: input (compaction requests are not cached) and output. */
	summaryInput: number;
	summaryOutput: number;
}

export interface CompactionCase {
	/** Context tokens the next request would carry without compacting. */
	contextTokens: number;
	/** Recent tokens compaction keeps verbatim. */
	keepTokens: number;
	/** Whether the prompt cache has expired, so the context would be written again. */
	cold: boolean;
	prices: CompactionPrices;
}

/**
 * What compacting a context costs once, and the tokens it leaves to carry: the summary model reads
 * the context uncached and writes a summary; the kept tokens and the summary are written to the cache.
 */
export function compactionCost(
	contextTokens: number,
	keepTokens: number,
	prices: CompactionPrices,
): { keptTokens: number; cost: number } | undefined {
	const summarized = contextTokens - keepTokens;
	if (summarized <= 0) return undefined;
	const summary = Math.min(SUMMARY_MAX_TOKENS, summarized * SUMMARY_SHARE);
	const keptTokens = keepTokens + summary;
	return { keptTokens, cost: contextTokens * prices.summaryInput + summary * prices.summaryOutput + keptTokens * prices.write };
}

/** Dollars compacting now saves over the expected rest of the session; negative when it costs more. */
export function compactionSaving({ contextTokens, keepTokens, cold, prices }: CompactionCase): number {
	const compaction = compactionCost(contextTokens, keepTokens, prices);
	if (!compaction) return -Infinity;
	const without = (cold ? contextTokens * prices.write : 0) + EXPECTED_REQUESTS * contextTokens * prices.read;
	return without - (compaction.cost + EXPECTED_REQUESTS * compaction.keptTokens * prices.read);
}
