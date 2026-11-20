// /context-limit: cap this session's context, so automatic compaction starts above that many
// tokens instead of near the end of the model's context window.
//
// Pi compacts automatically once the context passes `contextWindow - reserveTokens`, about 98% of a
// 1M window. `compaction.maxContextTokens` in the settings caps that threshold for every session;
// this command caps it for one (`pi.setCompactionOverrides`, added in vendor/pi).
//
// - `/context-limit 200k` (also `1.5m`, `150000`), `/context-limit off`, `/context-limit` (show).
// - The limit is a custom session entry (`harness-context-limit`), so it survives reloads and
//   restarts and follows the branch: `session_start` and `session_tree` apply the branch's latest
//   one. Forks of the session inherit it; a new session starts without.
// - A limit below the current context makes the next prompt compact first.
// - Without a session limit, the limit of the session's experiment arm or rule applies
//   (`settings.maxContextTokens`, lib/variants.ts); the prompt extension applies it again once a
//   run recorded the session's arms (`applyContextLimit`).
// - Without either, a session with `settings.decideCompactionAbove` compacts automatically above
//   that size only once it decided to (decider.ts): the threshold is where it is asked next.

import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";
import { EXPERIMENTS_DIR } from "../lib/experiments.ts";
import { currentSettings, RULES_DIR } from "../lib/rules.ts";
import { type Answer, DECISION_ENTRY, type DecisionData, deciderThreshold, draw, type Facts, filesOf, parseAnswer, preserveInstructions, question, STEP_TOKENS, settle } from "./decider.ts";
import { describeLimit, formatTokens, LIMIT_ENTRY, type LimitEntryData, parseCommand, refusal, sessionLimit, USAGE } from "./limit.ts";

export const STATUS_KEY = "context-limit";

export interface LimitSources {
	experimentsDir?: string;
	rulesDir?: string;
	/** The run's prompt, for a session without messages yet. */
	prompt?: string;
}

/**
 * The session's own limit, the one its experiment arm or rule sets, and the compaction decider's:
 * its setting (`decideAbove`) and where it asks next (`decider`, only without the other two).
 */
export function limits(ctx: ExtensionContext, { experimentsDir = EXPERIMENTS_DIR, rulesDir = RULES_DIR, prompt }: LimitSources = {}) {
	const branch = ctx.sessionManager.getBranch();
	const settings = currentSettings(ctx.sessionManager.getEntries(), prompt, experimentsDir, rulesDir);
	const own = sessionLimit(branch);
	const variant = settings.maxContextTokens;
	const decideAbove = own === undefined && variant === undefined ? settings.decideCompactionAbove : undefined;
	return { own, variant, decideAbove, decider: deciderThreshold(branch, decideAbove) };
}

/** Apply the session's limit (its own, else its variant's, else where the decider asks next) to Pi and the status line; returns it. */
export function applyContextLimit(pi: Pick<ExtensionAPI, "setCompactionOverrides">, ctx: ExtensionContext, sources: LimitSources = {}): number | undefined {
	const { own, variant, decider } = limits(ctx, sources);
	const limit = own ?? variant ?? decider;
	pi.setCompactionOverrides(limit === undefined ? undefined : { maxContextTokens: limit });
	const status = own ?? variant;
	ctx.ui.setStatus(STATUS_KEY, status !== undefined ? `compact above ${formatTokens(status)}` : decider !== undefined ? `compaction check at ${formatTokens(decider)}` : undefined);
	return limit;
}

/** What the question tells the model: the context's size and cost now and after compacting, and the files the compaction would summarize. */
export function decisionFacts(ctx: Pick<ExtensionContext, "model">, contextTokens: number, keepTokens: number, files: string[]): Facts {
	const cost = ctx.model?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const perToken = (dollarsPerMillion: number) => dollarsPerMillion / 1e6;
	// A summary is at most 3k tokens (compaction/economics.ts in vendor/pi).
	const kept = keepTokens + 3_000;
	return {
		contextTokens,
		keepTokens,
		nextTokens: contextTokens + STEP_TOKENS,
		requestNow: contextTokens * perToken(cost.cacheRead),
		requestAfter: kept * perToken(cost.cacheRead),
		compaction: contextTokens * perToken(cost.input) + 3_000 * perToken(cost.output) + kept * perToken(cost.cacheWrite),
		files,
	};
}

/**
 * Before an automatic compaction at the decider's threshold: ask the session (two framings, one
 * acting), record the answers, and keep (cancel; asked again later) or compact with what it needs.
 * Nothing to decide for other compactions, near the model's own limit, or without the setting.
 */
export async function decideCompaction(
	pi: Pick<ExtensionAPI, "askAside" | "appendEntry" | "getCompactionSettings" | "setCompactionOverrides">,
	ctx: ExtensionContext,
	event: SessionBeforeCompactEvent,
	{ random = Math.random, sources = {} }: { random?: () => number; sources?: LimitSources } = {},
): Promise<SessionBeforeCompactResult | undefined> {
	if (event.reason !== "threshold") return undefined;
	const { decider } = limits(ctx, sources);
	const settings = pi.getCompactionSettings();
	const window = ctx.model?.contextWindow;
	if (decider === undefined || !settings || !window) return undefined;
	const contextTokens = event.preparation.tokensBefore;
	// Near the model's own limit the session could not keep for long: compact as Pi always did.
	if (contextTokens + STEP_TOKENS >= window - settings.reserveTokens) return undefined;

	const files = filesOf(event.preparation.fileOps);
	const facts = decisionFacts(ctx, contextTokens, settings.keepRecentTokens, files);
	const { framings, acting } = draw(random);
	const answers: Answer[] = [];
	for (const framing of framings) {
		const reply = await pi.askAside(question(framing, facts), { kind: "compaction-decision", signal: event.signal }).catch(() => undefined);
		answers.push(parseAnswer(framing, reply?.text));
	}
	const settled = settle(answers, acting);
	const data: DecisionData = { contextTokens, threshold: decider, answers, acting: settled.acting, decision: settled.decision, files };
	pi.appendEntry<DecisionData>(DECISION_ENTRY, data);
	if (settled.decision === "keep") {
		applyContextLimit(pi, ctx, sources);
		return { cancel: true };
	}
	const instructions = preserveInstructions(answers.find((a) => a.framing === settled.acting)?.preserve ?? []);
	return instructions ? { customInstructions: instructions } : undefined;
}

/** `sources`: where experiments and rules are read (tests point them elsewhere). */
export default function contextLimit(pi: ExtensionAPI, sources: Omit<LimitSources, "prompt"> = {}) {
	const apply = (ctx: ExtensionContext) => applyContextLimit(pi, ctx, sources);

	const describe = (ctx: ExtensionContext) => {
		const settings = pi.getCompactionSettings();
		const { own, variant, decider } = limits(ctx, sources);
		const text = settings ? describeLimit(settings, ctx.model?.contextWindow, own, variant ?? decider) : "No model is selected.";
		return decider !== undefined ? `${text}\nAt ${formatTokens(decider)} the session decides itself whether to compact (the compaction decider).` : text;
	};

	pi.on("session_start", (_event, ctx) => void apply(ctx));
	pi.on("session_tree", (_event, ctx) => void apply(ctx));
	pi.on("session_compact", (_event, ctx) => void apply(ctx));
	pi.on("session_before_compact", (event, ctx) => decideCompaction(pi, ctx, event, { sources }));

	pi.registerCommand("context-limit", {
		description: "Compact this session above a context size: /context-limit 200k | off; /context-limit shows it",
		getArgumentCompletions: (prefix) => {
			const items = ["off", "100k", "200k", "400k"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const command = parseCommand(args);
			if ("error" in command) return ctx.ui.notify(command.error, "warning");
			if (command.action === "show") {
				apply(ctx);
				return ctx.ui.notify(describe(ctx), "info");
			}
			if (command.action === "off") {
				if (sessionLimit(ctx.sessionManager.getBranch()) === undefined) return ctx.ui.notify(`This session has no context limit.\n${describe(ctx)}`, "info");
				pi.appendEntry<LimitEntryData>(LIMIT_ENTRY, { maxContextTokens: null });
				apply(ctx);
				return ctx.ui.notify(`Context limit removed.\n${describe(ctx)}`, "info");
			}
			const settings = pi.getCompactionSettings();
			const refused = settings && refusal(command.maxContextTokens, settings);
			if (refused) return ctx.ui.notify(`${refused}\n${USAGE}`, "warning");
			pi.appendEntry<LimitEntryData>(LIMIT_ENTRY, { maxContextTokens: command.maxContextTokens });
			apply(ctx);
			const tokens = ctx.getContextUsage()?.tokens;
			const over = tokens != null && tokens > command.maxContextTokens ? `\nThe context (${formatTokens(tokens)}) is above it: the next prompt compacts first.` : "";
			ctx.ui.notify(`Context limit for this session: ${formatTokens(command.maxContextTokens)}.\n${describe(ctx)}${over}`, "info");
		},
	});
}
