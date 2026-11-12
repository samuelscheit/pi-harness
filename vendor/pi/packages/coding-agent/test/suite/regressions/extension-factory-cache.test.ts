import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearExtensionCache, loadExtensions, loadExtensionsCached } from "../../../src/core/extensions/loader.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";

interface TestState {
	moduleLoads?: number;
	factoryRuns?: number;
	version?: string;
}

function state(): TestState {
	const global = globalThis as typeof globalThis & { __extensionFactoryCacheTest?: TestState };
	if (!global.__extensionFactoryCacheTest) {
		global.__extensionFactoryCacheTest = {};
	}
	return global.__extensionFactoryCacheTest;
}

function resetState(): void {
	delete (globalThis as typeof globalThis & { __extensionFactoryCacheTest?: TestState }).__extensionFactoryCacheTest;
}

function writeCountingExtension(filePath: string): void {
	writeFileSync(
		filePath,
		`
const state = (globalThis.__extensionFactoryCacheTest ??= {});
state.moduleLoads = (state.moduleLoads ?? 0) + 1;

export default function () {
	state.factoryRuns = (state.factoryRuns ?? 0) + 1;
}
`,
		"utf-8",
	);
}

describe("extension factory cache", () => {
	const roots: string[] = [];

	function fixture(name: string) {
		const root = join(tmpdir(), `pi-extension-cache-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		roots.push(root);
		return { root, cwd, agentDir };
	}

	beforeEach(() => {
		resetState();
		clearExtensionCache();
	});

	afterEach(() => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root && existsSync(root)) {
				rmSync(root, { recursive: true, force: true });
			}
		}
		resetState();
		clearExtensionCache();
	});

	it("caches extension modules for cached same-cwd loads but reruns factories", async () => {
		const { root, cwd } = fixture("same-cwd");
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		const first = await loadExtensionsCached([extensionPath], cwd);
		const second = await loadExtensionsCached([extensionPath], cwd);

		expect(state().moduleLoads).toBe(1);
		expect(state().factoryRuns).toBe(2);
		expect(first.extensions[0]).not.toBe(second.extensions[0]);
		expect(first.runtime).not.toBe(second.runtime);
	});

	it("does not cache direct loadExtensions calls", async () => {
		const { root, cwd } = fixture("direct");
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		await loadExtensions([extensionPath], cwd);
		await loadExtensions([extensionPath], cwd);

		expect(state().moduleLoads).toBe(2);
		expect(state().factoryRuns).toBe(2);
	});

	it("clears the cache on resource loader reload", async () => {
		const { cwd, agentDir } = fixture("reload");
		const extensionDir = join(agentDir, "extensions");
		mkdirSync(extensionDir, { recursive: true });
		writeCountingExtension(join(extensionDir, "counting.ts"));
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});

		await loader.reload();
		await loader.reload();

		expect(state().moduleLoads).toBe(2);
		expect(state().factoryRuns).toBe(2);
	});

	it("reloads a changed JavaScript extension, which Node caches natively, and keeps an unchanged one", async () => {
		const { root, cwd } = fixture("native-js");
		const extensionPath = join(root, "native.mjs");
		const write = (version: string, mtime: Date) => {
			writeFileSync(
				extensionPath,
				`const state = (globalThis.__extensionFactoryCacheTest ??= {});\nstate.moduleLoads = (state.moduleLoads ?? 0) + 1;\nexport default function () { state.version = "${version}"; }\n`,
				"utf-8",
			);
			utimesSync(extensionPath, mtime, mtime);
		};
		const load = async () => {
			clearExtensionCache();
			const result = await loadExtensions([extensionPath], cwd);
			expect(result.errors).toEqual([]);
			return state().version;
		};

		write("v1", new Date("2026-01-01T00:00:00Z"));
		expect(await load()).toBe("v1");
		expect(await load()).toBe("v1");
		expect(state().moduleLoads).toBe(1);

		write("v2", new Date("2026-01-01T00:00:10Z"));
		expect(await load()).toBe("v2");
		expect(state().moduleLoads).toBe(2);
		expect(await load()).toBe("v2");
		expect(state().moduleLoads).toBe(2);

		write("v3", new Date("2026-01-01T00:00:20Z"));
		expect(await load()).toBe("v3");
		expect(state().moduleLoads).toBe(3);
	});

	it("keeps the cache scoped to one cwd", async () => {
		const { root } = fixture("cross-cwd");
		const firstCwd = join(root, "first");
		const secondCwd = join(root, "second");
		mkdirSync(firstCwd, { recursive: true });
		mkdirSync(secondCwd, { recursive: true });
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		await loadExtensionsCached([extensionPath], firstCwd);
		await loadExtensionsCached([extensionPath], secondCwd);
		await loadExtensionsCached([extensionPath], secondCwd);

		expect(state().moduleLoads).toBe(2);
		expect(state().factoryRuns).toBe(3);
	});
});
