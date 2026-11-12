// Attribute one request's cost to what its prompt contained, and explain cache rebuilds.
//
// Ported from the gateway's usage_insights/attribution.py. Prompt caching is a prefix: the first
// `cacheRead` tokens are billed at the read rate, the next `cacheWrite` tokens at the write rate
// and the rest as plain input. Walking the prompt's blocks in the order the provider reads them
// tells which content was paid at which rate. Estimated block sizes are scaled to the provider's
// real count, and the rates come from the cost Pi recorded for the request.

import type { Prompt } from "./blocks.ts";

// A rebuild: the request read at least this many fewer tokens from cache than the previous
// request left there. Normal requests read all of it, give or take a cache block.
export const REBUILD_MIN_LOST_TOKENS = 2_000;
// Typical cache prices relative to input, for a rate the request itself does not reveal.
const READ_TO_INPUT = 0.1;
const WRITE_TO_INPUT = 1.25;

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** Dollars per token. */
export interface Rates {
	input: number;
	read: number;
	write: number;
}

export interface CategoryCost {
	blocks: number;
	tokens: number;
	newTokens: number;
	read: number;
	write: number;
	uncached: number;
}

export interface Attribution {
	promptTokens: number;
	composition: Map<string, CategoryCost>;
	/** Tokens and cost of each tool result in the prompt. */
	results: Map<string, { tokens: number; cost: number }>;
	/** The largest new tool result, else the last new block: what this request answered. */
	trigger?: string;
	triggerTokens: number;
	rates: Rates;
}

/** Per-token rates paid in this request; a rate it does not reveal comes from `fallback`. */
export function ratesOf(usage: Usage, fallback?: Rates): Rates {
	const observed = (cost: number, tokens: number) => (tokens > 0 ? cost / tokens : undefined);
	const input = observed(usage.cost.input, usage.input) ?? fallback?.input ?? 0;
	return {
		input,
		read: observed(usage.cost.cacheRead, usage.cacheRead) ?? fallback?.read ?? input * READ_TO_INPUT,
		write: observed(usage.cost.cacheWrite, usage.cacheWrite) ?? fallback?.write ?? input * WRITE_TO_INPUT,
	};
}

export function attribute(prompt: Prompt, usage: Usage, fallback?: Rates): Attribution {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	const estimated = prompt.blocks.reduce((sum, b) => sum + b.tokens, 0) || 1;
	const scale = promptTokens / estimated;
	const rates = ratesOf(usage, fallback);
	const readEnd = usage.cacheRead;
	const writeEnd = readEnd + usage.cacheWrite;
	const composition = new Map<string, CategoryCost>();
	const results = new Map<string, { tokens: number; cost: number }>();
	let position = 0;
	let newTokens = 0;
	for (const block of prompt.blocks) {
		const tokens = block.tokens * scale;
		const start = position;
		const end = start + tokens;
		position = end;
		const read = Math.max(0, Math.min(end, readEnd) - start) * rates.read;
		const write = Math.max(0, Math.min(end, writeEnd) - Math.max(start, readEnd)) * rates.write;
		const uncached = Math.max(0, end - Math.max(start, writeEnd)) * rates.input;
		const entry = composition.get(block.category) ?? { blocks: 0, tokens: 0, newTokens: 0, read: 0, write: 0, uncached: 0 };
		entry.blocks += 1;
		entry.tokens += tokens;
		entry.read += read;
		entry.write += write;
		entry.uncached += uncached;
		if (block.isNew) {
			entry.newTokens += tokens;
			newTokens += tokens;
		}
		composition.set(block.category, entry);
		if (block.toolCallId !== undefined) results.set(block.toolCallId, { tokens, cost: read + write + uncached });
	}
	composition.set("model output", { blocks: 0, tokens: usage.output, newTokens: 0, read: 0, write: 0, uncached: usage.cost.output });

	const fresh = prompt.blocks.filter((b) => b.isNew);
	const freshResults = fresh.filter((b) => b.toolCallId !== undefined);
	const trigger = freshResults.length > 0 ? freshResults.reduce((a, b) => (b.tokens > a.tokens ? b : a)).category : fresh.at(-1)?.category;
	return { promptTokens, composition, results, trigger, triggerTokens: Math.round(newTokens), rates };
}

/** What a later request needs from its predecessor to explain a cache rebuild. */
export interface RequestState {
	ts: number;
	promptTokens: number;
	digests: string[];
	categories: string[];
	sectionEnds: [number, number];
	messageCount: number;
	/** Categories of the blocks new in this request. */
	newCategories: string[];
	model: string;
	thinking?: string;
	/** Whether this request wrote its cache with one-hour retention. */
	longRetention: boolean;
	rates: Rates;
}

export function requestState(prompt: Prompt, attribution: Attribution, usage: Usage, ts: number, model: string, thinking?: string): RequestState {
	return {
		ts,
		promptTokens: attribution.promptTokens,
		digests: prompt.blocks.map((b) => b.digest),
		categories: prompt.blocks.map((b) => b.category),
		sectionEnds: prompt.sectionEnds,
		messageCount: prompt.messageCount,
		newCategories: [...new Set(prompt.blocks.filter((b) => b.isNew).map((b) => b.category))],
		model,
		thinking,
		longRetention: (usage.cacheWrite1h ?? 0) > 0,
		rates: attribution.rates,
	};
}

export interface CacheEvent {
	cause: string;
	avoidable: boolean;
	/** Previously cached tokens this request did not read. */
	lostTokens: number;
	/** Dollars paid above the read rate for the part of the prompt that could have been read. */
	waste: number;
}

function rebuildCause(previous: RequestState, current: RequestState): [string, boolean] {
	const ttl = previous.longRetention ? 3600 : 300;
	if ((current.ts - previous.ts) / 1000 > ttl) return [`cache expired after idle (${ttl === 3600 ? "1 h" : "5 min"} TTL)`, true];
	if (previous.model !== current.model) return ["model switched", true];
	if (previous.thinking !== current.thinking) return ["thinking level changed", true];
	if (previous.messageCount && current.messageCount < previous.messageCount * 0.6) return ["compaction", false];
	const diverged = previous.digests.findIndex((digest, i) => i < current.digests.length && digest !== current.digests[i]);
	if (diverged < 0) {
		return current.newCategories.includes("system update")
			? ["prompt or tools updated mid-conversation", true]
			: ["cache missed without a prompt change", true];
	}
	if (diverged < previous.sectionEnds[0]) return ["tool definitions changed", true];
	if (diverged < previous.sectionEnds[1]) return ["system prompt changed", true];
	return [`earlier ${previous.categories[diverged]} changed`, true];
}

/** A cache rebuild in `current`, with its cause, or undefined when the cache held. */
export function cacheEvent(previous: RequestState | undefined, current: RequestState, usage: Usage): CacheEvent | undefined {
	if (!previous) return undefined;
	const lostTokens = Math.min(previous.promptTokens, current.promptTokens) - usage.cacheRead;
	if (lostTokens < REBUILD_MIN_LOST_TOKENS) return undefined;
	const [cause, avoidable] = rebuildCause(previous, current);
	if (!avoidable) return { cause, avoidable, lostTokens, waste: 0 };
	const paidRate = usage.cacheWrite > 0 ? current.rates.write : current.rates.input;
	return { cause, avoidable, lostTokens, waste: lostTokens * Math.max(0, paidRate - current.rates.read) };
}
