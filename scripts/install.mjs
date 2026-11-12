#!/usr/bin/env node
// Point a Pi agent directory at this harness and the model gateway.
//
// Usage: node scripts/install.mjs   (needs ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN, the
// same gateway settings Claude Code uses)
//
// Writes into $PI_CODING_AGENT_DIR (default ~/.pi/agent):
// - settings.json: this repo as the only package, Opus 5.5 as the startup model
// - models.json:   Pi's built-in `anthropic` provider routed through the gateway (Claude models,
//                  Messages API), and a `gateway` provider for every other gateway model
//                  (Responses API), with context windows from the gateway's /v1/models.
// The gateway key is never written: both providers read $ANTHROPIC_AUTH_TOKEN at request time.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const base = process.env.ANTHROPIC_BASE_URL?.replace(/\/+$/, "");
const token = process.env.ANTHROPIC_AUTH_TOKEN;
if (!base || !token) throw new Error("set ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN (the gateway) first");
const v1 = base.endsWith("/v1") ? base : `${base}/v1`;
const origin = v1.slice(0, -"/v1".length);

const response = await fetch(`${v1}/models`, { headers: { Authorization: `Bearer ${token}` } });
if (!response.ok) throw new Error(`gateway /v1/models: HTTP ${response.status}`);
const { data } = await response.json();

const gatewayModels = data
	.filter((m) => !m.id.startsWith("claude-"))
	.map((m) => ({
		id: m.id,
		reasoning: true,
		input: m.input_modalities ?? ["text"],
		...(m.context_window ? { contextWindow: m.context_window } : {}),
		...(m.max_tokens ? { maxTokens: m.max_tokens } : {}),
	}));

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
mkdirSync(agentDir, { recursive: true });

const modelsFile = join(agentDir, "models.json");
const models = readJson(modelsFile);
models.providers = {
	...models.providers,
	anthropic: { baseUrl: origin, apiKey: "$ANTHROPIC_AUTH_TOKEN" },
	gateway: { baseUrl: v1, api: "openai-responses", apiKey: "$ANTHROPIC_AUTH_TOKEN", models: gatewayModels },
};
writeJson(modelsFile, models);

const settingsFile = join(agentDir, "settings.json");
const settings = readJson(settingsFile);
writeJson(settingsFile, {
	...settings,
	packages: [root],
	defaultProvider: "anthropic",
	defaultModel: "claude-opus-5-5",
});

console.log(`${agentDir}: harness ${root}, gateway ${origin} (${gatewayModels.length} non-Claude models), default anthropic/claude-opus-5-5`);
