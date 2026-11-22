// A session's goal: its state, read from the session branch, its spend, and the texts the model
// and the user see. Pure functions; extensions/goal/index.ts wires them into Pi.
//
// The goal is stored as custom session entries (`harness-goal`), each holding the whole goal after
// a change (or `null` once cleared). The last one on the branch is the current goal, so it survives
// restarts, reloads and compaction, and branch navigation shows the goal of that branch.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ago, contentText, parseObject, str, T3_TOOL } from "../lib/t3-result.ts";

export const GOAL_ENTRY = "harness-goal";
export const GOAL_SECTION = "goal";
export const MAX_OBJECTIVE = 4000;

export type GoalStatus = "active" | "paused" | "achieved" | "blocked" | "budget-limited";

export interface Budget {
	usd?: number;
	tokens?: number;
}

export interface Goal {
	/** New for each goal set with a different objective; spend counts per id. */
	id: string;
	objective: string;
	/** A shell command that must exit 0 for the goal to count as achieved. */
	check?: string;
	budget?: Budget;
	status: GoalStatus;
	/** Why it is blocked. */
	reason?: string;
	setBy: "user" | "agent";
}

export interface GoalEntryData {
	goal: Goal | null;
}

export interface Spend {
	usd: number;
	/** Tokens the model processed anew: input, output and cache writes. Cache reads repeat the context on every request, so they would make a token budget measure context size instead of work. */
	tokens: number;
}

const goalOf = (entry: SessionEntry): Goal | null | undefined => (entry.type === "custom" && entry.customType === GOAL_ENTRY ? ((entry.data as GoalEntryData | undefined)?.goal ?? null) : undefined);

/** The current goal of a branch and what the model spent on it while it was active. */
export function goalState(branch: readonly SessionEntry[]): { goal: Goal | undefined; spent: Spend } {
	let goal: Goal | undefined;
	let spent: Spend = { usd: 0, tokens: 0 };
	for (const entry of branch) {
		const next = goalOf(entry);
		if (next !== undefined) {
			if (next?.id !== goal?.id) spent = { usd: 0, tokens: 0 };
			goal = next ?? undefined;
			continue;
		}
		if (goal?.status !== "active" || entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		spent = { usd: spent.usd + (usage?.cost?.total ?? 0), tokens: spent.tokens + (usage ? usage.input + usage.output + usage.cacheWrite : 0) };
	}
	return { goal, spent };
}

export const overBudget = (goal: Goal, spent: Spend): boolean =>
	(goal.budget?.usd !== undefined && spent.usd >= goal.budget.usd) || (goal.budget?.tokens !== undefined && spent.tokens >= goal.budget.tokens);

export const formatUsd = (usd: number) => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(0)}`;
export const formatTokens = (tokens: number) => (tokens >= 1e6 ? `${+(tokens / 1e6).toFixed(1)}M` : tokens >= 1e3 ? `${+(tokens / 1e3).toFixed(1)}k` : String(tokens));

/** `$5`, `5usd`, `5` (dollars) or `200k`, `2m`, `150000 tokens` (tokens). */
export function parseBudget(text: string): Budget | undefined {
	const match = /^\s*(\$)?\s*(\d+(?:\.\d+)?)\s*(usd|\$|k|m|tokens?)?\s*$/i.exec(text);
	if (!match) return undefined;
	const value = Number(match[2]);
	const unit = match[3]?.toLowerCase();
	if (!(value > 0)) return undefined;
	if (match[1] && unit && unit !== "usd" && unit !== "$") return undefined;
	if (unit === "k") return { tokens: Math.round(value * 1e3) };
	if (unit === "m") return { tokens: Math.round(value * 1e6) };
	if (unit?.startsWith("token")) return Number.isInteger(value) ? { tokens: value } : undefined;
	return { usd: value };
}

const budgetText = (budget: Budget) => [budget.usd === undefined ? "" : formatUsd(budget.usd), budget.tokens === undefined ? "" : `${formatTokens(budget.tokens)} tokens`].filter(Boolean).join(" or ");

/** What was spent, against the budget when there is one. */
export function spendText(goal: Goal, spent: Spend): string {
	const usd = goal.budget?.usd === undefined ? formatUsd(spent.usd) : `${formatUsd(spent.usd)} of ${formatUsd(goal.budget.usd)}`;
	const tokens = goal.budget?.tokens === undefined ? formatTokens(spent.tokens) : `${formatTokens(spent.tokens)} of ${formatTokens(goal.budget.tokens)}`;
	return `${usd}, ${tokens} tokens`;
}

const clip = (text: string, max: number) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The status line: short, one line. */
export function statusLine(goal: Goal, spent: Spend): string {
	const budget = goal.budget ? ` · ${spendText(goal, spent)}` : "";
	return `goal ${goal.status}: ${clip(goal.objective, 48)}${budget}`;
}

/** The whole goal, for `/goal` and the tool's `show`. */
export function describeGoal(goal: Goal | undefined, spent: Spend): string {
	if (!goal) return "No goal is set. Set one with `/goal <objective>`.";
	return [
		`Goal (${goal.status}${goal.status === "blocked" && goal.reason ? `: ${goal.reason}` : ""}, set by ${goal.setBy === "user" ? "the user" : "the agent"}):`,
		goal.objective,
		...(goal.check ? [`Check: \`${goal.check}\` must exit 0.`] : []),
		...(goal.budget ? [`Budget: ${budgetText(goal.budget)}.`] : []),
		`Spent while active: ${spendText(goal, spent)}.`,
	].join("\n");
}

const checkLine = (goal: Goal) => (goal.check ? `It counts as achieved only when \`${goal.check}\` exits 0; the check runs when you mark it achieved.` : "");

/**
 * The prompt section while the goal is active. It holds only what changes with the goal itself, not
 * the spend, so it stays the same from run to run and the cached prompt with it.
 */
export function sectionText(goal: Goal): string {
	return [
		`This session has a goal, set by ${goal.setBy === "user" ? "the user" : "you"}:\n${goal.objective}`,
		[checkLine(goal), goal.budget ? `Budget: ${budgetText(goal.budget)}.` : ""].filter(Boolean).join(" "),
		"Keep working toward it until it is achieved. Then audit it: map every requirement of the objective to evidence you checked (files, command output, test results), and mark it achieved with the `goal` tool. If you cannot go on without the user or something outside your reach, mark it blocked with the reason. Your turn cannot end while the goal is active, except when every remaining step depends on a running background job (the `goal` tool's `wait`).",
	]
		.filter(Boolean)
		.join("\n\n");
}

/** A background job the session's turn may wait on: a background call, a process, or a delegated task. */
export interface PendingJob {
	/** How the agent names it: `call <id>`, `pid <n>` or `task <taskId>`. */
	key: string;
	command: string;
	/** Other names that match it exactly: the call id, pid or process group. */
	ids: string[];
	startedAt?: number;
}

/** Run statuses of a thread that are not over: a task a `t3_thread_send` started then runs. */
const RUN_GOING = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * A delegated task the goal's `wait` found running through t3 (`task_status`) although the branch
 * holds no result about it: a continuation of a child (t3 starts a new task when the child runs again
 * after its result, e.g. woken by its own job, a usage-limit continuation or a follow-up a script
 * sent). The wait's result stores them in its `details`, so they are read from the branch like the rest.
 */
export interface ResolvedTask {
	taskId: string;
	/** The task's child thread, and the names the agent used for it (an earlier task of that child). */
	ids: string[];
	title?: string;
}

/** The `details` of an accepted `wait` that resolved tasks through t3. */
export interface WaitDetails {
	tasks: ResolvedTask[];
}

const resolvedTasks = (details: unknown): ResolvedTask[] => {
	const tasks = details && typeof details === "object" ? (details as Partial<WaitDetails>).tasks : undefined;
	return Array.isArray(tasks) ? tasks.filter((task): task is ResolvedTask => typeof task?.taskId === "string" && Array.isArray(task.ids)) : [];
};

/**
 * The tasks the session delegated through t3 (`delegate_task`, or `t3_thread_send` to a finished
 * child thread, which starts a fresh task) whose completion will wake it, read from the branch.
 *
 * t3 marks such a task in every result about it with `next` ("Completion wakes this thread, so end
 * your turn"); a result without it (a finished task, `task_cancel`, a child waiting on a question or
 * approval, whose answer the session owes) ends what the session may wait on. The completion reaches
 * the session as a user message `Delegated task <taskId> (title) [status]: …`, which ends it too.
 * Tasks a `goal` wait resolved through t3 (`details.tasks`) run until their completion message.
 * `known` holds every delegated task seen, ended ones too, with its child thread: the session's own
 * children (the thread-wait guard refuses waiting on them; a wait naming one is resolved through t3).
 * Read from the branch, not process state: it survives reloads and restarts as the session does.
 */
export function delegatedTasks(branch: readonly SessionEntry[]): { running: PendingJob[]; ended: Set<string>; known: PendingJob[] } {
	const known = new Map<string, PendingJob>();
	const running = new Set<string>();
	const ended = new Set<string>();
	const end = (taskId: string) => {
		running.delete(taskId);
		ended.add(taskId);
	};
	const learn = (taskId: string, ids: readonly string[], title: string | undefined, at: number) => {
		const previous = known.get(taskId);
		// A later task of a child (a follow-up, a continuation) keeps the child's title.
		const sibling = previous ? undefined : [...known.values()].filter((job) => job.command !== "delegated task" && ids.some((id) => job.ids.includes(id))).at(-1);
		known.set(taskId, {
			key: `task ${taskId}`,
			command: title ? `delegated task: ${title}` : (previous?.command ?? sibling?.command ?? "delegated task"),
			ids: [...new Set([taskId, ...(previous?.ids ?? []), ...ids])],
			startedAt: previous?.startedAt ?? at,
		});
	};
	const start = (taskId: string) => {
		ended.delete(taskId);
		running.add(taskId);
	};
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult") {
			if (message.isError) continue;
			if (message.toolName === "goal") {
				for (const task of resolvedTasks(message.details)) {
					learn(task.taskId, task.ids, task.title, message.timestamp);
					start(task.taskId);
				}
				continue;
			}
			if (!T3_TOOL.test(message.toolName)) continue;
			const data = parseObject(contentText(message.content).trim());
			const taskId = str(data?.taskId);
			if (!data || !taskId) continue;
			const threads = [str(data.childThreadId), str(data.threadId)].filter((id): id is string => id !== undefined);
			learn(taskId, threads, /^\[(.+)\]\(/.exec(str(data.link) ?? "")?.[1], message.timestamp);
			const wakes = str(data.next) !== undefined || (message.toolName.endsWith("t3_thread_send") && RUN_GOING.has(String(data.status)));
			if (wakes) start(taskId);
			else end(taskId);
		} else if ((message.role === "user" || message.role === "custom") && running.size > 0) {
			const text = contentText(message.content);
			for (const taskId of [...running]) if (text.includes(`Delegated task ${taskId}`)) end(taskId);
		}
	}
	return { running: [...known.values()].filter((task) => running.has(task.key.slice(5))), ended, known: [...known.values()] };
}

/** The session's own delegated task a thread belongs to (the newest one of that child), if any. */
export function ownChild(branch: readonly SessionEntry[], threadId: string): PendingJob | undefined {
	const { running, known } = delegatedTasks(branch);
	// t3's waits take threads: a task id names no child thread.
	if (known.some((job) => job.key === `task ${threadId}`)) return undefined;
	const of = (jobs: readonly PendingJob[]) => jobs.filter((job) => job.ids.includes(threadId)).at(-1);
	return of(running) ?? of(known);
}

export const jobLines = (jobs: readonly PendingJob[], now: number) =>
	jobs.map((job) => `- ${job.key}: \`${clip(job.command, 160)}\`${job.startedAt === undefined ? "" : ` (running ${ago(now - job.startedAt)})`}`);

/** The message that keeps a run from settling while the goal is active. With pending jobs, the strict form. */
export function continueText(goal: Goal, spent: Spend, jobs: readonly PendingJob[], now: number): string {
	const head = [
		"Your goal is still active, so your turn does not end yet.",
		"",
		`Goal: ${goal.objective}`,
		...(goal.check ? [`Check: \`${goal.check}\` must exit 0.`] : []),
		...(goal.budget ? [`Spent: ${spendText(goal, spent)}.`] : []),
		"",
	];
	const close = [
		"- If it is done, audit every requirement of the objective against evidence, then mark it achieved with the `goal` tool (its check must pass).",
		"- If you cannot go on without the user or something outside your reach, mark it blocked with the reason.",
	];
	if (jobs.length === 0) return [...head, "Do one of these now:", "- Continue with the next step toward the goal.", ...close].join("\n");
	return [
		...head,
		"Background work is still running; its end wakes you with its result:",
		...jobLines(jobs, now),
		"",
		"Do not stop to wait for it. Do one of these now:",
		"- List the remaining steps of the goal that do not depend on these jobs, and do them now.",
		"- Only when every remaining step depends on one of these jobs: call the `goal` tool with action `wait`, naming for each remaining step the job it waits for. Then end your turn; the job's end wakes you.",
		...close,
	].join("\n");
}

/**
 * The message that continues a run once when it would settle without a goal while background jobs
 * the agent was not yet told about run: ending the turn to wait for them is right only when every
 * remaining step depends on them.
 */
export function pendingText(jobs: readonly PendingJob[], now: number): string {
	return [
		"Your turn is about to end while background work runs; its end wakes you with its result:",
		...jobLines(jobs, now),
		"",
		"Do not end your turn to wait for it. Continue now with the remaining steps that do not depend on these jobs; where it is safe, assume they succeed and let their result correct you.",
		"Only if every remaining step depends on them, or a job is a server you keep running on purpose, end your turn with one line naming what you wait for.",
	].join("\n");
}

/**
 * The message that wakes an agent which has waited on jobs for a long time without other work: the
 * user's most repeated rule is to use waiting time ("you are waiting since 10:21 on tests, same
 * problem all over again", 2026-11-19), and the wording of the strict continue alone did not keep
 * agents from it.
 */
export function waitNudgeText(jobs: readonly PendingJob[], waitedMs: number, now: number): string {
	return [
		`You have been waiting ${ago(waitedMs)} on background work without doing anything else:`,
		...jobLines(jobs, now),
		"",
		"Do not keep waiting idle; use the time. Do one of these now:",
		"- Do the remaining steps of the goal that do not depend on these jobs, assuming they succeed where that is safe.",
		"- Cut a job's run time: run only the tests or targets that matter, split it, or run its parts in parallel; restart it that way if that is faster than waiting.",
		"- Start independent work in parallel: other checks, reviews, docs, a delegated task.",
		"Only if every remaining step still depends on these jobs, call the `goal` tool with action `wait` again, with a `reason` saying why nothing else can be done meanwhile.",
	].join("\n");
}

/** The message when the budget is reached: wrap up. */
export function budgetLimitText(goal: Goal, spent: Spend): string {
	return [
		`The budget of your goal is reached (spent ${spendText(goal, spent)}); the goal is now budget-limited and no longer keeps your turn going.`,
		"Start no new substantive work. Write a short summary for the user: what is done, with evidence, what remains, and what the next step would be. Then end your turn.",
	].join("\n");
}

/** The job a name refers to: its key, call id, pid or process group exactly, else the one job whose command contains it. */
export function findJob(jobs: readonly PendingJob[], name: string): PendingJob | undefined {
	const wanted = name.trim().replace(/^`|`$/g, "").trim().toLowerCase();
	if (!wanted) return undefined;
	const bare = wanted.replace(/^(call|pid|job|task|process group|pgid)\s+/, "");
	const exact = jobs.find((job) => job.key.toLowerCase() === wanted || job.ids.some((id) => id.toLowerCase() === bare));
	if (exact) return exact;
	const partial = jobs.filter((job) => job.command.toLowerCase().includes(bare));
	return partial.length === 1 ? partial[0] : undefined;
}

export interface Flags {
	/** `null`: remove it. */
	check?: string | null;
	budget?: Budget | null;
	objective?: string;
}

/** Split command arguments into words, honouring single and double quotes. */
function words(text: string): { word: string; end: number }[] {
	const out: { word: string; end: number }[] = [];
	const pattern = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/gy;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text))) {
		out.push({ word: match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : (match[2] ?? match[3]!), end: pattern.lastIndex });
	}
	return out;
}

/**
 * Leading flags of `/goal` and `/goal edit`: `--check <cmd>`, `--no-check`, `--budget <budget>`,
 * `--no-budget`, then `--` or the objective (the rest of the text as written).
 */
export function parseFlags(text: string): Flags | { error: string } {
	const flags: Flags = {};
	const list = words(text);
	let rest = 0;
	for (let i = 0; i < list.length; i++) {
		const { word } = list[i]!;
		const value = () => list[++i]?.word;
		if (word === "--") {
			rest = list[i]!.end;
			break;
		}
		if (word === "--check") {
			const check = value();
			if (!check?.trim()) return { error: "--check needs a command." };
			flags.check = check;
		} else if (word === "--budget") {
			const raw = value();
			const budget = raw === undefined ? undefined : parseBudget(raw);
			if (!budget) return { error: `--budget needs an amount: $5 (dollars) or 200k (tokens), not ${raw === undefined ? "nothing" : `"${raw}"`}.` };
			flags.budget = { ...(flags.budget ?? {}), ...budget };
		} else if (word === "--no-check") flags.check = null;
		else if (word === "--no-budget") flags.budget = null;
		else if (word.startsWith("--")) return { error: `Unknown option ${word}. Options: --check <command>, --no-check, --budget <$5|200k>, --no-budget, --.` };
		else break;
		rest = list[i]!.end;
	}
	const objective = text.slice(rest).trim();
	if (objective) flags.objective = objective;
	return flags;
}
