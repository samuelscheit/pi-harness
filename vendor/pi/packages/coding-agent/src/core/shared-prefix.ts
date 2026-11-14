/**
 * What a session needs to share prompt cache state with the sessions it forks or was forked from:
 * the prefix cache registry (prefix-cache.ts) under the agent directory.
 */
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SharedPrefixCheck } from "./cache-warmer.ts";
import { describeBranchPrefix, PrefixCacheRegistry, type PrefixRequest } from "./prefix-cache.ts";
import type { SessionProjection } from "./session-manager.ts";

type Projection = Pick<SessionProjection, "entries" | "messages">;

export class SharedPrefixCache {
	readonly registry: PrefixCacheRegistry;

	constructor(registry: PrefixCacheRegistry) {
		this.registry = registry;
	}

	/** The registry in `<agentDir>/prefix-cache`. */
	static forAgentDir(agentDir: string): SharedPrefixCache {
		return new SharedPrefixCache(new PrefixCacheRegistry(join(agentDir, "prefix-cache")));
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
}
