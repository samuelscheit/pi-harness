// Tests for Antigravity lifecycle hooks (agy/hooks/dispatch.ts): SessionStart A/B arms,
// PreToolUse guards (git, commit own-writes, message file, setsid, thread-wait), PostToolUse
// tracking, PreInvocation live rule & goal injection, and Stop goal enforcement.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { runGoalAction } from "../agy/goal-runtime.ts";
import { handleHookEvent } from "../agy/hooks/dispatch.ts";
import { loadGoalState, readAgySessionRecords } from "../agy/state.ts";

let dir: string;
let dataDir: string;
let harnessDir: string;
let repoDir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agy-hooks-"));
	dataDir = join(dir, "data");
	harnessDir = join(dir, "harness");
	repoDir = join(dir, "repo");
	mkdirSync(join(harnessDir, "prompt", "rules"), { recursive: true });
	mkdirSync(join(harnessDir, "prompt", "experiments"), { recursive: true });
	mkdirSync(repoDir, { recursive: true });
	writeFileSync(join(harnessDir, "prompt", "AGENTS.md"), "# Harness\nBase prompt.\n");
	writeFileSync(join(harnessDir, "prompt", "rules", "r1.md"), "---\nname: r1\n---\nInitial rule.\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function initGitRepo(cwd: string): void {
	execFileSync("git", ["-C", cwd, "init", "-q", "-b", "main"]);
	execFileSync("git", ["-C", cwd, "config", "user.email", "test@test"]);
	execFileSync("git", ["-C", cwd, "config", "user.name", "Test"]);
	writeFileSync(join(cwd, "a.txt"), "one\n");
	writeFileSync(join(cwd, "b.txt"), "two\n");
	execFileSync("git", ["-C", cwd, "add", "-A"]);
	execFileSync("git", ["-C", cwd, "commit", "-qm", "init"]);
}

describe("agy lifecycle hooks", () => {
	test("SessionStart assigns deterministic A/B prompt experiments, logs metadata, and seeds rules", () => {
		writeFileSync(
			join(harnessDir, "prompt", "experiments", "concise.md"),
			[
				"---",
				"name: concise",
				"status: running",
				"hypothesis: test",
				"---",
				"Keep replies extra concise.",
			].join("\n"),
		);

		const injectedTexts = (res: Record<string, unknown>): string[] => {
			const steps = Array.isArray(res.injectSteps) ? res.injectSteps : [];
			return steps
				.map((s) => (s as { systemMessage?: { systemMessage?: string } })?.systemMessage?.systemMessage)
				.filter((s): s is string => typeof s === "string");
		};

		// Pick a conversationId that hashes to arm B.
		let armBConv = "";
		for (let i = 0; i < 100; i += 1) {
			const conv = `conv-${i}`;
			const res = handleHookEvent(
				{ hookEventName: "SessionStart", conversationId: conv, workspacePaths: [repoDir], modelName: "gemini-4-neon" },
				{ dataDir, harnessRoot: harnessDir, now: 1_000 },
			);
			if (injectedTexts(res).some((t) => t.includes("Keep replies extra concise."))) {
				armBConv = conv;
				break;
			}
		}
		assert.ok(armBConv, "expected at least one conversationId to get arm B");
		const records = readAgySessionRecords(dataDir);
		const rec = records.get(armBConv);
		assert.ok(rec);
		assert.equal(rec.cwd, repoDir);
		assert.equal(rec.modelName, "gemini-4-neon");
		assert.equal(rec.arms.find((a) => a.experiment === "concise")?.arm, "B");
	});

	test("PreToolUse blocks dangerous git commands, message files, and setsid", () => {
		const conv = "conv-guards";
		const gitReset = handleHookEvent(
			{
				hookEventName: "PreToolUse",
				conversationId: conv,
				toolCall: { id: "c1", name: "run_command", args: { CommandLine: "git reset --hard HEAD~1", Cwd: repoDir } },
			},
			{ dataDir, harnessRoot: harnessDir },
		);
		assert.equal(gitReset.decision, "deny");
		assert.match(String(gitReset.reason), /git|reset/i);

		const msgFile = handleHookEvent(
			{
				hookEventName: "PreToolUse",
				conversationId: conv,
				toolCall: { id: "c2", name: "run_command", args: { CommandLine: "git commit -F /tmp/msg.txt", Cwd: repoDir } },
			},
			{ dataDir, harnessRoot: harnessDir },
		);
		assert.equal(msgFile.decision, "deny");
		assert.match(String(msgFile.reason), /-m|file|heredoc/i);

		const setsid = handleHookEvent(
			{
				hookEventName: "PreToolUse",
				conversationId: conv,
				toolCall: { id: "c3", name: "run_command", args: { CommandLine: "setsid sleep 10", Cwd: repoDir } },
			},
			{ dataDir, harnessRoot: harnessDir },
		);
		assert.equal(setsid.decision, "deny");
		assert.match(String(setsid.reason), /setsid/i);
	});

	test("PreToolUse + PostToolUse enforce own-writes commit scoping", () => {
		initGitRepo(repoDir);
		const conv = "conv-own-writes";
		const fileA = join(repoDir, "a.txt");
		const fileB = join(repoDir, "b.txt");

		// Foreign edit to b.txt (not made by this conversation).
		writeFileSync(fileB, "foreign change\n");

		// Agent edits a.txt via replace_file_content.
		assert.equal(
			handleHookEvent(
				{
					hookEventName: "PreToolUse",
					conversationId: conv,
					toolCall: { id: "edit-1", name: "replace_file_content", args: { TargetFile: fileA } },
				},
				{ dataDir, harnessRoot: harnessDir },
			).decision,
			"allow",
		);
		writeFileSync(fileA, "agent change\n");
		handleHookEvent(
			{
				hookEventName: "PostToolUse",
				conversationId: conv,
				toolCall: { id: "edit-1", name: "replace_file_content", args: { TargetFile: fileA } },
			},
			{ dataDir, harnessRoot: harnessDir },
		);

		// Blanket `git add -A && git commit` must be denied because b.txt has foreign changes.
		const denied = handleHookEvent(
			{
				hookEventName: "PreToolUse",
				conversationId: conv,
				toolCall: { id: "commit-1", name: "run_command", args: { CommandLine: "git add -A && git commit -m 'all'", Cwd: repoDir } },
			},
			{ dataDir, harnessRoot: harnessDir },
		);
		assert.equal(denied.decision, "deny");
		assert.match(String(denied.reason), /b\.txt/);

		// Explicitly committing only a.txt is allowed.
		const allowed = handleHookEvent(
			{
				hookEventName: "PreToolUse",
				conversationId: conv,
				toolCall: { id: "commit-2", name: "run_command", args: { CommandLine: "git add a.txt && git commit -m 'only a'", Cwd: repoDir } },
			},
			{ dataDir, harnessRoot: harnessDir },
		);
		assert.equal(allowed.decision, "allow");
	});

	test("PreToolUse blocks t3_thread_wait on own delegated child and repeated idle waits", () => {
		const conv = "conv-tw";
		const transcriptPath = join(dir, "transcript.jsonl");
		writeFileSync(
			transcriptPath,
			`${JSON.stringify({
				step_index: 5,
				type: "CALL_MCP_TOOL",
				content: JSON.stringify({ taskId: "task-1", childThreadId: "child-thread-1", next: "wait for notification" }),
			})}\n`,
		);

		handleHookEvent(
			{
				hookEventName: "PostToolUse",
				conversationId: conv,
				transcriptPath,
				stepIdx: 5,
				toolCall: {
					id: "tc-delegate",
					name: "call_mcp_tool",
					args: { ServerName: "t3-code", ToolName: "delegate_task", Arguments: { task: "do x", title: "Child X" } },
				},
			},
			{ dataDir, harnessRoot: harnessDir, now: 2_000 },
		);

		const waitOnChild = handleHookEvent(
			{
				hookEventName: "PreToolUse",
				conversationId: conv,
				toolCall: {
					id: "tc-wait",
					name: "call_mcp_tool",
					args: { ServerName: "t3-code", ToolName: "t3_thread_wait", Arguments: { threadId: "child-thread-1" } },
				},
			},
			{ dataDir, harnessRoot: harnessDir, now: 3_000 },
		);
		assert.equal(waitOnChild.decision, "deny");
		assert.match(String(waitOnChild.reason), /delegated|end your turn/i);
	});

	test("PreInvocation injects live rule updates and active goals; Stop holds until goal achieved or wait", async () => {
		const conv = "conv-goal";
		handleHookEvent(
			{ hookEventName: "SessionStart", conversationId: conv, workspacePaths: [repoDir] },
			{ dataDir, harnessRoot: harnessDir, now: 1_000 },
		);

		const injectedText = (res: Record<string, unknown>): string => {
			const steps = Array.isArray(res.injectSteps) ? res.injectSteps : [];
			return steps
				.map((s) => (s as { systemMessage?: { systemMessage?: string } })?.systemMessage?.systemMessage ?? "")
				.join("\n");
		};

		// Modify a rule mid-session: PreInvocation should inject the diff once.
		writeFileSync(join(harnessDir, "prompt", "rules", "r2.md"), "---\nname: r2\n---\nBrand new mid-session rule.\n");
		const pre1 = handleHookEvent(
			{ hookEventName: "PreInvocation", conversationId: conv, lastUserInput: "keep going" },
			{ dataDir, harnessRoot: harnessDir },
		);
		assert.match(injectedText(pre1), /Brand new mid-session rule\./);
		const pre2 = handleHookEvent(
			{ hookEventName: "PreInvocation", conversationId: conv, lastUserInput: "keep going" },
			{ dataDir, harnessRoot: harnessDir },
		);
		assert.equal(pre2.injectSteps, undefined, "unchanged rules should not be re-injected");

		// Set an active goal with a check command.
		await runGoalAction(
			{ action: "set", objective: "Create ok.txt", check: "test -f ok.txt" },
			{ conversationId: conv, cwd: repoDir, dataDir },
		);

		// Stop should force continuation while goal is active.
		const stop1 = handleHookEvent(
			{ hookEventName: "Stop", conversationId: conv, terminationReason: "NO_TOOL_CALL", fullyIdle: true },
			{ dataDir, harnessRoot: harnessDir },
		);
		assert.equal(stop1.decision, "continue");
		assert.match(String(stop1.reason), /Create ok\.txt/);

		// Check fails before ok.txt exists.
		const failAchieve = await runGoalAction({ action: "achieved" }, { conversationId: conv, cwd: repoDir, dataDir });
		assert.equal(failAchieve.isError, true);

		// Create ok.txt and mark achieved -> Stop now allows idle.
		writeFileSync(join(repoDir, "ok.txt"), "done\n");
		const okAchieve = await runGoalAction({ action: "achieved" }, { conversationId: conv, cwd: repoDir, dataDir });
		assert.ok(!okAchieve.isError);
		assert.equal(loadGoalState(conv, dataDir).goal?.status, "achieved");

		const stop2 = handleHookEvent(
			{ hookEventName: "Stop", conversationId: conv, terminationReason: "NO_TOOL_CALL", fullyIdle: true },
			{ dataDir, harnessRoot: harnessDir },
		);
		assert.equal(stop2.decision, "allow");
	});
});
