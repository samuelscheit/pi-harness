// A session's cache warming hold: its state, read from the session branch, its spend, parsing of
// `/warm` and `keep_warm` arguments, and the texts the user and the agent see. Pure functions;
// extensions/warm/index.ts wires them into Pi.
//
// The hold is stored as custom session entries (`harness-warm`), each holding the whole hold after
// a change (or `null` once ended). The last one on the branch is the current hold, so it survives
// reloads and restarts, and branch navigation shows that branch's hold.

import type { CacheWarmingStatus, SessionEntry } from "@earendil-works/pi-coding-agent";

export const HOLD_ENTRY = "harness-warm";
/** A hold without a time frame lasts until the next real request, at most this long. */
export const DEFAULT_HOLD_MS = 4 * 60 * 60_000;
/** Longest hold: a typo like `/warm 300h` should not keep a cache warm for days. */
export const MAX_HOLD_MS = 24 * 60 * 60_000;

export interface Hold {
	/** New for each hold; spend counts per id. */
	id: string;
	startedAt: number;
	until: number;
	/** The default hold: it also ends with the next real request. */
	untilNextRequest?: boolean;
	/** Budget in USD for the refreshes sent while it runs. */
	maxUsd?: number;
	setBy: "user" | "agent";
}

export interface HoldEntryData {
	hold: Hold | null;
	/** Why the hold ended, on a `null` entry. */
	reason?: string;
}

const holdOf = (entry: SessionEntry): Hold | null | undefined =>
	entry.type === "custom" && entry.customType === HOLD_ENTRY ? ((entry.data as HoldEntryData | undefined)?.hold ?? null) : undefined;

/** The branch's last hold (also when its time has passed), what its cache refreshes cost so far, and what the last refresh cost. */
export function holdState(branch: readonly SessionEntry[]): { hold: Hold | undefined; spent: number; lastWarmCost?: number } {
	let hold: Hold | undefined;
	let spent = 0;
	let lastWarmCost: number | undefined;
	for (const entry of branch) {
		const next = holdOf(entry);
		if (next !== undefined) {
			if (next?.id !== hold?.id) spent = 0;
			hold = next ?? undefined;
			continue;
		}
		if (entry.type !== "usage" || entry.kind !== "cache_warm") continue;
		lastWarmCost = entry.usage.cost.total;
		if (hold && Date.parse(entry.timestamp) <= hold.until) spent += lastWarmCost;
	}
	return { hold, spent, ...(lastWarmCost === undefined ? {} : { lastWarmCost }) };
}

export const isActive = (hold: Hold | undefined, now: number): hold is Hold => hold !== undefined && hold.until > now;
/** Whether the next refresh (costing `warmCost`) would take the spend over the budget. */
export const overBudget = (hold: Hold, spent: number, warmCost = 0): boolean => hold.maxUsd !== undefined && spent + warmCost > hold.maxUsd;

/** `3h`, `90m`, `2h30m`, `1.5h`, `45s` (also with spaces): milliseconds, or undefined. */
export function parseDuration(text: string): number | undefined {
	const compact = text.replace(/\s+/g, "").toLowerCase();
	if (!/^(\d+(\.\d+)?(h|hours?|m|min|minutes?|s|sec|seconds?))+$/.test(compact)) return undefined;
	let ms = 0;
	for (const [, value, unit] of compact.matchAll(/(\d+(?:\.\d+)?)([a-z]+)/g)) ms += Number(value) * (unit!.startsWith("h") ? 3_600_000 : unit!.startsWith("m") ? 60_000 : 1000);
	return ms > 0 ? Math.round(ms) : undefined;
}

/** `18:00` (local time; the next day when already past) or an ISO date-time in the future: epoch milliseconds or an error. */
export function parseUntil(text: string, now: number): number | { error: string } {
	const clock = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
	if (clock) {
		const [hours, minutes] = [Number(clock[1]), Number(clock[2])];
		if (hours > 23 || minutes > 59) return { error: `${text} is not a time of day (HH:MM, 00:00 to 23:59).` };
		const at = new Date(now);
		at.setHours(hours, minutes, 0, 0);
		if (at.getTime() <= now) at.setDate(at.getDate() + 1);
		return at.getTime();
	}
	const at = /^\d{4}-\d{2}-\d{2}/.test(text.trim()) ? Date.parse(text.trim()) : Number.NaN;
	if (Number.isNaN(at)) return { error: `"${text}" is neither HH:MM nor an ISO date-time.` };
	if (at <= now) return { error: `${new Date(at).toISOString()} is in the past.` };
	return at;
}

/** `$2`, `2`, `2usd`, `0.5`: dollars, or undefined. */
export function parseUsd(text: string): number | undefined {
	const match = /^\s*\$?\s*(\d+(?:\.\d+)?)\s*(usd)?\s*$/i.exec(text);
	const value = match ? Number(match[1]) : Number.NaN;
	return value > 0 ? value : undefined;
}

/** What to hold: a duration, an end time, or neither (the default hold); and a budget. */
export interface HoldRequest {
	forMs?: number;
	until?: number;
	maxUsd?: number;
}

export type WarmCommand = { action: "show" } | { action: "off" } | ({ action: "set" } & HoldRequest);

/** `/warm [3h | until 18:00 | on | off] [--max $2]`; `on` (or only `--max`) is the default hold. */
export function parseCommand(args: string, now: number): WarmCommand | { error: string } {
	const words = args.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return { action: "show" };
	if (words.length === 1 && words[0] === "off") return { action: "off" };
	const request: HoldRequest = {};
	const rest: string[] = [];
	for (let i = 0; i < words.length; i++) {
		if (words[i] === "--max") {
			const usd = words[i + 1] === undefined ? undefined : parseUsd(words[i + 1]!);
			if (usd === undefined) return { error: "--max needs an amount in dollars, e.g. --max $2." };
			request.maxUsd = usd;
			i++;
		} else rest.push(words[i]!);
	}
	if (rest.length === 1 && rest[0] === "on") rest.pop();
	if (rest[0] === "until") {
		if (rest.length !== 2) return { error: "Usage: /warm until <HH:MM | ISO date-time>" };
		const until = parseUntil(rest[1]!, now);
		if (typeof until !== "number") return until;
		request.until = until;
	} else if (rest.length > 0) {
		const ms = parseDuration(rest.join(""));
		if (ms === undefined) return { error: `"${rest.join(" ")}" is not a duration (3h, 90m, 2h30m) or "until HH:MM".` };
		request.forMs = ms;
	}
	return { action: "set", ...request };
}

/** The hold a request asks for, or why it cannot be held. */
export function newHold(request: HoldRequest, now: number, setBy: Hold["setBy"], id: string): Hold | { error: string } {
	if (request.forMs !== undefined && request.until !== undefined) return { error: "Give a duration or an end time, not both." };
	const until = request.until ?? (request.forMs === undefined ? now + DEFAULT_HOLD_MS : now + request.forMs);
	if (until <= now) return { error: "The hold would end before it starts." };
	if (until - now > MAX_HOLD_MS) return { error: `A hold lasts at most ${MAX_HOLD_MS / 3_600_000} hours.` };
	return {
		id,
		startedAt: now,
		until,
		...(request.forMs === undefined && request.until === undefined ? { untilNextRequest: true } : {}),
		...(request.maxUsd === undefined ? {} : { maxUsd: request.maxUsd }),
		setBy,
	};
}

export const formatUsd = (usd: number) => `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;

/** `18:00`, or with the weekday when not today. */
export function formatClock(time: number, now: number): string {
	const at = new Date(time);
	const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
	return at.toDateString() === new Date(now).toDateString() ? clock : `${at.toLocaleDateString("en-US", { weekday: "short" })} ${clock}`;
}

/** `54 min`, `4.5 min`, `2 h`, `11 s`. */
export function formatSpan(ms: number): string {
	if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
	if (ms >= 60_000) return `${+(ms / 60_000).toFixed(1)} min`;
	return `${Math.round(ms / 1000)} s`;
}

const endText = (hold: Hold, now: number) => (hold.untilNextRequest ? `until the next request (at most ${formatClock(hold.until, now)})` : `until ${formatClock(hold.until, now)}`);
const spendText = (hold: Hold, spent: number) => `${formatUsd(spent)} spent${hold.maxUsd === undefined ? "" : ` of ${formatUsd(hold.maxUsd)}`}`;

/** The status line while a hold runs: its end, the next refresh, the spend. */
export function statusLine(hold: Hold, spent: number, status: CacheWarmingStatus | undefined, now: number): string {
	const warming =
		status?.state === "scheduled" && status.nextWarmAt !== undefined
			? `next refresh ${formatClock(status.nextWarmAt, now)}`
			: status?.state === "refreshing"
				? "refreshing"
				: `waiting for a request${status?.reason ? ` (${status.reason})` : ""}`;
	return `warm ${endText(hold, now)} · ${warming} · ${spendText(hold, spent)}`;
}

/** Refreshes left until the hold's end, from the next one, `delayMs` apart. */
export function refreshesLeft(hold: Hold, status: CacheWarmingStatus, now: number): number {
	if (!status.cache) return 0;
	const first = status.nextWarmAt ?? now + status.cache.delayMs;
	return first > hold.until ? 0 : 1 + Math.floor((hold.until - first) / status.cache.delayMs);
}

/** A one-hour tier the model offers, in milliseconds. */
type ModelCache = { promptCache?: { short?: number; long?: number } } | undefined;

/** What a hold costs: per refresh and until its end; with a five-minute cache, how to switch to the one-hour one. */
export function estimateText(hold: Hold, status: CacheWarmingStatus | undefined, model: ModelCache, now: number): string {
	if (!status?.cache) return "Its cost is known after the next request: a refresh replays it with one output token, at the price of a cache read of the prompt.";
	const { delayMs, ttlMs, retention } = status.cache;
	const warmCost = status.decision?.warmCost;
	const count = refreshesLeft(hold, status, now);
	const lines = [
		warmCost === undefined || !status.decision?.economicsAvailable
			? `A refresh every ${formatSpan(delayMs)}, about ${count} until it ends; the price of a refresh is unknown for this model.`
			: `A refresh every ${formatSpan(delayMs)} at about ${formatUsd(warmCost)}: about ${count} until it ends, ${formatUsd(count * warmCost)} in total${hold.maxUsd === undefined ? "" : ` (budget ${formatUsd(hold.maxUsd)}, about ${Math.floor(hold.maxUsd / warmCost)} refreshes)`}.`,
	];
	if (status.state === "inactive") lines.push(`Warming is not running now (${status.reason ?? "no request yet"}); it starts with the next request.`);
	if (retention !== "long" && ttlMs <= 5 * 60_000) {
		lines.push(
			model?.promptCache?.long
				? `This cache lives ${formatSpan(ttlMs)}, so a long hold refreshes it every ${formatSpan(delayMs)}, which adds up to about what the misses would cost. The one-hour cache needs a refresh only every 54 min: set "cacheRetention": "long" in ~/.pi/agent/settings.json (or in this project's .pi/settings.json, which takes precedence) and run /reload; the next real request then writes the one-hour cache (a write costs 2x the input price instead of 1.25x). PI_CACHE_RETENTION=long in Pi's environment does the same when no settings file sets cacheRetention.`
				: `This cache lives ${formatSpan(ttlMs)} and the model has no one-hour cache tier, so a long hold refreshes it every ${formatSpan(delayMs)}.`,
		);
	}
	return lines.join("\n");
}

/** `/warm` without arguments and `keep_warm` replies. */
export function describeHold(hold: Hold | undefined, spent: number, status: CacheWarmingStatus | undefined, now: number): string {
	if (!isActive(hold, now))
		return `No cache warming hold: Pi's normal rules apply${status ? ` (${status.state}${status.reason ? `: ${status.reason}` : ""})` : ""}. Hold it with /warm 3h, /warm until 18:00 or /warm on (until the next request), optionally with --max $2.`;
	return `Cache held warm ${endText(hold, now)}, set by the ${hold.setBy}: ${statusLine(hold, spent, status, now).split(" · ").slice(1).join(", ")}.`;
}
