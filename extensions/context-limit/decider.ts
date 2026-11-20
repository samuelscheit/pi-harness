// The compaction decider: above a soft threshold (session setting `decideCompactionAbove`, see
// lib/variants.ts), an automatic compaction first asks the session's own model whether it can
// compact now. The model knows best what the rest of its task needs: compacting too early makes it
// read everything it still needs again (and then compact again), keeping too long makes every
// request carry a huge context, and some tasks simply need a large one.
//
// - The question is an aside (`pi.askAside`): it is sent on the session's exact context, so it reads
//   the prompt cache, and neither the question nor the answer enters the conversation.
// - "keep" cancels the compaction and asks again STEP_TOKENS later; "compact" lets it run, with
//   what the model says it still needs (`preserve`) as instructions for the summary.
// - Near the model's own limit (window minus reserve) it does not ask: Pi compacts as it always did.
//
// Framing decides answers, so the framing is measured, live. Each decision asks two of the four
// FRAMINGS (whether the costs are spelled out × which option comes first), in random order; one
// of the two, chosen at random, acts. Every answer is recorded as a session entry (DECISION_ENTRY),
// so the metrics (queries/decisions.ts) show per framing how often it compacts, how often two
// framings disagree on the same moment, how often a compaction it chose was followed by reading
// the summarized files again, and what keeping cost.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const DECISION_ENTRY = "harness-compaction-decision";
/** After "keep", the next question comes this many tokens later. */
export const STEP_TOKENS = 100_000;
/** Files listed in the question at most. */
const MAX_FILES = 30;
const MAX_PRESERVE = 20;

export const FRAMINGS = ["plain-compact-first", "plain-keep-first", "costs-compact-first", "costs-keep-first"] as const;
export type Framing = (typeof FRAMINGS)[number];

export type Decision = "compact" | "keep";

export interface Answer {
	framing: Framing;
	/** Null: no valid answer (failed request or unreadable reply). */
	decision: Decision | null;
	preserve: string[];
	reason: string;
}

export interface DecisionData {
	contextTokens: number;
	/** The threshold that triggered the question. */
	threshold: number;
	answers: Answer[];
	/** The framing whose answer was applied; null when none answered (then the context is kept). */
	acting: Framing | null;
	decision: Decision;
	/** Files read, written or edited in the part a compaction would summarize. */
	files: string[];
}

export interface Facts {
	contextTokens: number;
	/** Tokens the compaction keeps verbatim. */
	keepTokens: number;
	nextTokens: number;
	/** Dollars: one request now, one request after compacting, the compaction itself. */
	requestNow: number;
	requestAfter: number;
	compaction: number;
	files: string[];
}

const usd = (value: number) => `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;
const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;

const OPTIONS: Record<Decision, (f: Facts) => string> = {
	compact: (f) => `"compact": now. The older part of the context becomes a summary; the most recent ~${k(f.keepTokens)} tokens stay as they are. Anything else from the older part that the task needs again has to be read again.`,
	keep: (f) => `"keep": the full context stays. Every request carries all of it, and the harness asks again at ${k(f.nextTokens)} tokens.`,
};

/** The question in one framing. The wording of both options is symmetric; only the order and the cost line vary. */
export function question(framing: Framing, facts: Facts): string {
	const order: Decision[] = framing.endsWith("compact-first") ? ["compact", "keep"] : ["keep", "compact"];
	const costs = framing.startsWith("costs")
		? [
				"",
				`Costs: a request now costs about ${usd(facts.requestNow)} for the context alone, about ${usd(facts.requestAfter)} after compacting; compacting costs about ${usd(facts.compaction)} once. Reading something again costs its tokens once more, plus the turns it takes.`,
			]
		: [];
	return [
		"[A question from the harness, not from the user. Your answer is not shown to anyone and does not end your work: after it, the session continues exactly where it was.]",
		"",
		`The context of this session is ${k(facts.contextTokens)} tokens. Choose one:`,
		...order.map((option) => `- ${OPTIONS[option](facts)}`),
		...costs,
		"",
		facts.files.length ? `Files read or changed in the older part:\n${facts.files.map((file) => `- ${file}`).join("\n")}` : "The older part read or changed no files.",
		"",
		"Decide for your task as it stands: how much of the older part will the rest of it still need?",
		'Reply with only JSON: {"decision": "compact" or "keep", "preserve": [what a summary must keep in detail, such as files, decisions and open items; empty when keeping], "reason": "<one sentence>"}',
	].join("\n");
}

/** The model's reply as an answer; decision null when it is not a valid one. */
export function parseAnswer(framing: Framing, text: string | undefined): Answer {
	const none: Answer = { framing, decision: null, preserve: [], reason: "" };
	if (!text) return none;
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) return none;
	try {
		const value = JSON.parse(text.slice(start, end + 1)) as { decision?: unknown; preserve?: unknown; reason?: unknown };
		if (value.decision !== "compact" && value.decision !== "keep") return none;
		const preserve = Array.isArray(value.preserve)
			? value.preserve.filter((item): item is string => typeof item === "string" && item.trim() !== "").slice(0, MAX_PRESERVE).map((item) => item.trim().slice(0, 300))
			: [];
		return { framing, decision: value.decision, preserve, reason: typeof value.reason === "string" ? value.reason.slice(0, 500) : "" };
	} catch {
		return none;
	}
}

/** Two different framings in random order, and which of the two acts (index 0 or 1). */
export function draw(random: () => number = Math.random): { framings: [Framing, Framing]; acting: 0 | 1 } {
	const first = FRAMINGS[Math.floor(random() * FRAMINGS.length)]!;
	const rest = FRAMINGS.filter((f) => f !== first);
	const second = rest[Math.floor(random() * rest.length)]!;
	return { framings: [first, second], acting: random() < 0.5 ? 0 : 1 };
}

/** The decision applied: the acting framing's answer, else the other's, else keep (what the session would do without the decider). */
export function settle(answers: readonly Answer[], acting: 0 | 1): { acting: Framing | null; decision: Decision } {
	const order = acting === 0 ? [answers[0], answers[1]] : [answers[1], answers[0]];
	const valid = order.find((a) => a?.decision);
	return valid ? { acting: valid.framing, decision: valid.decision! } : { acting: null, decision: "keep" };
}

/** Instructions for the summary from what the session said it still needs. */
export const preserveInstructions = (preserve: readonly string[]) =>
	preserve.length ? `The session decided to compact and still needs these; keep them in detail in the summary:\n${preserve.map((item) => `- ${item}`).join("\n")}` : undefined;

/** The files of the part to summarize, written and edited first. */
export function filesOf(ops: { read: Set<string>; written: Set<string>; edited: Set<string> }): string[] {
	return [...new Set([...ops.edited, ...ops.written, ...ops.read])].slice(0, MAX_FILES);
}

/**
 * The threshold the decider sets on this branch: `above` after the latest compaction, raised by
 * STEP_TOKENS above each "keep" decided since. Undefined without the setting.
 */
export function deciderThreshold(branch: readonly SessionEntry[], above: number | undefined): number | undefined {
	if (above === undefined) return undefined;
	const since = branch.slice(branch.findLastIndex((e) => e.type === "compaction") + 1);
	const kept = since.flatMap((e) => (e.type === "custom" && e.customType === DECISION_ENTRY && (e.data as DecisionData | undefined)?.decision === "keep" ? [e.data as DecisionData] : []));
	return kept.length ? Math.max(above, kept.at(-1)!.contextTokens + STEP_TOKENS) : above;
}
