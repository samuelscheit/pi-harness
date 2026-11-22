#!/usr/bin/env node
// Sync pi-harness -> Antigravity (`agy`) plugin + T3 Code + `~/.local/bin/tool` + git post-commit hook.
//
// Usage:
//   npm run sync-agy                 (builds plugin from current deployed release, or repo checkout if
//                                     `--working-tree` / not yet deployed, validates with `agy plugin
//                                     validate --strict`, registers in ~/.gemini/config/plugins.json
//                                     and T3 Code's antigravity provider dirs, links ~/.local/bin/tool,
//                                     and installs .git/hooks/post-commit)
//   node agy/sync.ts --working-tree  (point directly at the repo checkout for live uncommitted iteration)
//   node agy/sync.ts --from-hook     (invoked by .git/hooks/post-commit: deploy commit then refresh agy)

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { currentLink, deploy } from "../extensions/lib/release.ts";
import { HARNESS_ROOT, SOURCE_ROOT } from "../extensions/lib/repository.ts";
import {
	AGY_PLUGINS_DIRNAME,
	buildAgyPlugin,
	installPostCommitHook,
	installToolSymlink,
	registerAgyPlugin,
	validateAgyPlugin,
} from "./build.ts";

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			"working-tree": { type: "boolean", default: false },
			"from-hook": { type: "boolean", default: false },
			"no-hook": { type: "boolean", default: false },
			"agent-dir": { type: "string" },
		},
	});

	const agentDir = values["agent-dir"] ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
	const source = SOURCE_ROOT;
	const workingTree = values["working-tree"] === true;

	// If not explicitly targeting the working tree, try deploying the latest commit via release.ts
	// so Pi and agy share the exact same immutable release behind ~/.pi/agent/harness/current.
	let runtimeRoot = source;
	let harnessRoot = source;

	if (!workingTree) {
		let branch = "";
		try {
			branch = execFileSync("git", ["-C", source, "branch", "--show-current"], { encoding: "utf8" }).trim();
		} catch {
			branch = "";
		}
		if (branch) {
			try {
				const res = await deploy({ source, branch, agentDir });
				if (res.status === "failed") {
					process.stderr.write(`deploy(${res.commit.slice(0, 9)}) failed, falling back to working tree: ${res.error}\n`);
				}
			} catch (error) {
				process.stderr.write(`deploy skipped, falling back to working tree: ${error instanceof Error ? error.message : String(error)}\n`);
			}
		}
		const link = currentLink(agentDir);
		if (existsSync(join(link, "agy", "hooks", "dispatch.ts"))) {
			runtimeRoot = link;
			harnessRoot = link;
		}
	}

	const pluginsParentDir = join(runtimeRoot, AGY_PLUGINS_DIRNAME);
	const built = buildAgyPlugin({ harnessRoot, pluginsParentDir, runtimeRoot });

	const validation = validateAgyPlugin(built.pluginDir);
	if (validation.status === "failed") {
		process.stderr.write(`agy plugin validate --strict failed:\n${validation.output}\n`);
		process.exitCode = 1;
		return;
	}

	const registered = registerAgyPlugin({ pluginsParentDir: built.pluginsParentDir });
	const toolLink = installToolSymlink(runtimeRoot);
	const hook = !values["no-hook"] && !values["from-hook"] ? installPostCommitHook(source) : undefined;

	if (!values["from-hook"]) {
		console.log(`Built agy plugin: ${built.pluginDir}`);
		console.log(`  rules/AGENTS.md: ${built.rules.bytes} bytes (${built.rules.sections.length} sections${built.rules.skipped.length ? `, ${built.rules.skipped.length} skipped` : ""}${built.rules.truncated.length ? `, ${built.rules.truncated.length} truncated` : ""})`);
		console.log(`  validation: ${validation.status}${validation.output ? ` (${validation.output.split("\n")[0]})` : ""}`);
		console.log(`  registered plugins.json (${registered.length}):\n    ${registered.join("\n    ")}`);
		console.log(`  tool CLI: ${toolLink.linked ? `${toolLink.path} -> ${join(runtimeRoot, "agy", "bin", "tool.ts")}` : toolLink.reason}`);
		if (hook) console.log(`  post-commit hook: ${hook.installed ? `installed at ${hook.path}` : `already present at ${hook.path}`}`);
		if (HARNESS_ROOT !== runtimeRoot && runtimeRoot === source) {
			console.log(`  note: pointing at working tree (${source}); commit your changes and re-run to switch to immutable releases.`);
		}
	}
}

main().catch((error) => {
	process.stderr.write(`sync-agy failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
	process.exitCode = 1;
});
