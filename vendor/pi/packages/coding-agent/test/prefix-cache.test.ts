import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { isPromptCacheCold } from "../src/core/cache-warmer.ts";
import {
	type BranchPrefix,
	describeBranchPrefix,
	type PrefixCacheRecord,
	PrefixCacheRegistry,
	reachablePrefixes,
} from "../src/core/prefix-cache.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-prefix-cache-"));
	dirs.push(dir);
	return dir;
}

const model = { provider: "anthropic", id: "opus" };
const now = 1_000_000;

function usage(input: number, cacheRead: number, cacheWrite: number): Usage {
	return {
		input,
		output: 1,
		cacheRead,
		cacheWrite,
		totalTokens: input + cacheRead + cacheWrite + 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** A session with a system prompt and `turns` user/assistant pairs. */
function session(turns: number, system = "you are pi"): SessionManager {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "system", content: system, timestamp: 1 });
	for (let turn = 0; turn < turns; turn++) {
		manager.appendMessage({ role: "user", content: `question ${turn}`, timestamp: 2 });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `answer ${turn}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "opus",
			usage: usage(0, 0, 0),
			stopReason: "stop",
			timestamp: 3,
		});
	}
	return manager;
}

const prefixOf = (manager: SessionManager): BranchPrefix => describeBranchPrefix(manager.buildSessionProjection());

describe("describeBranchPrefix", () => {
	it("names every prefix by its entry id chain, without the leading system message", () => {
		const manager = session(2);
		const prefix = prefixOf(manager);
		expect(prefix.points.map((point) => point.end)).toEqual([1, 2, 3, 4]);
		expect(prefix.positions).toBe(4);
		expect(prefix.lastReply).toEqual({ blockStart: 3, blocks: 1, positionStart: 3, positions: 1 });
		// A fork copies the entries with their ids: the same keys.
		const copy = SessionManager.inMemory("/tmp", undefined, manager.getEntries());
		expect(prefixOf(copy).points).toEqual(prefix.points);
	});

	it("hashes the prompt and tools apart from the conversation", () => {
		expect(prefixOf(session(1)).promptHash).not.toBe(prefixOf(session(1, "you are someone else")).promptHash);
		expect(prefixOf(session(1)).promptHash).toBe(prefixOf(session(3)).promptHash);
	});

	it("gives a kept entry a new key after a compaction and after a context edit", () => {
		const manager = session(3);
		const before = prefixOf(manager);
		const kept = manager.getBranch().at(-2)!; // the last user message
		manager.appendCompaction("summary", kept.id, 1000);
		const after = prefixOf(manager);
		const keptBefore = before.points.find((point) => point.entryId === kept.id)!;
		const keptAfter = after.points.find((point) => point.entryId === kept.id)!;
		expect(keptAfter.key).not.toBe(keptBefore.key);

		const edited = session(2);
		const target = edited.getBranch()[1]!;
		const unedited = prefixOf(edited).points.at(-1)!;
		edited.appendContextEdit(target.id, { content: "edited question" });
		expect(prefixOf(edited).points.at(-1)!.entryId).toBe(unedited.entryId);
		expect(prefixOf(edited).points.at(-1)!.key).not.toBe(unedited.key);
	});

	it("counts a run of tool results as one position that ends at the run's last result", () => {
		const manager = session(0);
		manager.appendMessage({ role: "user", content: "go", timestamp: 2 });
		manager.appendMessage({
			role: "assistant",
			content: [
				{ type: "toolCall", id: "a", name: "read", arguments: {} },
				{ type: "toolCall", id: "b", name: "read", arguments: {} },
				{ type: "toolCall", id: "c", name: "read", arguments: {} },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "opus",
			usage: usage(0, 0, 0),
			stopReason: "toolUse",
			timestamp: 3,
		});
		const results = ["a", "b", "c"].map((id) =>
			manager.appendMessage({
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: id }],
				isError: false,
				timestamp: 4,
			}),
		);
		const prefix = prefixOf(manager);
		expect(prefix.blocks).toBe(1 + 3 + 3);
		expect(prefix.positions).toBe(1 + 1 + 1);
		expect(prefix.points.map((point) => [point.entryId, point.end]).slice(-1)).toEqual([[results[2], 3]]);
		expect(prefix.points.some((point) => point.entryId === results[0] || point.entryId === results[1])).toBe(false);
	});
});

describe("reachablePrefixes", () => {
	it("reaches back 20 positions from the final breakpoint, counting it first", () => {
		const prefix = prefixOf(session(15)); // 30 positions
		const ends = (extra: number) => reachablePrefixes(prefix, extra, false).map((point) => point.end);
		// The request itself: its breakpoint is on position 30, so 11..30.
		expect(ends(0)).toEqual(Array.from({ length: 20 }, (_, index) => 11 + index));
		// The next request adds a prompt: 12..30.
		expect(ends(1)).toEqual(Array.from({ length: 19 }, (_, index) => 12 + index));
	});

	it("Pi's bridge keeps the entry before the last reply within reach on Anthropic only", () => {
		const manager = session(2);
		// The last reply, then a user message of 25 blocks.
		manager.appendMessage({
			role: "user",
			content: Array.from({ length: 25 }, (_, index) => ({ type: "text" as const, text: `part ${index}` })),
			timestamp: 5,
		});
		const prefix = prefixOf(manager);
		const beforeReply = prefix.points.at(-3)!; // question 1
		expect(beforeReply.end).toBe(prefix.lastReply!.positionStart);
		expect(reachablePrefixes(prefix, 1, false)).not.toContainEqual(beforeReply);
		expect(reachablePrefixes(prefix, 1, true)).toContainEqual(beforeReply);
	});
});

describe("PrefixCacheRegistry", () => {
	it("records a request's final prefix and refreshes the prefix its partial read covered", () => {
		const registry = new PrefixCacheRegistry(tempDir());
		const source = session(2);
		const sourcePrefix = prefixOf(source);
		registry.recordRequest({ model, bridge: true, ttlMs: 300_000, prefix: sourcePrefix }, usage(0, 0, 4000), now);
		const sourceFinal = sourcePrefix.points.at(-1)!;
		expect(registry.get(model, sourcePrefix.promptHash, sourceFinal)).toMatchObject({
			tokens: 4000,
			cache: "write",
			at: now,
			expiresAt: now + 300_000,
		});

		// A fork adds a prompt and reads the source's entry: 4000 tokens read, 50 written.
		const fork = SessionManager.inMemory("/tmp", undefined, source.getEntries());
		fork.appendMessage({ role: "user", content: "fork task", timestamp: 9 });
		const forkPrefix = prefixOf(fork);
		registry.recordRequest(
			{ model, bridge: true, ttlMs: 300_000, prefix: forkPrefix },
			usage(0, 4000, 50),
			now + 60_000,
		);
		expect(registry.get(model, sourcePrefix.promptHash, sourceFinal)).toMatchObject({
			tokens: 4000,
			cache: "read",
			at: now + 60_000,
			expiresAt: now + 360_000,
		});
		expect(registry.get(model, forkPrefix.promptHash, forkPrefix.points.at(-1)!)?.tokens).toBe(4050);
	});

	it("does not count a read of only the system prompt and tools as a read of the conversation", () => {
		const registry = new PrefixCacheRegistry(tempDir());
		const source = session(2);
		const sourcePrefix = prefixOf(source);
		registry.recordRequest({ model, bridge: true, ttlMs: 300_000, prefix: sourcePrefix }, usage(0, 0, 4000), now);
		const fork = SessionManager.inMemory("/tmp", undefined, source.getEntries());
		fork.appendMessage({ role: "user", content: "fork task", timestamp: 9 });
		registry.recordRequest(
			{ model, bridge: true, ttlMs: 300_000, prefix: prefixOf(fork) },
			usage(0, 1500, 2600),
			now + 400_000,
		);
		expect(registry.get(model, sourcePrefix.promptHash, sourcePrefix.points.at(-1)!)?.at).toBe(now);
	});

	it("ignores requests without cache activity and keeps the later expiry", () => {
		const registry = new PrefixCacheRegistry(tempDir());
		const prefix = prefixOf(session(1));
		registry.recordRequest({ model, bridge: true, ttlMs: 300_000, prefix }, usage(500, 0, 0), now);
		expect(registry.get(model, prefix.promptHash, prefix.points.at(-1)!)).toBeUndefined();
		registry.touch(model, prefix.promptHash, prefix.points.at(-1)!, { cache: "write", at: now, ttlMs: 3_600_000 });
		registry.touch(model, prefix.promptHash, prefix.points.at(-1)!, {
			cache: "read",
			at: now + 1000,
			ttlMs: 300_000,
		});
		expect(registry.get(model, prefix.promptHash, prefix.points.at(-1)!)?.expiresAt).toBe(now + 3_600_000);
	});

	describe("warm and cold", () => {
		const ttl = 300_000;
		function recorded() {
			const registry = new PrefixCacheRegistry(tempDir());
			const source = session(2);
			const prefix = prefixOf(source);
			registry.recordRequest({ model, bridge: true, ttlMs: ttl, prefix }, usage(0, 0, 4000), now);
			return { registry, source, prefix };
		}
		// The session's own entries say cold: the last reply is older than the lifetime.
		const ownCold = (manager: SessionManager, at: number) => isPromptCacheCold(manager.getBranch(), ttl, at);

		it("a live entry within reach makes a branch whose own timestamps are old warm", () => {
			const { registry, source, prefix } = recorded();
			const at = now + ttl - 1;
			expect(ownCold(source, at)).toBe(true);
			expect(isPromptCacheCold(source.getBranch(), ttl, at, { registry, model, bridge: true, prefix })).toBe(false);
			expect(
				isPromptCacheCold(source.getBranch(), ttl, now + ttl + 1, { registry, model, bridge: true, prefix }),
			).toBe(true);
		});

		it("another model or another prompt hash does not count", () => {
			const { registry, source, prefix } = recorded();
			const at = now + 1000;
			const shared = { registry, bridge: true, prefix };
			expect(isPromptCacheCold(source.getBranch(), ttl, at, { ...shared, model: { ...model, id: "sonnet" } })).toBe(
				true,
			);
			expect(
				isPromptCacheCold(source.getBranch(), ttl, at, {
					...shared,
					model,
					prefix: { ...prefix, promptHash: prefixOf(session(2, "other prompt")).promptHash },
				}),
			).toBe(true);
		});

		it("an entry too far from the branch end does not count", () => {
			const { registry, source } = recorded();
			// 20 more positions after the recorded entry, then the prompt: 21 back from the breakpoint.
			for (let turn = 0; turn < 10; turn++) {
				source.appendMessage({ role: "user", content: `more ${turn}`, timestamp: 2 });
				source.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: `reply ${turn}` }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "opus",
					usage: usage(0, 0, 0),
					stopReason: "stop",
					timestamp: 3,
				});
			}
			const far = prefixOf(source);
			const at = now + 1000;
			expect(registry.findWarm(model, far, false, at)).toBeUndefined();
			expect(isPromptCacheCold(source.getBranch(), ttl, at, { registry, model, bridge: false, prefix: far })).toBe(
				true,
			);
			// 18 positions after it, then the prompt: the breakpoint's lookback (itself first) ends on it.
			const entries = source.buildSessionProjection().entries.slice(0, -2);
			const near = describeBranchPrefix({ entries, messages: entries.flatMap((entry) => entry.messages) });
			expect(registry.findWarm(model, near, false, at)?.tokens).toBe(4000);
		});
	});

	it("prunes expired records and abandoned temporary files, keeps live ones", () => {
		const dir = tempDir();
		const registry = new PrefixCacheRegistry(dir);
		const prefix = prefixOf(session(3));
		const [first, second] = prefix.points;
		registry.touch(model, prefix.promptHash, first!, { cache: "write", at: now, ttlMs: 1000 });
		registry.touch(model, prefix.promptHash, second!, { cache: "write", at: now, ttlMs: 10_000 });
		writeFileSync(join(dir, "x.json.1.ab.tmp"), "{");
		utimesSync(join(dir, "x.json.1.ab.tmp"), 0, 0);
		writeFileSync(join(dir, "garbage.json"), "not json");
		registry.prune(now + 5000);
		expect(registry.get(model, prefix.promptHash, first!)).toBeUndefined();
		expect(registry.get(model, prefix.promptHash, second!)).toBeDefined();
		expect(readdirSync(dir)).toHaveLength(1);
	});

	it("stays consistent with eight processes writing the same records", async () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		const resolver = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
		const writer = resolve(__dirname, "fixtures/prefix-cache-writer.ts");
		const lasts = await Promise.all(
			Array.from(
				{ length: 8 },
				(_, index) =>
					new Promise<number>((done, fail) => {
						const child = spawn(
							process.execPath,
							["--import", resolver, writer, dir, String(index), "100", "5"],
							{
								stdio: ["ignore", "pipe", "inherit"],
							},
						);
						let out = "";
						child.stdout.on("data", (chunk) => {
							out += chunk;
						});
						child.on("error", fail);
						child.on("close", (code) =>
							code === 0 ? done(Number(out)) : fail(new Error(`writer exited ${code}`)),
						);
					}),
			),
		);
		const names = readdirSync(dir);
		expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(names).toHaveLength(5);
		const latest = Math.max(...lasts);
		for (const name of names) {
			const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as PrefixCacheRecord;
			expect(record.tokens).toBeGreaterThanOrEqual(100);
			// Two writers replacing one record in the same instant keep one of their expiries.
			expect(record.expiresAt).toBeGreaterThan(latest + 60_000 - 1000);
		}
	}, 60_000);
});
