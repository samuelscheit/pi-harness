// Parsing, state and texts of /context-limit (see index.ts).

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

/** The compaction settings in effect (`pi.getCompactionSettings()`). */
export type CompactionSettings = NonNullable<ReturnType<ExtensionAPI["getCompactionSettings"]>>;

/** The custom session entry that records the session's limit; `null` removes it. */
export const LIMIT_ENTRY = "harness-context-limit";
export interface LimitEntryData {
	maxContextTokens: number | null;
}

export const USAGE = "Usage: /context-limit 200k | 1.5m | 150000 | off; /context-limit shows it";

export type LimitCommand = { action: "show" } | { action: "off" } | { action: "set"; maxContextTokens: number } | { error: string };

const UNITS: Record<string, number> = { "": 1, k: 1_000, m: 1_000_000 };

/** "200k", "1.5m", "150000", "150,000", "150_000" as tokens; undefined for anything else or below one token. */
export function parseTokens(text: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(text.trim().replaceAll(/[,_]/g, ""));
	if (!match) return undefined;
	const tokens = Math.round(Number(match[1]) * UNITS[match[2].toLowerCase()]);
	return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

export function parseCommand(args: string): LimitCommand {
	const text = args.trim();
	if (text === "") return { action: "show" };
	if (/^(off|reset|default)$/i.test(text)) return { action: "off" };
	const tokens = parseTokens(text);
	return tokens === undefined ? { error: `"${text}" is not a token count. ${USAGE}` } : { action: "set", maxContextTokens: tokens };
}

/** The limit the branch's latest limit entry sets, or undefined. */
export function sessionLimit(branch: readonly SessionEntry[]): number | undefined {
	const entry = branch.findLast((e) => e.type === "custom" && e.customType === LIMIT_ENTRY);
	return entry?.type === "custom" ? ((entry.data as LimitEntryData | undefined)?.maxContextTokens ?? undefined) : undefined;
}

const trimmed = (n: number) => String(Number(n.toFixed(1)));
export const formatTokens = (tokens: number) => (tokens >= 1_000_000 ? `${trimmed(tokens / 1_000_000)}M` : tokens >= 1_000 ? `${trimmed(tokens / 1_000)}k` : String(tokens));

/** Why a limit cannot work: at or below the tokens a compaction keeps, every turn would compact again. */
export function refusal(maxContextTokens: number, settings: CompactionSettings): string | undefined {
	if (maxContextTokens > settings.keepRecentTokens) return undefined;
	return `A limit of ${formatTokens(maxContextTokens)} is not above the ${formatTokens(settings.keepRecentTokens)} recent tokens a compaction keeps (compaction.keepRecentTokens), so every turn would compact again.`;
}

/**
 * Where automatic compaction starts for the current model, and what sets it. `settings` are the
 * effective ones (the session's limit included), `limit` the session's limit.
 */
export function describeLimit(settings: CompactionSettings, contextWindow: number | undefined, limit: number | undefined): string {
	const lines: string[] = [];
	if (contextWindow === undefined || contextWindow <= 0) {
		lines.push(`The model's context window is unknown, so automatic compaction starts only on context overflow.`);
	} else {
		const windowThreshold = contextWindow - settings.reserveTokens;
		const windowText = `the context window ${formatTokens(contextWindow)} minus ${formatTokens(settings.reserveTokens)} reserve`;
		const max = settings.maxContextTokens;
		if (max !== undefined && max < windowThreshold) {
			lines.push(`Compacts automatically above ${formatTokens(max)} context tokens: ${limit !== undefined ? "this session's limit" : "compaction.maxContextTokens in the settings"} (${windowText} would be ${formatTokens(windowThreshold)}).`);
		} else {
			lines.push(`Compacts automatically above ${formatTokens(windowThreshold)} context tokens: ${windowText}.`);
			if (max !== undefined) lines.push(`${limit !== undefined ? "This session's limit" : "compaction.maxContextTokens"} (${formatTokens(max)}) is above that, so it changes nothing on this model.`);
		}
	}
	if (!settings.enabled) lines.push("Automatic compaction is off (compaction.enabled is false); /compact still works.");
	lines.push(`A compaction keeps the last ${formatTokens(settings.keepRecentTokens)} tokens.`);
	if (limit === undefined) lines.push("No session limit: /context-limit 200k sets one.");
	return lines.join("\n");
}
