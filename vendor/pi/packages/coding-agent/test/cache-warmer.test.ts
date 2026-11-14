import {
	type Api,
	type AssistantMessage,
	evaluateCacheWarming,
	type AssistantMessageEventStream,
	getCacheWarmingDelayMs,
	getPromptCacheTtlMs,
	isCacheWarmingReplayable,
	type Model,
	type ModelsSimpleStreamOptions,
	normalizeContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	CacheWarmer,
	type CacheWarmingAction,
	type CacheWarmingDecision,
	type CacheWarmingDecisionEvent,
	type CacheWarmRequest,
	formatCacheWarmingStatus,
	formatCacheWarmingUsage,
	isPromptCacheCold,
} from "../src/core/cache-warmer.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { type SessionEntry, SessionManager, type UsageEntry } from "../src/core/session-manager.ts";
import type { CacheWarmingMode } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const adaptiveModel: Model<Api> = {
	...getBuiltinModel("anthropic", "claude-opus-4-6"),
	promptCache: { short: 300, long: 3600 },
};
const budgetModel: Model<Api> = {
	...getBuiltinModel("anthropic", "claude-sonnet-4-5"),
	promptCache: { short: 300, long: 3600 },
};
const openaiModel: Model<Api> = {
	...getBuiltinModel("openai", "gpt-5"),
	promptCache: { short: 300, long: 86_400 },
};
const unknownModel: Model<Api> = { ...adaptiveModel, promptCache: undefined };

const warmUsage: Usage = {
	input: 0,
	output: 1,
	cacheRead: 100,
	cacheWrite: 0,
	totalTokens: 101,
	cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 },
};

function response(model: Model<Api>, stopReason: AssistantMessage["stopReason"] = "length"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: warmUsage,
		stopReason,
		timestamp: 0,
	};
}

function branchWithPrompt(promptTokens: number): SessionEntry[] {
	return [
		{
			type: "message",
			id: "a",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				...response(adaptiveModel),
				usage: { ...warmUsage, output: 10, cacheRead: promptTokens, totalTokens: promptTokens + 10 },
			},
		},
	];
}

function fakeRuntime(
	options: {
		result?: (model: Model<Api>) => Promise<AssistantMessage>;
		decide?: (event: CacheWarmingDecisionEvent) => CacheWarmingAction | Promise<CacheWarmingAction>;
		mode?: CacheWarmingMode;
		branch?: SessionEntry[];
		idleMaxAgeMs?: number;
	} = {},
) {
	const calls: Array<{ model: Model<Api>; options: ModelsSimpleStreamOptions | undefined }> = [];
	const events: CacheWarmingDecisionEvent[] = [];
	const warmedEntries: UsageEntry[] = [];
	const usageManager = SessionManager.inMemory();
	const appendUsage = vi.fn(usageManager.appendUsage.bind(usageManager));
	const state = { mode: options.mode ?? "idle", branch: options.branch ?? branchWithPrompt(100_000) };
	const warmer = new CacheWarmer(
		{
			streamSimple: (model, _context, streamOptions) => {
				calls.push({ model, options: streamOptions });
				return {
					result: () => (options.result ?? (async (m: Model<Api>) => response(m)))(model),
				} as unknown as AssistantMessageEventStream;
			},
		},
		{ appendUsage, getBranch: () => state.branch },
		() => state.mode,
		async (event) => {
			events.push(event);
			return options.decide?.(event) ?? event.action;
		},
		...(options.idleMaxAgeMs === undefined ? [] : [() => options.idleMaxAgeMs as number]),
	);
	warmer.onWarmed = (entry) => warmedEntries.push(entry);
	return { warmer, calls, events, warmedEntries, appendUsage, state };
}

function request(model: Model<Api> = adaptiveModel, options: ModelsSimpleStreamOptions = {}): CacheWarmRequest {
	return { model, context: normalizeContext({ messages: [] }), options };
}

const current = () => true;

// Retention falls back to PI_CACHE_RETENTION; the defaults below assume it is unset.
beforeEach(() => vi.stubEnv("PI_CACHE_RETENTION", ""));
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("cache warming", () => {
	it("derives eligibility and timing from retention and provider behavior", () => {
		expect([
			getPromptCacheTtlMs(adaptiveModel, undefined),
			getPromptCacheTtlMs(adaptiveModel, { cacheRetention: "long" }),
			getPromptCacheTtlMs(adaptiveModel, { cacheRetention: "none" }),
			getPromptCacheTtlMs(adaptiveModel, { env: { PI_CACHE_RETENTION: "long" } }),
			getPromptCacheTtlMs(openaiModel, { cacheRetention: "long" }),
			getPromptCacheTtlMs(unknownModel, undefined),
		]).toEqual([300_000, 3_600_000, undefined, 3_600_000, 86_400_000, undefined]);
		expect([getCacheWarmingDelayMs(300_000), getCacheWarmingDelayMs(60_000), getCacheWarmingDelayMs(10_000)]).toEqual(
			[270_000, 50_000, undefined],
		);
		expect([
			isCacheWarmingReplayable(budgetModel, { reasoning: "medium" }),
			isCacheWarmingReplayable(budgetModel, undefined),
			isCacheWarmingReplayable(adaptiveModel, { reasoning: "medium" }),
			isCacheWarmingReplayable(openaiModel, { reasoning: "medium" }),
		]).toEqual([false, true, true, true]);
	});

	it("replays profitable requests and preserves options across repeated refreshes", async () => {
		vi.useFakeTimers();
		const { warmer, calls, events, appendUsage, warmedEntries } = fakeRuntime();
		const signal = new AbortController().signal;
		const transformHeaders = async () => ({});

		warmer.start(request(adaptiveModel, { reasoning: "high", signal, sessionId: "s", transformHeaders }), current);
		await vi.advanceTimersByTimeAsync(270_000);

		expect(calls[0]).toMatchObject({
			model: adaptiveModel,
			options: {
				reasoning: "high",
				sessionId: "s",
				transformHeaders,
				maxTokens: 1,
				maxRetries: 0,
				disableContinuation: true,
			},
		});
		expect(calls[0].options?.signal).not.toBe(signal);
		expect(events[0]).toMatchObject({
			type: "cache_warming_decision",
			continuationProbability: 1,
			action: "warm",
		});
		expect(events[0].missCost).toBeCloseTo(0.575);
		expect(events[0].warmCost).toBeCloseTo(0.050025);
		expect(appendUsage).toHaveBeenCalledWith(
			"cache_warm",
			adaptiveModel.provider,
			adaptiveModel.id,
			warmUsage,
			undefined,
		);
		expect(warmedEntries).toEqual([appendUsage.mock.results[0]?.value]);

		await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(2);
		warmer.cancel();
	});

	it("does not issue refreshes after their safe deadline", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime();
		warmer.start(request(), current);

		// A five-minute cache is scheduled for 4m30s and retains 15 seconds of
		// the 30-second expiry margin. Simulate a timer delayed by sleep.
		vi.setSystemTime(285_001);
		vi.clearAllTimers();
		const internal = warmer as unknown as { run: object | undefined; refresh: (run: object) => Promise<void> };
		if (!internal.run) throw new Error("expected an active cache-warming run");
		await internal.refresh(internal.run);

		expect(calls).toHaveLength(0);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "cache refresh deadline missed" });
	});

	it("rechecks the deadline after an extension decision", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime({
			decide: async () => {
				await Promise.resolve();
				vi.setSystemTime(285_001);
				return "warm" as const;
			},
		});
		warmer.start(request(), current);
		vi.clearAllTimers();
		const internal = warmer as unknown as { run: object | undefined; refresh: (run: object) => Promise<void> };
		if (!internal.run) throw new Error("expected an active cache-warming run");
		await internal.refresh(internal.run);

		expect(calls).toHaveLength(0);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "cache refresh deadline missed" });
	});

	it("applies economic decisions and extension overrides", async () => {
		vi.useFakeTimers();
		const unprofitable = fakeRuntime({ branch: branchWithPrompt(5_000) });
		unprofitable.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unprofitable.calls).toHaveLength(0);
		expect(unprofitable.warmer.status).toMatchObject({
			state: "inactive",
			decision: { action: "stop", economicsAvailable: true },
			extensionOverride: false,
		});

		const forced = fakeRuntime({ branch: branchWithPrompt(5_000), decide: () => "warm" });
		forced.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(forced.calls).toHaveLength(1);
		expect(forced.warmedEntries[0]?.note).toBe("extension override");
		forced.warmer.cancel();

		const vetoed = fakeRuntime({ decide: () => "stop" });
		vetoed.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(vetoed.calls).toHaveLength(0);
		expect(vetoed.warmer.status).toMatchObject({ state: "inactive", extensionOverride: true });

		const unavailable = fakeRuntime({ branch: branchWithPrompt(0) });
		unavailable.warmer.start(request(), current);
		expect(unavailable.warmer.status).toMatchObject({
			state: "inactive",
			reason: "cache economics unavailable",
		});
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unavailable.calls).toHaveLength(0);
	});

	it("stops for unsupported requests, context changes, and mode changes", async () => {
		vi.useFakeTimers();
		const unsupported = fakeRuntime();
		unsupported.state.mode = "off";
		unsupported.warmer.start(request(), current);
		expect(unsupported.warmer.status.reason).toBe("cache warming disabled");
		unsupported.state.mode = "idle";
		unsupported.warmer.start(request(unknownModel), current);
		expect(unsupported.warmer.status.reason).toBe("cache lifetime unavailable");
		unsupported.warmer.start(request(budgetModel, { reasoning: "high" }), current);
		expect(unsupported.warmer.status.reason).toBe("request cannot be replayed safely");

		let stillCurrent = true;
		unsupported.warmer.start(request(), () => stillCurrent);
		stillCurrent = false;
		expect(unsupported.warmer.status.reason).toBe("conversation context changed");
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unsupported.calls).toHaveLength(0);

		unsupported.warmer.start(request(), current);
		unsupported.state.mode = "off";
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unsupported.calls).toHaveLength(0);

		const streaming = fakeRuntime({ mode: "streaming", branch: branchWithPrompt(400_000) });
		streaming.warmer.start(request(), current);
		streaming.warmer.onAgentSettled();
		expect(streaming.warmer.status.reason).toBe("agent run settled");
	});

	it("aborts replaced requests and does not record failed refreshes", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const pending = fakeRuntime({
			result: (model) =>
				new Promise((resolve) => {
					release = () => resolve(response(model));
				}),
		});
		pending.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		pending.warmer.start(request(), current);
		expect(pending.calls[0].options?.signal?.aborted).toBe(true);
		release();
		pending.warmer.cancel();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(pending.calls).toHaveLength(1);

		// The next refresh would come after the entry expired, so a failed one ends warming.
		const failed = fakeRuntime({ result: async (model) => response(model, "error") });
		failed.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(failed.appendUsage).not.toHaveBeenCalled();
		expect(failed.warmer.status).toMatchObject({ state: "inactive", reason: "cache refresh failed" });
		await vi.advanceTimersByTimeAsync(600_000);
		expect(failed.calls).toHaveLength(1);

		const thrown = fakeRuntime({ result: async () => Promise.reject(new Error("network")) });
		thrown.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(thrown.warmer.status).toMatchObject({ state: "inactive", reason: "cache refresh failed" });
	});

	it("formats status and usage entries", () => {
		const decision: CacheWarmingDecision = {
			phase: "idle",
			warmCost: 0.013,
			missCost: 0.621,
			continuationProbability: 0.6,
			expectedSavings: 0.36,
			economicsAvailable: true,
			held: false,
			action: "warm",
		};
		expect(formatCacheWarmingStatus({ state: "scheduled", nextWarmAt: 222_000, decision }, 0)).toBe(
			"Decision in 3m 42s (60% continuation probability, expected savings $0.360 >= $0.050 -> warm)",
		);
		const holdUntil = new Date(2026, 0, 1, 18, 0).getTime();
		const clock = new Date(holdUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		expect(
			formatCacheWarmingStatus(
				{ state: "scheduled", nextWarmAt: 60_000, decision: { ...decision, held: true }, holdUntil },
				0,
			),
		).toBe(`Decision in 1m (held until ${clock}, every refresh is sent at $0.013 -> warm)`);
		expect(formatCacheWarmingStatus({ state: "inactive", reason: "waiting for first request", holdUntil })).toBe(
			`Inactive (waiting for first request, held until ${clock})`,
		);
		const usage = {
			...warmUsage,
			cost: { input: 0.00004, output: 0.00005, cacheRead: 0.02940725, cacheWrite: 0, total: 0.02949725 },
		};
		const entry = SessionManager.inMemory().appendUsage(
			"cache_warm",
			adaptiveModel.provider,
			adaptiveModel.id,
			usage,
			"extension override",
		);
		expect(formatCacheWarmingUsage(entry.usage.cost.total, entry.note)).toBe(
			"Cache warmed (extension override): $0.029497",
		);
	});
});

describe("idle warming limit", () => {
	it("stops at settle with the default 30 minutes when the next refresh of a one-hour cache is later", async () => {
		vi.useFakeTimers();
		const { warmer, calls } = fakeRuntime();
		warmer.start(request(adaptiveModel, { cacheRetention: "long" }), current);
		warmer.onAgentSettled();
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "30-minute idle safety limit reached" });
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(calls).toHaveLength(0);
	});

	it("refreshes a one-hour cache once at 54 minutes with a 60-minute limit", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime({ idleMaxAgeMs: 60 * 60_000 });
		warmer.start(request(adaptiveModel, { cacheRetention: "long" }), current);
		warmer.onAgentSettled();
		expect(warmer.status).toMatchObject({ state: "scheduled", nextWarmAt: 3_240_000 });
		await vi.advanceTimersByTimeAsync(3_240_000);
		expect(calls).toHaveLength(1);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "60-minute idle safety limit reached" });
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(calls).toHaveLength(1);
	});

	it("reports every status change: scheduled, refreshing, scheduled again or stopped", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer } = fakeRuntime({ idleMaxAgeMs: 2 * 60 * 60_000 });
		const states: string[] = [];
		warmer.onStatusChanged = () => states.push(warmer.status.state);
		warmer.start(request(adaptiveModel, { cacheRetention: "long" }), current);
		warmer.onAgentSettled();
		expect(states).toEqual(["scheduled"]);
		await vi.advanceTimersByTimeAsync(3_240_000);
		expect(states).toEqual(["scheduled", "refreshing", "scheduled"]);
		// The next refresh (at 108 min) is within the two-hour limit; the one after is not.
		await vi.advanceTimersByTimeAsync(3_240_000);
		expect(states).toEqual(["scheduled", "refreshing", "scheduled", "refreshing", "inactive"]);
		warmer.cancel();
		expect(states.at(-1)).toBe("inactive");
	});
});

describe("cache warming hold", () => {
	const minutes = (n: number) => n * 60_000;

	it("extends the deadline to the hold's end, then stops; without a hold the idle limit applies", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const plain = fakeRuntime();
		plain.warmer.start(request(adaptiveModel, { cacheRetention: "long" }), current);
		plain.warmer.onAgentSettled();
		expect(plain.warmer.status.reason).toBe("30-minute idle safety limit reached");

		const { warmer, calls } = fakeRuntime();
		warmer.setHold(minutes(180));
		warmer.start(request(adaptiveModel, { cacheRetention: "long" }), current);
		warmer.onAgentSettled();
		expect(warmer.status).toMatchObject({
			state: "scheduled",
			nextWarmAt: minutes(54),
			holdUntil: minutes(180),
			cache: { ttlMs: minutes(60), delayMs: minutes(54), retention: "long" },
		});
		await vi.advanceTimersByTimeAsync(minutes(180));
		// Refreshes at 54, 108 and 162 minutes; the one at 216 falls after the hold.
		expect(calls).toHaveLength(3);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "cache warming hold ended" });
		await vi.advanceTimersByTimeAsync(minutes(120));
		expect(calls).toHaveLength(3);
		expect(warmer.status.holdUntil).toBeUndefined();
	});

	it("extends the one-hour streaming limit too", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime();
		warmer.setHold(minutes(20));
		warmer.start(request(), current);
		// Streaming refreshes of a five-minute cache every 4.5 minutes: 4 by 18 minutes.
		await vi.advanceTimersByTimeAsync(minutes(60));
		expect(calls.length).toBeGreaterThan(4);
		warmer.setHold(minutes(200));
		await vi.advanceTimersByTimeAsync(minutes(120));
		// Without the hold the streaming run would stop at 60 minutes (13 refreshes).
		expect(calls.length).toBe(Math.floor(minutes(180) / 270_000));
		warmer.cancel();
	});

	it("counts the user as returning and sends every refresh, also without known economics", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const unprofitable = fakeRuntime({ branch: branchWithPrompt(5_000) });
		unprofitable.warmer.setHold(minutes(10));
		unprofitable.warmer.start(request(), current);
		unprofitable.warmer.onAgentSettled();
		expect(unprofitable.warmer.status).toMatchObject({
			state: "scheduled",
			decision: { held: true, continuationProbability: 1, action: "warm" },
		});
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unprofitable.events[0]).toMatchObject({ held: true, continuationProbability: 1, action: "warm" });
		expect(unprofitable.warmedEntries[0]?.note).toBeUndefined();
		// 9 minutes is still held; at 13.5 minutes the hold is over and the normal economics stop it.
		await vi.advanceTimersByTimeAsync(minutes(10));
		expect(unprofitable.calls).toHaveLength(2);
		expect(unprofitable.events.map((e) => [e.held, e.action])).toEqual([
			[true, "warm"],
			[true, "warm"],
			[false, "stop"],
		]);
		expect(unprofitable.warmer.status).toMatchObject({ state: "inactive", reason: "expected savings below threshold" });

		const unknown = fakeRuntime({ branch: branchWithPrompt(0) });
		unknown.warmer.setHold(Date.now() + minutes(10));
		unknown.warmer.start(request(), current);
		expect(unknown.warmer.status.state).toBe("scheduled");
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unknown.calls).toHaveLength(1);
		unknown.warmer.cancel();

		const vetoed = fakeRuntime({ decide: () => "stop" });
		vetoed.warmer.setHold(Date.now() + minutes(10));
		vetoed.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(vetoed.calls).toHaveLength(0);
		expect(vetoed.warmer.status).toMatchObject({ state: "inactive", reason: "stopped by extension" });
	});

	it("warms with the setting off or streaming-only, and resumes the last request when the hold is set later", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const off = fakeRuntime({ mode: "off" });
		off.warmer.start(request(), current);
		expect(off.warmer.status.reason).toBe("cache warming disabled");
		vi.setSystemTime(60_000);
		off.warmer.setHold(minutes(10));
		// Resumed from the request's own time: the entry was written at 0, so the refresh is due at 4.5 minutes.
		expect(off.warmer.status).toMatchObject({ state: "scheduled", nextWarmAt: 270_000, holdUntil: minutes(10) });
		await vi.advanceTimersByTimeAsync(minutes(10));
		expect(off.calls).toHaveLength(2);
		expect(off.warmer.status).toMatchObject({ state: "inactive", reason: "cache warming disabled" });

		const streaming = fakeRuntime({ mode: "streaming" });
		streaming.warmer.start(request(), current);
		streaming.warmer.onAgentSettled();
		expect(streaming.warmer.status.reason).toBe("agent run settled");
		streaming.warmer.setHold(Date.now() + minutes(10));
		expect(streaming.warmer.status.state).toBe("scheduled");
		await vi.advanceTimersByTimeAsync(270_000);
		expect(streaming.calls).toHaveLength(1);
		streaming.warmer.cancel();
	});

	it("does not resume an expired entry, a changed context, a failed refresh or a non-replayable request", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const expired = fakeRuntime({ mode: "off" });
		expired.warmer.start(request(), current);
		vi.setSystemTime(285_001);
		expired.warmer.setHold(minutes(30));
		expect(expired.warmer.status).toMatchObject({ state: "inactive", reason: "prompt cache entry expired" });
		await vi.advanceTimersByTimeAsync(minutes(30));
		expect(expired.calls).toHaveLength(0);

		vi.setSystemTime(0);
		let stillCurrent = true;
		const changed = fakeRuntime({ mode: "off" });
		changed.warmer.start(request(), () => stillCurrent);
		stillCurrent = false;
		changed.warmer.setHold(minutes(30));
		expect(changed.warmer.status).toMatchObject({ state: "inactive", reason: "conversation context changed" });

		const failed = fakeRuntime({ result: async (model) => response(model, "error") });
		failed.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		failed.warmer.setHold(Date.now() + minutes(30));
		expect(failed.warmer.status).toMatchObject({ state: "inactive", reason: "cache refresh failed" });

		const unsafe = fakeRuntime();
		unsafe.warmer.setHold(Date.now() + minutes(30));
		unsafe.warmer.start(request(budgetModel, { reasoning: "high" }), current);
		expect(unsafe.warmer.status.reason).toBe("request cannot be replayed safely");
		unsafe.warmer.start(request(unknownModel), current);
		expect(unsafe.warmer.status.reason).toBe("cache lifetime unavailable");
	});

	it("clearing the hold applies the normal rules at once; a real request keeps it", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime();
		const states: string[] = [];
		warmer.onStatusChanged = () => states.push(warmer.status.state);
		warmer.setHold(minutes(180));
		warmer.start(request(adaptiveModel, { cacheRetention: "long" }), current);
		warmer.onAgentSettled();
		await vi.advanceTimersByTimeAsync(minutes(60));
		expect(calls).toHaveLength(1);
		// A new request replaces the run; the hold stays.
		warmer.start(request(adaptiveModel, { cacheRetention: "long" }), current);
		warmer.onAgentSettled();
		expect(warmer.status).toMatchObject({ state: "scheduled", holdUntil: minutes(180) });
		warmer.setHold(undefined);
		// 54 minutes after the request is past the 30-minute idle limit.
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "30-minute idle safety limit reached" });
		expect(warmer.status.holdUntil).toBeUndefined();
		expect(states.at(-1)).toBe("inactive");

		const off = fakeRuntime({ mode: "off" });
		off.warmer.setHold(Date.now() + minutes(30));
		off.warmer.start(request(), current);
		expect(off.warmer.status.state).toBe("scheduled");
		off.warmer.setHold(undefined);
		expect(off.warmer.status.reason).toBe("cache warming disabled");

		// A hold in the past is no hold.
		const past = fakeRuntime();
		past.warmer.setHold(-1);
		past.warmer.start(request(adaptiveModel, { cacheRetention: "long" }), current);
		past.warmer.onAgentSettled();
		expect(past.warmer.status.reason).toBe("30-minute idle safety limit reached");
		expect(() => past.warmer.setHold(Number.NaN)).toThrow(/Invalid cache warming hold/);
	});
});

describe("one-hour cache economics", () => {
	it("prices a miss of a one-hour cache at the one-hour write rate", () => {
		const tokens = 100_000;
		const { input, cacheRead, cacheWrite } = adaptiveModel.cost;
		const short = evaluateCacheWarming(adaptiveModel, tokens, "idle");
		const long = evaluateCacheWarming(adaptiveModel, tokens, "idle", "long");
		expect(short.missCost).toBeCloseTo(((cacheWrite - cacheRead) * tokens) / 1e6);
		expect(long.missCost).toBeCloseTo(((2 * input - cacheRead) * tokens) / 1e6);
		expect(long.warmCost).toBeCloseTo(short.warmCost);
	});
});

describe("isPromptCacheCold", () => {
	const at = (ms: number) => new Date(ms).toISOString();
	const assistant = (id: string, timestamp: number): SessionEntry => ({
		type: "message",
		id,
		parentId: null,
		timestamp: at(timestamp),
		message: { ...response(adaptiveModel), timestamp },
	});
	const warm = (id: string, timestamp: number): SessionEntry => ({
		type: "usage",
		id,
		parentId: null,
		timestamp: at(timestamp),
		kind: "cache_warm",
		provider: "anthropic",
		model: "m",
		usage: warmUsage,
	});
	const user: SessionEntry = { type: "message", id: "u", parentId: null, timestamp: at(0), message: { role: "user", content: "hi", timestamp: 0 } };

	it("measures from the last request or warm refresh", () => {
		expect(isPromptCacheCold([assistant("a", 0)], 300_000, 300_000)).toBe(false);
		expect(isPromptCacheCold([assistant("a", 0)], 300_000, 300_001)).toBe(true);
		expect(isPromptCacheCold([assistant("a", 0), warm("w", 280_000)], 300_000, 500_000)).toBe(false);
		expect(isPromptCacheCold([assistant("a", 0), warm("w", 280_000)], 300_000, 580_001)).toBe(true);
		expect(isPromptCacheCold([assistant("a", 0), user], 300_000, 400_000)).toBe(true);
	});

	it("is never cold without a lifetime, a request, or after a compaction", () => {
		expect(isPromptCacheCold([assistant("a", 0)], undefined, 10_000_000)).toBe(false);
		expect(isPromptCacheCold([user], 300_000, 10_000_000)).toBe(false);
		const compaction: SessionEntry = { type: "compaction", id: "c", parentId: null, timestamp: at(0), summary: "s", firstKeptEntryId: "a", tokensBefore: 1 };
		expect(isPromptCacheCold([assistant("a", 0), compaction], 300_000, 10_000_000)).toBe(false);
	});
});

describe("ExtensionRunner.emitCacheWarmingDecision", () => {
	it("uses the last extension override", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		const factories: ExtensionFactory[] = [
			(pi) => {
				pi.on("cache_warming_decision", () => ({ action: "warm" }));
			},
			(pi) => {
				pi.on("cache_warming_decision", () => ({ action: "stop" }));
			},
		];
		const extensions = [];
		for (const factory of factories) {
			extensions.push(await loadExtensionFromFactory(factory, process.cwd(), eventBus, runtime));
		}
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner(extensions, runtime, process.cwd(), SessionManager.inMemory(), modelRegistry);
		const event: CacheWarmingDecisionEvent = {
			type: "cache_warming_decision",
			warmCost: 0.05,
			missCost: 0.5,
			continuationProbability: 0.15,
			held: false,
			action: "warm",
		};

		expect(await runner.emitCacheWarmingDecision(event)).toBe("stop");
	});
});
