// Warm: hold a session's prompt cache warm while the user is away, or while the agent waits for
// results that arrive later (a coordinator waiting on its children).
//
// Pi's warmer stops early by design: an idle refresh must save at least $0.05 assuming a 15%
// chance that the user returns, and warming ends 60 minutes after the last request while
// streaming or `cacheWarmingIdleMinutes` when idle. When the user says they will be back, those
// guesses are wrong, and the next request pays a full cache write of the whole context. A hold
// (`pi.setCacheWarmingHold`, added in vendor/pi) tells Pi the user is coming back: until its end
// every refresh is sent, whatever the `cacheWarming` setting.
//
// - `/warm 3h`, `/warm until 18:00`, `/warm on` (until the next request, at most 4 hours),
//   `/warm off`, `/warm` (show); `--max $2` sets a budget. The agent's `keep_warm` tool does the same.
// - The hold is a custom session entry (`harness-warm`), so it survives reloads and restarts;
//   `session_start` arms a hold that is still in the future again.
// - It ends at its time, with off, when its budget is used up (the `cache_warm` usage entries
//   since it started, checked before each refresh), with the next real request for the default
//   hold, or with the session.
// - Setting it tells the cost per refresh and until its end; the status line shows its end, the
//   next refresh and the spend.

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	describeHold,
	estimateText,
	formatClock,
	formatUsd,
	HOLD_ENTRY,
	type Hold,
	type HoldEntryData,
	type HoldRequest,
	holdState,
	isActive,
	newHold,
	overBudget,
	parseCommand,
	parseDuration,
	parseUntil,
	statusLine,
} from "./hold.ts";

export const STATUS_KEY = "warm";

const parameters = Type.Object(
	{
		for: Type.Optional(Type.String({ description: "How long, e.g. '3h', '90m', '2h30m'." })),
		until: Type.Optional(Type.String({ description: "End time: HH:MM (local, the next day if already past) or an ISO date-time." })),
		off: Type.Optional(Type.Boolean({ description: "End the hold." })),
		max_usd: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Budget in USD for the refreshes." })),
	},
	{ additionalProperties: false },
);

export default function warm(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const state = (ctx: ExtensionContext) => holdState(ctx.sessionManager.getBranch());

	const refresh = (ctx: ExtensionContext) => {
		const now = Date.now();
		const { hold, spent } = state(ctx);
		ctx.ui.setStatus(STATUS_KEY, isActive(hold, now) ? statusLine(hold, spent, pi.getCacheWarmingStatus(), now) : undefined);
	};

	/** Apply the branch's hold to Pi, and time its end. */
	const arm = (ctx: ExtensionContext) => {
		clearTimeout(timer);
		timer = undefined;
		const now = Date.now();
		const { hold } = state(ctx);
		if (isActive(hold, now)) {
			pi.setCacheWarmingHold(hold.until);
			timer = setTimeout(() => {
				try {
					const { spent } = state(ctx);
					ctx.ui.notify(`The cache warming hold ended at ${formatClock(hold.until, Date.now())}: ${formatUsd(spent)} spent on refreshes.`, "info");
					arm(ctx);
				} catch {
					// A host that disposes a session without `session_shutdown` (the SDK) leaves ctx stale; the hold ended with the session.
				}
			}, hold.until - now + 50);
			timer.unref?.();
		} else pi.setCacheWarmingHold(undefined);
		refresh(ctx);
	};

	const end = (ctx: ExtensionContext, reason: string) => {
		pi.appendEntry<HoldEntryData>(HOLD_ENTRY, { hold: null, reason });
		arm(ctx);
	};

	/** Start a hold; the reply tells what it costs. */
	const set = (ctx: ExtensionContext, request: HoldRequest, setBy: Hold["setBy"]): string => {
		const now = Date.now();
		const hold = newHold(request, now, setBy, randomUUID());
		if ("error" in hold) throw new Error(hold.error);
		pi.appendEntry<HoldEntryData>(HOLD_ENTRY, { hold });
		arm(ctx);
		const until = hold.untilNextRequest ? `until the next request, at most until ${formatClock(hold.until, now)}` : `until ${formatClock(hold.until, now)}`;
		return `Prompt cache held warm ${until}.\n${estimateText(hold, pi.getCacheWarmingStatus(), ctx.model, now)}`;
	};

	/** End the current hold; the reply says what it cost. */
	const off = (ctx: ExtensionContext): string => {
		const { hold, spent } = state(ctx);
		if (!isActive(hold, Date.now())) return "No cache warming hold is running.";
		end(ctx, "off");
		return `Cache warming hold ended: ${formatUsd(spent)} spent on refreshes. Pi's normal warming rules apply again.`;
	};

	pi.on("session_start", (_event, ctx) => arm(ctx));
	pi.on("session_tree", (_event, ctx) => arm(ctx));
	pi.on("session_shutdown", () => clearTimeout(timer));
	pi.on("cache_warming", (_event, ctx) => refresh(ctx));

	// The default hold lasts until the next real request.
	pi.on("before_agent_start", (event, ctx) => {
		if (event.reloaded) return;
		const { hold } = state(ctx);
		if (isActive(hold, Date.now()) && hold.untilNextRequest) end(ctx, "next request");
	});

	// The budget: a refresh that would take the spend over it is not sent, and the hold ends. A
	// refresh costs what the last one did, or Pi's estimate from the model's prices if that is more.
	pi.on("cache_warming_decision", (event, ctx) => {
		const { hold, spent, lastWarmCost } = state(ctx);
		const next = Math.max(event.warmCost, lastWarmCost ?? 0);
		if (!event.held || !isActive(hold, Date.now()) || !overBudget(hold, spent, next)) return;
		end(ctx, "budget");
		ctx.ui.notify(`The cache warming hold ended: its budget of ${formatUsd(hold.maxUsd!)} is used up (${formatUsd(spent)} spent, the next refresh costs about ${formatUsd(next)}).`, "warning");
		return { action: "stop" };
	});

	pi.registerTool({
		name: "keep_warm",
		label: "keep_warm",
		description:
			"Hold this session's prompt cache warm until a time, so the next request does not write the whole context again. Without `for` or `until`, until the next request (at most 4 hours). `off` ends it. Returns the cost per refresh and in total.",
		promptSnippet: "Keep the prompt cache warm while waiting",
		promptGuidelines: ["Call `keep_warm` when the user says they will be back later, or when results arrive later (e.g. while you wait on delegated tasks)."],
		parameters,
		async execute(_callId, params, _signal, _onUpdate, ctx) {
			const done = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
			if (params.off) return done(off(ctx));
			const now = Date.now();
			const request: HoldRequest = params.max_usd === undefined ? {} : { maxUsd: params.max_usd };
			if (params.for !== undefined) {
				const ms = parseDuration(params.for);
				if (ms === undefined) throw new Error(`"${params.for}" is not a duration (3h, 90m, 2h30m).`);
				request.forMs = ms;
			}
			if (params.until !== undefined) {
				const until = parseUntil(params.until, now);
				if (typeof until !== "number") throw new Error(until.error);
				request.until = until;
			}
			const text = set(ctx, request, "agent");
			ctx.ui.notify(text, "info");
			return done(text);
		},
	});

	pi.registerCommand("warm", {
		description: "Hold the prompt cache warm: /warm 3h | until 18:00 | on (until the next request) | off [--max $2]; /warm shows it",
		getArgumentCompletions: (prefix) => {
			const items = ["on", "off", "until"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const now = Date.now();
			const command = parseCommand(args, now);
			if ("error" in command) return ctx.ui.notify(command.error, "warning");
			if (command.action === "off") return ctx.ui.notify(off(ctx), "info");
			if (command.action === "show") {
				const { hold, spent } = state(ctx);
				const status = pi.getCacheWarmingStatus();
				return ctx.ui.notify(isActive(hold, now) ? `${describeHold(hold, spent, status, now)}\n${estimateText(hold, status, ctx.model, now)}` : describeHold(hold, spent, status, now), "info");
			}
			try {
				ctx.ui.notify(set(ctx, command, "user"), "info");
			} catch (error) {
				ctx.ui.notify((error as Error).message, "warning");
			}
		},
	});
}
