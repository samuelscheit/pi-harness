/**
 * What a session needs to share prompt cache state and compactions with the sessions it forks or
 * was forked from: the prefix cache registry (prefix-cache.ts) and the fork base store (fork-base.ts),
 * both under the agent directory.
 */
import { join } from "node:path";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Api,
	getCacheWarmingRequestOptions,
	isCacheWarmingReplayable,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import type { SharedPrefixCheck } from "./cache-warmer.ts";
import { type ForkBaseKey, ForkBaseStore, forkBaseKey } from "./fork-base.ts";
import { describeBranchPrefix, PrefixCacheRegistry, type PrefixRequest } from "./prefix-cache.ts";
import type { CompactionEntry, SessionEntry, SessionProjection } from "./session-manager.ts";

type Projection = Pick<SessionProjection, "entries" | "messages">;

export class SharedPrefixCache {
	readonly registry: PrefixCacheRegistry;
	readonly bases: ForkBaseStore;

	constructor(registry: PrefixCacheRegistry, bases: ForkBaseStore) {
		this.registry = registry;
		this.bases = bases;
	}

	/** The registry in `<agentDir>/prefix-cache`, the bases in `<agentDir>/fork-bases`. */
	static forAgentDir(agentDir: string): SharedPrefixCache {
		return new SharedPrefixCache(
			new PrefixCacheRegistry(join(agentDir, "prefix-cache")),
			new ForkBaseStore(join(agentDir, "fork-bases")),
		);
	}

	/** A request of `model` sending `projection`, with the cache lifetime its retention gives. */
	request(model: Model<Api>, ttlMs: number, projection: Projection): PrefixRequest {
		return {
			model: { provider: model.provider, id: model.id },
			bridge: model.api === "anthropic-messages",
			ttlMs,
			prefix: describeBranchPrefix(projection),
		};
	}

	check(request: PrefixRequest): SharedPrefixCheck {
		return { registry: this.registry, model: request.model, bridge: request.bridge, prefix: request.prefix };
	}

	/** Where the base of the branch `request` sends is stored, for a compaction by `summaryModel` with `settings`. */
	baseKey(
		request: PrefixRequest,
		summaryModel: Pick<Model<Api>, "provider" | "id">,
		settings: object,
	): { key: string; parts: ForkBaseKey } | undefined {
		const point = request.prefix.points.at(-1);
		if (!point) return undefined;
		const parts: ForkBaseKey = {
			provider: request.model.provider,
			model: request.model.id,
			promptHash: request.prefix.promptHash,
			point: point.key,
			entryId: point.entryId,
			settings: { summaryModel: `${summaryModel.provider}/${summaryModel.id}`, ...settings },
		};
		return { key: forkBaseKey(parts), parts };
	}
}

/** The branch entries a compaction keeps: from its first kept entry up to its parent. */
export function keptEntries(branch: SessionEntry[], compaction: CompactionEntry): SessionEntry[] {
	const end = branch.findIndex((entry) => entry.id === compaction.id);
	const start = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	return start >= 0 && end >= 0 && start < end ? branch.slice(start, end) : [];
}

/**
 * The part of a context a cache prime sends: everything before its final assistant reply, so every
 * fork's first request (the context, then a prompt) reaches the primed entry through the lookback
 * or Pi's bridge breakpoint. A context that does not end in a reply is sent whole.
 */
export function primeProjection(projection: Projection): Projection {
	const last = projection.entries.findLastIndex((entry) => entry.messages.length > 0);
	const endsInReply = last >= 0 && projection.entries[last]!.messages.some((message) => message.role === "assistant");
	const entries = endsInReply ? projection.entries.slice(0, last) : projection.entries;
	return { entries, messages: entries.flatMap((entry) => entry.messages) };
}

/**
 * Write the cache entry of `messages` for `model` with the session's request options and a
 * one-token output cap, like a cache warm. Undefined when the request cannot be replayed safely
 * (budget-based thinking keys the cache on max_tokens) or failed.
 */
export async function sendCachePrime(
	agent: Agent,
	model: Model<Api>,
	messages: AgentMessage[],
	options: SimpleStreamOptions,
	signal?: AbortSignal,
): Promise<{ usage: Usage; provider: string; model: string } | undefined> {
	const request: SimpleStreamOptions = {
		...options,
		reasoning: agent.state.thinkingLevel === "off" ? undefined : agent.state.thinkingLevel,
		thinkingBudgets: agent.thinkingBudgets,
		transport: agent.transport,
		maxRetryDelayMs: agent.maxRetryDelayMs,
		onPayload: agent.onPayload,
		apiKey: options.apiKey ?? (await agent.getApiKey?.(model.provider)),
	};
	if (!isCacheWarmingReplayable(model, request)) return undefined;
	const transformed = agent.transformContext ? await agent.transformContext(messages, signal) : messages;
	const context = normalizeContext({ messages: await agent.convertToLlm(transformed) });
	const controller = new AbortController();
	signal?.addEventListener("abort", () => controller.abort(), { once: true });
	// No session id: the prime must not replace the session's own warming or provider thread.
	const stream = await agent.streamFunction(model, context, getCacheWarmingRequestOptions(request, controller.signal));
	const message = await stream.result();
	if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
	return { usage: message.usage, provider: message.provider, model: message.responseModel ?? message.model };
}

/** What `sendAside` returns: the answer's text (tool calls ignored) and what the request cost. */
export interface AsideResult {
	text: string;
	usage: Usage;
	provider: string;
	model: string;
}

/**
 * Ask `question` on `messages` as the session's next request would send them (same system prompt,
 * tools, model, thinking level and cache retention), so it reads the session's prompt cache, and
 * return the answer without adding either to the session. No session id: the request must not
 * replace the session's own cache warming or provider thread. Undefined when the request failed.
 */
export async function sendAside(
	agent: Agent,
	model: Model<Api>,
	messages: AgentMessage[],
	question: string,
	options: SimpleStreamOptions,
	signal?: AbortSignal,
): Promise<AsideResult | undefined> {
	const request: SimpleStreamOptions = {
		...options,
		reasoning: agent.state.thinkingLevel === "off" ? undefined : agent.state.thinkingLevel,
		thinkingBudgets: agent.thinkingBudgets,
		transport: agent.transport,
		maxRetryDelayMs: agent.maxRetryDelayMs,
		onPayload: agent.onPayload,
		apiKey: options.apiKey ?? (await agent.getApiKey?.(model.provider)),
		...(signal ? { signal } : {}),
	};
	const asked: AgentMessage[] = [...messages, { role: "user", content: [{ type: "text", text: question }], timestamp: Date.now() }];
	const transformed = agent.transformContext ? await agent.transformContext(asked, signal) : asked;
	const context = normalizeContext({ messages: await agent.convertToLlm(transformed) });
	const stream = await agent.streamFunction(model, context, request);
	const message = await stream.result();
	if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
	const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	return { text, usage: message.usage, provider: message.provider, model: message.responseModel ?? message.model };
}
