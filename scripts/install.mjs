#!/usr/bin/env node
// Install the vendored Pi as the global `pi` and point its agent directory at this harness and
// the model gateway.
//
// Usage: node scripts/install.mjs   (needs ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN, the
// same gateway settings Claude Code uses)
//
// Pi: vendor/pi (a git subtree of github.com/earendil-works/pi) gets its dependencies installed in
// the working tree, and the current branch's vendor/pi is built as a deploy builds it
// (extensions/lib/pi-build.ts: from the commit, not the working tree). The global
// @earendil-works/pi-coding-agent (an npm-installed one is replaced) and `pi` link to
// <agent dir>/harness/pi, the build each deploy switches to. The harness's node_modules links to
// vendor/pi/node_modules, so its scripts, tests and type checks resolve the vendored packages.
//
// Writes into $PI_CODING_AGENT_DIR (default ~/.pi/agent):
// - harness/:      releases of this repo (extensions/lib/release.ts): Pi loads the harness from
//                  harness/current, a snapshot of the current branch's latest commit; running
//                  sessions reload into each new commit when idle (extensions/release).
// - settings.json: the current harness release and the vendored pi-lens as packages, Opus 5.5 as the startup model, and context
//                  cost control: a one-hour cache, kept warm while idle for up to CACHE_WARMING_IDLE_MINUTES, and
//                  compaction with Haiku before a run whose cache expired, when that costs less than writing the
//                  context again (`warm` compaction stays off until its effect on quality is measured).
// - models.json:   Pi's built-in `anthropic` provider routed through the gateway (Claude models,
//                  Messages API), and a `gateway` provider for every other gateway model
//                  (Responses API), with context windows from the gateway's /v1/models and
//                  mid-conversation developer messages, so prompt edits keep the prompt cache.
//                  The gateway forwards Anthropic message threads, so Claude requests send only
//                  what is new since the previous reply.
// - auth.json:     both providers' key, read from the macOS Keychain item KEYCHAIN_SERVICE, so Pi
//                  works however it is started (t3 does not load shell variables) and the token is
//                  never written to a file.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGY_PLUGINS_DIRNAME, buildAgyPlugin, installPostCommitHook, installToolSymlink, registerAgyPlugin } from "../agy/build.ts";
import { fetchGatewayListing, GATEWAY_PROVIDER, gatewayModels, readModelsJson, writeModelsJson } from "../extensions/lib/gateway.ts";
import { piLink } from "../extensions/lib/pi-build.ts";
import { currentLink, deploy, harnessDir } from "../extensions/lib/release.ts";
import { LAUNCH_AGENT, launchAgent } from "./patch-t3.ts";

const KEYCHAIN_SERVICE = "pi-harness-gateway";
const T3_APP = "/Applications/T3 Code (Nightly).app";
// Compact only when the expected saving covers what the agent re-reads afterwards (measured over
// 242 Claude Code compactions: $0.50–0.70 on average) with margin; detail lost beyond that is not priced.
const COMPACTION_MIN_SAVING = 1;
// Keep an idle session's one-hour cache warm this long. Of recorded pauses still idle at a refresh,
// 37% / 14% / 11% / 10% resumed within the next hour at 54 / 114 / 174 / 234 minutes; a refresh pays
// above ~5%. Four hours is also how long t3 keeps an idle session with pending background work.
const CACHE_WARMING_IDLE_MINUTES = 240;
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendoredPi = join(root, "vendor/pi");
const vendoredLens = join(root, "vendor/pi-lens");
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const base = process.env.ANTHROPIC_BASE_URL?.replace(/\/+$/, "");
const token = process.env.ANTHROPIC_AUTH_TOKEN;
if (!base || !token) throw new Error("set ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN (the gateway) first");
const v1 = base.endsWith("/v1") ? base : `${base}/v1`;
const origin = v1.slice(0, -"/v1".length);

// The first list; the gateway extension keeps it current from then on (extensions/gateway).
const gatewayList = gatewayModels(await fetchGatewayListing(v1, token));

const npm = (cwd, ...args) => execFileSync("npm", args, { cwd, stdio: "inherit" });
// The dependencies every Pi build links to (extensions/lib/pi-build.ts), and the model data builds copy.
npm(vendoredPi, "ci");
if (!existsSync(join(vendoredPi, "packages/ai/src/providers/data"))) npm(vendoredPi, "run", "hydrate:model-data");
// t3's Pi adapter needs fixes it has not shipped (scripts/patch-t3.ts). Every t3 update drops them, so
// a LaunchAgent applies them at login and whenever /Applications changes; loading it runs it now.
const agentPlist = join(homedir(), "Library/LaunchAgents", `${LAUNCH_AGENT}.plist`);
const patchLog = join(agentDir, "logs/patch-t3.log");
mkdirSync(dirname(patchLog), { recursive: true });
writeFileSync(agentPlist, launchAgent({ node: process.execPath, script: join(root, "scripts/patch-t3.ts"), app: T3_APP, log: patchLog }));
const domain = `gui/${process.getuid()}`;
try {
	execFileSync("launchctl", ["bootout", `${domain}/${LAUNCH_AGENT}`], { stdio: "ignore" });
} catch {
	// Not loaded yet.
}
execFileSync("launchctl", ["bootstrap", domain, agentPlist], { stdio: "inherit" });
console.log(`t3 patches kept applied by ${agentPlist} (log: ${patchLog})`);
// pi-lens: install scripts skipped (its `prepare` also rewires git hooks); build and fetch the core grammars explicitly.
npm(vendoredLens, "ci", "--ignore-scripts", "--no-audit", "--no-fund");
npm(vendoredLens, "run", "build:dist");
execFileSync("node", ["scripts/download-grammars.js", "--core", "--dest", "grammars"], { cwd: vendoredLens, stdio: "inherit" });
// The usage dashboard (`/harness dashboard`, `npm run dashboard`): its own dependencies and build.
npm(join(root, "dashboard"), "ci", "--no-audit", "--no-fund");
npm(join(root, "dashboard"), "run", "build");
const harnessModules = join(root, "node_modules");
if (!existsSync(harnessModules)) symlinkSync("vendor/pi/node_modules", harnessModules);

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
mkdirSync(agentDir, { recursive: true });

const modelsFile = join(agentDir, "models.json");
const models = readModelsJson(modelsFile);
models.providers = {
	...models.providers,
	anthropic: { baseUrl: origin, compat: { supportsMessageThreads: true } },
	// Prompt edits go out as developer messages appended to the conversation, so the cached
	// prefix stays (test/prompt-cache.test.ts); without this flag Pi folds them into the
	// instructions and the whole conversation is written again.
	[GATEWAY_PROVIDER]: { baseUrl: v1, api: "openai-responses", compat: { supportsMidConvoSystemMessages: true }, models: gatewayList },
};
writeModelsJson(modelsFile, models);

// -U replaces an existing item; the token travels as an argument only to the local `security` tool.
execFileSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", "gateway", "-w", token]);
const authFile = join(agentDir, "auth.json");
const keyFromKeychain = { type: "api_key", key: `!security find-generic-password -ws '${KEYCHAIN_SERVICE}'` };
writeJson(authFile, { ...readJson(authFile), anthropic: keyFromKeychain, gateway: keyFromKeychain });
chmodSync(authFile, 0o600);

// The first release and its Pi build: the committed state of the current branch (uncommitted edits are not deployed).
const branch = execFileSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" }).trim();
if (!branch) throw new Error(`${root} is not on a branch; check out the branch to deploy`);
const deployed = await deploy({ source: root, branch, agentDir });
if (deployed.status === "failed") throw new Error(`harness commit ${deployed.commit} does not load:\n${deployed.error}`);
if (deployed.status === "busy") throw new Error(`another Pi process is deploying ${deployed.commit}; run this again when it is done`);

/** Replace `path` with a link to `target`, atomically. */
const link = (path, target) => {
	mkdirSync(dirname(path), { recursive: true });
	rmSync(`${path}.install`, { force: true });
	symlinkSync(target, `${path}.install`);
	renameSync(`${path}.install`, path);
};
// The global Pi is whatever build <agent dir>/harness/pi points at; deploys switch that link.
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const globalPackage = join(globalRoot, PI_PACKAGE);
if (existsSync(globalPackage) && !lstatSync(globalPackage).isSymbolicLink()) npm(root, "uninstall", "-g", PI_PACKAGE);
link(globalPackage, join(piLink(harnessDir(agentDir)), "packages/coding-agent"));
link(join(execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim(), "bin", "pi"), join(globalPackage, "dist/bundle/cli.js"));

const settingsFile = join(agentDir, "settings.json");
const settings = readJson(settingsFile);
writeJson(settingsFile, {
	...settings,
	// The harness first: its lens extension points pi-lens at the layered config before pi-lens loads.
	packages: [currentLink(agentDir), vendoredLens],
	defaultProvider: "anthropic",
	defaultModel: "claude-opus-5-5",
	cacheRetention: "long",
	cacheWarmingIdleMinutes: CACHE_WARMING_IDLE_MINUTES,
	compaction: {
		...settings.compaction,
		economic: { model: "anthropic/claude-haiku-5-5", minSaving: COMPACTION_MIN_SAVING },
	},
});

// Antigravity (agy) plugin, standalone `tool` CLI, and post-commit sync hook.
const agyRoot = currentLink(agentDir);
const agyPluginsParent = join(agyRoot, AGY_PLUGINS_DIRNAME);
if (!existsSync(join(agyPluginsParent, "pi-harness", "plugin.json")) && existsSync(join(agyRoot, "agy", "hooks", "dispatch.ts"))) {
	buildAgyPlugin({ harnessRoot: agyRoot, pluginsParentDir: agyPluginsParent, runtimeRoot: agyRoot });
}
if (existsSync(join(agyPluginsParent, "pi-harness", "plugin.json"))) {
	registerAgyPlugin({ pluginsParentDir: agyPluginsParent });
	installToolSymlink(agyRoot);
	installPostCommitHook(root);
}

console.log(`${agentDir}: harness ${root} (${branch} at ${deployed.commit.slice(0, 9)}, ${currentLink(agentDir)}), gateway ${origin} (${gatewayList.length} non-Claude models), default anthropic/claude-opus-5-5`);
