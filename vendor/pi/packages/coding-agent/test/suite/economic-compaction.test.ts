import { type AssistantMessage, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeSummaryModel } from "../../src/core/compaction/index.ts";
import type { CompactionEntry } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const FIVE_MINUTES = 300_000;
// Opus-like session model, Haiku-like summary model, dollars per million tokens.
const MAIN_COST = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const SUMMARY_COST = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
// ~40k tokens of context per prompt (4 characters per token).
const BIG = "word ".repeat(32_000);

/** A session on `main` that compacts with `summaryModel` when that saves at least `minSaving` dollars. */
async function economicHarness(
	minSaving: number | undefined,
	warm = true,
	summaryModel = "faux/summary",
): Promise<Harness> {
	const harness = await createHarness({
		models: [
			{ id: "main", cost: MAIN_COST },
			{ id: "summary", cost: SUMMARY_COST },
		],
		// Five-minute cache, whatever PI_CACHE_RETENTION the environment sets.
		settings: {
			cacheRetention: "short",
			compaction: {
				keepRecentTokens: 1_000,
				...(minSaving === undefined ? {} : { economic: { model: summaryModel, minSaving, warm } }),
			},
		},
	});
	for (const model of harness.models) (model as Model<string>).promptCache = { short: 300, long: 3600 };
	return harness;
}

/** A response that records which model produced it. */
const reply =
	(text: string, calls: string[]) => (_context: unknown, _options: unknown, _state: unknown, model: Model<string>) => {
		calls.push(model.id);
		return fauxAssistantMessage(text) as AssistantMessage;
	};

const compactions = (harness: Harness) =>
	harness.sessionManager.getEntries().filter((entry): entry is CompactionEntry => entry.type === "compaction");

/** Two big prompts, then a third after `delay`; returns the models called. */
async function run(harness: Harness, delay: number): Promise<string[]> {
	const calls: string[] = [];
	harness.setResponses([
		reply("one", calls),
		reply("two", calls),
		reply("## Goal\nsummary", calls),
		reply("prefix summary", calls),
		reply("three", calls),
	]);
	await harness.session.prompt(`first ${BIG}`);
	await harness.session.prompt(`second ${BIG}`);
	expect(compactions(harness)).toHaveLength(0);
	const now = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(now + delay);
	await harness.session.prompt("third");
	return calls;
}

describe("economic compaction", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("compacts a large context with the summary model when that is cheaper than carrying it", async () => {
		const harness = await economicHarness(0);
		harnesses.push(harness);
		const calls = await run(harness, 1000);
		expect(calls[0]).toBe("main");
		expect(calls.slice(2, -1).every((id) => id === "summary")).toBe(true);
		expect(calls.at(-1)).toBe("main");
		expect(harness.session.model?.id).toBe("main");
		expect(compactions(harness).map((entry) => entry.reason)).toEqual(["economic"]);
		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["economic"]);
		// The entry names the summary model that ran it, not the session's model.
		expect(compactions(harness).map((entry) => [entry.provider, entry.model])).toEqual([["faux", "summary"]]);
		expect(harness.eventsOfType("compaction_end").map((event) => event.result?.generatedBy)).toEqual([
			{ provider: "faux", model: "summary" },
		]);
	});

	it("an expired cache adds the rewrite to the saving: compacts cold where warm would not pay enough", async () => {
		// Two prompts carry ~80k tokens. Warm, 30 more requests save ~$0.95; cold adds the avoided ~$0.50 rewrite.
		const warm = await economicHarness(1.2);
		harnesses.push(warm);
		await run(warm, FIVE_MINUTES - 10_000);
		vi.restoreAllMocks();
		expect(compactions(warm)).toHaveLength(0);

		const cold = await economicHarness(1.2);
		harnesses.push(cold);
		await run(cold, FIVE_MINUTES + 1000);
		expect(compactions(cold).map((entry) => entry.reason)).toEqual(["cold"]);
	});

	it("without `warm`, a warm cache is never compacted, an expired one still is", async () => {
		const warm = await economicHarness(0, false);
		harnesses.push(warm);
		await run(warm, 1000);
		vi.restoreAllMocks();
		expect(compactions(warm)).toHaveLength(0);

		const cold = await economicHarness(0, false);
		harnesses.push(cold);
		await run(cold, FIVE_MINUTES + 1000);
		expect(compactions(cold).map((entry) => entry.reason)).toEqual(["cold"]);
	});

	it("leaves a small context, a high threshold and an unset setting alone", async () => {
		for (const [minSaving, big] of [
			[0, false],
			[100, true],
			[undefined, true],
		] as const) {
			const harness = await economicHarness(minSaving);
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage("one"),
				fauxAssistantMessage("two"),
				fauxAssistantMessage("three"),
			]);
			await harness.session.prompt(big ? `first ${BIG}` : "first");
			await harness.session.prompt(big ? `second ${BIG}` : "second");
			const now = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(now + FIVE_MINUTES + 1000);
			await harness.session.prompt("third");
			vi.restoreAllMocks();
			expect(compactions(harness)).toHaveLength(0);
		}
	});

	describe("manual compaction", () => {
		/** Two small prompts, then `/compact` after `delay`; returns the models called and the summary request. */
		async function compactAfter(harness: Harness, delay: number, instructions?: string) {
			const calls: string[] = [];
			const requests: string[] = [];
			const summarize = (context: unknown, _options: unknown, _state: unknown, model: Model<string>) => {
				calls.push(model.id);
				requests.push(JSON.stringify(context));
				return fauxAssistantMessage("## Goal\nsummary") as AssistantMessage;
			};
			harness.setResponses([reply("one", calls), reply("two", calls), summarize, summarize]);
			await harness.session.prompt(`first ${"word ".repeat(2_000)}`);
			await harness.session.prompt(`second ${"word ".repeat(2_000)}`);
			const now = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(now + delay);
			const result = await harness.session.compact(instructions);
			return { calls: calls.slice(2), requests, result };
		}

		it("an expired cache: the economic model writes the summary, whatever minSaving says", async () => {
			const harness = await economicHarness(1000, false);
			harnesses.push(harness);
			const { calls, result } = await compactAfter(harness, FIVE_MINUTES + 1000);
			expect(calls.length).toBeGreaterThan(0);
			expect(calls.every((id) => id === "summary")).toBe(true);
			expect(result.generatedBy).toEqual({ provider: "faux", model: "summary" });
			expect(result.summaryModelReason).toBe("cache expired");
			expect(describeSummaryModel(result)).toBe("cache expired: summary by summary");
			expect(compactions(harness).map((entry) => [entry.reason, entry.model])).toEqual([["manual", "summary"]]);
			expect(harness.eventsOfType("compaction_end").map((event) => event.result?.summaryModelReason)).toEqual([
				"cache expired",
			]);
			expect(harness.session.model?.id).toBe("main");
		});

		it("a warm cache: the session model writes the summary", async () => {
			const harness = await economicHarness(0);
			harnesses.push(harness);
			const { calls, result } = await compactAfter(harness, 1000);
			expect(calls.length).toBeGreaterThan(0);
			expect(calls.every((id) => id === "main")).toBe(true);
			expect(result.generatedBy).toEqual({ provider: "faux", model: "main" });
			expect(result.summaryModelReason).toBeUndefined();
			expect(describeSummaryModel(result)).toBeUndefined();
		});

		it("an expired cache without an economic model, or with an unknown one: the session model", async () => {
			for (const harness of [await economicHarness(undefined), await economicHarness(0, true, "faux/missing")]) {
				harnesses.push(harness);
				const { calls, result } = await compactAfter(harness, FIVE_MINUTES + 1000);
				vi.restoreAllMocks();
				expect(calls.length).toBeGreaterThan(0);
				expect(calls.every((id) => id === "main")).toBe(true);
				expect(result.generatedBy).toEqual({ provider: "faux", model: "main" });
				expect(result.summaryModelReason).toBeUndefined();
			}
		});

		it("passes custom instructions to the economic model", async () => {
			const harness = await economicHarness(0);
			harnesses.push(harness);
			const { calls, requests } = await compactAfter(harness, FIVE_MINUTES + 1000, "keep the zebra decision");
			expect(calls[0]).toBe("summary");
			expect(requests[0]).toContain("keep the zebra decision");
		});
	});

	it("counts a warm refresh as keeping the cache alive", async () => {
		const harness = await economicHarness(1.2);
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		await harness.session.prompt(`first ${BIG}`);
		await harness.session.prompt(`second ${BIG}`);
		const now = Date.now();
		const usage = {
			input: 0,
			output: 1,
			cacheRead: 10,
			cacheWrite: 0,
			totalTokens: 11,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		vi.useFakeTimers({ toFake: ["Date"], now: now + FIVE_MINUTES - 30_000 });
		harness.sessionManager.appendUsage("cache_warm", "faux", "main", usage);
		vi.useRealTimers();
		vi.spyOn(Date, "now").mockReturnValue(now + FIVE_MINUTES + 60_000);
		await harness.session.prompt("third");
		expect(compactions(harness)).toHaveLength(0);
	});
});
