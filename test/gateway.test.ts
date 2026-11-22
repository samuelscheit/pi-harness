import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { syncGateway } from "../extensions/gateway/index.ts";
import { fetchGatewayListing, gatewayModels, gatewayThinkingLevelMap, syncGatewayModels } from "../extensions/lib/gateway.ts";

const listing = [
	{
		id: "gpt-5.6",
		input_modalities: ["text", "image"] as ("text" | "image")[],
		context_window: 400_000,
		max_tokens: 128_000,
		supported_reasoning_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
	},
	{ id: "claude-opus-5-5", context_window: 1_000_000 },
	{
		id: "gemini-4-neon",
		input_modalities: ["text", "image"] as ("text" | "image")[],
		context_window: 1_000_000,
		max_tokens: 262_144,
		supported_reasoning_efforts: ["low", "medium", "high", "xhigh"],
	},
	{ id: "gpt-oss-120b" },
];

const tempModels = (config: unknown) => {
	const file = join(mkdtempSync(join(tmpdir(), "gateway-")), "models.json");
	writeFileSync(file, JSON.stringify(config));
	return file;
};

describe("gatewayModels", () => {
	test("non-Claude models only, sorted, with limits, thinkingLevelMap, and text input by default", () => {
		assert.deepEqual(gatewayModels(listing), [
			{
				id: "gemini-4-neon",
				reasoning: true,
				thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
				input: ["text", "image"],
				contextWindow: 1_000_000,
				maxTokens: 262_144,
			},
			{
				id: "gpt-5.6",
				reasoning: true,
				thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
				input: ["text", "image"],
				contextWindow: 400_000,
				maxTokens: 128_000,
			},
			{ id: "gpt-oss-120b", reasoning: true, input: ["text"] },
		]);
	});

	test("gatewayThinkingLevelMap maps none -> off and ignores unknown/empty efforts", () => {
		assert.equal(gatewayThinkingLevelMap(undefined), undefined);
		assert.equal(gatewayThinkingLevelMap([]), undefined);
		assert.equal(gatewayThinkingLevelMap(["ultra"]), undefined);
		assert.deepEqual(gatewayThinkingLevelMap(["none", "minimal", "high"]), {
			off: "none",
			minimal: "minimal",
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
	});
});

describe("syncGatewayModels", () => {
	const stale = [{ id: "gpt-5.6", reasoning: true, input: ["text", "image"], contextWindow: 400_000, maxTokens: 128_000 }, { id: "gpt-6-astra", reasoning: true, input: ["text"] }];
	const config = () => ({
		$schema: "x",
		providers: {
			anthropic: { baseUrl: "https://gw.example" },
			gateway: { baseUrl: "https://gw.example/v1", api: "openai-responses", compat: { supportsMidConvoSystemMessages: true }, models: stale },
		},
	});

	test("replaces the models, keeps the provider's settings and other providers, and names the change", () => {
		const file = tempModels(config());
		assert.deepEqual(syncGatewayModels(file, gatewayModels(listing)), { added: ["gemini-4-neon", "gpt-oss-120b"], removed: ["gpt-6-astra"] });
		const written = JSON.parse(readFileSync(file, "utf8"));
		assert.deepEqual(written, { ...config(), providers: { ...config().providers, gateway: { ...config().providers.gateway, models: gatewayModels(listing) } } });
		assert.deepEqual(readdirSync(join(file, "..")), ["models.json"], "no temp file left behind");
	});

	test("an unchanged list writes nothing", () => {
		const file = tempModels({ providers: { gateway: { baseUrl: "x", models: gatewayModels(listing) } } });
		const before = readFileSync(file, "utf8");
		assert.equal(syncGatewayModels(file, gatewayModels(listing)), undefined);
		assert.equal(readFileSync(file, "utf8"), before);
	});

	test("a changed limit is a change without added or removed ids", () => {
		const models = gatewayModels(listing);
		const file = tempModels({ providers: { gateway: { baseUrl: "x", models: models.map((m) => ({ ...m, contextWindow: 1 })) } } });
		assert.deepEqual(syncGatewayModels(file, models), { added: [], removed: [] });
	});

	test("without a gateway provider (not installed) nothing is written", () => {
		const file = tempModels({ providers: { anthropic: {} } });
		assert.equal(syncGatewayModels(file, gatewayModels(listing)), undefined);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { providers: { anthropic: {} } });
	});
});

describe("fetchGatewayListing and syncGateway against a gateway", () => {
	let server: Server;
	let v1 = "";
	let status = 200;
	let body: unknown = { data: listing };
	const seen: (string | undefined)[] = [];
	before(async () => {
		server = createServer((request, response) => {
			seen.push(request.headers.authorization);
			response.writeHead(request.url === "/v1/models" ? status : 404, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		v1 = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	});
	after(() => server.close());

	const context = (apiKey: string | undefined, refreshed: unknown[]) =>
		({
			modelRegistry: {
				getApiKeyAndHeaders: async (model: { provider: string; baseUrl: string }) => {
					assert.equal(model.provider, "gateway");
					assert.equal(model.baseUrl, v1);
					return apiKey ? { ok: true, apiKey } : { ok: false, error: 'No API key found for "gateway"' };
				},
				refresh: async (options: unknown) => void refreshed.push(options),
			},
		}) as unknown as ExtensionContext;

	test("reads the listing with the bearer token", async () => {
		seen.length = 0;
		assert.deepEqual(await fetchGatewayListing(v1, "secret"), listing);
		assert.deepEqual(seen, ["Bearer secret"]);
	});

	test("HTTP errors and bodies without a model list throw", async () => {
		status = 503;
		await assert.rejects(fetchGatewayListing(v1, "t"), /HTTP 503/);
		status = 200;
		body = { error: "nope" };
		await assert.rejects(fetchGatewayListing(v1, "t"), /no model list/);
		body = { data: [{ name: "no id" }] };
		await assert.rejects(fetchGatewayListing(v1, "t"), /no model list/);
		body = { data: listing };
	});

	test("syncGateway writes the live list with the provider's key and refreshes the registry once", async () => {
		const file = tempModels({ providers: { gateway: { baseUrl: `${v1}/`, api: "openai-responses", models: [{ id: "gpt-6-astra", reasoning: true, input: ["text"] }] } } });
		const refreshed: unknown[] = [];
		assert.equal(await syncGateway(context("k", refreshed), file), "gateway models: +gateway/gemini-4-neon +gateway/gpt-5.6 +gateway/gpt-oss-120b -gateway/gpt-6-astra");
		assert.deepEqual(refreshed, [{ allowNetwork: false }]);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).providers.gateway.models, gatewayModels(listing));
		assert.equal(await syncGateway(context("k", refreshed), file), undefined, "a second sync finds nothing to change");
		assert.equal(refreshed.length, 1);
	});

	test("syncGateway fails without a key and does nothing without a gateway provider", async () => {
		const file = tempModels({ providers: { gateway: { baseUrl: v1, models: [] } } });
		await assert.rejects(syncGateway(context(undefined, []), file), /No API key found/);
		assert.equal(await syncGateway(context("k", []), tempModels({ providers: {} })), undefined);
	});
});
