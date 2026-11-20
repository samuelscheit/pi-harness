// Session settings that experiments vary (arm B, lib/experiments.ts) and promoted rules fix for
// every session (lib/rules.ts): the model, the thinking level, and the context size above which Pi
// compacts. Both declare them in their frontmatter, with the sessions they apply to:
//
//   settings:
//     model: anthropic/claude-sonnet-5-5   provider/id, as the model registry knows it
//     thinking: low                        off | minimal | low | medium | high | xhigh | max
//     maxContextTokens: 400000             compact above this many context tokens (>= 50000)
//     decideCompactionAbove: 300000        above this, the session decides whether to compact
//                                          (extensions/context-limit/decider.ts; >= 50000)
//   sessions: delegated                    all (default) | delegated | top-level
//
// A delegated session is one a parent started with delegate_task: its first message is t3's role
// preamble ("Act as the review sub-agent for this task."). Most spend is in such sessions.
//
// The model and thinking level replace only Pi's defaults (`defaultProvider`/`defaultModel` and
// `defaultThinkingLevel` in the agent's settings.json, the project's `.pi/settings.json` over it):
// a session someone started with another model or level on purpose keeps it, such as a subagent
// its parent gave a `target.model` or an effort option. Such a session is not enrolled in an
// experiment that would set it, so arm B never holds sessions that did not get its settings. A
// choice that happens to equal the default cannot be told from no choice; it is treated as none.
//
// Stopping an experiment ends its arms, but a resumed session keeps the model and level it started
// with, as Pi recorded them; only new sessions go back to the defaults.
//
// The model and thinking level are set once, on the session's first run, before its first request:
// Pi records them in the session, so they survive a resume, and switching later would rewrite the
// whole cached context (and mix two settings in one measured session). An experiment with
// settings therefore enrolls only sessions that have not made a request yet. The context limit is
// not recorded by Pi; it is applied on every run (extensions/prompt, extensions/context-limit), and
// a session's own /context-limit wins over it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

export const SESSION_KINDS = ["all", "delegated", "top-level"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/** Below this a context limit leaves too little to work in after a compaction. */
export const MIN_CONTEXT_TOKENS = 50_000;

export interface SessionSettings {
	/** `provider/id`. */
	model?: string;
	thinking?: Thinking;
	maxContextTokens?: number;
	decideCompactionAbove?: number;
}

const SETTING_KEYS = ["model", "thinking", "maxContextTokens", "decideCompactionAbove"] as const;
const MODEL = /^[\w.-]+\/[\w.:@-]+$/;

/** The `settings` frontmatter value (absent: none), or why it is invalid. */
export function parseSettings(raw: unknown): SessionSettings | { problem: string } {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) return { problem: `settings must be a map, got ${JSON.stringify(raw)}` };
	const record = raw as Record<string, unknown>;
	const unknown = Object.keys(record).filter((key) => !(SETTING_KEYS as readonly string[]).includes(key));
	if (unknown.length) return { problem: `unknown settings ${unknown.join(", ")} (known: ${SETTING_KEYS.join(", ")})` };
	const settings: SessionSettings = {};
	if (record.model !== undefined) {
		if (typeof record.model !== "string" || !MODEL.test(record.model)) return { problem: `settings.model must be provider/id, got ${JSON.stringify(record.model)}` };
		settings.model = record.model;
	}
	if (record.thinking !== undefined) {
		if (!(THINKING_LEVELS as readonly unknown[]).includes(record.thinking)) return { problem: `settings.thinking must be one of ${THINKING_LEVELS.join(", ")}, got ${JSON.stringify(record.thinking)}` };
		settings.thinking = record.thinking as Thinking;
	}
	for (const key of ["maxContextTokens", "decideCompactionAbove"] as const) {
		const tokens = record[key];
		if (tokens === undefined) continue;
		if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < MIN_CONTEXT_TOKENS) return { problem: `settings.${key} must be an integer of at least ${MIN_CONTEXT_TOKENS}, got ${JSON.stringify(tokens)}` };
		settings[key] = tokens;
	}
	return settings;
}

/** The `sessions` frontmatter value (absent: all), or undefined when invalid. */
export function parseSessionKind(raw: unknown): SessionKind | undefined {
	if (raw === undefined || raw === null) return "all";
	return (SESSION_KINDS as readonly unknown[]).includes(raw) ? (raw as SessionKind) : undefined;
}

export const hasSettings = (settings: SessionSettings) => SETTING_KEYS.some((key) => settings[key] !== undefined);

/** t3's preamble of a session delegate_task started (see extensions/metrics/work.ts). */
const DELEGATED = /^Act as the [\w-]+ sub-agent for this task\./;
export const isDelegatedPrompt = (text: string) => DELEGATED.test(text.trimStart());
/** The same test in SQL on a session's first user message (aliased `s`, table user_messages). */
export const DELEGATED_SQL = (session: string) =>
	`(SELECT LTRIM(u.text) FROM user_messages u WHERE u.session_id = ${session} ORDER BY u.ts LIMIT 1) LIKE 'Act as the % sub-agent for this task.%'`;

/** Whether a session whose first user message is `firstPrompt` is one of `kind`. */
export const matchesKind = (kind: SessionKind, firstPrompt: string) => kind === "all" || (kind === "delegated") === isDelegatedPrompt(firstPrompt);

interface EntryLike {
	type: string;
	message?: { role?: string; content?: unknown };
}

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("")
			: "";

/** What enrollment needs to know about a session (lib/experiments.ts `enrolls`). */
export interface SessionFacts {
	firstPrompt: string;
	/** No request made yet. */
	fresh: boolean;
	/** Whether the session still runs Pi's default model and thinking level (unknown: undefined, treated as yes). */
	onDefaults?: { model: boolean; thinking: boolean };
}

/** What a run needs to know about its session: its first user message, and whether any request was made yet. */
export function sessionFacts(entries: readonly EntryLike[], prompt: string | undefined): SessionFacts {
	const messages = entries.filter((e) => e.type === "message" && e.message);
	const first = messages.find((e) => e.message!.role === "user");
	return { firstPrompt: first ? textOf(first.message!.content) : (prompt ?? ""), fresh: !messages.some((e) => e.message!.role === "assistant") };
}

/** Later settings win, key by key. */
export const mergeSettings = (...list: readonly SessionSettings[]): SessionSettings => Object.assign({}, ...list.map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined))));

/** Pi's own fallback thinking level (DEFAULT_THINKING_LEVEL in vendor/pi, not exported). */
const PI_THINKING = "medium";

type DefaultKeys = { defaultProvider?: unknown; defaultModel?: unknown; defaultThinkingLevel?: unknown };

function readDefaults(file: string): DefaultKeys {
	try {
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as DefaultKeys) : {};
	} catch {
		// An unreadable settings file: as if it set nothing, as Pi does.
		return {};
	}
}

/**
 * Pi's defaults: the model as `provider/id` (when one is named) and the thinking level, from the
 * agent's settings.json with the project's (`<cwd>/.pi/settings.json`) over it, key by key.
 */
export function piDefaults(agentDir = getAgentDir(), cwd?: string): { model?: string; thinking: string } {
	const global = readDefaults(join(agentDir, "settings.json"));
	const project = cwd ? readDefaults(join(cwd, CONFIG_DIR_NAME, "settings.json")) : {};
	const pick = <K extends keyof DefaultKeys>(key: K) => (project[key] !== undefined ? project[key] : global[key]);
	const [defaultProvider, defaultModel, defaultThinkingLevel] = [pick("defaultProvider"), pick("defaultModel"), pick("defaultThinkingLevel")];
	return {
		...(typeof defaultProvider === "string" && typeof defaultModel === "string" ? { model: `${defaultProvider}/${defaultModel}` } : {}),
		thinking: typeof defaultThinkingLevel === "string" ? defaultThinkingLevel : PI_THINKING,
	};
}

/** The settings as one line, for reports and changelog entries. */
export const describeSettings = (settings: SessionSettings) =>
	SETTING_KEYS.filter((key) => settings[key] !== undefined)
		.map((key) => `${key}: ${settings[key]}`)
		.join(", ");
