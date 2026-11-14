import {
	type Api,
	CACHE_WARMING_MAX_AGE_MS,
	CACHE_WARMING_MAX_IDLE_AGE_MS,
	CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS,
	type CacheRetention,
	type CacheWarmingAction,
	type CacheWarmingDecision,
	type Context,
	evaluateCacheWarming,
	getCacheWarmingDelayMs,
	getCacheWarmingRequestOptions,
	getPromptCacheTtlMs,
	isCacheWarmingReplayable,
	type Model,
	type ModelsSimpleStreamOptions,
	resolvePromptCacheRetention,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "./model-runtime.ts";
import type { BranchPrefix, ModelRef, PrefixCacheRegistry } from "./prefix-cache.ts";
import type { SessionEntry, SessionManager, UsageEntry } from "./session-manager.ts";
import type { CacheWarmingMode } from "./settings-manager.ts";

export type { CacheWarmingAction, CacheWarmingDecision };

/** Prompt size of the most recent real request on the branch, as reported by the provider. */
function lastPromptTokens(entries: SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			return usage.input + usage.cacheRead + usage.cacheWrite;
		}
	}
	return 0;
}

/** The shared prefix cache registry and what the branch's next request would send, for `isPromptCacheCold`. */
export interface SharedPrefixCheck {
	registry: PrefixCacheRegistry;
	model: ModelRef;
	/** Anthropic: Pi's lookback bridge breakpoint applies. */
	bridge: boolean;
	prefix: BranchPrefix;
}

/**
 * Whether the prompt cache entry the branch's next request would read has expired: neither the
 * last request nor a warm refresh after it touched the entry within `ttlMs`, and no request of any
 * session (a fork reading the shared prefix, the source itself) left a live entry within reach in
 * the shared registry. A branch that ends in a compaction has no entry for its new context yet, so
 * there is nothing to lose.
 */
export function isPromptCacheCold(
	branch: SessionEntry[],
	ttlMs: number | undefined,
	now: number,
	shared?: SharedPrefixCheck,
): boolean {
	if (ttlMs === undefined) return false;
	if (!isOwnCacheCold(branch, ttlMs, now)) return false;
	return !shared?.registry.findWarm(shared.model, shared.prefix, shared.bridge, now);
}

function isOwnCacheCold(branch: SessionEntry[], ttlMs: number, now: number): boolean {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "compaction") return false;
		if (entry.type === "usage" && entry.kind === "cache_warm") return now - Date.parse(entry.timestamp) > ttlMs;
		if (entry.type === "message" && entry.message.role === "assistant") return now - entry.message.timestamp > ttlMs;
	}
	return false;
}

/**
 * Fired before each refresh with pi's decision filled in. Everything else an
 * extension might want (model, idle state, context size) is on the context.
 */
export interface CacheWarmingDecisionEvent
	extends Pick<CacheWarmingDecision, "warmCost" | "missCost" | "continuationProbability" | "held" | "action"> {
	type: "cache_warming_decision";
}

export interface CacheWarmingDecisionEventResult {
	/** Override whether this refresh is sent. "stop" ends warming until the next real request. */
	action?: CacheWarmingAction;
}

export interface CacheWarmingStatus {
	/** "scheduled": a refresh timer is armed; "refreshing": a warm request is in flight. */
	state: "inactive" | "scheduled" | "refreshing";
	/** Why nothing is scheduled. */
	reason?: string;
	nextWarmAt?: number;
	/** The pending decision, or the decision that stopped warming. */
	decision?: CacheWarmingDecision;
	/** True when an extension changed `decision.action`. */
	extensionOverride?: boolean;
	/** End of the session's hold (see `CacheWarmer.setHold`) while it runs. */
	holdUntil?: number;
	/** The cache entry of the last eligible request: its lifetime, the refresh interval and the retention tier. */
	cache?: { ttlMs: number; delayMs: number; retention: CacheRetention };
}

/** The request whose prompt cache entry should be kept warm, exactly as it was sent. */
export interface CacheWarmRequest {
	model: Model<Api>;
	context: Context;
	options: ModelsSimpleStreamOptions;
}

interface ActiveRun extends CacheWarmRequest {
	/** False once the session's model or messages no longer match the request. */
	isCurrent: () => boolean;
	ttlMs: number;
	delayMs: number;
	/** Latest safe time to send this refresh, leaving half the original expiry margin. */
	refreshDeadlineAt: number;
	startedAt: number;
	/** When the request or the last refresh touched the cache entry; the next refresh is due `delayMs` later. */
	touchedAt: number;
	controller: AbortController;
	phase: "streaming" | "idle";
	nextWarmAt: number;
	/** Set while a refresh that an extension forced is in flight. */
	extensionOverride: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Keeps one prompt cache entry alive by re-sending its request with a
 * one-token output cap before the entry expires. `start` replaces any
 * previous run; warm requests never extend the fixed safety windows.
 *
 * A hold (`setHold`) is the session's explicit request to keep its cache warm until a time: until
 * then the deadline is at least the hold's end, every refresh is sent (the user counts as
 * returning), and warming runs whatever the `cacheWarming` mode. Replayability, a known cache
 * lifetime and stopping after a failed refresh still apply.
 */
export class CacheWarmer {
	private run?: ActiveRun;
	/** The last eligible request, kept after warming stops so a hold can resume it while its entry lives. */
	private last?: ActiveRun;
	private holdUntil?: number;
	private inactive: CacheWarmingStatus;
	private readonly models: Pick<ModelRuntime, "streamSimple">;
	private readonly sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">;
	private readonly getMode: () => CacheWarmingMode;
	/** Lets extensions override `event.action`; failures fall back to pi's decision. */
	private readonly decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction>;
	/** How long after a request idle refreshes may still be sent. */
	private readonly getIdleMaxAgeMs: () => number;
	/** Called with the persisted usage entry and the time the refresh was sent, after each successful refresh. */
	onWarmed?: (entry: UsageEntry, sentAt: number) => void;
	/**
	 * When another request (another session reading the shared prefix) last touched the entry being
	 * warmed, from the shared prefix registry. A refresh is postponed past that touch instead of sent.
	 */
	sharedTouchedAt?: () => number | undefined;
	/**
	 * Called whenever warming is scheduled, starts a refresh or stops, so a host that unloads idle
	 * sessions (t3) can keep this one while a refresh is pending.
	 */
	onStatusChanged?: () => void;

	constructor(
		models: Pick<ModelRuntime, "streamSimple">,
		sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">,
		getMode: () => CacheWarmingMode,
		decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction> = async (event) => event.action,
		getIdleMaxAgeMs: () => number = () => CACHE_WARMING_MAX_IDLE_AGE_MS,
	) {
		this.models = models;
		this.sessionManager = sessionManager;
		this.getMode = getMode;
		this.decide = decide;
		this.getIdleMaxAgeMs = getIdleMaxAgeMs;
		this.inactive = { state: "inactive", reason: "waiting for first request" };
	}

	get status(): CacheWarmingStatus {
		const last = this.last;
		const extras: Pick<CacheWarmingStatus, "holdUntil" | "cache"> = {
			...(this.held() ? { holdUntil: this.holdUntil } : {}),
			...(last
				? {
						cache: {
							ttlMs: last.ttlMs,
							delayMs: last.delayMs,
							retention: resolvePromptCacheRetention(last.options),
						},
					}
				: {}),
		};
		if (this.mode() === "off") return { state: "inactive", reason: "cache warming disabled", ...extras };
		const run = this.run;
		if (!run) return { ...this.inactive, ...extras };
		if (!run.isCurrent()) return { state: "inactive", reason: "conversation context changed", ...extras };
		const decision = this.evaluate(run);
		const refreshing = run.timer === undefined;
		if (!decision.economicsAvailable && !decision.held && !refreshing) {
			return { state: "inactive", reason: "cache economics unavailable", ...extras };
		}
		return {
			state: refreshing ? "refreshing" : "scheduled",
			nextWarmAt: run.nextWarmAt,
			decision,
			extensionOverride: run.extensionOverride,
			...extras,
		};
	}

	/** Keep the prompt cache entry written by `request` warm while `isCurrent` holds. */
	start(request: CacheWarmRequest, isCurrent: () => boolean): void {
		this.clearRun();
		this.last = undefined;
		if (!isCacheWarmingReplayable(request.model, request.options)) {
			this.stop("request cannot be replayed safely");
			return;
		}
		const ttlMs = getPromptCacheTtlMs(request.model, request.options);
		if (ttlMs === undefined) {
			this.stop(
				request.options.cacheRetention === "none"
					? "request disabled prompt caching"
					: "cache lifetime unavailable",
			);
			return;
		}
		const delayMs = getCacheWarmingDelayMs(ttlMs);
		if (delayMs === undefined) {
			this.stop("cache lifetime unavailable");
			return;
		}
		const now = Date.now();
		const run: ActiveRun = {
			...request,
			isCurrent,
			ttlMs,
			delayMs,
			refreshDeadlineAt: 0,
			startedAt: now,
			touchedAt: now,
			controller: new AbortController(),
			phase: "streaming",
			nextWarmAt: 0,
			extensionOverride: false,
		};
		// Kept even when warming is off, so a hold set later can still keep this entry warm.
		this.last = run;
		if (this.mode() === "off") {
			this.stop("cache warming disabled");
			return;
		}
		this.run = run;
		this.schedule(run);
	}

	onAgentSettled(): void {
		if (this.last) this.last.phase = "idle";
		const run = this.run;
		if (!run) return;
		run.phase = "idle";
		const reason = this.getModeStopReason(run) ?? this.deadlineStopReason(run);
		if (reason) this.stop(reason);
	}

	/** Reconcile an active run after the persisted warming mode changes. */
	onModeChanged(): void {
		this.reconcile();
	}

	/**
	 * Hold the cache warm until `untilMs` (epoch milliseconds), or end the hold with `undefined`.
	 * While the hold runs, warming continues to at least its end, every refresh is sent, and the
	 * `cacheWarming` mode does not stop it. Setting a hold resumes warming of the last request when
	 * warming had stopped and its cache entry is still alive. Ending it applies the normal rules at once.
	 */
	setHold(untilMs: number | undefined): void {
		if (untilMs !== undefined && !Number.isFinite(untilMs)) throw new Error(`Invalid cache warming hold: ${untilMs}`);
		this.holdUntil = untilMs;
		if (this.held()) this.resume();
		else this.reconcile();
		this.onStatusChanged?.();
	}

	cancel(): void {
		this.stop("inactive");
	}

	/** Whether a hold covers time `at` (default now). */
	private held(at = Date.now()): boolean {
		return this.holdUntil !== undefined && at <= this.holdUntil;
	}

	/** The warming mode in effect: a hold warms as "idle" whatever the setting. */
	private mode(): CacheWarmingMode {
		return this.held() ? "idle" : this.getMode();
	}

	/** Warm the last request again under a hold, if warming stopped while its cache entry is still alive. */
	private resume(): void {
		const last = this.last;
		if (this.run || !last) return;
		if (!last.isCurrent()) {
			this.stop("conversation context changed", undefined, true);
			return;
		}
		const run: ActiveRun = { ...last, controller: new AbortController(), timer: undefined, extensionOverride: false };
		this.last = run;
		this.run = run;
		this.schedule(run);
	}

	/** Stop an active run that the current mode or deadline no longer allows. */
	private reconcile(): void {
		const run = this.run;
		if (!run) return;
		// A refresh in flight checks its deadline when it schedules the next one.
		const reason = this.getModeStopReason(run) ?? (run.timer ? this.deadlineStopReason(run) : undefined);
		if (reason) this.stop(reason);
	}

	private clearRun(): void {
		const run = this.run;
		if (!run) return;
		this.run = undefined;
		if (run.timer) clearTimeout(run.timer);
		run.controller.abort();
	}

	/** `forget`: the last request's entry cannot be warmed any more, so a hold must not resume it. */
	private stop(
		reason: string,
		stopped?: Pick<CacheWarmingStatus, "decision" | "extensionOverride">,
		forget = false,
	): void {
		this.clearRun();
		if (forget) this.last = undefined;
		this.inactive = { state: "inactive", reason, ...stopped };
		this.onStatusChanged?.();
	}

	private schedule(run: ActiveRun): void {
		run.extensionOverride = false;
		run.nextWarmAt = run.touchedAt + run.delayMs;
		// A timer can run late after sleep or event-loop blockage. Keep half of
		// the planned pre-expiry margin for that delay and request dispatch; a
		// late refresh is likely a full-price cache write, not a cache warm.
		run.refreshDeadlineAt = run.nextWarmAt + Math.floor((run.ttlMs - run.delayMs) / 2);
		if (Date.now() > run.refreshDeadlineAt) {
			this.stop("prompt cache entry expired", undefined, true);
			return;
		}
		const reason = this.deadlineStopReason(run);
		if (reason) {
			this.stop(reason);
			return;
		}
		run.timer = setTimeout(() => void this.refresh(run), Math.max(0, run.nextWarmAt - Date.now()));
		run.timer.unref?.();
		this.onStatusChanged?.();
	}

	/**
	 * Why the run's next refresh may not be sent: it falls after the safety window of its phase
	 * (one hour while streaming, `getIdleMaxAgeMs` when idle) and after the hold's end.
	 */
	private deadlineStopReason(run: ActiveRun): string | undefined {
		const normal = run.startedAt + (run.phase === "idle" ? this.getIdleMaxAgeMs() : CACHE_WARMING_MAX_AGE_MS);
		const deadline = Math.max(normal, this.holdUntil ?? 0);
		if (run.nextWarmAt <= deadline && Date.now() < deadline) return undefined;
		if (this.holdUntil !== undefined && this.holdUntil > normal) return "cache warming hold ended";
		return run.phase === "idle" ? this.idleLimitReason() : "one-hour safety limit reached";
	}

	private async refresh(run: ActiveRun): Promise<void> {
		run.timer = undefined;
		this.onStatusChanged?.();
		if (!this.validateRun(run)) return;
		if (this.refreshDeadlineMissed(run)) return;
		const shared = this.sharedTouchedAt?.();
		if (shared !== undefined && shared > run.touchedAt) {
			run.touchedAt = shared;
			this.schedule(run);
			return;
		}
		const decision = this.evaluate(run);
		const { warmCost, missCost, continuationProbability, held } = decision;
		let action = decision.action;
		try {
			action = await this.decide({
				type: "cache_warming_decision",
				warmCost,
				missCost,
				continuationProbability,
				held,
				action,
			});
		} catch {
			// Extension failures fall back to pi's own decision.
		}
		if (!this.validateRun(run) || this.refreshDeadlineMissed(run)) return;
		const extensionOverride = action !== decision.action;
		if (action === "stop") {
			const reason = extensionOverride
				? "stopped by extension"
				: decision.economicsAvailable
					? "expected savings below threshold"
					: "cache economics unavailable";
			this.stop(reason, { decision, extensionOverride });
			return;
		}

		run.extensionOverride = extensionOverride;
		let warmed = false;
		const sentAt = Date.now();
		try {
			const message = await this.models
				.streamSimple(run.model, run.context, getCacheWarmingRequestOptions(run.options, run.controller.signal))
				.result();
			if (!this.validateRun(run)) return;
			if (message.stopReason !== "error" && message.stopReason !== "aborted") {
				const entry = this.sessionManager.appendUsage(
					"cache_warm",
					message.provider,
					message.responseModel ?? message.model,
					message.usage,
					extensionOverride ? "extension override" : undefined,
				);
				warmed = true;
				this.onWarmed?.(entry, sentAt);
			}
		} catch {
			// Cache warming is best-effort and must not affect the active agent run.
		}
		if (this.run !== run) return;
		// The next refresh would come after the entry expired and write the whole prompt again.
		if (!warmed) {
			this.stop("cache refresh failed", undefined, true);
			return;
		}
		run.touchedAt = Date.now();
		this.schedule(run);
	}

	private idleLimitReason(): string {
		return `${Math.round(this.getIdleMaxAgeMs() / 60_000)}-minute idle safety limit reached`;
	}

	private refreshDeadlineMissed(run: ActiveRun): boolean {
		if (Date.now() <= run.refreshDeadlineAt) return false;
		this.stop("cache refresh deadline missed", undefined, true);
		return true;
	}

	private validateRun(run: ActiveRun): boolean {
		if (this.run !== run) return false;
		if (!run.isCurrent()) {
			this.stop("conversation context changed", undefined, true);
			return false;
		}
		const reason = this.getModeStopReason(run);
		if (!reason) return true;
		this.stop(reason);
		return false;
	}

	private getModeStopReason(run: ActiveRun): string | undefined {
		const mode = this.mode();
		if (mode === "off") return "cache warming disabled";
		if (mode === "streaming" && run.phase === "idle") return "agent run settled";
		return undefined;
	}

	private evaluate(run: ActiveRun): CacheWarmingDecision {
		return evaluateCacheWarming(
			run.model,
			lastPromptTokens(this.sessionManager.getBranch()),
			run.phase,
			resolvePromptCacheRetention(run.options),
			this.held(run.nextWarmAt),
		);
	}
}

function formatDollars(value: number): string {
	return value < 0 ? `-$${Math.abs(value).toFixed(3)}` : `$${value.toFixed(3)}`;
}

function formatClock(time: number): string {
	return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatCacheWarmingEconomics(decision: CacheWarmingDecision, holdUntil: number | undefined): string {
	if (decision.held) {
		const until = holdUntil === undefined ? "" : ` until ${formatClock(holdUntil)}`;
		return `held${until}, every refresh is sent at ${formatDollars(decision.warmCost)}`;
	}
	if (!decision.economicsAvailable) return "cache economics unavailable";
	const probability = Math.round(decision.continuationProbability * 100);
	const probabilityText =
		decision.phase === "streaming"
			? `${probability}% continuation probability while agent is running`
			: `${probability}% continuation probability`;
	const comparison = decision.action === "warm" ? ">=" : "<";
	return `${probabilityText}, expected savings ${formatDollars(decision.expectedSavings)} ${comparison} $${CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS.toFixed(3)}`;
}

function formatCacheWarmingDecisionTime(nextWarmAt: number | undefined, now: number): string {
	if (nextWarmAt === undefined || nextWarmAt <= now) return "Decision now";
	let remainingSeconds = Math.ceil((nextWarmAt - now) / 1000);
	const hours = Math.floor(remainingSeconds / 3600);
	remainingSeconds %= 3600;
	const minutes = Math.floor(remainingSeconds / 60);
	const seconds = remainingSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
	return `Decision in ${parts.join(" ")}`;
}

/** One-line status for `/session`. */
export function formatCacheWarmingStatus(status: CacheWarmingStatus, now = Date.now()): string {
	const decision = status.decision;
	// A decision is attached once pi (or an extension) acted on it; "inactive"
	// without one never got that far.
	if (!decision || (status.state === "inactive" && !decision.economicsAvailable && !status.extensionOverride)) {
		const hold = status.holdUntil === undefined ? "" : `, held until ${formatClock(status.holdUntil)}`;
		return `Inactive (${status.reason ?? "unknown reason"}${hold})`;
	}
	const economics = formatCacheWarmingEconomics(decision, status.holdUntil);
	const details = status.extensionOverride ? `extension override, ${economics}` : `${economics} -> ${decision.action}`;
	if (status.state === "inactive") return `Stopped (${details})`;
	if (status.state === "refreshing") return `Warming cache (${details})`;
	return `${formatCacheWarmingDecisionTime(status.nextWarmAt, now)} (${details})`;
}

/** One-line transcript text for the total cost of one or more consecutive cache warms. */
export function formatCacheWarmingUsage(totalCost: number, note?: string): string {
	const noteText = note ? ` (${note})` : "";
	const cost = totalCost.toFixed(6).replace(/(\.\d{3}\d*?)0+$/, "$1");
	return `Cache warmed${noteText}: $${cost}`;
}
