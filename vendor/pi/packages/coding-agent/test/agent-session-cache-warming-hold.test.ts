// pi.setCacheWarmingHold(untilMs) in a real session: with the `cacheWarming` setting "off", a hold
// set after a request resumes warming of that request's cache entry until the hold's end, the
// extension sees each status change as a `cache_warming` event, and pi.getCacheWarmingStatus()
// reports the hold and the cache lifetime. Ending the hold stops warming at once.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { CacheWarmingEvent, ExtensionAPI } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A session on a faux model whose prompt cache lives 11 seconds, so refreshes come every second. */
async function start() {
	const dir = mkdtempSync(join(tmpdir(), "pi-warm-hold-"));
	const faux = registerFauxProvider({ models: [{ id: "warm-1" }] });
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null });
	runtime.registerProvider(faux.models[0].provider, {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [
			{
				id: "warm-1",
				name: "Warm",
				api: faux.api,
				reasoning: false,
				input: ["text"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200_000,
				maxTokens: 8000,
				promptCache: { short: 11 },
			},
		],
	});
	let api: ExtensionAPI | undefined;
	const events: CacheWarmingEvent[] = [];
	const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", cacheRetention: "short" });
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		extensionFactories: [
			(pi: ExtensionAPI) => {
				api = pi;
				pi.on("cache_warming", (event) => void events.push(event));
			},
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: runtime.getModel(faux.models[0].provider, "warm-1"),
		modelRuntime: runtime,
		resourceLoader,
		sessionManager: SessionManager.inMemory(dir),
		settingsManager,
	});
	await session.bindExtensions({});
	cleanups.push(() => {
		session.dispose();
		faux.unregister();
		rmSync(dir, { recursive: true, force: true });
	});
	// Each refresh replays the request and takes one faux response.
	faux.setResponses([fauxAssistantMessage("Hello."), ...Array.from({ length: 20 }, () => fauxAssistantMessage("x"))]);
	return { session, api: api!, events };
}

const warms = (session: AgentSession) =>
	session.sessionManager.getEntries().filter((entry) => entry.type === "usage" && entry.kind === "cache_warm");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("pi.setCacheWarmingHold", () => {
	it("warms with the setting off until the hold ends, and reports it to extensions", async () => {
		const { session, api, events } = await start();
		await session.prompt("hi");
		expect(api.getCacheWarmingStatus()).toMatchObject({ state: "inactive", reason: "cache warming disabled" });

		const until = Date.now() + 2_600;
		api.setCacheWarmingHold(until);
		expect(api.getCacheWarmingStatus()).toMatchObject({
			state: "scheduled",
			holdUntil: until,
			cache: { ttlMs: 11_000, delayMs: 1_000, retention: "short" },
			decision: { held: true, continuationProbability: 1, action: "warm" },
		});
		expect(events.at(-1)).toMatchObject({ type: "cache_warming", state: "scheduled", holdUntil: until });
		await sleep(4_000);
		expect(warms(session).length).toBeGreaterThanOrEqual(2);
		expect(warms(session).length).toBeLessThanOrEqual(3);
		const after = warms(session).length;
		expect(api.getCacheWarmingStatus()).toMatchObject({ state: "inactive" });
		expect(events.at(-1)).toMatchObject({ state: "inactive" });
		expect(events.some((event) => event.state === "refreshing")).toBe(true);
		await sleep(1_500);
		expect(warms(session).length).toBe(after);
	}, 15_000);

	it("ending the hold stops warming at once", async () => {
		const { session, api, events } = await start();
		await session.prompt("hi");
		api.setCacheWarmingHold(Date.now() + 60_000);
		await sleep(1_500);
		expect(warms(session).length).toBe(1);
		api.setCacheWarmingHold(undefined);
		expect(api.getCacheWarmingStatus()).toMatchObject({ state: "inactive", reason: "cache warming disabled" });
		expect(events.at(-1)).toEqual({ type: "cache_warming", state: "inactive", reason: "cache warming disabled" });
		await sleep(1_500);
		expect(warms(session).length).toBe(1);
	}, 15_000);
});
