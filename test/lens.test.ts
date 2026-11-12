import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { effectiveConfigPath, mergeConfig } from "../extensions/lens/index.ts";

describe("mergeConfig", () => {
	test("objects merge key by key at any depth", () => {
		assert.deepEqual(
			mergeConfig(
				{ lsp: { enabled: true, queryMaxFileLines: 5000 }, actionableWarnings: { autoFix: { enabled: false, maxFixes: 5 } } },
				{ lsp: { enabled: false }, actionableWarnings: { autoFix: { maxFixes: 0 } } },
			),
			{ lsp: { enabled: false, queryMaxFileLines: 5000 }, actionableWarnings: { autoFix: { enabled: false, maxFixes: 0 } } },
		);
	});

	test("arrays and scalars replace, they are not concatenated", () => {
		assert.deepEqual(mergeConfig({ ignore: ["a/**", "b/**"], startup: { mode: "full" } }, { ignore: ["c/**"], startup: { mode: "quick" } }), {
			ignore: ["c/**"],
			startup: { mode: "quick" },
		});
	});

	test("null removes a global key so the tool default applies", () => {
		assert.deepEqual(mergeConfig({ contextInjection: { retain: true, enabled: true } }, { contextInjection: { retain: null } }), {
			contextInjection: { enabled: true },
		});
		assert.deepEqual(mergeConfig({ ignore: ["x"] }, { ignore: null }), {});
	});

	test("an object replaces a scalar and the other way round", () => {
		assert.deepEqual(mergeConfig({ tools: { lazy: true } }, { tools: { lazy: "auto" } }), { tools: { lazy: "auto" } });
		assert.deepEqual(mergeConfig({ widget: false }, { widget: { visible: true } }), { widget: { visible: true } });
	});

	test("inputs are not mutated", () => {
		const base = { lsp: { enabled: true } };
		mergeConfig(base, { lsp: { enabled: false } });
		assert.deepEqual(base, { lsp: { enabled: true } });
	});
});

describe("effectiveConfigPath", () => {
	let dir: string;
	let globalFile: string;
	let stateDir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lens-"));
		globalFile = join(dir, "harness/config/pi-lens.json");
		stateDir = join(dir, "state");
		mkdirSync(join(dir, "harness/config"), { recursive: true });
		writeFileSync(globalFile, JSON.stringify({ contextInjection: { retain: true }, ignore: ["dist/**"] }));
		mkdirSync(join(dir, "repo/.git"), { recursive: true });
		mkdirSync(join(dir, "repo/packages/app"), { recursive: true });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("without a project file pi-lens reads the global file directly", () => {
		assert.equal(effectiveConfigPath(join(dir, "repo"), stateDir, globalFile), globalFile);
		assert.equal(existsSync(stateDir), false);
	});

	test("a project file at the repository root applies from any subdirectory", () => {
		mkdirSync(join(dir, "repo/.pi"));
		writeFileSync(join(dir, "repo/.pi/pi-lens.json"), JSON.stringify({ lsp: { enabled: false }, ignore: ["gen/**"] }));
		const file = effectiveConfigPath(join(dir, "repo/packages/app"), stateDir, globalFile);
		assert.equal(readdirSync(stateDir).length, 1);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
			contextInjection: { retain: true },
			ignore: ["gen/**"],
			lsp: { enabled: false },
		});
		// The same project always maps to the same file; another project gets its own.
		assert.equal(effectiveConfigPath(join(dir, "repo"), stateDir, globalFile), file);
		mkdirSync(join(dir, "other/.git"), { recursive: true });
		mkdirSync(join(dir, "other/.pi"));
		writeFileSync(join(dir, "other/.pi/pi-lens.json"), "{}");
		assert.notEqual(effectiveConfigPath(join(dir, "other"), stateDir, globalFile), file);
	});

	test("a project can configure pi-lens with no global file at all", () => {
		rmSync(globalFile);
		mkdirSync(join(dir, "repo/.pi"));
		writeFileSync(join(dir, "repo/.pi/pi-lens.json"), JSON.stringify({ lens: { enabled: false } }));
		assert.deepEqual(JSON.parse(readFileSync(effectiveConfigPath(join(dir, "repo"), stateDir, globalFile), "utf8")), { lens: { enabled: false } });
	});

	test("a malformed or non-object project file is an error, never a silent default", () => {
		mkdirSync(join(dir, "repo/.pi"));
		writeFileSync(join(dir, "repo/.pi/pi-lens.json"), "{ not json");
		assert.throws(() => effectiveConfigPath(join(dir, "repo"), stateDir, globalFile), SyntaxError);
		writeFileSync(join(dir, "repo/.pi/pi-lens.json"), "[1, 2]");
		assert.throws(() => effectiveConfigPath(join(dir, "repo"), stateDir, globalFile), /expected a JSON object/);
	});
});
