import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePackagePath } from "../../clients/package-root.js";
import {
	biomeConfigArgs,
	markdownlintConfigArgs,
	ruffConfigArgs,
} from "../../clients/tool-policy.js";

/**
 * Shared config-args seam regression tests (#1247).
 *
 * The lint runners and the autofix surfaces MUST both consume the builders
 * under test — this suite pins the exact args they produce for the two
 * project states (no config → package-owned fallback; config present → user
 * config wins / empty). If a builder drifts, both surfaces drift together and
 * the divergence that caused the whole-file CHANGELOG/AGENTS.md markdownlint
 * reformat (`#946` → `# 946`) is reintroduced.
 */
describe("shared lint/autofix config-args builders (#1247)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-config-args-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("markdownlintConfigArgs", () => {
		it("falls back to the package-owned core.json when the project has no config", () => {
			const args = markdownlintConfigArgs(tmpDir);
			expect(args).toEqual([
				"--config",
				resolvePackagePath(import.meta.url, "config/markdownlint/core.json"),
			]);
		});

		it("passes no --config when the project ships its own markdownlint config", () => {
			fs.writeFileSync(path.join(tmpDir, ".markdownlint.json"), "{}");
			expect(markdownlintConfigArgs(tmpDir)).toEqual([]);
		});

		it("respects a config nested below the start dir (walk-up discovery)", () => {
			const nested = path.join(tmpDir, "a", "b");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(
				path.join(tmpDir, "a", ".markdownlint.yaml"),
				"MD013: false\n",
			);
			expect(markdownlintConfigArgs(nested)).toEqual([]);
		});
	});

	describe("ruffConfigArgs", () => {
		it("falls back to the package-owned core.toml when the project has no config", () => {
			const args = ruffConfigArgs(tmpDir);
			expect(args).toEqual([
				"--config",
				resolvePackagePath(import.meta.url, "config/ruff/core.toml"),
			]);
		});

		it("passes no --config when the project ships a ruff section in pyproject.toml", () => {
			fs.writeFileSync(
				path.join(tmpDir, "pyproject.toml"),
				"[tool.ruff]\nline-length = 100\n",
			);
			expect(ruffConfigArgs(tmpDir)).toEqual([]);
		});
	});

	describe("biomeConfigArgs", () => {
		it("falls back to the package-owned core.jsonc when the project has no config", () => {
			const args = biomeConfigArgs(tmpDir);
			expect(args).toEqual([
				`--config-path=${resolvePackagePath(
					import.meta.url,
					"config/biome/core.jsonc",
				)}`,
			]);
		});

		// Biome discovers its config from its cwd, and an `npx` run has a
		// neutral one, so the project's config is always named. Naming the ROOT
		// config's directory keeps biome's nested-config merge (#1731): verified
		// against biome 2.6.5 in biome-config-decorator-metadata.test.ts.
		const named = (dir: string) => [`--config-path=${fs.realpathSync(dir)}`];

		it.each(["biome.json", "biome.jsonc", ".biome.json", ".biome.jsonc"])(
			"names the project's own directory when it ships %s",
			(name) => {
				fs.writeFileSync(path.join(tmpDir, name), "{}");
				expect(biomeConfigArgs(tmpDir)).toEqual(named(tmpDir));
			},
		);

		it("names the nearest config's directory from a subdirectory", () => {
			const sub = path.join(tmpDir, "src", "deep");
			fs.mkdirSync(sub, { recursive: true });
			fs.writeFileSync(path.join(tmpDir, "biome.json"), "{}");
			expect(biomeConfigArgs(sub)).toEqual(named(tmpDir));
		});

		it("climbs past a nested root: false config (JSONC, comments and all) to the root", () => {
			const pkg = path.join(tmpDir, "packages", "a");
			fs.mkdirSync(pkg, { recursive: true });
			fs.writeFileSync(path.join(tmpDir, "biome.json"), '{ "root": true }');
			fs.writeFileSync(
				path.join(pkg, "biome.jsonc"),
				'{\n\t// a package\n\t"root": false,\n\t"extends": "//",\n}\n',
			);
			expect(biomeConfigArgs(pkg)).toEqual(named(tmpDir));
		});

		it("stops at the nearest config that does not say root: false", () => {
			// An explicit `root: true`, an omitted key (biome's default) and an
			// unparseable file all end the climb; biome reports a broken file.
			const pkg = path.join(tmpDir, "pkg");
			fs.mkdirSync(pkg);
			fs.writeFileSync(path.join(tmpDir, "biome.json"), "{}");
			for (const content of ['{ "root": true }', "{}", "{ not json"]) {
				fs.writeFileSync(path.join(pkg, "biome.json"), content);
				expect(biomeConfigArgs(pkg), content).toEqual(named(pkg));
			}
		});

		it("hands a nested config with no root above it to biome as is", () => {
			fs.writeFileSync(
				path.join(tmpDir, "biome.json"),
				'{ "root": false, "extends": "//" }',
			);
			expect(biomeConfigArgs(tmpDir)).toEqual(named(tmpDir));
		});
	});
});
