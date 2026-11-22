#!/usr/bin/env node
// Unified Antigravity (`agy`) lifecycle hook dispatcher.
//
// Reads a camelCase JSON hook payload from stdin, runs the corresponding pi-harness logic
// (reusing extensions/bash/*, extensions/goal/*, extensions/lib/experiments.ts, agy/rules.ts),
// and writes the JSON response to stdout.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { changeEnds, changeStarts, commitRefusal, toolPath } from "../../extensions/bash/commit.ts";
import { setsidCommands } from "../../extensions/bash/detach.ts";
import { refusalText } from "../../extensions/bash/commands.ts";
import { gitRefusal } from "../../extensions/bash/git.ts";
import { messageFileRefusal } from "../../extensions/bash/message.ts";
import { sectionText } from "../../extensions/goal/goal.ts";
import { hashArm, runningExperiments } from "../../extensions/lib/experiments.ts";
import { HARNESS_ROOT, RELEASE } from "../../extensions/lib/repository.ts";
import { ago, parseObject, str } from "../../extensions/lib/t3-result.ts";
import { hasSettings } from "../../extensions/lib/variants.ts";
import { evaluateGoalStop, goalSectionHash } from "../goal-runtime.ts";
import { compileAgyRules, diffRuleSections } from "../rules.ts";
import {
	loadGoalState,
	loadOwnWrites,
	loadRulesSeen,
	loadThreadWaitState,
	pluginDataDir,
	recordAgySession,
	saveGoalState,
	saveOwnWrites,
	saveRulesSeen,
	saveThreadWaitState,
} from "../state.ts";

export interface HookPayload {
	hookEventName?: string;
	conversationId?: string;
	workspacePaths?: string[];
	transcriptPath?: string;
	artifactDirectoryPath?: string;
	modelName?: string;
	lastUserInput?: string;
	cwd?: string;
	stepIdx?: number;
	error?: string;
	invocationNum?: number;
	initialNumSteps?: number;
	executionNum?: number;
	terminationReason?: string;
	fullyIdle?: boolean;
	continuationActive?: boolean;
	toolCall?: {
		id?: string;
		name?: string;
		args?: Record<string, unknown>;
	};
}

export interface DispatchOptions {
	dataDir?: string;
	harnessRoot?: string;
	now?: number;
}

const EDIT_TOOLS = new Set(["replace_file_content", "multi_replace_file_content", "write_to_file"]);

function unwrapTool(toolCall: HookPayload["toolCall"]): { name: string; args: Record<string, unknown> } {
	const name = toolCall?.name ?? "";
	const args = toolCall?.args && typeof toolCall.args === "object" ? toolCall.args : {};
	if (name === "call_mcp_tool") {
		const innerName = typeof args.ToolName === "string" ? args.ToolName : name;
		const rawInner = args.Arguments;
		const innerArgs =
			rawInner && typeof rawInner === "object"
				? (rawInner as Record<string, unknown>)
				: typeof rawInner === "string"
					? (parseObject(rawInner) ?? {})
					: {};
		return { name: innerName, args: innerArgs };
	}
	return { name, args };
}

const isToolNamed = (name: string, short: string) =>
	name === short || name.endsWith(`_${short}`) || name.endsWith(`__${short}`);

function extractTargetFile(args: Record<string, unknown>, cwd: string): string | undefined {
	const raw = str(args.TargetFile) ?? str(args.AbsolutePath) ?? str(args.path) ?? str(args.file_path);
	return raw ? toolPath(raw, cwd) : undefined;
}

/** Read the JSON content of a specific `stepIdx` (or the last entry) from `transcriptPath`. */
function readTranscriptStepContent(transcriptPath: string | undefined, stepIdx: number | undefined): string | undefined {
	if (!transcriptPath) return undefined;
	try {
		const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
		for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
			const line = lines[i];
			if (!line) continue;
			try {
				const parsed = JSON.parse(line) as { step_index?: number; content?: string };
				if (stepIdx === undefined || parsed.step_index === stepIdx) return parsed.content;
			} catch {
				// Skip incomplete line.
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function handleSessionStart(payload: HookPayload, dataDir: string, harnessRoot: string, now: number): Record<string, unknown> {
	const conversationId = payload.conversationId ?? "default";
	const cwd = payload.cwd || payload.workspacePaths?.[0] || process.cwd();
	const compiled = compileAgyRules(harnessRoot);

	saveRulesSeen(
		conversationId,
		{
			hash: compiled.hash,
			sections: Object.fromEntries(compiled.sections.map((s) => [s.name, s.hash])),
		},
		dataDir,
	);

	// Assign prompt-body A/B experiments deterministically from conversationId.
	// Settings-only experiments cannot be enforced by agy hooks, so skip them.
	const running = runningExperiments(join(harnessRoot, "prompt", "experiments"));
	const arms: { experiment: string; arm: "A" | "B"; forced: boolean; assignedAt: number }[] = [];
	const injectSteps: { systemMessage: { systemMessage: string } }[] = [];

	for (const exp of running) {
		if (!exp.body || (hasSettings(exp.settings) && !exp.body)) continue;
		const arm = hashArm(conversationId, exp.name);
		arms.push({ experiment: exp.name, arm, forced: false, assignedAt: now });
		if (arm === "B") {
			injectSteps.push({
				systemMessage: {
					systemMessage: `[pi-harness experiment: ${exp.name}]\n\n${exp.body}`,
				},
			});
		}
	}

	recordAgySession(
		{
			conversationId,
			cwd,
			workspacePaths: payload.workspacePaths ?? (cwd ? [cwd] : []),
			...(payload.modelName ? { modelName: payload.modelName } : {}),
			...(payload.transcriptPath ? { transcriptPath: payload.transcriptPath } : {}),
			...(RELEASE?.commit ? { harnessCommit: RELEASE.commit } : {}),
			rulesHash: compiled.hash,
			arms,
			startedAt: now,
		},
		dataDir,
	);

	return injectSteps.length > 0 ? { injectSteps } : {};
}

function handlePreToolUse(payload: HookPayload, dataDir: string, now: number): Record<string, unknown> {
	const conversationId = payload.conversationId ?? "default";
	const cwd = payload.cwd || payload.workspacePaths?.[0] || process.cwd();
	const rawName = payload.toolCall?.name ?? "";
	const rawArgs = payload.toolCall?.args && typeof payload.toolCall.args === "object" ? payload.toolCall.args : {};
	const callId = payload.toolCall?.id ?? `step-${payload.stepIdx ?? now}`;

	// 1. Track own-writes before any file editing/writing tool runs.
	if (EDIT_TOOLS.has(rawName)) {
		const target = extractTargetFile(rawArgs, cwd);
		if (target) {
			const files = loadOwnWrites(conversationId, dataDir);
			changeStarts(files, callId, target);
			saveOwnWrites(conversationId, files, dataDir);
		}
		return { decision: "allow" };
	}

	// 2. Shell command safety guards (git destructive commands, -F message files, setsid, own-writes commit guard).
	if (rawName === "run_command") {
		const command = str(rawArgs.CommandLine) ?? str(rawArgs.command) ?? "";
		const commandCwd = str(rawArgs.Cwd) ? resolve(cwd, str(rawArgs.Cwd)!) : cwd;
		if (command) {
			const gitDenied = gitRefusal(command);
			if (gitDenied) return { decision: "deny", reason: gitDenied };

			const msgDenied = messageFileRefusal(command);
			if (msgDenied) return { decision: "deny", reason: msgDenied };

			const setsid = setsidCommands(command);
			if (setsid.length > 0) {
				return {
					decision: "deny",
					reason: refusalText(
						"runs `setsid`",
						setsid,
						"`setsid` does not exist on macOS and detaches jobs out of session tracking.",
						"Run background commands directly via `run_command` (or with `> log 2>&1 &`) instead of `setsid`.",
					),
				};
			}

			const files = loadOwnWrites(conversationId, dataDir);
			const commitDenied = commitRefusal(files, command, commandCwd);
			if (commitDenied) return { decision: "deny", reason: commitDenied };
		}
		return { decision: "allow" };
	}

	// 3. Thread-wait guard against waiting on own delegated children or repeating a timed-out wait.
	const { name, args } = unwrapTool(payload.toolCall);
	if (isToolNamed(name, "t3_thread_wait")) {
		const threadId = str(args.threadId);
		if (threadId) {
			const tw = loadThreadWaitState(conversationId, dataDir);
			const child = tw.children.find((c) => c.threadId === threadId);
			if (child) {
				return {
					decision: "deny",
					reason: [
						`Refused: thread ${threadId} is your own delegated child (task ${child.taskId}${child.title ? `, ${child.title}` : ""}). Its completion wakes you automatically, and t3_thread_wait times out after 60 minutes.`,
						"",
						"Instead:",
						"- Do remaining independent work now.",
						"- If every remaining step depends on it: call `goal` with action `wait` (if a goal is active) or end your turn naming what you wait for.",
						`- To check status without blocking: call task_status with taskId ${threadId}.`,
					].join("\n"),
				};
			}
			const envId = str(args.environmentId);
			const runId = str(args.runId);
			const until = args.untilDelegatedWorkSettled === true;
			const earlier = tw.timedOut.find(
				(w) =>
					w.threadId === threadId &&
					w.environmentId === envId &&
					w.until === until &&
					(runId === undefined ? w.runId === undefined : w.runId === runId),
			);
			if (earlier) {
				return {
					decision: "deny",
					reason: [
						`Refused: you waited on thread ${threadId} ${ago(now - earlier.at)} ago, the wait timed out${earlier.note ? ` (${earlier.note})` : ""}, and you made no other tool call since.`,
						"Change the approach: do independent work, inspect status with t3_thread_read / task_status, or end your turn.",
					].join("\n"),
				};
			}
		}
	}

	return { decision: "allow" };
}

function handlePostToolUse(payload: HookPayload, dataDir: string, now: number): Record<string, unknown> {
	const conversationId = payload.conversationId ?? "default";
	const rawName = payload.toolCall?.name ?? "";
	const callId = payload.toolCall?.id ?? `step-${payload.stepIdx ?? now}`;
	const failed = Boolean(payload.error);

	// 1. Complete own-writes tracking.
	if (EDIT_TOOLS.has(rawName)) {
		const files = loadOwnWrites(conversationId, dataDir);
		changeEnds(files, callId, failed);
		saveOwnWrites(conversationId, files, dataDir);
	}

	// 2. Update goal work counter & loop-guard reset for non-goal tool calls.
	const { name, args } = unwrapTool(payload.toolCall);
	if (!isToolNamed(name, "goal")) {
		const goalState = loadGoalState(conversationId, dataDir);
		let changed = false;
		if (goalState.goal?.status === "active" || goalState.work > 0 || goalState.idle > 0) {
			goalState.work += 1;
			goalState.idle = 0;
			goalState.notified = false;
			changed = true;
		}

		// Record delegated children from delegate_task results for both goal wait and thread-wait guard.
		if (isToolNamed(name, "delegate_task") && !failed) {
			const content = readTranscriptStepContent(payload.transcriptPath, payload.stepIdx);
			const data = content ? parseObject(content.trim()) : undefined;
			const taskId = str(data?.taskId);
			const childThreadId = str(data?.childThreadId) ?? str(data?.threadId);
			const title = str(args.title) ?? /^\[(.+)\]\(/.exec(str(data?.link) ?? "")?.[1];
			if (taskId) {
				const active = str(data?.next) !== undefined;
				const idx = goalState.delegatedTasks.findIndex((t) => t.taskId === taskId);
				const entry = { taskId, ...(childThreadId ? { threadId: childThreadId } : {}), ...(title ? { title } : {}), active, startedAt: now };
				if (idx >= 0) goalState.delegatedTasks[idx] = entry;
				else goalState.delegatedTasks.push(entry);
				changed = true;

				if (childThreadId) {
					const tw = loadThreadWaitState(conversationId, dataDir);
					if (!tw.children.some((c) => c.threadId === childThreadId)) {
						tw.children.push({ taskId, threadId: childThreadId, ...(title ? { title } : {}) });
						saveThreadWaitState(conversationId, tw, dataDir);
					}
				}
			}
		}

		if (changed) saveGoalState(conversationId, goalState, dataDir);
	}

	// 3. Update thread-wait idle re-wait tracker.
	const tw = loadThreadWaitState(conversationId, dataDir);
	if (isToolNamed(name, "t3_thread_wait")) {
		const threadId = str(args.threadId);
		if (threadId && !failed) {
			const content = readTranscriptStepContent(payload.transcriptPath, payload.stepIdx);
			const data = content ? parseObject(content.trim()) : undefined;
			if (data?.timedOut === true) {
				const envId = str(args.environmentId);
				const runId = str(args.runId) ?? str(data.runId);
				const until = args.untilDelegatedWorkSettled === true;
				tw.timedOut = tw.timedOut.filter((w) => !(w.threadId === threadId && w.environmentId === envId && w.until === until));
				tw.timedOut.push({
					threadId,
					...(envId ? { environmentId: envId } : {}),
					...(runId ? { runId } : {}),
					until,
					at: now,
					...(str(data.note) ? { note: str(data.note) } : {}),
				});
				saveThreadWaitState(conversationId, tw, dataDir);
			}
		}
	} else if (tw.timedOut.length > 0) {
		tw.timedOut = [];
		saveThreadWaitState(conversationId, tw, dataDir);
	}

	return {};
}

function handlePreInvocation(payload: HookPayload, dataDir: string, harnessRoot: string): Record<string, unknown> {
	const conversationId = payload.conversationId ?? "default";
	const injectSteps: { systemMessage: { systemMessage: string } }[] = [];

	// 1. Active goal injection & blocked-goal reactivation on new user input.
	const goalState = loadGoalState(conversationId, dataDir);
	let goalChanged = false;
	const userInput = payload.lastUserInput?.trim();
	if (userInput && userInput !== goalState.lastUserInput) {
		goalState.lastUserInput = userInput;
		goalChanged = true;
		if (goalState.goal?.status === "blocked") {
			goalState.goal = { ...goalState.goal, status: "active", reason: undefined };
			goalState.idle = 0;
			goalState.notified = false;
			goalState.injectedHash = undefined;
		}
		// Mark delegated tasks finished if the user/system message reports their completion.
		for (const task of goalState.delegatedTasks) {
			if (task.active && userInput.includes(`Delegated task ${task.taskId}`)) {
				task.active = false;
			}
		}
	}
	if (goalState.goal?.status === "active") {
		const hash = goalSectionHash(goalState.goal);
		if (goalState.injectedHash !== hash) {
			injectSteps.push({ systemMessage: { systemMessage: sectionText(goalState.goal) } });
			goalState.injectedHash = hash;
			goalChanged = true;
		}
	}
	if (goalChanged) saveGoalState(conversationId, goalState, dataDir);

	// 2. Mid-session live rule sync: if pi-harness deployed updated rules while this session was running,
	//    inject only the newly added or modified rule sections.
	const seen = loadRulesSeen(conversationId, dataDir);
	if (seen) {
		const compiled = compileAgyRules(harnessRoot);
		if (compiled.hash !== seen.hash) {
			const updated = diffRuleSections(compiled, seen.sections);
			if (updated.length > 0) {
				injectSteps.push({
					systemMessage: {
						systemMessage: [
							"[pi-harness rules updated mid-session]",
							...updated.map((s) => s.text),
						].join("\n\n"),
					},
				});
			}
			saveRulesSeen(
				conversationId,
				{
					hash: compiled.hash,
					sections: Object.fromEntries(compiled.sections.map((s) => [s.name, s.hash])),
				},
				dataDir,
			);
		}
	}

	return injectSteps.length > 0 ? { injectSteps } : {};
}

function handleStop(payload: HookPayload, dataDir: string, now: number): Record<string, unknown> {
	const conversationId = payload.conversationId ?? "default";
	const decision = evaluateGoalStop(conversationId, payload, dataDir, now);
	return decision.decision === "continue"
		? { decision: "continue", ...(decision.reason ? { reason: decision.reason } : {}) }
		: { decision: "allow" };
}

/** Pure entrypoint for all agy hook events (also called directly by unit tests). */
export function handleHookEvent(payload: HookPayload, options: DispatchOptions = {}): Record<string, unknown> {
	const dataDir = options.dataDir ?? pluginDataDir();
	const harnessRoot = options.harnessRoot ?? HARNESS_ROOT;
	const now = options.now ?? Date.now();
	const event = payload.hookEventName ?? "";

	switch (event) {
		case "SessionStart":
			return handleSessionStart(payload, dataDir, harnessRoot, now);
		case "PreToolUse":
			return handlePreToolUse(payload, dataDir, now);
		case "PostToolUse":
			return handlePostToolUse(payload, dataDir, now);
		case "PreInvocation":
			return handlePreInvocation(payload, dataDir, harnessRoot);
		case "Stop":
			return handleStop(payload, dataDir, now);
		default:
			return {};
	}
}

async function main(): Promise<void> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	const payload = raw ? (JSON.parse(raw) as HookPayload) : {};
	const eventFlagIdx = process.argv.indexOf("--event");
	if (!payload.hookEventName && eventFlagIdx >= 0 && process.argv[eventFlagIdx + 1]) {
		payload.hookEventName = process.argv[eventFlagIdx + 1];
	}
	const result = handleHookEvent(payload);
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		process.stderr.write(`pi-harness agy hook error: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
		// Fail open on unexpected internal errors so we never brick the user's agy session.
		process.stdout.write("{}\n");
	});
}
