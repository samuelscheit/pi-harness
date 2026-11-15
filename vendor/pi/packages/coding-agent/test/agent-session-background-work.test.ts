// pi.setBackgroundWork(key, items): the session keeps each key's items and emits `background_work`
// with the items of all keys (and their number) on each change, so a host that unloads idle
// sessions can keep one whose extension still has jobs running, and show each job. The items are
// session state: they survive a reload of the extensions.

import { afterEach, describe, expect, test } from "vitest";
import type { BackgroundWorkItem, ExtensionAPI } from "../src/core/extensions/types.ts";
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

const events = (h: Harness) => h.eventsOfType("background_work");
const ids = (h: Harness) => events(h).map((e) => e.items.map((item) => item.id));
const item = (id: string, extra: Partial<BackgroundWorkItem> = {}): BackgroundWorkItem => ({ id, kind: "call", label: `bash: ${id}`, startedAt: 1000, ...extra });

describe("setBackgroundWork", () => {
	test("emits the items of all keys and their number, only when they change", async () => {
		const h = await start();
		api!.setBackgroundWork("jobs", [item("a")]);
		api!.setBackgroundWork("jobs", [item("a")]);
		api!.setBackgroundWork("other", [item("b"), item("c")]);
		api!.setBackgroundWork("jobs", [item("a", { label: "bash: a (renamed)" })]);
		api!.setBackgroundWork("jobs", []);
		api!.setBackgroundWork("missing", []);
		api!.setBackgroundWork("other", []);
		expect(ids(h)).toEqual([["a"], ["a", "b", "c"], ["a", "b", "c"], ["b", "c"], []]);
		expect(events(h).map((e) => e.pending)).toEqual([1, 3, 3, 2, 0]);
		expect(events(h)[2]!.items[0]!.label).toBe("bash: a (renamed)");
		expect(h.session.backgroundWork).toEqual([]);
	});

	test("carries every field an item has, and only those; a later change of the extension's object does not leak in", async () => {
		const h = await start();
		const full = item("call-1", {
			kind: "process",
			label: "process: npm run dev",
			command: "npm run dev > dev.log 2>&1",
			pid: 4242,
			processGroup: 4200,
			logPath: "/tmp/dev.log",
			url: "http://127.0.0.1:4317/workflows/x",
			toolCallId: "toolu_1",
			awaited: false,
		});
		api!.setBackgroundWork("jobs", [{ ...full, extra: "dropped" } as BackgroundWorkItem]);
		expect(events(h)[0]).toEqual({ type: "background_work", pending: 1, items: [full] });
		const mine = item("d");
		api!.setBackgroundWork("other", [mine]);
		mine.label = "changed afterwards";
		expect(h.session.backgroundWork.at(-1)!.label).toBe("bash: d");
	});

	test("rejects items that are not well formed, and ids another key holds; nothing is emitted for them", async () => {
		const h = await start();
		const bad = (items: unknown) => () => api!.setBackgroundWork("jobs", items as BackgroundWorkItem[]);
		expect(bad(1)).toThrow(/Invalid background work: expected an array/);
		expect(bad([{ kind: "x", label: "x", startedAt: 1 }])).toThrow(/item 0 needs a non-empty id/);
		expect(bad([item("a"), item("a")])).toThrow(/item 1 repeats id "a"/);
		expect(bad([item("a", { kind: " " })])).toThrow(/needs a non-empty kind/);
		expect(bad([item("a", { label: "" })])).toThrow(/needs a non-empty label/);
		expect(bad([item("a", { startedAt: Number.NaN })])).toThrow(/needs startedAt/);
		expect(bad([item("a", { pid: 1.5 })])).toThrow(/invalid pid: 1.5/);
		expect(bad([item("a", { processGroup: 0 })])).toThrow(/invalid processGroup: 0/);
		expect(bad([item("a", { logPath: "" })])).toThrow(/empty or non-string logPath/);
		expect(bad([item("a", { awaited: "no" as unknown as boolean })])).toThrow(/non-boolean awaited: "no"/);
		expect(events(h)).toEqual([]);
		api!.setBackgroundWork("other", [item("a")]);
		expect(bad([item("a")])).toThrow(/id "a" is another key's/);
		expect(ids(h)).toEqual([["a"]]);
	});

	test("survives a reload; the reloaded extension sets its items again without a new event", async () => {
		const h = await start();
		api!.setBackgroundWork("jobs", [item("a"), item("b")]);
		const before = api!;
		await h.session.reload();
		expect(api).not.toBe(before);
		expect(h.session.backgroundWork.map((i) => i.id)).toEqual(["a", "b"]);
		api!.setBackgroundWork("jobs", [item("a"), item("b")]);
		expect(ids(h)).toEqual([["a", "b"]]);
		api!.setBackgroundWork("jobs", []);
		expect(ids(h)).toEqual([["a", "b"], []]);
	});
});
