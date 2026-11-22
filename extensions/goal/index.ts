// Goal: a session keeps working until an objective is achieved, like Codex CLI's `/goal`.
//
// The user's most repeated complaint was an agent ending its turn "waiting" for a build or test
// although independent work remained and the user had asked it to keep going (the law-formalization
// coordinator's children, 2026-11-13/14: about 30 pauses, 318 minutes, each ended only by a
// background job's end; the user intervened four times). For a single task, ending the turn is
// right. So the agent is held only when someone set a goal: the user with `/goal <objective>`, or
// the agent with the `goal` tool when its task (a delegated child's brief) says to keep going.
//
// While a goal is active:
// - its prompt section `goal` is rendered (after the harness's own sections, see extensions/prompt)
//   and the status line shows it;
// - a run may not settle (`agent_before_settle`): it continues with a message that restates the goal
//   and says what to do. With background work pending (extensions/bash/jobs.ts) the strict form
//   applies: do the steps that do not depend on the jobs, and only a `wait` naming a running job for
//   every remaining step lets the turn end; the job's end then wakes the session;
// - a loop guard stops forcing after `MAX_IDLE_CONTINUES` continues in a row without a tool call,
//   and tells the user; a tool call or a user message resets it;
// - spend while active (from the assistant messages' usage) is checked against the budget after
//   each turn: once reached, the goal becomes budget-limited and the agent writes a summary.
// Marking it achieved runs its check (exit 0 required). Blocked needs a reason; a user message
// makes a blocked goal active again (it was blocked on them).
//
// Without an active goal the turn may end, but not silently while background jobs run: the same
// coordinator ended its turns "waiting" for builds although independent work remained, also with no
// goal set (2026-11-14, the user had to ask "can't you work in parallel assuming they are green").
// A run that would settle with jobs pending the agent was not yet told about continues once with
// `pendingText`: continue with the independent steps, or end with one line naming what it waits for.
// The jobs it was told about (`memory.told`, also by the goal's strict continue and `wait`) never
// trigger it again, so a server started on purpose costs one request, not one per turn.
//
// A goal may also wait on a task delegated through t3 (`delegate_task` in async mode): its
// completion wakes the session as t3's message, like a job's end. Without it (2026-11-19) `wait`
// refused ("No background job is running") while a child ran, and the agent wrote caffeinate and
// `t3_thread_wait` loops, restarted about 20 times. The running tasks come from the branch
// (goal.ts `delegatedTasks`); the goal's strict continue lists them, and a finished or unknown task
// is refused.
//
// Waiting is a decision the agent must not repeat without doing anything (the user's rule, given in
// three sessions: "do not fake being productive by waiting on long running processes"; an agent
// waited on a landing's build and tests from 10:21 on, ending its turn again and again):
// - a `wait` naming a job it already waited on, with no tool call since that wait, needs a `reason`;
// - an accepted wait arms a wake-up after `WAIT_NUDGE_MS` of idle waiting (then twice as long each
//   time): if the session is still idle and the jobs run, a message tells the agent how long it has
//   waited and to use the time; waiting again then needs a reason. A single wait on a job that ends
//   sooner is never disturbed.

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runShell } from "../lib/process.ts";
import { isUserInput } from "../lib/user-input.ts";
import {
	budgetLimitText,
	continueText,
	delegatedTasks,
	describeGoal,
	findJob,
	GOAL_ENTRY,
	GOAL_SECTION,
	type Goal,
	type GoalEntryData,
	goalState,
	jobLines,
	MAX_OBJECTIVE,
	overBudget,
	type PendingJob,
	parseFlags,
	pendingText,
	sectionText,
	spendText,
	statusLine,
	waitNudgeText,
} from "./goal.ts";

export const MESSAGE_TYPE = "goal";
/** Forced continues in a row without a tool call before the guard lets the turn end. */
export const MAX_IDLE_CONTINUES = 3;
export const CHECK_TIMEOUT_MS = 10 * 60_000;
/** Idle waiting on jobs after which the agent is woken to use the time; each later wake-up comes after twice the time. */
export const WAIT_NUDGE_MS = 15 * 60_000;

const minutesText = (ms: number) => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
};
/** Output of a failed check shown to the agent, from its end. */
const CHECK_TAIL = 4000;

/**
 * What the goal reads of a session's background work. The job state (`sessionJobs` of the
 * background-job module: tool calls moved to the background, and processes bash calls left running)
 * is process-wide in `globalThis.__harnessJobs`, so it outlives reloads; it is read here directly,
 * loosely typed, so the goal does not depend on that module's path or a job's exact fields.
 */
interface JobsView {
	jobs?: Map<string, { callId: string; command?: string; toolName?: string; input?: Record<string, unknown>; startedAt?: number; pgid?: number }>;
	leftovers?: Map<number, { pid: number; command: string; adoptedAt?: number }>;
}

const clipLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);

/** The session's background work that wakes it when it ends: calls running in the background and processes calls left running. */
export function pendingJobs(sessionId: string): PendingJob[] {
	const state = (globalThis as { __harnessJobs?: Map<string, JobsView> }).__harnessJobs?.get(sessionId);
	const calls = [...(state?.jobs?.values() ?? [])].map((job) => {
		const command = job.command ?? (typeof job.input?.command === "string" ? job.input.command : `${job.toolName ?? "tool"} ${clipLine(JSON.stringify(job.input ?? {}))}`);
		return { key: `call ${job.callId}`, command, ids: [job.callId, ...(job.pgid === undefined ? [] : [String(job.pgid)])], ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }) };
	});
	const left = [...(state?.leftovers?.values() ?? [])].map((p) => ({ key: `pid ${p.pid}`, command: p.command, ids: [String(p.pid)], ...(p.adoptedAt === undefined ? {} : { startedAt: p.adoptedAt }) }));
	return [...calls, ...left];
}

const DESCRIPTION =
	"Set, show or finish this session's goal: an objective the session keeps working on until it is achieved. While it is active, your turn cannot end: continue, mark it achieved (its check, if any, must exit 0) or blocked with a reason, or, when every remaining step depends on a running background job, `wait` naming each step's job.";

const parameters = Type.Object(
	{
		action: Type.Union([Type.Literal("set"), Type.Literal("achieved"), Type.Literal("blocked"), Type.Literal("wait"), Type.Literal("show")], {
			description: "set: a new goal (or the same objective again, to update it or make it active). achieved / blocked: finish it. wait: every remaining step depends on a running background job. show: the goal and its spend.",
		}),
		objective: Type.Optional(Type.String({ description: `set: what must be true when the goal is achieved, specific and checkable (at most ${MAX_OBJECTIVE} characters).` })),
		check: Type.Optional(Type.String({ description: "set: a shell command (run in the session's directory) that must exit 0 for the goal to count as achieved, e.g. 'npm test'." })),
		budget_usd: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "set: stop when the model spent this many USD on the goal." })),
		budget_tokens: Type.Optional(Type.Integer({ minimum: 1, description: "set: stop when the model processed this many new tokens (input, output, cache writes) on the goal." })),
		reason: Type.Optional(Type.String({ description: "blocked: what blocks it and what is needed to go on. wait: needed to wait again on a job you already waited on without doing anything since: why nothing else can be done meanwhile." })),
		steps: Type.Optional(
			Type.Array(Type.Object({ step: Type.String({ description: "A remaining step of the goal." }), job: Type.String({ description: "The running job it waits for: `call <id>`, `pid <n>`, `task <taskId>` (a delegated task), or part of its command or task title." }) }, { additionalProperties: false }), {
				description: "wait: every remaining step, each with the job it depends on.",
			}),
		),
	},
	{ additionalProperties: false },
);

interface SessionMemory {
	/** Forced continues since the last tool call or user message. */
	idle: number;
	/** The guard told the user it stopped forcing. */
	notified: boolean;
	/** A valid `wait` of the current run: the job keys it named. */
	waiting: string[] | undefined;
	/** The keys of the pending jobs the agent was last told about; kept across runs. */
	told: string[];
	/** Tool calls other than `goal` so far: a wait compares it to tell whether anything was done since the last one. */
	work: number;
	/** The jobs the agent waited on, by key: since when it waits on each without other work, and when to wake it. */
	waits: Map<string, WaitRecord>;
}

interface WaitRecord {
	/** When the idle waiting on it started. */
	since: number;
	/** `work` at the last accepted wait on it. */
	work: number;
	/** Wake-ups sent so far for this stretch of waiting. */
	nudges: number;
	nudgeAt: number;
}

const freshMemory = (): SessionMemory => ({ idle: 0, notified: false, waiting: undefined, told: [], work: 0, waits: new Map() });

export interface GoalOptions {
	/** Idle waiting before the first wake-up; default {@link WAIT_NUDGE_MS}. */
	waitNudgeMs?: number;
}

const tail = (text: string, max: number) => (text.length > max ? `[…]\n${text.slice(-max)}` : text);

/** What the goal may wait on: the session's background work and the tasks it delegated whose completion wakes it. */
const waitable = (ctx: ExtensionContext) => [...pendingJobs(ctx.sessionManager.getSessionId()), ...delegatedTasks(ctx.sessionManager.getBranch()).running];

export default function goal(pi: ExtensionAPI, options: GoalOptions = {}) {
	const nudgeMs = options.waitNudgeMs ?? WAIT_NUDGE_MS;
	let memory = freshMemory();
	let nudgeTimer: NodeJS.Timeout | undefined;
	const disarm = () => {
		clearTimeout(nudgeTimer);
		nudgeTimer = undefined;
	};
	/** Wake the agent at the earliest wake-up of the jobs its current wait names. */
	const arm = (ctx: ExtensionContext) => {
		disarm();
		const records = (memory.waiting ?? []).flatMap((key) => memory.waits.get(key) ?? []);
		if (records.length === 0) return;
		const at = Math.min(...records.map((r) => r.nudgeAt));
		nudgeTimer = setTimeout(() => nudge(ctx), Math.max(0, at - Date.now()));
		nudgeTimer.unref();
	};
	const nudge = (ctx: ExtensionContext) => {
		nudgeTimer = undefined;
		const waiting = memory.waiting;
		// A run since the wait (a job's end, a user message) made it decide anew: nothing to wake.
		if (!waiting || !ctx.isIdle() || state(ctx).goal?.status !== "active") return;
		const running = waitable(ctx).filter((job) => waiting.includes(job.key));
		const records = running.flatMap((job) => memory.waits.get(job.key) ?? []);
		if (records.length === 0) return;
		const now = Date.now();
		for (const record of records) {
			record.nudges++;
			record.nudgeAt = now + nudgeMs * 2 ** record.nudges;
		}
		pi.sendMessage({ customType: MESSAGE_TYPE, content: waitNudgeText(running, now - Math.min(...records.map((r) => r.since)), now), display: true }, { triggerTurn: true, deliverAs: "steer" });
	};
	const state = (ctx: ExtensionContext) => goalState(ctx.sessionManager.getBranch());
	const refresh = (ctx: ExtensionContext) => {
		const { goal, spent } = state(ctx);
		ctx.ui.setStatus(MESSAGE_TYPE, goal ? statusLine(goal, spent) : undefined);
	};
	const save = (ctx: ExtensionContext, next: Goal | null) => {
		pi.appendEntry<GoalEntryData>(GOAL_ENTRY, { goal: next });
		refresh(ctx);
	};
	const entry = (next: Goal | null): SessionBoundaryDraft => ({ type: "custom", customType: GOAL_ENTRY, data: { goal: next } satisfies GoalEntryData });
	const message = (content: string): SessionBoundaryDraft => ({ type: "custom_message", customType: MESSAGE_TYPE, content, display: true });
	/** Tell the agent about a change the user made; starts a run when the session is idle. */
	const tellAgent = (content: string) => pi.sendMessage({ customType: MESSAGE_TYPE, content, display: true }, { triggerTurn: true, deliverAs: "steer" });

	const reset = (ctx: ExtensionContext) => {
		disarm();
		memory = freshMemory();
		refresh(ctx);
	};
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_tree", (_event, ctx) => reset(ctx));
	pi.on("session_shutdown", () => disarm());
	pi.on("tool_call", (event) => {
		if (event.toolName !== "goal") memory.work++;
	});
	pi.on("session_compact", (_event, ctx) => refresh(ctx));

	// A user message: the guard starts over, and a goal blocked (on the user) is active again.
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		memory.idle = 0;
		memory.notified = false;
		// Only the user's words unblock a goal: a t3 notification (a delegated task ended) is not the
		// answer a blocked goal waits for.
		if (!isUserInput(event)) return;
		const { goal } = state(ctx);
		if (goal?.status === "blocked") save(ctx, { ...goal, status: "active", reason: undefined });
	});

	pi.on("before_agent_start", (event, ctx) => {
		memory.waiting = undefined;
		const { goal } = state(ctx);
		if (goal?.status === "active") event.systemPromptOptions.sections[GOAL_SECTION] = sectionText(goal);
		else delete event.systemPromptOptions.sections[GOAL_SECTION];
	});

	/** When the budget is reached: the entries that make the goal budget-limited and ask for a summary. */
	const budgetReached = (ctx: ExtensionContext): SessionBoundaryDraft[] | undefined => {
		const { goal, spent } = state(ctx);
		if (goal?.status !== "active" || !overBudget(goal, spent)) return undefined;
		const limited: Goal = { ...goal, status: "budget-limited" };
		ctx.ui.setStatus(MESSAGE_TYPE, statusLine(limited, spent));
		return [entry(limited), message(budgetLimitText(goal, spent))];
	};

	pi.on("turn_end", (event, ctx) => {
		const calls = event.message.role === "assistant" ? event.message.content.filter((c) => c.type === "toolCall") : [];
		if (calls.some((c) => c.name !== "goal")) {
			memory.idle = 0;
			memory.notified = false;
		}
		const limited = budgetReached(ctx);
		if (!limited) {
			refresh(ctx);
			return;
		}
		// Without tool calls the run would end here: one more request writes the summary.
		return { entries: [...event.entries, ...limited], ...(calls.length === 0 && event.outcome === "completed" ? { continue: true } : {}) };
	});

	pi.on("agent_before_settle", (event, ctx) => {
		if (event.outcome !== "completed") return;
		const limited = budgetReached(ctx);
		if (limited) {
			return { entries: [...event.entries, ...limited], continue: true };
		}
		const { goal, spent } = state(ctx);
		if (goal?.status !== "active") {
			// Delegated tasks are not named here: t3 tells the agent their completion wakes it.
			const jobs = pendingJobs(ctx.sessionManager.getSessionId());
			const keys = jobs.map((job) => job.key);
			const told = new Set(memory.told);
			// Ended jobs drop out, so the memory holds only what still runs.
			memory.told = keys;
			if (keys.every((key) => told.has(key))) return;
			return { entries: [...event.entries, message(pendingText(jobs, Date.now()))], continue: true };
		}
		const jobs = waitable(ctx);
		const keys = jobs.map((job) => job.key);
		if (memory.waiting?.every((key) => keys.includes(key))) return;
		if (memory.idle >= MAX_IDLE_CONTINUES) {
			if (!memory.notified && ctx.hasUI) ctx.ui.notify(`Goal: the agent stopped ${MAX_IDLE_CONTINUES + 1} times in a row without a tool call, so its turn ended. The goal stays active: send a message to go on, or /goal pause.`, "warning");
			memory.notified = true;
			return;
		}
		memory.idle++;
		if (keys.length > 0) memory.told = keys;
		return { entries: [...event.entries, message(continueText(goal, spent, jobs, Date.now()))], continue: true };
	});

	pi.registerTool({
		name: "goal",
		label: "goal",
		description: DESCRIPTION,
		promptSnippet: "Set, show or finish the session's goal",
		promptGuidelines: [
			"Set a goal with `goal` (action set) when the user or your brief asks you to keep going until something is done (\"continue until all tests pass\", a delegated brief that says to finish X before reporting); a single task needs none. While it is active your turn cannot end: continue, mark it achieved (after auditing every requirement of the objective against evidence; with a check, only when the check exits 0) or blocked with the reason.",
			"While a goal is active and background jobs or delegated tasks run, do the remaining steps that do not depend on them. Only when every remaining step depends on a running job or task, call `goal` with action `wait`, naming each step's job, as the only call of its response: it ends your turn, and the job's end wakes you. Waiting again on the same job without doing anything in between needs a `reason`.",
		],
		parameters,
		async execute(_callId, params, signal, _onUpdate, ctx) {
			const { goal: current, spent } = state(ctx);
			const done = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
			if (params.action === "show") return done(describeGoal(current, spent));

			if (params.action === "set") {
				const objective = params.objective?.trim();
				if (!objective) throw new Error("set needs an objective.");
				if (objective.length > MAX_OBJECTIVE) throw new Error(`The objective has ${objective.length} characters; at most ${MAX_OBJECTIVE}.`);
				const same = current?.objective === objective;
				if (current && !same && current.setBy === "user" && (current.status === "active" || current.status === "paused"))
					throw new Error(`The user set this session's goal, and it is ${current.status}: ${current.objective}\nYou cannot replace it; work toward it, or mark it achieved or blocked.`);
				if (same && current.status === "paused") throw new Error("The user paused this goal; only they can resume it (/goal resume).");
				const budget = params.budget_usd === undefined && params.budget_tokens === undefined ? (same ? current.budget : undefined) : { ...(params.budget_usd === undefined ? {} : { usd: params.budget_usd }), ...(params.budget_tokens === undefined ? {} : { tokens: params.budget_tokens }) };
				const check = params.check?.trim() || (same ? current.check : undefined);
				const next: Goal = {
					id: same ? current.id : randomUUID(),
					objective,
					...(check ? { check } : {}),
					...(budget ? { budget } : {}),
					status: "active",
					setBy: same ? current.setBy : "agent",
				};
				if (same && overBudget(next, spent)) throw new Error(`The goal's budget is spent (${spendText(next, spent)}); set a larger budget to go on.`);
				save(ctx, next);
				return done(`Goal ${same ? "updated" : "set"} and active. Your turn cannot end while it is active: work toward it, then mark it achieved${next.check ? " (its check must exit 0)" : ""} or blocked with the reason.\n\n${describeGoal(next, same ? spent : { usd: 0, tokens: 0 })}`);
			}

			if (!current) throw new Error("No goal is set.");

			if (params.action === "blocked") {
				const reason = params.reason?.trim();
				if (!reason) throw new Error("blocked needs a reason: what blocks the goal and what is needed to go on.");
				if (current.status === "achieved") throw new Error("The goal is already achieved.");
				save(ctx, { ...current, status: "blocked", reason });
				return done(`Goal blocked: ${reason}\nIt no longer keeps your turn going; a message from the user makes it active again. Tell the user what you need.`);
			}

			if (params.action === "achieved") {
				if (current.status === "achieved") return done("The goal is already achieved.");
				if (current.check) {
					const result = await runShell(current.check, { cwd: ctx.cwd, timeoutMs: CHECK_TIMEOUT_MS, ...(signal ? { signal } : {}) });
					if (result.exitCode !== 0) {
						const how = result.timedOut ? `did not finish within ${CHECK_TIMEOUT_MS / 60_000} minutes` : result.aborted ? "was aborted" : `exited with code ${result.exitCode ?? "(killed by a signal)"}`;
						throw new Error(`The goal's check \`${current.check}\` ${how}, so the goal is not achieved and stays ${current.status}. Fix what it reports, then mark it achieved again.\n\n${tail(result.output.trim(), CHECK_TAIL) || "(no output)"}`);
					}
				}
				save(ctx, { ...current, status: "achieved", reason: undefined });
				return done(`Goal achieved${current.check ? ` (its check \`${current.check}\` exited 0)` : ""}. Spent while active: ${spendText(current, spent)}. Report the result to the user.`);
			}

			// wait
			if (current.status !== "active") throw new Error(`The goal is ${current.status}; nothing keeps your turn going, so there is nothing to wait for.`);
			const jobs = waitable(ctx);
			const { ended } = delegatedTasks(ctx.sessionManager.getBranch());
			/** The ended delegated tasks the steps name: their result or request reached the conversation already. */
			const endedLine = (named: readonly { job: string }[]) => {
				const tasks = [...ended].filter((taskId) => named.some((s) => s.job.includes(taskId)));
				return tasks.length ? [`Delegated task ${tasks.join(", ")} ended already or no longer wakes you (it waits on a question or approval): its result or request is in the conversation or in task_status.`] : [];
			};
			const steps = params.steps ?? [];
			if (jobs.length === 0) throw new Error(["No background job or delegated task is running, so nothing will wake you.", ...endedLine(steps), "Continue with the next step, or mark the goal achieved or blocked."].join(" "));
			if (steps.length === 0) throw new Error("wait needs every remaining step, each with the running job it depends on.");
			const resolved = steps.map((s) => ({ ...s, found: findJob(jobs, s.job) }));
			const unknown = resolved.filter((s) => !s.found);
			const now = Date.now();
			if (unknown.length > 0)
				throw new Error(
					[
						`These steps name no running job: ${unknown.map((s) => `"${s.step}" (${s.job})`).join(", ")}.`,
						...endedLine(unknown),
						"Running jobs:",
						...jobLines(jobs, now),
						"A step that depends on none of them can be done now: do it. Name each job as `call <id>`, `pid <n>`, `task <taskId>` or a part of its command found in no other job.",
					].join("\n"),
				);
			const keys = [...new Set(resolved.map((s) => s.found!.key))];
			// Jobs that ended no longer count as waited on.
			for (const key of memory.waits.keys()) if (!jobs.some((job) => job.key === key)) memory.waits.delete(key);
			const idle = keys.filter((key) => memory.waits.get(key)?.work === memory.work);
			const reason = params.reason?.trim();
			if (idle.length > 0 && !reason) {
				const since = Math.min(...idle.map((key) => memory.waits.get(key)!.since));
				throw new Error(
					[
						`You have been waiting on ${idle.join(", ")} for ${minutesText(now - since)} and made no tool call since your last wait: waiting again is not progress.`,
						"Use the time: do the steps that do not depend on it (assume it succeeds where safe), cut its run time (fewer tests or targets, split, parallel), or start independent work in parallel.",
						"Only if every remaining step still depends on it, call `wait` again with a `reason` saying why nothing else can be done meanwhile.",
					].join("\n"),
				);
			}
			for (const key of keys) {
				const record = memory.waits.get(key);
				// Waiting on it again without work continues the stretch of idle waiting; after work, a new one starts.
				if (record && idle.includes(key)) record.work = memory.work;
				else memory.waits.set(key, { since: now, work: memory.work, nudges: 0, nudgeAt: now + nudgeMs });
			}
			memory.waiting = keys;
			memory.told = jobs.map((job) => job.key);
			arm(ctx);
			// An accepted wait ends the run here: without `terminate` the model was called once more only to
			// write a closing line (3,879 such turns, 2.3% of Pi spend; docs/research/context-engineering/10 §5).
			return {
				...done(
					`Waiting is fine: every remaining step depends on a running job (${resolved.map((s) => `"${s.step}" → ${s.found!.key}`).join("; ")}).${reason && idle.length ? ` Your reason to wait again: ${reason}` : ""} Your turn ends here; the job's end wakes you with its result. If you are still waiting idle after a while, you will be woken to use the time.`,
				),
				terminate: true,
			};
		},
	});

	pi.registerCommand("goal", {
		description: "Set or show the session's goal: /goal [--check <cmd>] [--budget <$5|200k>] <objective> | pause | resume | clear | edit",
		getArgumentCompletions: (prefix) => {
			const items = ["pause", "resume", "clear", "edit"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const { goal: current, spent } = state(ctx);
			const notify = (text: string, level: "info" | "warning" = "info") => ctx.ui.notify(text, level);
			const text = args.trim();
			if (!text) return notify(describeGoal(current, spent));

			if (text === "pause" || text === "resume" || text === "clear") {
				if (!current) return notify("No goal is set.", "warning");
				if (text === "clear") {
					save(ctx, null);
					return notify("Goal cleared.");
				}
				if (text === "pause") {
					if (current.status !== "active") return notify(`The goal is ${current.status}, not active.`, "warning");
					save(ctx, { ...current, status: "paused" });
					return notify("Goal paused: it no longer keeps the agent's turn going. /goal resume continues it.");
				}
				if (current.status === "active" || current.status === "achieved") return notify(`The goal is ${current.status}.`, "warning");
				if (overBudget(current, spent)) return notify("The goal's budget is spent; raise it first: /goal edit --budget <$|tokens>.", "warning");
				const next: Goal = { ...current, status: "active", reason: undefined };
				save(ctx, next);
				memory.idle = 0;
				memory.notified = false;
				tellAgent(`The user resumed the goal. Continue working toward it:\n\n${next.objective}`);
				return;
			}

			const edit = /^edit(\s|$)/.test(text);
			const flags = parseFlags(edit ? text.slice(4) : text);
			if ("error" in flags) return notify(flags.error, "warning");
			let objective = flags.objective;
			if (edit) {
				if (!current) return notify("No goal to edit. Set one with /goal <objective> (or /goal -- edit … for an objective that starts with \"edit\").", "warning");
				if (objective === undefined && flags.check === undefined && flags.budget === undefined) {
					if (!ctx.hasUI) return notify("Usage: /goal edit [--check <cmd>|--no-check] [--budget <$5|200k>|--no-budget] [objective]", "warning");
					objective = (await ctx.ui.editor("Edit the goal", current.objective))?.trim();
					if (!objective) return notify("Goal unchanged.");
				}
			} else if (!objective) return notify("Usage: /goal [--check <cmd>] [--budget <$5|200k>] <objective>", "warning");
			if (objective && objective.length > MAX_OBJECTIVE) return notify(`The objective has ${objective.length} characters; at most ${MAX_OBJECTIVE}.`, "warning");

			const base: Goal | undefined = edit ? current : undefined;
			const check = flags.check === null ? undefined : (flags.check ?? base?.check);
			const budget = flags.budget === null ? undefined : flags.budget ? { ...(base?.budget ?? {}), ...flags.budget } : base?.budget;
			const next: Goal = {
				id: base?.id ?? randomUUID(),
				objective: objective ?? base!.objective,
				...(check ? { check } : {}),
				...(budget ? { budget } : {}),
				status: base?.status ?? "active",
				...(base?.reason ? { reason: base.reason } : {}),
				setBy: "user",
			};
			save(ctx, next);
			memory.idle = 0;
			memory.notified = false;
			if (!edit) return tellAgent(`The user set a goal for this session. Work toward it until it is achieved:\n\n${describeGoal(next, { usd: 0, tokens: 0 })}`);
			notify(describeGoal(next, state(ctx).spent));
			if (next.status === "active") tellAgent(`The user edited the goal. Continue toward it:\n\n${describeGoal(next, state(ctx).spent)}`);
		},
	});
}
