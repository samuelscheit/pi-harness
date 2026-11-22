// The guard against an idle re-wait on a t3 thread (pure; extensions/thread-wait/index.ts wires it in).
//
// The user's rule, given in four sessions: "do not fake to be working productively by iteratively
// waiting on long running processes", latest "do not repeat the same waiting step that has already
// timed out; change the approach". A coordinator called `t3_thread_wait` with a 6 h timeout on child
// threads; t3 ended every wait after 60 min and the agent restarted all of them, for hours, on
// children that had long completed (2026-11-19/20). A wait that timed out says nothing changed, so
// the same wait again, with no other tool call and no new message in between, can only time out
// again: it is refused here, naming what the last result said and what to do instead.
//
// Read from the session branch (as the goal reads its tasks), so it survives reloads and restarts.
// Calls a script makes through `ctx.executeTool` (a workflow's slices, a codemode script) are not
// model decisions: the hook skips them (index.ts), and they never appear in the branch.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ownChild } from "../goal/goal.ts";
import { ago, contentText, parseObject, str, T3_TOOL } from "../lib/t3-result.ts";

/** t3's wait tool as the bridge registers it (also under the canonical name). */
export const isThreadWait = (toolName: string) => T3_TOOL.test(toolName) && toolName.endsWith("__t3_thread_wait");

/** What a wait call asks for. */
interface WaitCall {
	environmentId?: string;
	threadId: string;
	runId?: string;
	until: boolean;
}

/** A wait that timed out and has had no other tool call or message since. */
interface TimedOut extends WaitCall {
	/** The run the result reports (the one the wait followed). */
	resultRunId?: string;
	at: number;
	data: Record<string, unknown>;
}

const waitCall = (input: unknown): WaitCall | undefined => {
	const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const threadId = str(args.threadId);
	if (!threadId) return undefined;
	return { threadId, environmentId: str(args.environmentId), runId: str(args.runId), until: args.untilDelegatedWorkSettled === true };
};

const sameThread = (a: WaitCall, b: WaitCall) => a.threadId === b.threadId && a.environmentId === b.environmentId && a.until === b.until;

/**
 * Whether `call` waits for what a timed-out wait already waited for: the same thread, with the same
 * condition. No `runId` waits for the latest run, as the earlier call without one did; a `runId` is
 * the run the earlier call named or the one its result reported.
 */
const repeats = (earlier: TimedOut, call: WaitCall) => sameThread(earlier, call) && (call.runId === undefined ? earlier.runId === undefined : call.runId === earlier.runId || call.runId === earlier.resultRunId);

/**
 * The waits that timed out and are still current on the branch: no tool call other than a wait and
 * no message (the user's, a t3 notification, an extension's) has come since.
 */
export function timedOutWaits(branch: readonly SessionEntry[]): TimedOut[] {
	const open = new Map<string, TimedOut>();
	const calls = new Map<string, { call: WaitCall; withWork: boolean }>();
	const keyOf = (c: WaitCall) => `${c.environmentId ?? ""}\0${c.threadId}\0${c.runId ?? ""}\0${c.until}`;
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			const blocks = message.content.filter((block) => block.type === "toolCall");
			// Another tool call in the same message ran beside its waits: those waits were not idle.
			const withWork = blocks.some((block) => !isThreadWait(block.name));
			if (withWork) open.clear();
			for (const block of blocks) {
				const call = isThreadWait(block.name) ? waitCall(block.arguments) : undefined;
				if (call) calls.set(block.id, { call, withWork });
			}
		} else if (message.role === "toolResult") {
			if (!isThreadWait(message.toolName)) {
				open.clear();
				continue;
			}
			const asked = calls.get(message.toolCallId);
			if (!asked || message.isError) continue;
			const data = parseObject(contentText(message.content).trim());
			const key = keyOf(asked.call);
			if (data?.timedOut === true && !asked.withWork) open.set(key, { ...asked.call, resultRunId: str(data.runId), at: message.timestamp, data });
			else open.delete(key);
		} else {
			open.clear();
		}
	}
	return [...open.values()];
}

/** What the last result said, in a line or two. */
function lastResult(earlier: TimedOut): string {
	const { data } = earlier;
	const thread = data.thread && typeof data.thread === "object" ? (data.thread as Record<string, unknown>) : undefined;
	const holding = Array.isArray(thread?.holding) ? (thread.holding as unknown[]).filter((item): item is string => typeof item === "string") : [];
	const parts = [`status ${str(data.status) ?? "unknown"}`];
	if (thread && str(thread.status) && thread.status !== data.status) parts.push(`the thread's latest run ${thread.status}`);
	if (holding.length > 0) parts.push(`held by ${holding.slice(0, 3).join("; ")}${holding.length > 3 ? `; and ${holding.length - 3} more` : ""}`);
	const note = str(data.note);
	return `${parts.join(", ")}${note ? `. t3 said: ${note}` : ""}`;
}

/**
 * Why a wait on the session's own delegated child is refused, or undefined for any other thread.
 *
 * Every run of such a child is a task whose end t3 delivers to the session as a message that wakes
 * it, so a wait on it only blocks the turn: t3 ends it after 60 min at most, and a delegated
 * coordinator then ended its turn with an empty report ("wait ran out, waiting again"), which t3
 * took as its task's end and woke its own parent with, dozens of times with large contexts
 * (2026-11-21, the user: "das kann kein Zustand sein"). The children are read from the branch
 * (goal.ts `delegatedTasks`); a script's own waits on the children it manages never reach the hook.
 */
export function ownChildWait(branch: readonly SessionEntry[], input: unknown): string | undefined {
	const call = waitCall(input);
	const task = call && ownChild(branch, call.threadId);
	if (!task) return undefined;
	return [
		`Refused: thread ${call.threadId} is your own delegated child (${task.key}, ${task.command}). Its run's end wakes you with a "Delegated task …" message, and t3 ends a t3_thread_wait after 60 minutes at most, so waiting on it only blocks your turn and ends it on a timeout instead of the child's result.`,
		"",
		"Instead:",
		"- Do the remaining work that does not depend on the child now.",
		`- When every remaining step depends on it: with an active goal, call \`goal\` with action \`wait\` naming \`${task.key}\` (or the child's thread id; a child that runs again under a new task is found); without a goal, end your turn with one line naming what you wait for.`,
		`- To see where it stands without blocking: task_status with taskId ${call.threadId}.`,
	].join("\n");
}

/**
 * Why `call` is refused, or undefined when it is not an idle re-wait. `now` is the time of the call.
 */
export function idleRewait(branch: readonly SessionEntry[], input: unknown, now: number): string | undefined {
	const call = waitCall(input);
	if (!call) return undefined;
	const earlier = timedOutWaits(branch).find((candidate) => repeats(candidate, call));
	if (!earlier) return undefined;
	const wakes = str(earlier.data.next) !== undefined;
	return [
		`Refused: you waited on thread ${call.threadId} ${ago(now - earlier.at)} ago, the wait timed out (${lastResult(earlier)}), and you made no other tool call and received no message since. Waiting again repeats a wait that already timed out and cannot change the outcome.`,
		"",
		"Change the approach:",
		"- Do independent work, or work that makes the job shorter or parallel, instead of waiting.",
		"- To see whether anything changed, read it: t3_thread_read, or task_status for a delegated task. A wait is not a status check.",
		wakes ? "- This thread's completion wakes you (`next` was set): end your turn." : "- If nothing else is left, end your turn with one line naming what you wait for, or ask the user.",
		"Waiting on this thread is allowed again after any other tool call or new message.",
	].join("\n");
}
