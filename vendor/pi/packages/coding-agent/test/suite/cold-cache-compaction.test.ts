import { type AssistantMessage, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionEntry } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const FIVE_MINUTES = 300_000;

/** A session on `main` that compacts with `summary` once its five-minute cache is cold. */
async function coldCacheHarness(coldCache: { minTokens: number; model: string } | undefined): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "main" }, { id: "summary" }],
		settings: { compaction: { keepRecentTokens: 1, ...(coldCache ? { coldCache } : {}) } },
	});
	for (const model of harness.models) (model as Model<string>).promptCache = { short: 300, long: 3600 };
	return harness;
}

/** A response that records which model produced it. */
const reply = (text: string, calls: string[]) => (_context: unknown, _options: unknown, _state: unknown, model: Model<string>) => {
	calls.push(model.id);
	return fauxAssistantMessage(text) as AssistantMessage;
};

const compactions = (harness: Harness) =>
	harness.sessionManager.getEntries().filter((entry): entry is CompactionEntry => entry.type === "compaction");

describe("cold-cache compaction", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("compacts with the configured model before a run whose cache expired", async () => {
		const harness = await coldCacheHarness({ minTokens: 0, model: "faux/summary" });
		harnesses.push(harness);
		const calls: string[] = [];
		// keepRecentTokens: 1 cuts inside the last turn, so compaction summarizes the history and the turn prefix.
		harness.setResponses([
			reply("one", calls),
			reply("two", calls),
			reply("## Goal\nsummary", calls),
			reply("turn prefix summary", calls),
			reply("three", calls),
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		expect(compactions(harness)).toHaveLength(0);

		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now + FIVE_MINUTES + 1000);
		await harness.session.prompt("third");

		expect(calls).toEqual(["main", "main", "summary", "summary", "main"]);
		expect(harness.session.model?.id).toBe("main");
		const [entry] = compactions(harness);
		expect(entry).toMatchObject({ reason: "cold", summary: expect.stringContaining("summary") });
		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["cold"]);
	});

	it("leaves a warm cache, a small context, and an unset setting alone", async () => {
		for (const [coldCache, delay] of [
			[{ minTokens: 0, model: "faux/summary" }, FIVE_MINUTES - 10_000],
			[{ minTokens: 1_000_000, model: "faux/summary" }, FIVE_MINUTES + 1000],
			[undefined, FIVE_MINUTES + 1000],
		] as const) {
			const harness = await coldCacheHarness(coldCache);
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
			await harness.session.prompt("first");
			const now = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(now + delay);
			await harness.session.prompt("second");
			vi.restoreAllMocks();
			expect(compactions(harness)).toHaveLength(0);
		}
	});

	it("counts a warm refresh as keeping the cache alive", async () => {
		const harness = await coldCacheHarness({ minTokens: 0, model: "faux/summary" });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		const now = Date.now();
		const usage = { input: 0, output: 1, cacheRead: 10, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		vi.spyOn(Date, "now").mockReturnValue(now + FIVE_MINUTES - 30_000);
		vi.useFakeTimers({ toFake: ["Date"], now: now + FIVE_MINUTES - 30_000 });
		harness.sessionManager.appendUsage("cache_warm", "faux", "main", usage);
		vi.useRealTimers();
		vi.spyOn(Date, "now").mockReturnValue(now + FIVE_MINUTES + 60_000);
		await harness.session.prompt("second");
		expect(compactions(harness)).toHaveLength(0);
	});
});
