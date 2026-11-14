/**
 * The prompt cache entry of a template's prefix, shared by every fork of the template.
 *
 * A template is a prepared conversation without a prompt (`SessionTemplate`). Every fork runs it with
 * its current prompt and tools in front, so forks with the same prompt share the prefix "prompt +
 * template", named in the registry like any prefix (prefix-cache.ts). A fork's own requests write
 * cache entries only at their own breakpoints, after the fork's task, which no other fork shares. So
 * the prefix gets an entry of its own: before a fork's first request, unless a live entry covers it,
 * the fork writes it with a one-token request (`sendCachePrime`), ending before the template's last
 * reply like a fork base's prime, where every fork's first request reaches it through the lookback.
 *
 * Whether that pays is decided like a cache warm (`evaluateCacheWarming`): the prime reads what the
 * fork then writes anyway, so it costs a read of the prefix, and it saves a write of the prefix for
 * each further fork within the cache's lifetime. The chance of a further fork comes from the
 * registry's record of the prefix: the times forks started from it (`PrefixCacheRecord.reads`), as
 * a rate per hour over the last day. Forks waiting for the prefix's lock right now make it certain.
 * The same rule keeps the entry warm afterwards: shortly before it expires, the fork refreshes it
 * while the rate says the next fork is likely enough, and stops otherwise. A template nobody forks
 * is never written or warmed.
 *
 * The decision and the write hold a lock per prefix (file-lock.ts in the fork-base directory), so
 * parallel forks write the entry once and then read it.
 */

import { createHash } from "node:crypto";
import {
	type Api,
	CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS,
	type CacheRetention,
	evaluateCacheWarming,
	getCacheWarmingDelayMs,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import { estimateTokens } from "./compaction/compaction.ts";
import { type ModelRef, type PrefixPoint, type PrefixRequest, READS_KEPT_MS } from "./prefix-cache.ts";
import type { SessionProjection } from "./session-manager.ts";
import { primeProjection, type SharedPrefixCache } from "./shared-prefix.ts";

type Projection = Pick<SessionProjection, "entries" | "messages">;

const HOUR_MS = 60 * 60_000;

/**
 * The chance that another fork starts from the prefix within `ttlMs`: forks arrive at the rate of
 * the reads of the last day (Poisson), over at least an hour so that one recent read does not
 * count as a burst.
 */
export function nextReadProbability(reads: readonly number[], now: number, ttlMs: number): number {
	const recent = reads.filter((time) => time <= now && now - time < READS_KEPT_MS);
	if (recent.length === 0) return 0;
	const window = Math.max(HOUR_MS, now - Math.min(...recent));
	return 1 - Math.exp((-recent.length / window) * ttlMs);
}

/** What writing or refreshing a `tokens`-token prefix costs and is expected to save, given the chance of the next fork. */
export function prefixWarmingDecision(
	model: Model<Api>,
	tokens: number,
	probability: number,
	retention: CacheRetention,
): { warmCost: number; missCost: number; expectedSavings: number; pays: boolean } {
	const { warmCost, missCost, economicsAvailable } = evaluateCacheWarming(model, tokens, "idle", retention);
	const expectedSavings = probability * missCost - warmCost;
	return {
		warmCost,
		missCost,
		expectedSavings,
		pays: economicsAvailable && expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS,
	};
}

/** The lock serialising the decision and the write of one template prefix's entry. */
export function templatePrefixLock(model: ModelRef, promptHash: string, point: PrefixPoint): string {
	const id = createHash("sha256").update(`${model.provider}/${model.id}\n${promptHash}\n${point.key}`).digest("hex");
	return `template-${id.slice(0, 40)}`;
}

export interface TemplatePrefixDeps {
	shared: SharedPrefixCache;
	/** Describe a request of `model` sending `projection` (the session's `_prefixRequest`). */
	describe(model: Model<Api>, projection: Projection): PrefixRequest | undefined;
	/** Send a one-token request writing or refreshing the entry of `projection` (`sendCachePrime`). */
	send(
		model: Model<Api>,
		projection: Projection,
	): Promise<{ usage: Usage; provider: string; model: string } | undefined>;
	/** A prime was sent: record its usage in the session. */
	sent(result: { usage: Usage; provider: string; model: string }): void;
	retention(): CacheRetention;
}

/** The template prefix of one fork: what its prime sends and where the registry names it. */
interface Target {
	model: Model<Api>;
	ttlMs: number;
	projection: Projection;
	request: PrefixRequest;
	point: PrefixPoint;
	lock: string;
	tokens: number;
}

export class TemplatePrefix {
	private readonly deps: TemplatePrefixDeps;
	private timer: NodeJS.Timeout | undefined;
	private disposed = false;

	constructor(deps: TemplatePrefixDeps) {
		this.deps = deps;
	}

	/**
	 * Before a template fork's first request (`projection`: its context, `leafId`: the template's
	 * last entry): record the fork as a read of the template prefix, write the prefix's entry when
	 * none is alive and that pays, then keep it warm while that pays. Never throws: the entry is an
	 * optimisation, the fork's request writes what it needs anyway.
	 */
	async beforeFirstRequest(model: Model<Api>, ttlMs: number, projection: Projection, leafId: string): Promise<void> {
		try {
			const target = this.target(model, ttlMs, projection, leafId);
			if (!target) return;
			const { registry, bases } = this.deps.shared;
			await bases.locks.withLock(target.lock, async (self) => {
				const now = Date.now();
				const record = registry.get(model, target.request.prefix.promptHash, target.point);
				registry.noteRead(model, target.request.prefix.promptHash, target.point, now, target.tokens);
				if ((record?.expiresAt ?? 0) > now) return;
				const waiting = bases.locks.waiters(target.lock, self) > 0;
				if (!waiting && !this.pays(target, record?.reads ?? [], now)) return;
				await this.prime(target);
			});
			this.keepWarm(target);
		} catch {
			// The fork's own request writes the cache anyway.
		}
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
	}

	private target(model: Model<Api>, ttlMs: number, projection: Projection, leafId: string): Target | undefined {
		const end = projection.entries.findIndex((entry) => entry.sourceEntry.id === leafId);
		if (end < 0) return undefined;
		const entries = projection.entries.slice(0, end + 1);
		const prime = primeProjection({ entries, messages: entries.flatMap((entry) => entry.messages) });
		const request = this.deps.describe(model, prime);
		const point = request?.prefix.points.at(-1);
		if (!request || !point) return undefined;
		const lock = templatePrefixLock(model, request.prefix.promptHash, point);
		const tokens = prime.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		return { model, ttlMs, projection: prime, request, point, lock, tokens };
	}

	private pays(target: Target, reads: readonly number[], now: number): boolean {
		const record = this.deps.shared.registry.get(target.model, target.request.prefix.promptHash, target.point);
		const tokens = record?.tokens || target.tokens;
		return prefixWarmingDecision(
			target.model,
			tokens,
			nextReadProbability(reads, now, target.ttlMs),
			this.deps.retention(),
		).pays;
	}

	private async prime(target: Target): Promise<void> {
		const sentAt = Date.now();
		const result = await this.deps.send(target.model, target.projection);
		if (!result) return;
		this.deps.shared.registry.recordRequest(target.request, result.usage, sentAt);
		this.deps.sent(result);
	}

	/**
	 * Refresh the prefix's entry shortly before it expires, while the next fork is likely enough to
	 * pay for it. A refresh another session made meanwhile (a fork's read) postpones it.
	 */
	private keepWarm(target: Target): void {
		clearTimeout(this.timer);
		const delay = getCacheWarmingDelayMs(target.ttlMs);
		const record = this.deps.shared.registry.get(target.model, target.request.prefix.promptHash, target.point);
		if (this.disposed || delay === undefined || !record || record.expiresAt <= Date.now()) return;
		const refreshAt = record.expiresAt - target.ttlMs + delay;
		this.timer = setTimeout(() => void this.refresh(target), Math.max(0, refreshAt - Date.now()));
		this.timer.unref?.();
	}

	private async refresh(target: Target): Promise<void> {
		const { registry, bases } = this.deps.shared;
		try {
			const refreshed = await bases.locks.withLock(target.lock, async () => {
				const now = Date.now();
				const record = registry.get(target.model, target.request.prefix.promptHash, target.point);
				if (this.disposed || !record || record.expiresAt <= now) return false;
				// Touched since this refresh was scheduled: plan anew from that touch.
				if (record.expiresAt - target.ttlMs + (getCacheWarmingDelayMs(target.ttlMs) ?? 0) > now) return true;
				if (!this.pays(target, record.reads ?? [], now)) return false;
				await this.prime(target);
				return true;
			});
			if (refreshed) this.keepWarm(target);
		} catch {
			// Warming is an optimisation.
		}
	}
}
