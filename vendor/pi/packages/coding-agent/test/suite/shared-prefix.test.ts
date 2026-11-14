import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionEntry, SessionManager as SessionManagerType } from "../../src/core/session-manager.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SharedPrefixCache } from "../../src/core/shared-prefix.ts";
import { createHarness, type Harness } from "./harness.ts";

const FIVE_MINUTES = 300_000;
const MAIN_COST = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const SUMMARY_COST = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
const BIG = "word ".repeat(32_000);
const LOOKBACK = 20;

interface SimRequest {
	label: string;
	model: string;
	cacheRead: number;
	cacheWrite: number;
	maxTokens?: number;
}

/**
 * Anthropic's prompt cache across sessions: a breakpoint on the last message writes an entry for
 * the prefix ending there; a request reads the longest live entry among the 20 positions ending at
 * its breakpoint and refreshes it. One position per message (the tests send one block each).
 */
class SimulatedCache {
	private readonly entries = new Map<string, { expiresAt: number; tokens: number }>();
	readonly requests: SimRequest[] = [];

	attach(harness: Harness, label: string): void {
		const agent = harness.session.agent;
		const inner = agent.streamFunction;
		const stream: StreamFn = async (model, context, options) => {
			const source = await inner(model, context, options);
			const out = createAssistantMessageEventStream();
			void (async () => {
				for await (const event of source) {
					if (event.type === "done") this.apply(event.message, model, context.messages, label, options?.maxTokens);
					out.push(event);
				}
			})();
			return out;
		};
		agent.streamFunction = stream;
	}

	private apply(
		message: AssistantMessage,
		model: Model<string>,
		messages: Message[],
		label: string,
		maxTokens?: number,
	) {
		const now = Date.now();
		const wire = messages.map((m) => ({ role: m.role, content: m.content }));
		const start = wire[0]?.role === "system" ? 1 : 0;
		const prefixes = wire.slice(start).map((_, index) => {
			const text = JSON.stringify(wire.slice(0, start + index + 1));
			return {
				key: createHash("sha256").update(`${model.id}\n${text}`).digest("hex"),
				tokens: Math.ceil(text.length / 4),
			};
		});
		const last = prefixes.at(-1);
		if (!last) return;
		let read: { key: string; tokens: number } | undefined;
		for (let index = prefixes.length - 1; index >= Math.max(0, prefixes.length - LOOKBACK); index--) {
			const entry = this.entries.get(prefixes[index]!.key);
			if (entry && entry.expiresAt > now) {
				read = prefixes[index];
				break;
			}
		}
		if (read) this.entries.set(read.key, { expiresAt: now + FIVE_MINUTES, tokens: read.tokens });
		this.entries.set(last.key, { expiresAt: now + FIVE_MINUTES, tokens: last.tokens });
		const cacheRead = read?.tokens ?? 0;
		message.usage = {
			input: 0,
			output: 1,
			cacheRead,
			cacheWrite: last.tokens - cacheRead,
			totalTokens: last.tokens + 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		this.requests.push({ label, model: model.id, cacheRead, cacheWrite: last.tokens - cacheRead, maxTokens });
	}
}

/** Answers with the model's role: a summary for the summary model (after `summaryDelayMs`), else "ok". */
const answer =
	(summaryDelayMs = 0) =>
	async (_context: unknown, _options: unknown, _state: unknown, model: Model<string>) => {
		if (model.id !== "summary") return fauxAssistantMessage("ok") as AssistantMessage;
		await new Promise((resolve) => setTimeout(resolve, summaryDelayMs));
		return fauxAssistantMessage("## Goal\nsummary") as AssistantMessage;
	};

const compactions = (manager: SessionManagerType) =>
	manager.getBranch().filter((entry): entry is CompactionEntry => entry.type === "compaction");

describe("shared prefix cache and fork bases", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function setup(economic = true) {
		const root = mkdtempSync(join(tmpdir(), "pi-shared-prefix-"));
		dirs.push(root);
		const sessionsDir = join(root, "sessions");
		const shared = SharedPrefixCache.forAgentDir(join(root, "agent"));
		const sim = new SimulatedCache();
		const open = async (label: string, sessionManager: SessionManagerType, summaryDelayMs = 0) => {
			const harness = await createHarness({
				models: [
					{ id: "main", cost: MAIN_COST },
					{ id: "summary", cost: SUMMARY_COST },
				],
				settings: {
					cacheRetention: "short",
					compaction: {
						keepRecentTokens: 1_000,
						...(economic ? { economic: { model: "faux/summary", minSaving: 0 } } : {}),
					},
				},
				sessionManager,
				sharedPrefixCache: shared,
			});
			harnesses.push(harness);
			for (const model of harness.models) (model as Model<string>).promptCache = { short: 300, long: 3600 };
			harness.setResponses(Array.from({ length: 12 }, () => answer(summaryDelayMs)));
			sim.attach(harness, label);
			return harness;
		};
		/** A source with two big prompts at the real time; returns it and the time of its last request. */
		const source = async () => {
			const harness = await open("source", SessionManager.create(root, sessionsDir));
			await harness.session.prompt(`first ${BIG}`);
			await harness.session.prompt(`second ${BIG}`);
			return { harness, at: Date.now() };
		};
		const fork = (from: Harness, label: string, summaryDelayMs = 0) =>
			open(label, SessionManager.forkFrom(from.sessionManager.getSessionFile()!, root, sessionsDir), summaryDelayMs);
		const at = (time: number) => vi.spyOn(Date, "now").mockReturnValue(time);
		return { root, shared, sim, open, source, fork, at };
	}

	it("a fork of a warm point keeps the full history and its read keeps the source warm", async () => {
		const { sim, source, fork, at } = setup();
		const { harness: src, at: t0 } = await source();
		at(t0 + 60_000);
		const child = await fork(src, "child");
		await child.session.prompt("task");
		expect(compactions(child.sessionManager)).toHaveLength(0);
		expect(child.sessionManager.getHeader()?.fork?.base).toBe("full");
		// The child's first request read the source's last prompt from the cache.
		const read = sim.requests.find((request) => request.label === "child")!;
		expect(read.cacheRead).toBeGreaterThan(20_000);

		// Six minutes after its own last request the source's file says cold, but the child's read
		// refreshed the entry a minute in: no compaction.
		at(t0 + FIVE_MINUTES + 30_000);
		await src.session.prompt("third");
		expect(compactions(src.sessionManager)).toHaveLength(0);

		// Without that read the same source compacts.
		const { harness: alone, at: t1 } = await setup().source();
		at(t1 + FIVE_MINUTES + 30_000);
		await alone.session.prompt("third");
		expect(compactions(alone.sessionManager).map((entry) => entry.reason)).toEqual(["cold"]);
	});

	it("parallel forks of a cold point compact once, wait for the base, and read one primed cache entry", async () => {
		const { shared, sim, source, fork, at } = setup();
		const { harness: src, at: t0 } = await source();
		at(t0 + FIVE_MINUTES + 60_000);
		const forks = await Promise.all([1, 2, 3, 4].map((index) => fork(src, `fork${index}`, 50)));
		await Promise.all(forks.map((child, index) => child.session.prompt(`task ${index}`)));

		const summaries = sim.requests.filter((request) => request.model === "summary");
		expect(summaries.length).toBeGreaterThan(0);
		expect(new Set(summaries.map((request) => request.label)).size).toBe(1);

		const ids = forks.map((child) => compactions(child.sessionManager).map((entry) => entry.id));
		expect(new Set(ids.map((list) => list.join()))).toHaveLength(1);
		expect(ids[0]).toHaveLength(1);
		const keys = new Set(forks.map((child) => child.sessionManager.getHeader()?.fork?.base));
		expect(keys.size).toBe(1);
		const key = [...keys][0]!;
		const base = shared.bases.load(key)!;
		expect(base.compaction.id).toBe(ids[0]![0]);
		expect(base.meta.forks).toHaveLength(4);
		expect(base.meta.primes).toHaveLength(1);
		expect(base.meta.bytes).toBeGreaterThan(0);
		// Every fork's context starts with the base file's context, byte for byte (timestamps included).
		const baseContext = SessionManager.open(base.path).buildSessionProjection().messages;
		for (const child of forks) {
			const context = child.sessionManager.buildSessionProjection().messages;
			expect(JSON.stringify(context.slice(0, baseContext.length))).toBe(JSON.stringify(baseContext));
		}
		const primeUsages = forks.flatMap((child) =>
			child.sessionManager.getBranch().filter((entry) => entry.type === "usage" && entry.kind === "cache_prime"),
		);
		expect(primeUsages).toHaveLength(1);

		// One prime wrote the base prefix; every fork's first answer read it.
		const primes = sim.requests.filter((request) => request.maxTokens === 1);
		expect(primes).toHaveLength(1);
		for (const label of ["fork1", "fork2", "fork3", "fork4"]) {
			const first = sim.requests.find(
				(request) => request.label === label && request.model === "main" && !request.maxTokens,
			)!;
			expect(first.cacheRead).toBeGreaterThanOrEqual(primes[0]!.cacheWrite);
		}

		// A later fork of the same point takes the base: no summary, no prime (the entry is alive).
		const before = sim.requests.length;
		const later = await fork(src, "later");
		await later.session.prompt("later task");
		const added = sim.requests.slice(before);
		expect(added.filter((request) => request.model === "summary")).toHaveLength(0);
		expect(added.filter((request) => request.maxTokens === 1)).toHaveLength(0);
		expect(compactions(later.sessionManager).map((entry) => entry.id)).toEqual(ids[0]);
		expect(later.sessionManager.getHeader()?.fork?.base).toBe(key);

		// The source itself, resuming cold at the same point, takes the base too.
		await src.session.prompt("source resumes");
		expect(sim.requests.slice(before).filter((request) => request.model === "summary")).toHaveLength(0);
		expect(compactions(src.sessionManager).map((entry) => entry.id)).toEqual(ids[0]);
		expect(shared.bases.load(key)!.meta.forks).toHaveLength(6);
	});

	it("a single cold fork makes the base without priming; the next fork within the hour primes", async () => {
		const { shared, sim, source, fork, at } = setup();
		const { harness: src, at: t0 } = await source();
		at(t0 + FIVE_MINUTES + 60_000);
		const first = await fork(src, "first");
		await first.session.prompt("task");
		const key = first.sessionManager.getHeader()!.fork!.base!;
		expect(shared.bases.load(key)!.meta.primes).toHaveLength(0);
		expect(sim.requests.filter((request) => request.maxTokens === 1)).toHaveLength(0);

		// Six minutes later the base prefix is cold; another fork took the base within the hour: prime.
		at(t0 + 2 * FIVE_MINUTES + 120_000);
		const second = await fork(src, "second");
		await second.session.prompt("task");
		expect(sim.requests.filter((request) => request.model === "summary" && request.label === "second")).toHaveLength(
			0,
		);
		expect(shared.bases.load(key)!.meta.primes).toHaveLength(1);
		expect(second.sessionManager.getHeader()?.fork?.base).toBe(key);
	});

	it("without compaction.economic, a cold fork keeps the full history and no base is made", async () => {
		const { root, sim, source, fork, at } = setup(false);
		const { harness: src, at: t0 } = await source();
		at(t0 + FIVE_MINUTES + 60_000);
		const child = await fork(src, "child");
		await child.session.prompt("task");
		expect(compactions(child.sessionManager)).toHaveLength(0);
		expect(child.sessionManager.getHeader()?.fork).toEqual({ leafId: expect.any(String) });
		expect(existsSync(join(root, "agent", "fork-bases"))).toBe(false);
		expect(sim.requests.filter((request) => request.model === "summary")).toHaveLength(0);
	});

	it("removes bases no session took within a day", async () => {
		const { shared, source, fork, at } = setup();
		const { harness: src, at: t0 } = await source();
		at(t0 + FIVE_MINUTES + 60_000);
		const child = await fork(src, "child");
		await child.session.prompt("task");
		const key = child.sessionManager.getHeader()!.fork!.base!;
		expect(shared.bases.prune(t0 + 12 * 3_600_000)).toEqual([]);
		expect(shared.bases.load(key)).toBeDefined();
		expect(shared.bases.prune(t0 + FIVE_MINUTES + 60_000 + 24 * 3_600_000 + 1)).toEqual([key]);
		expect(shared.bases.load(key)).toBeUndefined();
		expect(readdirSync(shared.bases.dir)).toEqual([]);
	});
});
