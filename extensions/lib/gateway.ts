// The model gateway's non-Claude models as Pi's `gateway` provider in models.json.
//
// The gateway adds and retires model aliases on its own schedule (2026-11-21: `gemini-4-neon` was
// served but missing in Pi, while `gpt-6-astra` was listed but retired), so a list written once by
// the installer goes stale. The installer writes the first list; the gateway extension rewrites it
// from the live listing at session start. Claude models stay with Pi's built-in `anthropic`
// provider, which the installer routes to the gateway.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** The provider id under which the gateway's non-Claude models appear (`gateway/<id>`). */
export const GATEWAY_PROVIDER = "gateway";

/** One entry of the gateway's `GET /v1/models` listing, as far as Pi needs it. */
export interface GatewayListing {
	id: string;
	input_modalities?: ("text" | "image")[];
	context_window?: number;
	max_tokens?: number;
}

/** A model entry of models.json. */
export interface GatewayModel {
	id: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
}

/** The models.json entries of the listing's non-Claude models, sorted by id. */
export function gatewayModels(listing: readonly GatewayListing[]): GatewayModel[] {
	return listing
		.filter((m) => !m.id.startsWith("claude-"))
		.map((m) => ({
			id: m.id,
			reasoning: true,
			input: m.input_modalities ?? ["text"],
			...(m.context_window ? { contextWindow: m.context_window } : {}),
			...(m.max_tokens ? { maxTokens: m.max_tokens } : {}),
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/** The gateway's listing; `v1` is its base URL ending in /v1. Throws on HTTP errors and malformed bodies. */
export async function fetchGatewayListing(v1: string, token: string, signal?: AbortSignal): Promise<GatewayListing[]> {
	const response = await fetch(`${v1}/models`, { headers: { Authorization: `Bearer ${token}` }, signal });
	if (!response.ok) throw new Error(`gateway ${v1}/models: HTTP ${response.status}`);
	const { data } = (await response.json()) as { data?: unknown };
	if (!Array.isArray(data) || !data.every((m) => typeof m?.id === "string")) throw new Error(`gateway ${v1}/models: no model list`);
	return data as GatewayListing[];
}

type ModelsJson = { providers?: Record<string, { models?: GatewayModel[] } & Record<string, unknown>> } & Record<string, unknown>;

export const readModelsJson = (file: string): ModelsJson => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});

/** Write models.json whole, atomically: Pi processes read it at any time, and several sessions may sync at once. */
export function writeModelsJson(file: string, value: ModelsJson): void {
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, "\t")}\n`);
	renameSync(temp, file);
}

/** What a sync changed: the ids added and removed. */
export interface GatewaySync {
	added: string[];
	removed: string[];
}

/**
 * Replace the gateway provider's models in models.json with `models`, keeping its other settings and
 * every other provider. Returns undefined when nothing changed (the file is then not written), and
 * when models.json has no gateway provider (the installer has not set it up).
 */
export function syncGatewayModels(file: string, models: GatewayModel[]): GatewaySync | undefined {
	const config = readModelsJson(file);
	const provider = config.providers?.[GATEWAY_PROVIDER];
	if (!provider) return undefined;
	const before = provider.models ?? [];
	if (JSON.stringify(before) === JSON.stringify(models)) return undefined;
	const had = new Set(before.map((m) => m.id));
	const has = new Set(models.map((m) => m.id));
	writeModelsJson(file, { ...config, providers: { ...config.providers, [GATEWAY_PROVIDER]: { ...provider, models } } });
	return { added: [...has].filter((id) => !had.has(id)), removed: [...had].filter((id) => !has.has(id)) };
}
