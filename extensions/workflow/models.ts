// Models as scripts name them: "provider/id", resolved against the agent dir's model runtime.

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Prompt cache retention of every workflow request (llm() and agent() children). Their requests come
 * seconds apart, so the 5-minute cache (write 1.25x input) always suffices; the 1-hour one costs 2x.
 * Set explicitly: unset, Pi falls back to PI_CACHE_RETENTION, so the cost would depend on how Pi
 * was started.
 */
export const CACHE_RETENTION = "short";

export const THINKING = ["off", "minimal", "low", "medium", "high"] as const;
export type Thinking = (typeof THINKING)[number];

/** A script's thinking level, checked; throws naming the caller. */
export function thinkingOption(value: unknown, caller: string): Thinking {
	if (typeof value === "string" && (THINKING as readonly string[]).includes(value)) return value as Thinking;
	throw new TypeError(`${caller}: thinking must be one of ${THINKING.join(", ")}`);
}

/** Resolve "provider/id"; throws when malformed, unknown or without credentials. */
export function resolveModel(runtime: ModelRuntime, spec: string) {
	const slash = spec.indexOf("/");
	if (slash <= 0) throw new Error(`model must be "provider/id", got "${spec}"`);
	const model = runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1));
	if (!model) throw new Error(`unknown model ${spec}`);
	if (!runtime.hasConfiguredAuth(model.provider)) throw new Error(`no credentials for ${model.provider}`);
	return model;
}
