// Builds, validates, and registers the native Antigravity (`agy`) plugin generated from pi-harness.
//
// Layout written under `<pluginsParentDir>/pi-harness/`:
//   plugin.json        manifest
//   rules/AGENTS.md    compiled prompt/AGENTS.md + prompt/rules/*.md (under agy's 24 KB limit)
//   hooks.json         PreToolUse, PostToolUse, SessionStart, PreInvocation, Stop -> agy/hooks/dispatch.ts
//   mcp_config.json    pi-harness MCP server + vendor/pi-lens MCP server (with layered config)

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HARNESS_ROOT } from "../extensions/lib/repository.ts";
import { type CompiledRules, compileAgyRules } from "./rules.ts";

export const AGY_PLUGINS_DIRNAME = "agy-plugins";
export const AGY_PLUGIN_NAME = "pi-harness";

export interface BuildAgyPluginOptions {
	/** Harness directory to read prompts/rules from (a release dir or the source checkout). */
	harnessRoot?: string;
	/** Parent `agy-plugins/` directory where `pi-harness/` will be written. */
	pluginsParentDir?: string;
	/** Stable root path referenced inside hooks.json and mcp_config.json (e.g. ~/.pi/agent/harness/current). */
	runtimeRoot?: string;
	/** Absolute path to the Node.js binary to run hooks and MCP servers (default process.execPath). */
	nodePath?: string;
}

export interface BuildAgyPluginResult {
	pluginsParentDir: string;
	pluginDir: string;
	rules: CompiledRules;
}

const shellQuote = (value: string) => (/^[a-zA-Z0-9._/@:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`);

/** Generate `<pluginsParentDir>/pi-harness/` cleanly from `harnessRoot`. */
export function buildAgyPlugin(options: BuildAgyPluginOptions = {}): BuildAgyPluginResult {
	const harnessRoot = resolve(options.harnessRoot ?? HARNESS_ROOT);
	const pluginsParentDir = resolve(options.pluginsParentDir ?? join(harnessRoot, AGY_PLUGINS_DIRNAME));
	const runtimeRoot = resolve(options.runtimeRoot ?? harnessRoot);
	const nodePath = options.nodePath ?? process.execPath;

	const pluginDir = join(pluginsParentDir, AGY_PLUGIN_NAME);
	const rulesDir = join(pluginDir, "rules");
	mkdirSync(rulesDir, { recursive: true });

	// 1. plugin.json (keep strictly to fields recognized by `agy plugin validate --strict`).
	const manifest = {
		name: AGY_PLUGIN_NAME,
		version: "1.0.0",
		repository: "https://github.com/samuelscheit/pi-harness",
	};
	writeFileSync(join(pluginDir, "plugin.json"), `${JSON.stringify(manifest, null, "\t")}\n`);

	// 2. rules/AGENTS.md
	const rules = compileAgyRules(harnessRoot);
	writeFileSync(join(rulesDir, "AGENTS.md"), rules.content);

	// 3. hooks.json (MUST sit directly at plugin root for native plugins).
	const dispatchScript = join(runtimeRoot, "agy", "hooks", "dispatch.ts");
	const hookCmd = (event: string) => `${shellQuote(nodePath)} ${shellQuote(dispatchScript)} --event ${event}`;
	const hooks = {
		[AGY_PLUGIN_NAME]: {
			SessionStart: [{ type: "command", command: hookCmd("SessionStart"), timeout: 15 }],
			PreToolUse: [
				{
					matcher: "run_command|replace_file_content|multi_replace_file_content|write_to_file|call_mcp_tool|.*t3_thread_wait.*",
					hooks: [{ type: "command", command: hookCmd("PreToolUse"), timeout: 15 }],
				},
			],
			PostToolUse: [
				{
					matcher: "*",
					hooks: [{ type: "command", command: hookCmd("PostToolUse"), timeout: 15 }],
				},
			],
			PreInvocation: [{ type: "command", command: hookCmd("PreInvocation"), timeout: 15 }],
			Stop: [{ type: "command", command: hookCmd("Stop"), timeout: 15 }],
		},
	};
	writeFileSync(join(pluginDir, "hooks.json"), `${JSON.stringify(hooks, null, "\t")}\n`);

	// 4. mcp_config.json (pi-harness MCP server + vendor/pi-lens MCP server with layered config).
	const mcpConfig = {
		mcpServers: {
			"pi-harness": {
				command: nodePath,
				args: [join(runtimeRoot, "agy", "mcp", "server.ts")],
			},
			"pi-lens": {
				command: nodePath,
				args: [join(runtimeRoot, "agy", "mcp", "lens-server.ts")],
			},
		},
	};
	writeFileSync(join(pluginDir, "mcp_config.json"), `${JSON.stringify(mcpConfig, null, "\t")}\n`);

	// Ensure CLI scripts are executable when present in harnessRoot.
	for (const rel of ["agy/hooks/dispatch.ts", "agy/mcp/server.ts", "agy/mcp/lens-server.ts", "agy/bin/tool.ts"]) {
		const target = join(harnessRoot, rel);
		if (existsSync(target)) {
			try {
				chmodSync(target, 0o755);
			} catch {
				// Read-only release or symlink: ignore.
			}
		}
	}

	return { pluginsParentDir, pluginDir, rules };
}

export interface ValidationResult {
	status: "ok" | "skipped" | "failed";
	output: string;
}

/** Run `agy plugin validate --strict <pluginDir>` if `agy` is installed. */
export function validateAgyPlugin(pluginDir: string, agyBin = "agy"): ValidationResult {
	try {
		const output = execFileSync(agyBin, ["plugin", "validate", "--strict", pluginDir], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
		});
		return { status: "ok", output: output.trim() };
	} catch (error) {
		const e = error as { code?: string; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
		if (e.code === "ENOENT") return { status: "skipped", output: `${agyBin} not found on PATH` };
		const combined = [e.stdout?.toString(), e.stderr?.toString(), e.message].filter(Boolean).join("\n").trim();
		return { status: "failed", output: combined };
	}
}

interface PluginsJsonEntry {
	path: string;
	include_only?: string[];
	exclude?: string[];
}

interface PluginsJson {
	inherits?: PluginsJsonEntry[];
	entries?: PluginsJsonEntry[];
	[key: string]: unknown;
}

/** Merge `pluginsParentDir` idempotently into a single `plugins.json` file. */
export function upsertPluginsJson(file: string, pluginsParentDir: string): boolean {
	const resolvedTarget = resolve(pluginsParentDir);
	let existing: PluginsJson = {};
	if (existsSync(file)) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				existing = parsed as PluginsJson;
			}
		} catch {
			existing = {};
		}
	}
	const entries = Array.isArray(existing.entries) ? [...existing.entries] : [];
	const already = entries.some((e) => typeof e?.path === "string" && resolve(e.path) === resolvedTarget);
	if (already) return false;
	// Remove any older pi-harness agy-plugins entry pointing to another path so we never duplicate.
	const filtered = entries.filter((e) => !(typeof e?.path === "string" && e.path.endsWith(`/${AGY_PLUGINS_DIRNAME}`)));
	filtered.push({ path: resolvedTarget });
	const next: PluginsJson = { ...existing, entries: filtered };
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, "\t")}\n`);
	renameSync(tmp, file);
	return true;
}

export interface RegisterAgyOptions {
	pluginsParentDir: string;
	/** Standalone agy CLI config dir (default ~/.gemini/config). */
	geminiConfigDir?: string;
	/** T3 Code Antigravity providers parent dir (default ~/.t3/userdata/providers/antigravity). */
	t3AntigravityDir?: string;
}

/**
 * Register the plugin in both standalone `agy` CLI (`~/.gemini/config/plugins.json`) and every
 * T3 Code isolated Antigravity `GEMINI_HOME` (`~/.t3/userdata/providers/antigravity/<hash>/config/plugins.json`).
 */
export function registerAgyPlugin(options: RegisterAgyOptions): string[] {
	const home = homedir();
	const geminiConfigDir = options.geminiConfigDir ?? join(home, ".gemini", "config");
	const t3AntigravityDir = options.t3AntigravityDir ?? join(home, ".t3", "userdata", "providers", "antigravity");

	const targets: string[] = [join(geminiConfigDir, "plugins.json")];

	if (existsSync(t3AntigravityDir)) {
		for (const entry of readdirSync(t3AntigravityDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			targets.push(join(t3AntigravityDir, entry.name, "config", "plugins.json"));
		}
	}

	const updated: string[] = [];
	for (const file of targets) {
		upsertPluginsJson(file, options.pluginsParentDir);
		updated.push(file);
	}
	return updated;
}

/**
 * Atomically symlink `<binDir>/tool` -> `<runtimeRoot>/agy/bin/tool.ts` so `tool edit - <<'EOF'`
 * works in `agy` `run_command`. Never overwrites a regular non-symlink binary.
 */
export function installToolSymlink(runtimeRoot: string, binDir = join(homedir(), ".local", "bin")): { path: string; linked: boolean; reason?: string } {
	const linkPath = join(binDir, "tool");
	const target = join(resolve(runtimeRoot), "agy", "bin", "tool.ts");
	mkdirSync(binDir, { recursive: true });
	if (existsSync(linkPath)) {
		const stat = lstatSync(linkPath);
		if (!stat.isSymbolicLink()) {
			return { path: linkPath, linked: false, reason: `${linkPath} exists and is not a symlink; left untouched` };
		}
	}
	const tmp = `${linkPath}.${process.pid}.tmp`;
	rmSync(tmp, { force: true });
	symlinkSync(target, tmp);
	renameSync(tmp, linkPath);
	return { path: linkPath, linked: true };
}

const HOOK_MARKER = "# pi-harness:agy-sync";

/**
 * Install (or update) a lightweight `.git/hooks/post-commit` hook so every commit in `repoRoot`
 * (manual or from `dream`) automatically deploys and refreshes the `agy` plugin.
 */
export function installPostCommitHook(repoRoot: string, nodePath = process.execPath): { path: string; installed: boolean } {
	const hooksDir = join(repoRoot, ".git", "hooks");
	if (!existsSync(hooksDir)) return { path: join(hooksDir, "post-commit"), installed: false };
	const hookPath = join(hooksDir, "post-commit");
	const syncScript = join(repoRoot, "agy", "sync.ts");
	const snippet = [
		HOOK_MARKER,
		`if [ -f ${shellQuote(syncScript)} ]; then`,
		`  (${shellQuote(nodePath)} ${shellQuote(syncScript)} --from-hook >/dev/null 2>&1 &)`,
		`fi`,
	].join("\n");

	if (existsSync(hookPath)) {
		const current = readFileSync(hookPath, "utf8");
		if (current.includes(HOOK_MARKER)) return { path: hookPath, installed: false };
		writeFileSync(hookPath, `${current.trimEnd()}\n\n${snippet}\n`);
	} else {
		writeFileSync(hookPath, `#!/bin/sh\n${snippet}\n`);
	}
	chmodSync(hookPath, 0o755);
	return { path: hookPath, installed: true };
}
