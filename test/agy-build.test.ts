// Tests for building, validating, registering, and syncing the Antigravity (`agy`) plugin
// (agy/build.ts): plugin layout, agy plugin validate --strict, idempotent plugins.json upsert,
// tool symlink safety, and git post-commit hook installation.

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	AGY_PLUGINS_DIRNAME,
	buildAgyPlugin,
	installPostCommitHook,
	installToolSymlink,
	registerAgyPlugin,
	upsertPluginsJson,
	validateAgyPlugin,
} from "../agy/build.ts";
import { HARNESS_ROOT } from "../extensions/lib/repository.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agy-build-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("agy plugin build and registration", () => {
	test("buildAgyPlugin writes a valid native plugin bundle that passes `agy plugin validate --strict`", () => {
		const pluginsParentDir = join(dir, AGY_PLUGINS_DIRNAME);
		const built = buildAgyPlugin({
			harnessRoot: HARNESS_ROOT,
			pluginsParentDir,
			runtimeRoot: HARNESS_ROOT,
		});

		assert.ok(existsSync(join(built.pluginDir, "plugin.json")));
		assert.ok(existsSync(join(built.pluginDir, "rules", "AGENTS.md")));
		assert.ok(existsSync(join(built.pluginDir, "hooks.json")));
		assert.ok(existsSync(join(built.pluginDir, "mcp_config.json")));

		const hooks = JSON.parse(readFileSync(join(built.pluginDir, "hooks.json"), "utf8")) as Record<string, Record<string, unknown>>;
		assert.ok(hooks["pi-harness"]?.SessionStart);
		assert.ok(hooks["pi-harness"]?.PreToolUse);
		assert.ok(hooks["pi-harness"]?.PostToolUse);
		assert.ok(hooks["pi-harness"]?.PreInvocation);
		assert.ok(hooks["pi-harness"]?.Stop);

		const mcp = JSON.parse(readFileSync(join(built.pluginDir, "mcp_config.json"), "utf8")) as { mcpServers: Record<string, unknown> };
		assert.ok(mcp.mcpServers["pi-harness"]);
		assert.ok(mcp.mcpServers["pi-lens"]);

		const validation = validateAgyPlugin(built.pluginDir);
		assert.notEqual(validation.status, "failed", `agy plugin validate --strict failed:\n${validation.output}`);
	});

	test("upsertPluginsJson and registerAgyPlugin are idempotent and preserve existing entries", () => {
		const geminiConfig = join(dir, "gemini", "config");
		const t3Providers = join(dir, "t3", "providers", "antigravity");
		mkdirSync(geminiConfig, { recursive: true });
		mkdirSync(join(t3Providers, "hash-a"), { recursive: true });
		mkdirSync(join(t3Providers, "hash-b"), { recursive: true });

		const existingFile = join(geminiConfig, "plugins.json");
		writeFileSync(existingFile, JSON.stringify({ entries: [{ path: "/some/other/plugins" }] }, null, "\t"));

		const targetDir = join(dir, "release-1", AGY_PLUGINS_DIRNAME);
		const files = registerAgyPlugin({
			pluginsParentDir: targetDir,
			geminiConfigDir: geminiConfig,
			t3AntigravityDir: t3Providers,
		});
		assert.equal(files.length, 3);

		const parsed = JSON.parse(readFileSync(existingFile, "utf8")) as { entries: { path: string }[] };
		assert.deepEqual(
			parsed.entries.map((e) => e.path),
			["/some/other/plugins", targetDir],
		);

		// Calling again is a no-op.
		assert.equal(upsertPluginsJson(existingFile, targetDir), false);

		// Updating to a new agy-plugins path replaces the old one cleanly without duplicating.
		const targetDir2 = join(dir, "release-2", AGY_PLUGINS_DIRNAME);
		assert.equal(upsertPluginsJson(existingFile, targetDir2), true);
		const parsed2 = JSON.parse(readFileSync(existingFile, "utf8")) as { entries: { path: string }[] };
		assert.deepEqual(
			parsed2.entries.map((e) => e.path),
			["/some/other/plugins", targetDir2],
		);
	});

	test("installToolSymlink links atomically and refuses to overwrite a regular file", () => {
		const binDir = join(dir, "bin");
		const res1 = installToolSymlink(HARNESS_ROOT, binDir);
		assert.equal(res1.linked, true);
		assert.ok(lstatSync(res1.path).isSymbolicLink());
		assert.equal(readlinkSync(res1.path), join(HARNESS_ROOT, "agy", "bin", "tool.ts"));

		// A regular binary at `tool` is never clobbered.
		const binDir2 = join(dir, "bin2");
		mkdirSync(binDir2, { recursive: true });
		writeFileSync(join(binDir2, "tool"), "#!/bin/sh\necho custom\n");
		const res2 = installToolSymlink(HARNESS_ROOT, binDir2);
		assert.equal(res2.linked, false);
		assert.equal(readFileSync(join(binDir2, "tool"), "utf8"), "#!/bin/sh\necho custom\n");
	});

	test("installPostCommitHook installs once and preserves existing hook content", () => {
		const fakeRepo = join(dir, "repo");
		mkdirSync(join(fakeRepo, ".git", "hooks"), { recursive: true });
		writeFileSync(join(fakeRepo, ".git", "hooks", "post-commit"), "#!/bin/sh\necho existing\n");

		const first = installPostCommitHook(fakeRepo);
		assert.equal(first.installed, true);
		const content = readFileSync(first.path, "utf8");
		assert.match(content, /echo existing/);
		assert.match(content, /pi-harness:agy-sync/);

		const second = installPostCommitHook(fakeRepo);
		assert.equal(second.installed, false);
	});
});
