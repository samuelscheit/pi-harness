// Models as scripts name them: "provider/id", resolved against the agent dir's model runtime, and
// checked against what the provider serves before the first request.
//
// Pi's catalog (pi.dev, models.json) lists what a provider offers in general, not what the
// configured endpoint serves: a gateway configures model aliases of its own. A model the catalog
// knows but the endpoint does not answers each request with a 404 ("model alias … is not
// configured"), which a workflow only learned at its calls, one after the other, while the rest
// of the script went on (2026-11-14: 45 minutes until the run failed). So before a model's first
// request the provider's own model listing (`GET /v1/models` for Anthropic's and OpenAI's APIs)
// is read once per process and endpoint, and a model it does not list fails at once, naming the
// models it does. A provider without a listing, or whose listing fails, is not checked further.

import type { Api, Model } from "@earendil-works/pi-ai";
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

/** How long a provider's listing is trusted; a gateway's aliases change rarely. */
const SERVED_TTL_MS = 10 * 60_000;
/** A listing that takes longer is skipped: the request then tells. */
const LISTING_TIMEOUT_MS = 5_000;
/** Pages of a paginated listing (Anthropic's), at most. */
const MAX_PAGES = 20;

/** A script's thinking level, checked; throws naming the caller. */
export function thinkingOption(value: unknown, caller: string): Thinking {
	if (typeof value === "string" && (THINKING as readonly string[]).includes(value)) return value as Thinking;
	throw new TypeError(`${caller}: thinking must be one of ${THINKING.join(", ")}`);
}

/** "provider/a, provider/b, …" for an error. */
const listed = (provider: string, ids: Iterable<string>) => [...ids].map((id) => `${provider}/${id}`).join(", ") || "none";

/** Resolve "provider/id" in the catalog; throws when malformed, unknown (naming the provider's models) or without credentials. */
export function resolveModel(runtime: ModelRuntime, spec: string) {
	const slash = spec.indexOf("/");
	if (slash <= 0) throw new Error(`model must be "provider/id", got "${spec}"`);
	const provider = spec.slice(0, slash);
	const model = runtime.getModel(provider, spec.slice(slash + 1));
	if (!model) {
		const known = runtime.getModels(provider);
		const configured = [...new Set(runtime.getAvailableSnapshot().map((m) => m.provider))];
		throw new Error(known.length ? `unknown model ${spec}; ${provider} has ${listed(provider, known.map((m) => m.id))}` : `unknown model ${spec}: no provider ${provider} (configured: ${configured.join(", ") || "none"})`);
	}
	if (!runtime.hasConfiguredAuth(model.provider)) throw new Error(`no credentials for ${model.provider}`);
	return model;
}

/** The listing URL of a model's endpoint, for the APIs that have one. */
function listingUrl(api: string, baseUrl: string): string | undefined {
	const base = baseUrl.replace(/\/+$/, "");
	// Anthropic's SDK appends /v1 to its base URL; OpenAI's base URL includes it.
	if (api === "anthropic-messages") return `${base.endsWith("/v1") ? base : `${base}/v1`}/models`;
	if (api.startsWith("openai-")) return `${base}/models`;
	return undefined;
}

/** The ids the endpoint lists, or undefined when it cannot tell (no listing, an error, a timeout). */
async function fetchServed(runtime: ModelRuntime, model: Model<Api>, signal?: AbortSignal): Promise<Set<string> | undefined> {
	const resolved = await runtime.getAuth(model).catch(() => undefined);
	const auth = resolved?.auth;
	const url = listingUrl(model.api, auth?.baseUrl ?? model.baseUrl);
	if (!url) return undefined;
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries({ ...model.headers, ...auth?.headers })) if (value !== null && value !== undefined) headers[name] = value;
	if (auth?.apiKey) {
		if (model.api === "anthropic-messages") headers["x-api-key"] ??= auth.apiKey;
		else headers.authorization ??= `Bearer ${auth.apiKey}`;
	}
	if (model.api === "anthropic-messages") headers["anthropic-version"] ??= "2023-06-01";
	const timeout = AbortSignal.timeout(LISTING_TIMEOUT_MS);
	const ids = new Set<string>();
	try {
		let after: string | undefined;
		for (let page = 0; page < MAX_PAGES; page++) {
			const pageUrl = model.api === "anthropic-messages" ? `${url}?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}` : url;
			const response = await fetch(pageUrl, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
			if (!response.ok) return undefined;
			const body = (await response.json()) as { data?: { id?: unknown }[]; has_more?: unknown; last_id?: unknown };
			if (!Array.isArray(body.data)) return undefined;
			for (const entry of body.data) if (typeof entry?.id === "string") ids.add(entry.id);
			if (body.has_more !== true || typeof body.last_id !== "string") break;
			after = body.last_id;
		}
	} catch {
		if (signal?.aborted) throw signal.reason;
		return undefined;
	}
	return ids.size ? ids : undefined;
}

// Per runtime, per endpoint: the listing and when it was read.
const servedCache = new WeakMap<ModelRuntime, Map<string, { at: number; served: Promise<Set<string> | undefined> }>>();

/** Throws when the model's endpoint lists its models and this one is not among them; the error names those it serves. */
export async function checkServed(runtime: ModelRuntime, model: Model<Api>, signal?: AbortSignal): Promise<void> {
	const cache = servedCache.get(runtime) ?? servedCache.set(runtime, new Map()).get(runtime)!;
	const key = `${model.provider}\0${model.api}\0${model.baseUrl}`;
	let entry = cache.get(key);
	if (!entry || Date.now() - entry.at > SERVED_TTL_MS) {
		entry = { at: Date.now(), served: fetchServed(runtime, model, signal) };
		cache.set(key, entry);
		// An aborted listing says nothing about the endpoint: the next call reads it again.
		entry.served.catch(() => cache.get(key) === entry && cache.delete(key));
	}
	const served = await entry.served;
	if (served && !served.has(model.id)) throw new Error(`unknown model ${model.provider}/${model.id}: its endpoint serves ${listed(model.provider, [...served].sort())}`);
}

/** resolveModel, then checkServed: what every model a workflow names goes through before its first request. */
export async function servedModel(runtime: ModelRuntime, spec: string, signal?: AbortSignal) {
	const model = resolveModel(runtime, spec);
	await checkServed(runtime, model, signal);
	return model;
}
