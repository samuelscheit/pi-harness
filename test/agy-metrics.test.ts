// Tests for Antigravity (`agy`) metrics ingestion (extensions/metrics/agy.ts), toolEffect for agy
// built-in tools (extensions/metrics/work.ts), and dream collection from agy transcripts
// (scripts/dream/collect.ts).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { recordAgySession } from "../agy/state.ts";
import { indexAgySessions, unwrapAgyUserText } from "../extensions/metrics/agy.ts";
import { overview, Scope } from "../extensions/metrics/queries/index.ts";
import { importedAgy, openStore } from "../extensions/metrics/store.ts";
import { delegation, toolEffect } from "../extensions/metrics/work.ts";
import { collect, precedingAgentText, repositories } from "../scripts/dream/collect.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agy-metrics-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("agy metrics ingestion and dream integration", () => {
	test("unwrapAgyUserText strips T3 Code XML wrappers cleanly", () => {
		const wrapped =
			"<USER_REQUEST><t3_code_instructions>long rules</t3_code_instructions><user_request>Use bun instead of npm</user_request><runtime_info>info</runtime_info></USER_REQUEST>";
		assert.equal(unwrapAgyUserText(wrapped), "Use bun instead of npm");
		assert.equal(unwrapAgyUserText("plain text"), "plain text");
	});

	test("toolEffect and delegation recognize agy built-in tools and call_mcp_tool wrappers", () => {
		const cwd = "/work/proj";
		const edit = toolEffect("replace_file_content", { TargetFile: "/work/proj/src/a.ts" }, cwd);
		assert.equal(edit.mutates, true);
		assert.deepEqual(edit.writes, ["/work/proj/src/a.ts"]);

		const view = toolEffect("view_file", { AbsolutePath: "/work/proj/src/b.ts" }, cwd);
		assert.equal(view.mutates, false);
		assert.deepEqual(view.files, ["/work/proj/src/b.ts"]);

		const cmd = toolEffect("run_command", { CommandLine: "echo hi > out.txt", Cwd: cwd }, cwd);
		assert.equal(cmd.mutates, true);

		const del = delegation(
			"call_mcp_tool",
			{ ServerName: "t3-code", ToolName: "delegate_task", Arguments: { task: "fix tests", title: "Fixer" } },
			JSON.stringify({ childThreadId: "child-1" }),
		);
		assert.equal(del?.kind, "delegate");
		assert.equal(del?.threadId, "child-1");
		assert.equal(del?.title, "Fixer");
	});

	test("indexAgySessions indexes transcripts, joins A/B arms, and feeds metrics + dream collect", () => {
		const brainRoot = join(dir, "brain");
		const dataDir = join(dir, "agy-data");
		const repo = join(dir, "my-repo");
		mkdirSync(join(repo, ".git"), { recursive: true });

		const convId = "11111111-2222-3333-4444-555555555555";
		const logsDir = join(brainRoot, convId, ".system_generated", "logs");
		mkdirSync(logsDir, { recursive: true });
		const transcriptFile = join(logsDir, "transcript.jsonl");

		const entries = [
			{
				step_index: 0,
				source: "USER_EXPLICIT",
				type: "USER_INPUT",
				status: "DONE",
				created_at: "2026-11-22T10:00:00.000Z",
				content: "<user_request>Build feature X</user_request>",
			},
			{
				step_index: 1,
				source: "MODEL",
				type: "PLANNER_RESPONSE",
				status: "DONE",
				created_at: "2026-11-22T10:00:05.000Z",
				content: "I will run npm test first.",
				input_tokens: 1000,
				cache_read_tokens: 500,
				output_tokens: 120,
				tool_calls: [{ name: "run_command", args: { CommandLine: "npm test", Cwd: repo } }],
			},
			{
				step_index: 2,
				source: "SYSTEM",
				type: "RUN_COMMAND",
				status: "DONE",
				created_at: "2026-11-22T10:00:07.000Z",
				content: "all passed",
				exit_code: 0,
			},
			{
				step_index: 3,
				source: "MODEL",
				type: "PLANNER_RESPONSE",
				status: "DONE",
				created_at: "2026-11-22T10:00:10.000Z",
				content: "Ran npm test and everything passed.",
				input_tokens: 1200,
				cache_read_tokens: 900,
				output_tokens: 80,
				tool_calls: [],
			},
			{
				step_index: 4,
				source: "USER_EXPLICIT",
				type: "USER_INPUT",
				status: "DONE",
				created_at: "2026-11-22T10:01:00.000Z",
				content: "<user_request>No, always use pnpm test in this repo</user_request>",
			},
		];
		writeFileSync(transcriptFile, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);

		recordAgySession(
			{
				conversationId: convId,
				cwd: repo,
				workspacePaths: [repo],
				modelName: "gemini-4-neon",
				transcriptPath: transcriptFile,
				arms: [{ experiment: "test-exp", arm: "B", forced: false, assignedAt: Date.parse("2026-11-22T10:00:00.000Z") }],
				startedAt: Date.parse("2026-11-22T10:00:00.000Z"),
			},
			dataDir,
		);

		const db = openStore(join(dir, "metrics.db"));
		try {
			const res = indexAgySessions(db, { roots: [brainRoot], dataDir });
			assert.equal(res.files, 1);
			assert.equal(res.indexed, 1);
			assert.equal(res.failed.length, 0);
			assert.equal(importedAgy(db), true);

			// Overview filtered to source: "agy" sees the session and its requests.
			const ov = overview(new Scope(db, { source: "agy" }));
			assert.equal(ov.kpis.sessions, 1);
			assert.equal(ov.kpis.requests, 2);

			// Default source ("pi") does NOT include agy sessions.
			assert.equal(overview(new Scope(db, { source: "pi" })).kpis.sessions, 0);

			// Experiment arm was stored.
			const armRow = db.prepare("SELECT experiment, arm, forced FROM experiment_arms WHERE session_id = ?").get(convId) as {
				experiment: string;
				arm: string;
				forced: number;
			};
			assert.deepEqual({ ...armRow }, { experiment: "test-exp", arm: "B", forced: 0 });

			// Dream collects the user's follow-up correction with preceding PLANNER_RESPONSE text.
			assert.deepEqual(repositories(db), [repo]);
			const before = precedingAgentText(transcriptFile);
			assert.equal(before.get("step-4"), "Ran npm test and everything passed.");

			const obs = collect(db, 0);
			assert.equal(obs.length, 1);
			assert.equal(obs[0]!.text, "No, always use pnpm test in this repo");
			assert.equal(obs[0]!.before, "Ran npm test and everything passed.");
			assert.equal(obs[0]!.repo, repo);
		} finally {
			db.close();
		}
	});
});
