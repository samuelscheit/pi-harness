import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeBranchPrefix, PrefixCacheRegistry, READS_KEPT_MS } from "../src/core/prefix-cache.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../src/core/session-manager.ts";
import { SharedPrefixCache } from "../src/core/shared-prefix.ts";
import {
	nextReadProbability,
	prefixWarmingDecision,
	TemplatePrefix,
	templatePrefixLock,
} from "../src/core/template-prefix.ts";

const dirs: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-template-prefix-"));
	dirs.push(dir);
	return dir;
}

const HOUR = 3_600_000;
const zero: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const model = {
	id: "opus",
	provider: "anthropic",
	api: "anthropic-messages",
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
} as Model<Api>;

/** A template file: a prepared conversation without a system message, ending in a user message. */
function writeTemplate(dir: string): string {
	const path = join(dir, "template.jsonl");
	const at = new Date(0).toISOString();
	const lines = [
		{
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "tmpl",
			timestamp: at,
			cwd: dir,
			template: { name: "review" },
		},
		// About 50k tokens: large enough that keeping it cached pays.
		{
			type: "message",
			id: "t1",
			parentId: null,
			timestamp: at,
			message: { role: "user", content: `You review code. ${"word ".repeat(40_000)}`, timestamp: 0 },
		},
		{
			type: "message",
			id: "t2",
			parentId: "t1",
			timestamp: at,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Understood." }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "opus",
				usage: zero,
				stopReason: "stop",
				timestamp: 0,
			},
		},
		{
			type: "message",
			id: "t3",
			parentId: "t2",
			timestamp: at,
			message: { role: "user", content: "The task follows.", timestamp: 0 },
		},
	];
	writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return path;
}

/** A fork of the template that ran: its prompt recorded after the template, then its task. */
function fork(template: string, dir: string, prompt: string, task: string): SessionManager {
	const manager = SessionManager.forkFrom(template, dir, join(dir, "sessions"));
	manager.appendMessage({ role: "system", content: prompt, timestamp: 1 });
	manager.appendMessage({ role: "user", content: task, timestamp: 2 });
	return manager;
}

describe("template forks", () => {
	it("carry the template in their header and put their prompt in front of the template", () => {
		const dir = tempDir();
		const template = writeTemplate(dir);
		const child = fork(template, dir, "you are pi", "review a.ts");
		expect(child.getHeader()?.fork).toEqual({
			leafId: "t3",
			template: { name: "review" },
		});
		const roles = child.buildSessionProjection().messages.map((message) => message.role);
		expect(roles).toEqual(["system", "user", "assistant", "user", "user"]);
		// In the file the prompt stays where the run recorded it.
		expect(child.getBranch().map((entry) => (entry.type === "message" ? entry.message.role : entry.type))).toEqual([
			"user",
			"assistant",
			"user",
			"system",
			"user",
		]);
	});

	it("share the template's prefix keys whatever their prompt entry; the prompt only changes the prompt hash", () => {
		const dir = tempDir();
		const template = writeTemplate(dir);
		const one = describeBranchPrefix(fork(template, dir, "you are pi", "task one").buildSessionProjection());
		const two = describeBranchPrefix(fork(template, dir, "you are pi", "task two").buildSessionProjection());
		const released = describeBranchPrefix(
			fork(template, dir, "you are pi, release 2", "task one").buildSessionProjection(),
		);
		const templatePoints = (prefix: typeof one) =>
			prefix.points.filter((point) => ["t1", "t2", "t3"].includes(point.entryId));
		expect(templatePoints(one)).toHaveLength(3);
		expect(templatePoints(two)).toEqual(templatePoints(one));
		expect(two.promptHash).toBe(one.promptHash);
		// A prompt change (a harness release) keeps the template's chain but names another prompt: a new cache entry.
		expect(templatePoints(released)).toEqual(templatePoints(one));
		expect(released.promptHash).not.toBe(one.promptHash);
		const registry = new PrefixCacheRegistry(join(dir, "registry"));
		const point = templatePoints(one).at(-1)!;
		registry.touch(model, one.promptHash, point, { tokens: 100, cache: "write", at: 0, ttlMs: HOUR });
		expect(registry.get(model, two.promptHash, point)?.tokens).toBe(100);
		expect(registry.get(model, released.promptHash, point)).toBeUndefined();
	});
});

describe("prefix reads", () => {
	it("are kept per record for a day, also past the entry's expiry", () => {
		const dir = tempDir();
		const registry = new PrefixCacheRegistry(dir);
		const point = { key: "k", entryId: "e", end: 3 };
		registry.noteRead(model, "p", point, 1_000, 400);
		registry.touch(model, "p", point, { tokens: 500, cache: "write", at: 2_000, ttlMs: 300_000 });
		registry.noteRead(model, "p", point, 3_000, 400);
		const record = registry.get(model, "p", point)!;
		expect(record.reads).toEqual([1_000, 3_000]);
		expect(record.tokens).toBe(500);
		expect(record.expiresAt).toBe(302_000);
		// Expired, but read within the day: kept, still cold.
		registry.prune(400_000);
		expect(registry.get(model, "p", point)?.reads).toEqual([1_000, 3_000]);
		registry.prune(3_000 + READS_KEPT_MS);
		expect(registry.get(model, "p", point)).toBeUndefined();
		// Older reads fall out as new ones come.
		registry.noteRead(model, "p", point, 0, 10);
		registry.noteRead(model, "p", point, READS_KEPT_MS + 1, 10);
		expect(registry.get(model, "p", point)?.reads).toEqual([READS_KEPT_MS + 1]);
	});

	it("give the chance of the next fork within the cache lifetime", () => {
		const now = 10 * HOUR;
		expect(nextReadProbability([], now, HOUR)).toBe(0);
		// One read in the last hour: a rate of one per hour.
		expect(nextReadProbability([now - 60_000], now, HOUR)).toBeCloseTo(1 - Math.exp(-1), 5);
		expect(nextReadProbability([now - 60_000], now, 300_000)).toBeCloseTo(1 - Math.exp(-1 / 12), 5);
		// Six reads over the last six hours: one per hour too.
		const six = [1, 2, 3, 4, 5, 6].map((hours) => now - hours * HOUR + 1);
		expect(nextReadProbability(six, now, HOUR)).toBeCloseTo(1 - Math.exp(-1), 2);
		// Reads older than a day do not count.
		expect(nextReadProbability([now - READS_KEPT_MS - 1], now, HOUR)).toBe(0);
	});

	it("decide whether a write pays like a cache warm", () => {
		// 40k tokens with the one-hour cache: a miss costs 40k × (10 − 0.5) $/M, a warm 40k × 0.5 $/M.
		const likely = prefixWarmingDecision(model, 40_000, 0.6, "long");
		expect(likely.missCost).toBeCloseTo(0.38, 5);
		expect(likely.warmCost).toBeCloseTo(0.020025, 5);
		expect(likely.pays).toBe(true);
		expect(prefixWarmingDecision(model, 40_000, 0.1, "long").pays).toBe(false);
		expect(prefixWarmingDecision(model, 40_000, 0, "long").pays).toBe(false);
		const free = { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<Api>;
		expect(prefixWarmingDecision(free, 40_000, 1, "long").pays).toBe(false);
	});
});

describe("TemplatePrefix", () => {
	/** A template fork and a TemplatePrefix whose primes the cache answers like Anthropic: read when live, else write. */
	function setup() {
		const dir = tempDir();
		const template = writeTemplate(dir);
		const shared = SharedPrefixCache.forAgentDir(join(dir, "agent"));
		const sent: { at: number; cacheRead: number; cacheWrite: number }[] = [];
		const keeper = (manager: SessionManager) =>
			new TemplatePrefix({
				shared,
				describe: (_model, projection) => shared.request(model, HOUR, projection),
				send: async (_model, projection) => {
					const request = shared.request(model, HOUR, projection);
					const record = shared.registry.get(model, request.prefix.promptHash, request.prefix.points.at(-1)!);
					const live = (record?.expiresAt ?? 0) > Date.now();
					const usage = {
						...zero,
						input: 0,
						output: 1,
						cacheRead: live ? 50_000 : 0,
						cacheWrite: live ? 0 : 50_000,
					};
					sent.push({ at: Date.now(), cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
					return { usage, provider: "anthropic", model: "opus" };
				},
				sent: (result) => manager.appendUsage("cache_prime", result.provider, result.model, result.usage),
				retention: () => "long",
			});
		const use = async (task: string) => {
			const manager = fork(template, dir, "you are pi", task);
			const prefix = keeper(manager);
			await prefix.beforeFirstRequest(model, HOUR, manager.buildSessionProjection(), "t3");
			return { manager, prefix };
		};
		return { dir, template, shared, sent, use };
	}

	it("writes nothing for a template's first fork, then primes for the next one and refreshes while forks keep coming", async () => {
		vi.useFakeTimers({ now: 10 * HOUR });
		const { sent, use } = setup();
		// Nobody forked it before: the fork's own request writes what it needs.
		const first = await use("one");
		expect(sent).toHaveLength(0);
		first.prefix.dispose();

		// Ten minutes later: one fork in the last hour makes another likely within the hour.
		await vi.advanceTimersByTimeAsync(600_000);
		const second = await use("two");
		expect(sent).toEqual([{ at: 10 * HOUR + 600_000, cacheRead: 0, cacheWrite: 50_000 }]);
		expect(
			second.manager.getBranch().filter((entry) => entry.type === "usage" && entry.kind === "cache_prime"),
		).toHaveLength(1);

		// A third fork finds the entry alive: no prime.
		await vi.advanceTimersByTimeAsync(600_000);
		const third = await use("three");
		third.prefix.dispose();
		expect(sent).toHaveLength(1);

		// The second fork's keeper refreshes at 90% of the hour after its prime, reading the entry.
		await vi.advanceTimersByTimeAsync(0.9 * HOUR - 600_000);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toMatchObject({ cacheRead: 50_000, cacheWrite: 0 });

		// Without further forks the rate falls; at some refresh the next fork is no longer likely enough.
		await vi.advanceTimersByTimeAsync(30 * HOUR);
		const refreshes = sent.length - 1;
		expect(refreshes).toBeGreaterThan(1);
		expect(refreshes).toBeLessThan(30);
		await vi.advanceTimersByTimeAsync(10 * HOUR);
		expect(sent.length - 1).toBe(refreshes);
		second.prefix.dispose();
	});

	it("primes once for forks that wait on the lock at the same time", async () => {
		const { dir, template, shared, sent, use } = setup();
		const prefix = describeBranchPrefix(fork(template, dir, "you are pi", "probe").buildSessionProjection());
		const lock = templatePrefixLock(model, prefix.promptHash, prefix.points.find((point) => point.entryId === "t3")!);
		// A parallel fork holds the prefix's lock while three more queue up behind it.
		let release!: () => void;
		const held = shared.bases.locks.withLock(
			lock,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const waiting = [use("a"), use("b"), use("c")];
		await vi.waitFor(() => expect(shared.bases.locks.waiters(lock)).toBe(3));
		release();
		await held;
		for (const { prefix: keeper } of await Promise.all(waiting)) keeper.dispose();
		// The first behind the lock saw the others waiting and primed; the others found the entry alive.
		expect(sent).toHaveLength(1);
		expect(sent[0]!.cacheWrite).toBe(50_000);
	});
});
