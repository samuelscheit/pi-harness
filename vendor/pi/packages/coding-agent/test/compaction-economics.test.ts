import { describe, expect, it } from "vitest";
import { type CompactionCase, compactionSaving, expectedRequests } from "../src/core/compaction/economics.ts";

const prices = { read: 0.5e-6, write: 6.25e-6, summaryInput: 1e-6, summaryOutput: 5e-6 };
const base: CompactionCase = { contextTokens: 200_000, keepTokens: 20_000, cold: false, pastRequests: 100, prices };

describe("expectedRequests", () => {
	it("is half the past requests, at least 10 and at most 60", () => {
		expect(expectedRequests(0)).toBe(10);
		expect(expectedRequests(40)).toBe(20);
		expect(expectedRequests(1000)).toBe(60);
	});
});

describe("compactionSaving", () => {
	it("prices carrying the context against one summary and a smaller carried context", () => {
		// 50 more requests: 200k carried costs 50 × 200k × read = $5; compaction reads 200k ($0.20), writes a
		// 3k summary ($0.015), writes 23k ($0.144) and carries 23k ($0.575).
		expect(compactionSaving(base)).toBeCloseTo(5 - (0.2 + 0.015 + 0.14375 + 0.575), 9);
	});

	it("adds the avoided rewrite of an expired cache", () => {
		expect(compactionSaving({ ...base, cold: true }) - compactionSaving(base)).toBeCloseTo(200_000 * 6.25e-6, 9);
	});

	it("a context no larger than what compaction keeps has nothing to save", () => {
		expect(compactionSaving({ ...base, contextTokens: 20_000 })).toBe(-Infinity);
		expect(compactionSaving({ ...base, contextTokens: 10_000 })).toBe(-Infinity);
	});

	it("a context just above the kept size costs more to compact than it saves", () => {
		expect(compactionSaving({ ...base, contextTokens: 24_000, pastRequests: 0 })).toBeLessThan(0);
	});

	it("the summary of a small remainder is a quarter of it, not the full 3k", () => {
		// 4k summarized → 1k summary.
		const small = { ...base, contextTokens: 24_000, keepTokens: 20_000, pastRequests: 0 };
		const kept = 21_000;
		const expected = 10 * 24_000 * prices.read - (24_000 * prices.summaryInput + 1_000 * prices.summaryOutput + kept * prices.write + 10 * kept * prices.read);
		expect(compactionSaving(small)).toBeCloseTo(expected, 12);
	});

	it("a long session saves more than a fresh one with the same context", () => {
		expect(compactionSaving({ ...base, pastRequests: 120 })).toBeGreaterThan(compactionSaving({ ...base, pastRequests: 4 }));
	});
});
