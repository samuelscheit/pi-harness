// pi.setBackgroundWork(key, pending): the session sums the keys and emits `background_work` on each
// change of the total, so a host that unloads idle sessions can keep one whose extension still has
// jobs running. The count is session state: it survives a reload of the extensions.

import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

let api: ExtensionAPI | undefined;
let harness: Harness | undefined;

afterEach(() => {
	harness?.cleanup();
	harness = undefined;
	api = undefined;
});

async function start(): Promise<Harness> {
	const created = await createHarness();
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: created.tempDir,
		agentDir: created.tempDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		extensionFactories: [
			(pi: ExtensionAPI) => {
				api = pi;
			},
		],
	});
	await resourceLoader.reload();
	created.cleanup();
	harness = await createHarness({ resourceLoader });
	await harness.session.bindExtensions({});
	return harness;
}

const pendings = (h: Harness) => h.eventsOfType("background_work").map((e) => e.pending);

describe("setBackgroundWork", () => {
	test("emits the total over all keys, only when it changes", async () => {
		const h = await start();
		api!.setBackgroundWork("jobs", 1);
		api!.setBackgroundWork("jobs", 1);
		api!.setBackgroundWork("other", 2);
		api!.setBackgroundWork("jobs", 0);
		api!.setBackgroundWork("missing", 0);
		api!.setBackgroundWork("other", 0);
		expect(pendings(h)).toEqual([1, 3, 2, 0]);
		expect(h.session.backgroundWork).toBe(0);
	});

	test("rejects counts that are not whole and non-negative", async () => {
		const h = await start();
		expect(() => api!.setBackgroundWork("jobs", -1)).toThrow(/Invalid background work/);
		expect(() => api!.setBackgroundWork("jobs", 1.5)).toThrow(/Invalid background work/);
		expect(() => api!.setBackgroundWork("jobs", Number.NaN)).toThrow(/Invalid background work/);
		expect(pendings(h)).toEqual([]);
	});

	test("survives a reload; the reloaded extension sets its key again without a new event", async () => {
		const h = await start();
		api!.setBackgroundWork("jobs", 2);
		const before = api!;
		await h.session.reload();
		expect(api).not.toBe(before);
		expect(h.session.backgroundWork).toBe(2);
		api!.setBackgroundWork("jobs", 2);
		expect(pendings(h)).toEqual([2]);
		api!.setBackgroundWork("jobs", 0);
		expect(pendings(h)).toEqual([2, 0]);
	});
});
