#!/usr/bin/env node
// Install the vendored Pi as the global `pi` and point its agent directory at this harness and
// the model gateway.
//
// Usage: node scripts/install.mjs   (needs ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN, the
// same gateway settings Claude Code uses)
//
// Pi: vendor/pi (a git subtree of github.com/earendil-works/pi) is built and linked globally,
// replacing an npm-installed @earendil-works/pi-coding-agent. The harness's node_modules links to
// vendor/pi/node_modules, so its scripts, tests and type checks resolve the vendored packages.
//
// Writes into $PI_CODING_AGENT_DIR (default ~/.pi/agent):
// - settings.json: this repo as the only package, Opus 5.5 as the startup model
// - models.json:   Pi's built-in `anthropic` provider routed through the gateway (Claude models,
//                  Messages API), and a `gateway` provider for every other gateway model
//                  (Responses API), with context windows from the gateway's /v1/models.
//                  The gateway forwards Anthropic message threads, so Claude requests send only
//                  what is new since the previous reply.
// - auth.json:     both providers' key, read from the macOS Keychain item KEYCHAIN_SERVICE, so Pi
//                  works however it is started (t3 does not load shell variables) and the token is
//                  never written to a file.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KEYCHAIN_SERVICE = "pi-harness-gateway";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendoredPi = join(root, "vendor/pi");
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

const npm = (cwd, ...args) => execFileSync("npm", args, { cwd, stdio: "inherit" });
npm(vendoredPi, "ci");
npm(vendoredPi, "run", "build");
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
if (existsSync(join(globalRoot, PI_PACKAGE)) && !lstatSync(join(globalRoot, PI_PACKAGE)).isSymbolicLink()) {
	npm(root, "uninstall", "-g", PI_PACKAGE);
}
npm(join(vendoredPi, "packages/coding-agent"), "link");
const harnessModules = join(root, "node_modules");
if (!existsSync(harnessModules)) symlinkSync("vendor/pi/node_modules", harnessModules);

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
mkdirSync(agentDir, { recursive: true });

const modelsFile = join(agentDir, "models.json");
const models = readJson(modelsFile);
models.providers = {
	...models.providers,
	anthropic: { baseUrl: origin, compat: { supportsMessageThreads: true } },
	gateway: { baseUrl: v1, api: "openai-responses", models: gatewayModels },
};
writeJson(modelsFile, models);

// -U replaces an existing item; the token travels as an argument only to the local `security` tool.
execFileSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", "gateway", "-w", token]);
const authFile = join(agentDir, "auth.json");
const keyFromKeychain = { type: "api_key", key: `!security find-generic-password -ws '${KEYCHAIN_SERVICE}'` };
writeJson(authFile, { ...readJson(authFile), anthropic: keyFromKeychain, gateway: keyFromKeychain });
chmodSync(authFile, 0o600);

const settingsFile = join(agentDir, "settings.json");
const settings = readJson(settingsFile);
writeJson(settingsFile, {
	...settings,
	packages: [root],
	defaultProvider: "anthropic",
	defaultModel: "claude-opus-5-5",
});

console.log(`${agentDir}: harness ${root}, gateway ${origin} (${gatewayModels.length} non-Claude models), default anthropic/claude-opus-5-5`);
