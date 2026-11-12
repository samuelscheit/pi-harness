import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bestCompaction, cacheWarm, type Child, resumeCost, type Turn } from "../extensions/metrics/efficiency.ts";

// Opus-like prices per token.
const READ = 0.5e-6;
const WRITE = 6.25e-6;
const INPUT = 5e-6;

const child: Child = { cost: 1.2, requests: 30, baseTokens: 17_000, startupCost: 0.11, rediscoveryCost: 0.3, readRate: READ, writeRate: WRITE };

describe("resumeCost", () => {
	const now = 10 * 60_000;

	test("a warm agent costs its extra context on every request instead of the startup and rediscovery", () => {
		const agent = { contextTokens: 117_000, lastTs: now - 60_000, longRetention: false };
		assert.ok(cacheWarm(agent, now));
		assert.ok(Math.abs(resumeCost(child, agent, now) - (1.2 - 0.11 - 0.3 + 30 * 100_000 * READ)) < 1e-9);
	});

	test("a cold agent also rewrites its whole context once", () => {
		const agent = { contextTokens: 117_000, lastTs: now - 6 * 60_000, longRetention: false };
		assert.equal(cacheWarm(agent, now), false);
		assert.ok(Math.abs(resumeCost(child, agent, now) - (1.2 - 0.11 - 0.3 + 30 * 100_000 * READ + 117_000 * WRITE)) < 1e-9);
	});

	test("one-hour retention keeps an agent warm past five minutes, not past the hour", () => {
		assert.equal(cacheWarm({ contextTokens: 1, lastTs: 0, longRetention: true }, 59 * 60_000), true);
		assert.equal(cacheWarm({ contextTokens: 1, lastTs: 0, longRetention: true }, 61 * 60_000), false);
	});

	test("a small agent is never charged negative extra context", () => {
		const agent = { contextTokens: 5_000, lastTs: now, longRetention: true };
		assert.ok(Math.abs(resumeCost(child, agent, now) - (1.2 - 0.11 - 0.3)) < 1e-9);
	});

	test("the gateway case: a fresh subagent beat resuming a warm 128k one", () => {
		const fresh: Child = { cost: 1.76, requests: 41, baseTokens: 16_600, startupCost: 0.133, rediscoveryCost: 0.346, readRate: READ, writeRate: WRITE };
		const warm = { contextTokens: 128_000, lastTs: now - 60_000, longRetention: true };
		assert.ok(resumeCost(fresh, warm, now) > fresh.cost);
	});
});

describe("bestCompaction", () => {
	const turn = (promptTokens: number): Turn => ({ promptTokens, inputRate: INPUT, readRate: READ, writeRate: WRITE });

	test("contexts that never outgrow what a compaction keeps have nothing to save", () => {
		assert.equal(bestCompaction([10_000, 15_000, 22_000].map(turn)), undefined);
		assert.equal(bestCompaction([]), undefined);
	});

	test("a big context with many requests left is worth compacting", () => {
		const turns = Array.from({ length: 100 }, (_, i) => turn(30_000 + i * 2_000));
		const best = bestCompaction(turns)!;
		// Compacting at request i saves (p_i - 23k) on each of the 99 - i later requests, minus its own cost.
		const saving = (i: number) => (turns[i]!.promptTokens - 23_000) * READ * (99 - i) - (turns[i]!.promptTokens * READ + 3_000 * INPUT * 5 + 23_000 * WRITE);
		const expected = turns.map((_, i) => saving(i)).reduce((a, b) => Math.max(a, b));
		assert.ok(Math.abs(best.saving - expected) < 1e-9);
		assert.ok(best.index > 0 && best.index < 99);
	});

	test("compacting right before the end does not pay for itself", () => {
		// Reading 200k, writing a summary and rewriting what is kept (~$0.32) beats one cheaper read ($0.09).
		assert.equal(bestCompaction([turn(200_000), turn(201_000)]), undefined);
		assert.equal(bestCompaction([turn(200_000)]), undefined);
		// With enough requests left the same compaction pays.
		assert.equal(bestCompaction(Array.from({ length: 6 }, () => turn(200_000)))?.index, 0);
	});
});
