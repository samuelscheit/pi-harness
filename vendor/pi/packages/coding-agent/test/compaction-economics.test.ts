import { describe, expect, it } from "vitest";
import { type CompactionCase, compactionSaving, EXPECTED_REQUESTS } from "../src/core/compaction/economics.ts";

const prices = { read: 0.5e-6, write: 6.25e-6, summaryInput: 1e-6, summaryOutput: 5e-6 };
const base: CompactionCase = { contextTokens: 200_000, keepTokens: 20_000, cold: false, prices };

describe("compactionSaving", () => {
	it("prices carrying the context against one summary and a smaller carried context", () => {
		expect(EXPECTED_REQUESTS).toBe(30);
		// 30 more requests: 200k carried costs 30 × 200k × read = $3; compaction reads 200k ($0.20), writes a
		// 3k summary ($0.015), writes 23k ($0.144) and carries 23k ($0.345).
		expect(compactionSaving(base)).toBeCloseTo(3 - (0.2 + 0.015 + 0.14375 + 0.345), 9);
	});

	it("adds the avoided rewrite of an expired cache", () => {
		expect(compactionSaving({ ...base, cold: true }) - compactionSaving(base)).toBeCloseTo(200_000 * 6.25e-6, 9);
	});

	it("a context no larger than what compaction keeps has nothing to save", () => {
		expect(compactionSaving({ ...base, contextTokens: 20_000 })).toBe(-Infinity);
		expect(compactionSaving({ ...base, contextTokens: 10_000 })).toBe(-Infinity);
	});

	it("a context just above the kept size costs more to compact than it saves", () => {
		expect(compactionSaving({ ...base, contextTokens: 24_000 })).toBeLessThan(0);
	});

	it("the summary of a small remainder is a quarter of it, not the full 3k", () => {
		// 8k summarized → 2k summary, 22k kept.
		const small = { ...base, contextTokens: 28_000 };
		const kept = 22_000;
		const expected =
			30 * 28_000 * prices.read - (28_000 * prices.summaryInput + 2_000 * prices.summaryOutput + kept * prices.write + 30 * kept * prices.read);
		expect(compactionSaving(small)).toBeCloseTo(expected, 12);
	});

	it("break-even: with Opus and Haiku prices a warm context pays from about 36k tokens", () => {
		// 30 × 0.5e-6 − 1e-6 = $14 per million context tokens against a fixed ~$0.50 (summary, kept write and reads).
		expect(compactionSaving({ ...base, contextTokens: 35_000 })).toBeLessThan(0);
		expect(compactionSaving({ ...base, contextTokens: 37_000 })).toBeGreaterThan(0);
	});
});
