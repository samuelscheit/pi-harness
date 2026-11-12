/**
 * Whether compacting before the next run pays for itself.
 *
 * Every request pays for its whole context: tokens cached by an earlier request at the read
 * price, tokens written to the cache at the write price. Compaction trades a one-time cost (a
 * cheap model reads the context and writes a summary; the kept tokens and the summary are written
 * to the cache once) for a smaller context on every later request. When the cache has expired,
 * not compacting also costs writing the whole context again.
 */

/** Requests a session is expected to make after this one, as a share of the requests it made so far. */
const EXPECTED_REQUESTS_PER_PAST_REQUEST = 0.5;
const MIN_EXPECTED_REQUESTS = 10;
const MAX_EXPECTED_REQUESTS = 60;
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
	/** Assistant requests the session made so far. */
	pastRequests: number;
	prices: CompactionPrices;
}

/** How many more requests to expect: half the past ones, within bounds (see the metrics for the measured spread). */
export function expectedRequests(pastRequests: number): number {
	return Math.min(MAX_EXPECTED_REQUESTS, Math.max(MIN_EXPECTED_REQUESTS, Math.round(pastRequests * EXPECTED_REQUESTS_PER_PAST_REQUEST)));
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
export function compactionSaving({ contextTokens, keepTokens, cold, pastRequests, prices }: CompactionCase): number {
	const compaction = compactionCost(contextTokens, keepTokens, prices);
	if (!compaction) return -Infinity;
	const requests = expectedRequests(pastRequests);
	const without = (cold ? contextTokens * prices.write : 0) + requests * contextTokens * prices.read;
	return without - (compaction.cost + requests * compaction.keptTokens * prices.read);
}
