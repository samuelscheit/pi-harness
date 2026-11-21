// Gateway: keep the `gateway` provider's models in models.json equal to what the gateway serves.
//
// The installer writes the gateway's non-Claude models once; the gateway adds and retires aliases
// later (extensions/lib/gateway.ts). At session start this extension reads the live listing with the
// provider's own credentials (auth.json), rewrites models.json when the list differs, and refreshes
// the session's model registry, so a new model can be selected at once and a retired one is gone.
// It runs in the background and at most once per SYNC_INTERVAL_MS per process; a failure (offline,
// gateway down) leaves models.json as it is and is reported as a warning only when there is a UI.

import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { fetchGatewayListing, GATEWAY_PROVIDER, gatewayModels, readModelsJson, syncGatewayModels } from "../lib/gateway.ts";

const SYNC_INTERVAL_MS = 10 * 60_000;
const LISTING_TIMEOUT_MS = 10_000;

let lastSync = 0;

/** The gateway's API key as Pi resolves it for the provider (auth.json, models.json, environment). */
async function gatewayKey(ctx: ExtensionContext, baseUrl: string): Promise<string> {
	// Auth resolves per provider; the model only carries the provider id and endpoint.
	const probe = { id: "", name: "", provider: GATEWAY_PROVIDER, api: "openai-responses", baseUrl } as unknown as Model<Api>;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(probe);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`no API key for ${GATEWAY_PROVIDER}`);
	return auth.apiKey;
}

/** Sync models.json with the gateway; returns a line describing the change, or undefined when none. */
export async function syncGateway(ctx: ExtensionContext, modelsFile = join(getAgentDir(), "models.json")): Promise<string | undefined> {
	const configured = readModelsJson(modelsFile).providers?.[GATEWAY_PROVIDER]?.baseUrl;
	if (typeof configured !== "string") return undefined;
	const v1 = configured.replace(/\/+$/, "");
	const listing = await fetchGatewayListing(v1, await gatewayKey(ctx, v1), AbortSignal.timeout(LISTING_TIMEOUT_MS));
	const change = syncGatewayModels(modelsFile, gatewayModels(listing));
	if (!change) return undefined;
	await ctx.modelRegistry.refresh({ allowNetwork: false });
	const list = (sign: string, ids: string[]) => ids.map((id) => `${sign}${GATEWAY_PROVIDER}/${id}`);
	return `gateway models: ${[...list("+", change.added), ...list("-", change.removed)].join(" ") || "limits changed"}`;
}

export default function gateway(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (Date.now() - lastSync < SYNC_INTERVAL_MS) return;
		lastSync = Date.now();
		void syncGateway(ctx).then(
			(line) => line && ctx.hasUI && ctx.ui.notify(line, "info"),
			(error: unknown) => {
				// The next session start tries again.
				lastSync = 0;
				if (ctx.hasUI) ctx.ui.notify(`gateway model sync failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			},
		);
	});
}
