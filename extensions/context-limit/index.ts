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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EXPERIMENTS_DIR } from "../lib/experiments.ts";
import { currentSettings, RULES_DIR } from "../lib/rules.ts";
import { describeLimit, formatTokens, LIMIT_ENTRY, type LimitEntryData, parseCommand, refusal, sessionLimit, USAGE } from "./limit.ts";

export const STATUS_KEY = "context-limit";

export interface LimitSources {
	experimentsDir?: string;
	rulesDir?: string;
	/** The run's prompt, for a session without messages yet. */
	prompt?: string;
}

/** The session's own limit and the one its experiment arm or rule sets. */
export function limits(ctx: ExtensionContext, { experimentsDir = EXPERIMENTS_DIR, rulesDir = RULES_DIR, prompt }: LimitSources = {}) {
	return { own: sessionLimit(ctx.sessionManager.getBranch()), variant: currentSettings(ctx.sessionManager.getEntries(), prompt, experimentsDir, rulesDir).maxContextTokens };
}

/** Apply the session's limit (its own, else its variant's) to Pi and the status line; returns it. */
export function applyContextLimit(pi: Pick<ExtensionAPI, "setCompactionOverrides">, ctx: ExtensionContext, sources: LimitSources = {}): number | undefined {
	const { own, variant } = limits(ctx, sources);
	const limit = own ?? variant;
	pi.setCompactionOverrides(limit === undefined ? undefined : { maxContextTokens: limit });
	ctx.ui.setStatus(STATUS_KEY, limit === undefined ? undefined : `compact above ${formatTokens(limit)}`);
	return limit;
}

export default function contextLimit(pi: ExtensionAPI) {
	const apply = (ctx: ExtensionContext) => applyContextLimit(pi, ctx);

	const describe = (ctx: ExtensionContext) => {
		const settings = pi.getCompactionSettings();
		const { own, variant } = limits(ctx);
		return settings ? describeLimit(settings, ctx.model?.contextWindow, own, variant) : "No model is selected.";
	};

	pi.on("session_start", (_event, ctx) => void apply(ctx));
	pi.on("session_tree", (_event, ctx) => void apply(ctx));

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
