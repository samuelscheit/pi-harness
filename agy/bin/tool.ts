#!/usr/bin/env node
// Standalone `tool` CLI for Antigravity (`agy`) shell commands.
//
// Brings pi-harness's bash scripting ergonomics into `agy`'s `run_command`:
// - `tool edit - <<'EOF'`    atomic multi-file SEARCH/REPLACE blocks (extensions/bash/edit-blocks.ts)
// - `tool edit --help`       prints the SEARCH/REPLACE format reference
// - `tool read <path>`       prints a file's contents (optional --offset / --limit)
// - `tool note_improvement`  appends to .agents/improvements.md
// - `tool goal ...`          manages the current conversation's goal

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { EDIT_BLOCKS_HELP } from "../../extensions/bash/edit-blocks.ts";
import { appendNote, backlogPath, formatNote } from "../../extensions/improvements/index.ts";
import { applyEditBlocks } from "../edit-runtime.ts";
import { type GoalActionInput, runGoalAction } from "../goal-runtime.ts";

const conversationId = () => process.env.ANTIGRAVITY_CONVERSATION_ID || process.env.PI_HARNESS_CONVERSATION_ID || "default";

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
	const [sub, ...rest] = process.argv.slice(2);
	if (!sub || sub === "--help" || sub === "-h") {
		process.stdout.write(
			[
				"Usage: tool <subcommand> [args]",
				"",
				"Subcommands:",
				"  edit -              Apply SEARCH/REPLACE blocks from stdin (atomic across files)",
				"  edit --help         Show SEARCH/REPLACE block format",
				"  read <path>         Print file contents (--offset <1-based line>, --limit <lines>)",
				"  note_improvement    Append a friction note (--scope project|harness --observation ... --proposal ...)",
				"  goal <action>       Manage session goal (set|achieved|blocked|wait|show|pause|resume|clear)",
			].join("\n") + "\n",
		);
		return;
	}

	if (sub === "edit") {
		if (rest.includes("--help") || rest.includes("-h")) {
			process.stdout.write(`${EDIT_BLOCKS_HELP}\n`);
			return;
		}
		if (rest[0] !== "-") {
			process.stderr.write("Usage: tool edit - <<'EOF'\nRun `tool edit --help` for the block format.\n");
			process.exitCode = 2;
			return;
		}
		const stdin = await readStdin();
		const res = await applyEditBlocks(stdin, { cwd: process.cwd(), conversationId: conversationId() });
		if (res.stdout) process.stdout.write(res.stdout);
		if (res.stderr) process.stderr.write(res.stderr);
		process.exitCode = res.code;
		return;
	}

	if (sub === "read") {
		const { values, positionals } = parseArgs({
			args: rest,
			allowPositionals: true,
			options: { offset: { type: "string" }, limit: { type: "string" } },
		});
		const target = positionals[0];
		if (!target) {
			process.stderr.write("Usage: tool read <path> [--offset <line>] [--limit <lines>]\n");
			process.exitCode = 2;
			return;
		}
		const abs = resolve(process.cwd(), target);
		if (!existsSync(abs)) {
			process.stderr.write(`tool read: no such file: ${abs}\n`);
			process.exitCode = 1;
			return;
		}
		const lines = readFileSync(abs, "utf8").split("\n");
		const start = Math.max(1, Number(values.offset ?? 1) || 1);
		const limit = values.limit ? Math.max(1, Number(values.limit) || lines.length) : lines.length;
		process.stdout.write(`${lines.slice(start - 1, start - 1 + limit).join("\n")}\n`);
		return;
	}

	if (sub === "note_improvement") {
		const { values } = parseArgs({
			args: rest,
			options: {
				scope: { type: "string" },
				observation: { type: "string" },
				proposal: { type: "string" },
			},
		});
		const scope = values.scope === "harness" ? "harness" : values.scope === "project" ? "project" : undefined;
		if (!scope || !values.observation?.trim() || !values.proposal?.trim()) {
			process.stderr.write("Usage: tool note_improvement --scope project|harness --observation <text> --proposal <text>\n");
			process.exitCode = 2;
			return;
		}
		const file = backlogPath(scope, process.cwd());
		const entry = formatNote({ scope, observation: values.observation, proposal: values.proposal }, new Date(), conversationId(), process.cwd());
		appendNote(file, entry);
		process.stdout.write(`Noted in ${file}.\n`);
		return;
	}

	if (sub === "goal") {
		const [action, ...flagArgs] = rest;
		const validActions = new Set(["set", "achieved", "blocked", "wait", "show", "pause", "resume", "clear"]);
		if (!action || !validActions.has(action)) {
			process.stderr.write("Usage: tool goal <set|achieved|blocked|wait|show|pause|resume|clear> [flags]\n");
			process.exitCode = 2;
			return;
		}
		const { values, positionals } = parseArgs({
			args: flagArgs,
			allowPositionals: true,
			options: {
				objective: { type: "string" },
				check: { type: "string" },
				reason: { type: "string" },
				budget_usd: { type: "string" },
				budget_tokens: { type: "string" },
			},
		});
		const input: GoalActionInput = {
			action: action as GoalActionInput["action"],
			objective: values.objective ?? (positionals.length ? positionals.join(" ") : undefined),
			check: values.check,
			reason: values.reason,
			...(values.budget_usd ? { budget_usd: Number(values.budget_usd) } : {}),
			...(values.budget_tokens ? { budget_tokens: Number(values.budget_tokens) } : {}),
		};
		const result = await runGoalAction(input, { conversationId: conversationId(), cwd: process.cwd() });
		process.stdout.write(`${result.text}\n`);
		if (result.isError) process.exitCode = 1;
		return;
	}

	process.stderr.write(`tool: unknown subcommand "${sub}". Run \`tool --help\`.\n`);
	process.exitCode = 2;
}

main().catch((error) => {
	process.stderr.write(`tool: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
