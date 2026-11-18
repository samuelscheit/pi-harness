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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describeLimit, formatTokens, LIMIT_ENTRY, type LimitEntryData, parseCommand, refusal, sessionLimit, USAGE } from "./limit.ts";

export const STATUS_KEY = "context-limit";

export default function contextLimit(pi: ExtensionAPI) {
	/** Apply the branch's limit to Pi and the status line; returns it. */
	const apply = (ctx: ExtensionContext) => {
		const limit = sessionLimit(ctx.sessionManager.getBranch());
		pi.setCompactionOverrides(limit === undefined ? undefined : { maxContextTokens: limit });
		ctx.ui.setStatus(STATUS_KEY, limit === undefined ? undefined : `compact above ${formatTokens(limit)}`);
		return limit;
	};

	const describe = (ctx: ExtensionContext, limit: number | undefined) => {
		const settings = pi.getCompactionSettings();
		return settings ? describeLimit(settings, ctx.model?.contextWindow, limit) : "No model is selected.";
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
			if (command.action === "show") return ctx.ui.notify(describe(ctx, apply(ctx)), "info");
			if (command.action === "off") {
				if (sessionLimit(ctx.sessionManager.getBranch()) === undefined) return ctx.ui.notify(`This session has no context limit.\n${describe(ctx, undefined)}`, "info");
				pi.appendEntry<LimitEntryData>(LIMIT_ENTRY, { maxContextTokens: null });
				return ctx.ui.notify(`Context limit removed.\n${describe(ctx, apply(ctx))}`, "info");
			}
			const settings = pi.getCompactionSettings();
			const refused = settings && refusal(command.maxContextTokens, settings);
			if (refused) return ctx.ui.notify(`${refused}\n${USAGE}`, "warning");
			pi.appendEntry<LimitEntryData>(LIMIT_ENTRY, { maxContextTokens: command.maxContextTokens });
			const limit = apply(ctx);
			const tokens = ctx.getContextUsage()?.tokens;
			const over = tokens != null && tokens > command.maxContextTokens ? `\nThe context (${formatTokens(tokens)}) is above it: the next prompt compacts first.` : "";
			ctx.ui.notify(`Context limit for this session: ${formatTokens(command.maxContextTokens)}.\n${describe(ctx, limit)}${over}`, "info");
		},
	});
}
