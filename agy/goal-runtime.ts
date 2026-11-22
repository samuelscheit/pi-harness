// Goal action execution and transcript spend computation for Antigravity (`agy`).
//
// Shared by the `pi-harness` MCP server (`goal` tool), the `tool goal` CLI, and the `Stop` /
// `PreInvocation` lifecycle hooks so goal state stays identical everywhere.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
	budgetLimitText,
	continueText,
	describeGoal,
	type Goal,
	MAX_OBJECTIVE,
	overBudget,
	type PendingJob,
	sectionText,
	type Spend,
} from "../extensions/goal/goal.ts";
import { CHECK_TIMEOUT_MS, MAX_IDLE_CONTINUES } from "../extensions/goal/index.ts";
import { runShell } from "../extensions/lib/process.ts";
import { type AgyGoalState, loadGoalState, pluginDataDir, saveGoalState } from "./state.ts";

const CHECK_TAIL = 4000;
const tail = (text: string, max: number) => (text.length > max ? `[…]\n${text.slice(-max)}` : text);

export const goalSectionHash = (goal: Goal): string =>
	createHash("sha256").update(sectionText(goal)).digest("hex").slice(0, 16);

/** Total new tokens (input + output, excluding cache reads) recorded in an `agy` transcript.jsonl. */
export function transcriptNewTokens(transcriptPath: string | undefined): number {
	if (!transcriptPath || !existsSync(transcriptPath)) return 0;
	let tokens = 0;
	try {
		for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const step = JSON.parse(line) as { type?: string; input_tokens?: number; output_tokens?: number };
				if (step.type !== "PLANNER_RESPONSE") continue;
				if (typeof step.input_tokens === "number") tokens += step.input_tokens;
				if (typeof step.output_tokens === "number") tokens += step.output_tokens;
			} catch {
				// Partial line while transcript is being written.
			}
		}
	} catch {
		return 0;
	}
	return tokens;
}

export function goalSpend(state: AgyGoalState, transcriptPath?: string): Spend {
	const current = transcriptNewTokens(transcriptPath);
	const tokens = Math.max(0, current - state.baselineTokens);
	return { usd: 0, tokens };
}

export interface GoalActionInput {
	action: "set" | "achieved" | "blocked" | "wait" | "show" | "pause" | "resume" | "clear";
	objective?: string;
	check?: string;
	budget_usd?: number;
	budget_tokens?: number;
	reason?: string;
	steps?: { step: string; job: string }[];
	set_by?: "user" | "agent";
}

export interface GoalActionOptions {
	conversationId: string;
	cwd: string;
	transcriptPath?: string;
	dataDir?: string;
	signal?: AbortSignal;
}

export interface GoalActionResult {
	text: string;
	isError?: boolean;
}

export async function runGoalAction(input: GoalActionInput, options: GoalActionOptions): Promise<GoalActionResult> {
	const dataDir = options.dataDir ?? pluginDataDir();
	const state = loadGoalState(options.conversationId, dataDir);
	const spent = goalSpend(state, options.transcriptPath);

	switch (input.action) {
		case "show":
			return { text: describeGoal(state.goal ?? undefined, spent) };

		case "clear":
			state.goal = null;
			state.idle = 0;
			state.notified = false;
			state.waiting = undefined;
			state.injectedHash = undefined;
			saveGoalState(options.conversationId, state, dataDir);
			return { text: "Goal cleared." };

		case "pause":
			if (!state.goal) return { text: "No goal is set.", isError: true };
			state.goal = { ...state.goal, status: "paused" };
			saveGoalState(options.conversationId, state, dataDir);
			return { text: `Goal paused.\n${describeGoal(state.goal, spent)}` };

		case "resume":
			if (!state.goal) return { text: "No goal is set.", isError: true };
			state.goal = { ...state.goal, status: "active", reason: undefined };
			state.idle = 0;
			state.notified = false;
			state.waiting = undefined;
			saveGoalState(options.conversationId, state, dataDir);
			return { text: `Goal resumed.\n${describeGoal(state.goal, spent)}` };

		case "set": {
			const objective = input.objective?.trim();
			if (!objective) return { text: "action `set` requires a non-empty `objective`.", isError: true };
			if (objective.length > MAX_OBJECTIVE) return { text: `objective exceeds ${MAX_OBJECTIVE} characters.`, isError: true };
			const setBy = input.set_by ?? "agent";
			const sameObjective = state.goal?.objective === objective;
			if (setBy === "agent" && state.goal && state.goal.setBy === "user" && (state.goal.status === "active" || state.goal.status === "paused") && !sameObjective) {
				return { text: "A user-set goal is already active or paused; finish or wait on it rather than replacing it.", isError: true };
			}
			const budget =
				input.budget_usd !== undefined || input.budget_tokens !== undefined
					? { ...(input.budget_usd !== undefined ? { usd: input.budget_usd } : {}), ...(input.budget_tokens !== undefined ? { tokens: input.budget_tokens } : {}) }
					: sameObjective
						? state.goal?.budget
						: undefined;
			const next: Goal = {
				id: sameObjective && state.goal ? state.goal.id : randomUUID(),
				objective,
				...(input.check?.trim() ? { check: input.check.trim() } : sameObjective && state.goal?.check ? { check: state.goal.check } : {}),
				...(budget ? { budget } : {}),
				status: "active",
				setBy: sameObjective && state.goal ? state.goal.setBy : setBy,
			};
			if (!sameObjective) state.baselineTokens = transcriptNewTokens(options.transcriptPath);
			state.goal = next;
			state.idle = 0;
			state.notified = false;
			state.waiting = undefined;
			saveGoalState(options.conversationId, state, dataDir);
			return { text: `Goal set.\n${describeGoal(next, goalSpend(state, options.transcriptPath))}` };
		}

		case "achieved": {
			if (!state.goal || state.goal.status !== "active") {
				return { text: "No active goal to mark achieved.", isError: true };
			}
			if (state.goal.check) {
				const checkResult = await runShell(state.goal.check, {
					cwd: options.cwd,
					timeoutMs: CHECK_TIMEOUT_MS,
					signal: options.signal,
				});
				if (checkResult.exitCode !== 0) {
					const output = tail(checkResult.output.trim(), CHECK_TAIL);
					return {
						text: [
							`Goal check \`${state.goal.check}\` failed (${checkResult.timedOut ? "timed out" : `exit ${checkResult.exitCode ?? "signal"}`}). The goal stays active.`,
							output ? `\nOutput:\n${output}` : "",
						].join("\n"),
						isError: true,
					};
				}
			}
			state.goal = { ...state.goal, status: "achieved" };
			state.idle = 0;
			state.waiting = undefined;
			saveGoalState(options.conversationId, state, dataDir);
			return { text: `Goal achieved.\n${describeGoal(state.goal, spent)}` };
		}

		case "blocked": {
			if (!state.goal || state.goal.status !== "active") {
				return { text: "No active goal to mark blocked.", isError: true };
			}
			const reason = input.reason?.trim();
			if (!reason) return { text: "action `blocked` requires a `reason` explaining what is needed.", isError: true };
			state.goal = { ...state.goal, status: "blocked", reason };
			state.idle = 0;
			state.waiting = undefined;
			saveGoalState(options.conversationId, state, dataDir);
			return { text: `Goal marked blocked: ${reason}\nYour turn may now end; the next user message will reactivate the goal.` };
		}

		case "wait": {
			if (!state.goal || state.goal.status !== "active") {
				return { text: "No active goal to wait on.", isError: true };
			}
			const steps = input.steps ?? [];
			if (steps.length === 0) {
				return { text: "action `wait` requires `steps`: each remaining step and the running background job/task it depends on.", isError: true };
			}
			const keys: string[] = [];
			for (const s of steps) {
				if (!s.step?.trim() || !s.job?.trim()) {
					return { text: "Each entry in `steps` must have non-empty `step` and `job`.", isError: true };
				}
				keys.push(s.job.trim());
			}
			const repeated = keys.filter((k) => {
				const prev = state.waits[k];
				return prev !== undefined && prev.work === state.work;
			});
			if (repeated.length > 0 && !input.reason?.trim()) {
				return {
					text: `You already waited on ${repeated.join(", ")} without doing any other tool work since. Either do independent work now, or call \`wait\` with a \`reason\` explaining why nothing else can be done meanwhile.`,
					isError: true,
				};
			}
			const now = Date.now();
			for (const k of keys) {
				const prev = state.waits[k];
				state.waits[k] = {
					since: prev && prev.work === state.work ? prev.since : now,
					work: state.work,
					nudges: prev && prev.work === state.work ? prev.nudges : 0,
					nudgeAt: now + 15 * 60_000,
				};
			}
			state.waiting = [...new Set(keys)];
			state.idle = 0;
			saveGoalState(options.conversationId, state, dataDir);
			return { text: `Wait accepted for ${state.waiting.join(", ")}. End your turn now; the background job's completion will wake you.` };
		}
	}
}

export interface StopDecision {
	decision: "continue" | "allow";
	reason?: string;
}

/** Decide in the `Stop` hook whether an active goal must keep the agent going. */
export function evaluateGoalStop(
	conversationId: string,
	payload: { terminationReason?: string; fullyIdle?: boolean; continuationActive?: boolean; transcriptPath?: string },
	dataDir = pluginDataDir(),
	now = Date.now(),
): StopDecision {
	const terminal = payload.terminationReason;
	if (terminal && terminal !== "NO_TOOL_CALL") return { decision: "allow" };

	const state = loadGoalState(conversationId, dataDir);
	const goal = state.goal;
	if (!goal || goal.status !== "active") return { decision: "allow" };

	const spent = goalSpend(state, payload.transcriptPath);
	if (overBudget(goal, spent)) {
		state.goal = { ...goal, status: "budget-limited" };
		state.idle = 0;
		state.waiting = undefined;
		saveGoalState(conversationId, state, dataDir);
		return { decision: "continue", reason: budgetLimitText(state.goal, spent) };
	}

	const activeTasks: PendingJob[] = state.delegatedTasks
		.filter((t) => t.active)
		.map((t) => ({
			key: `task ${t.taskId}`,
			command: t.title ? `delegated task: ${t.title}` : "delegated task",
			ids: [t.taskId, ...(t.threadId ? [t.threadId] : [])],
			startedAt: t.startedAt,
		}));

	const hasBackground = payload.fullyIdle === false || activeTasks.length > 0;

	if (state.waiting && state.waiting.length > 0 && hasBackground) {
		// Wait accepted for this turn while background work is still running: allow stop and clear wait for next wakeup.
		state.waiting = undefined;
		saveGoalState(conversationId, state, dataDir);
		return { decision: "allow" };
	}
	state.waiting = undefined;

	if (state.idle >= MAX_IDLE_CONTINUES) {
		state.notified = true;
		saveGoalState(conversationId, state, dataDir);
		return { decision: "allow" };
	}

	state.idle += 1;
	saveGoalState(conversationId, state, dataDir);

	const jobs: PendingJob[] = [
		...activeTasks,
		...(payload.fullyIdle === false && activeTasks.length === 0
			? [{ key: "background task", command: "running agy background command/subagent", ids: ["background"] }]
			: []),
	];
	return { decision: "continue", reason: continueText(goal, spent, jobs, now) };
}
