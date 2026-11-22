#!/usr/bin/env node
// `pi-harness` MCP server for Antigravity (`agy`).
//
// Exposes the harness's core tools over stdio JSON-RPC 2.0 by importing the same TypeScript
// modules Pi runs:
// - `note_improvement` (extensions/improvements/index.ts)
// - `goal`             (agy/goal-runtime.ts -> extensions/goal/goal.ts)
// - `edit_blocks`      (agy/edit-runtime.ts -> extensions/bash/edit-blocks.ts)
// - `workflow`         (extensions/workflow/run.ts, stop.ts, steer.ts, render.ts)
// - saved workflows    (workflows/*.ts + <repo>/.pi/workflows/*.ts, e.g. fix_loop)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { stringify } from "yaml";
import { EDIT_BLOCKS_HELP } from "../../extensions/bash/edit-blocks.ts";
import { MAX_OBJECTIVE } from "../../extensions/goal/goal.ts";
import { appendNote, backlogPath, formatNote } from "../../extensions/improvements/index.ts";
import { HARNESS_ROOT, SOURCE_ROOT } from "../../extensions/lib/repository.ts";
import { runState, sweepRuns } from "../../extensions/workflow/journal.ts";
import { HARNESS_WORKFLOWS, loadWorkflows, projectWorkflowsDir } from "../../extensions/workflow/library.ts";
import { phaseStatus } from "../../extensions/workflow/render.ts";
import { INLINE_FILE, type ResumeRequest, type RunEnv, resumeWorkflow, runWorkflow } from "../../extensions/workflow/run.ts";
import { steerRun } from "../../extensions/workflow/steer.ts";
import { lockHeld, stopRun } from "../../extensions/workflow/stop.ts";
import { applyEditBlocks } from "../edit-runtime.ts";
import { type GoalActionInput, runGoalAction } from "../goal-runtime.ts";
import { pluginDataDir } from "../state.ts";
import { type McpCallResult, type McpServerConfig, type McpToolDefinition, serveStdio } from "./protocol.ts";

const WORKFLOW_API = readFileSync(new URL("../../extensions/workflow/api.d.ts", import.meta.url), "utf8").split("// ---\n")[1]?.trim() ?? "";

export interface HarnessMcpOptions {
	cwd?: string;
	agentDir?: string;
	dataDir?: string;
	harnessRoot?: string;
	conversationId?: string;
	modelRuntime?: () => Promise<ModelRuntime>;
}

const ok = (text: string): McpCallResult => ({ content: [{ type: "text", text }] });
const err = (text: string): McpCallResult => ({ content: [{ type: "text", text }], isError: true });

export function createHarnessMcpConfig(options: HarnessMcpOptions = {}): McpServerConfig {
	const defaultCwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? getAgentDir() ?? join(homedir(), ".pi/agent");
	const dataDir = options.dataDir ?? pluginDataDir();
	const harnessRoot = options.harnessRoot ?? SOURCE_ROOT;
	const defaultConvId = () => options.conversationId ?? process.env.ANTIGRAVITY_CONVERSATION_ID ?? process.env.PI_HARNESS_CONVERSATION_ID ?? "default";

	let sharedRuntime: Promise<ModelRuntime> | undefined;
	const getRuntime = options.modelRuntime ?? (() => (sharedRuntime ??= ModelRuntime.create()));
	const llmCache = new Map<string, unknown>();

	try {
		sweepRuns(agentDir);
	} catch {
		// Best-effort cleanup.
	}

	const workflowDirs = (cwd: string) => [
		join(HARNESS_ROOT, "workflows"),
		...(HARNESS_WORKFLOWS !== join(HARNESS_ROOT, "workflows") ? [HARNESS_WORKFLOWS] : []),
		projectWorkflowsDir(cwd),
	];

	const getSavedWorkflows = (cwd: string) => loadWorkflows(cwd, workflowDirs(cwd)).workflows;

	const makeRunEnv = async (cwd: string): Promise<RunEnv> => {
		const runtime = await getRuntime();
		return {
			cwd,
			runtime,
			agentDir,
			llmCache,
			sessionId: defaultConvId(),
			library: () => getSavedWorkflows(cwd),
		};
	};

	const staticTools: McpToolDefinition[] = [
		{
			name: "note_improvement",
			description:
				"Note something the harness or this project should do better, for a later improvement pass (nightly dreaming). Use when you notice friction worth fixing: the user corrected you or repeated an instruction, an instruction was missing/ambiguous, or a tool failed/misled you. Appends a note and returns at once.",
			inputSchema: {
				type: "object",
				properties: {
					scope: {
						type: "string",
						enum: ["project", "harness"],
						description: "project: this repository's instructions/skills/conventions. harness: global rules, tools, prompts, extensions.",
					},
					observation: {
						type: "string",
						description: "What happened, with concrete evidence (user words, error, file, command).",
					},
					proposal: {
						type: "string",
						description: "The specific change you would make (file, rule text, tool behaviour).",
					},
					cwd: {
						type: "string",
						description: "Optional working directory (for project scope); defaults to the MCP server cwd.",
					},
				},
				required: ["scope", "observation", "proposal"],
				additionalProperties: false,
			},
		},
		{
			name: "goal",
			description:
				"Set, show, or finish this session's goal: an objective the session keeps working on until achieved. While active, the Stop hook holds your turn until you mark it achieved (running its check command, if any, which must exit 0), blocked with a reason, or wait (naming the running background jobs every remaining step depends on).",
			inputSchema: {
				type: "object",
				properties: {
					action: {
						type: "string",
						enum: ["set", "achieved", "blocked", "wait", "show", "pause", "resume", "clear"],
						description: "set: start/update a goal. achieved/blocked: finish it. wait: every remaining step depends on a running background job. show/pause/resume/clear: inspect or control it.",
					},
					objective: {
						type: "string",
						description: `set: specific, checkable objective (max ${MAX_OBJECTIVE} chars).`,
					},
					check: {
						type: "string",
						description: "set: shell command (run in cwd) that must exit 0 for achieved.",
					},
					budget_usd: {
						type: "number",
						description: "set: USD spend budget.",
					},
					budget_tokens: {
						type: "integer",
						description: "set: new-token budget (input + output, excluding cache reads).",
					},
					reason: {
						type: "string",
						description: "blocked: what blocks progress. wait: why nothing else can be done when re-waiting.",
					},
					steps: {
						type: "array",
						items: {
							type: "object",
							properties: {
								step: { type: "string" },
								job: { type: "string" },
							},
							required: ["step", "job"],
							additionalProperties: false,
						},
						description: "wait: every remaining step paired with the running job/task it waits on.",
					},
					cwd: {
						type: "string",
						description: "Optional working directory for running the check command.",
					},
					conversation_id: {
						type: "string",
						description: "Optional conversation id override (normally inherited automatically).",
					},
				},
				required: ["action"],
				additionalProperties: false,
			},
		},
		{
			name: "edit_blocks",
			description: `Apply atomic multi-file SEARCH/REPLACE blocks checked with Pi's matcher before writing any file (and tracked for own-writes commit safety).\n\n${EDIT_BLOCKS_HELP}`,
			inputSchema: {
				type: "object",
				properties: {
					blocks: {
						type: "string",
						description: "Path lines and <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks.",
					},
					cwd: {
						type: "string",
						description: "Optional working directory for resolving relative paths.",
					},
					conversation_id: {
						type: "string",
						description: "Optional conversation id for own-writes commit tracking.",
					},
				},
				required: ["blocks"],
				additionalProperties: false,
			},
		},
		{
			name: "workflow",
			description: [
				"Run a durable TypeScript workflow script that handles deterministic procedures in code and calls models only for judgments (`llm()`, `delegate()`). Only the returned value, cost, and changed files reach the conversation.",
				"Also supports `status`, `stop`, `steer`, and `resume` by run id.",
				WORKFLOW_API ? `Globals:\n${WORKFLOW_API}` : "",
			]
				.filter(Boolean)
				.join("\n\n"),
			inputSchema: {
				type: "object",
				properties: {
					code: { type: "string", description: "TypeScript async function body to execute (or edited code with `resume`)." },
					budget: { type: "number", description: "USD budget cap for the run (default 2)." },
					cwd: { type: "string", description: "Optional working directory for the run." },
					status: { type: "string", description: "Return phase/call status YAML for this run id." },
					stop: { type: "string", description: "Stop this running run id." },
					stopChildren: { type: "boolean", description: "With `stop`: also cancel delegated children." },
					steer: { type: "string", description: "Run id whose active delegates should receive `message`." },
					message: { type: "string", description: "With `steer`: steering text for active delegates." },
					resume: { type: "string", description: "Resume this run id from its durable journal." },
					inFlight: { type: "string", enum: ["rerun", "fail"], description: "With `resume`: policy for interrupted shell/tool calls." },
				},
				additionalProperties: false,
			},
		},
	];

	const listTools = (): McpToolDefinition[] => {
		const saved = getSavedWorkflows(defaultCwd);
		const savedDefs: McpToolDefinition[] = [...saved.values()].map((wf) => ({
			name: wf.name,
			description: `${wf.meta.description} (saved pi-harness workflow; default budget $${wf.meta.budget})`,
			inputSchema: {
				...wf.meta.parameters,
				properties: {
					...((wf.meta.parameters.properties as Record<string, unknown> | undefined) ?? {}),
					cwd: { type: "string", description: "Optional working directory for this workflow run." },
					budget: { type: "number", description: `Optional USD budget override (default $${wf.meta.budget}).` },
				},
			},
		}));
		return [...staticTools, ...savedDefs];
	};

	const callTool = async (name: string, args: Record<string, unknown>): Promise<McpCallResult> => {
		const cwd = typeof args.cwd === "string" && args.cwd.trim() ? resolve(defaultCwd, args.cwd.trim()) : defaultCwd;
		const convId = typeof args.conversation_id === "string" && args.conversation_id.trim() ? args.conversation_id.trim() : defaultConvId();

		if (name === "note_improvement") {
			const scope = args.scope === "harness" ? "harness" : args.scope === "project" ? "project" : undefined;
			const observation = typeof args.observation === "string" ? args.observation : "";
			const proposal = typeof args.proposal === "string" ? args.proposal : "";
			if (!scope || !observation.trim() || !proposal.trim()) {
				return err("note_improvement requires scope ('project' | 'harness'), observation, and proposal.");
			}
			const file = backlogPath(scope, cwd, harnessRoot);
			const entry = formatNote({ scope, observation, proposal }, new Date(), convId, cwd);
			appendNote(file, entry);
			return ok(`Noted in ${file}.`);
		}

		if (name === "goal") {
			const result = await runGoalAction(args as unknown as GoalActionInput, {
				conversationId: convId,
				cwd,
				dataDir,
			});
			return result.isError ? err(result.text) : ok(result.text);
		}

		if (name === "edit_blocks") {
			const blocks = typeof args.blocks === "string" ? args.blocks : "";
			if (!blocks.trim()) return err("edit_blocks requires a non-empty `blocks` string.");
			const res = await applyEditBlocks(blocks, { cwd, conversationId: convId, dataDir });
			const combined = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join("\n");
			return res.code === 0 ? ok(combined || "No changes.") : err(combined || `edit_blocks failed (exit ${res.code})`);
		}

		if (name === "workflow") {
			if (typeof args.status === "string" && args.status.trim()) {
				const id = args.status.trim();
				const { entries } = runState(agentDir, id);
				const running = lockHeld(agentDir, id);
				return ok(stringify(phaseStatus(entries, { processEnded: !running })).trim());
			}
			if (typeof args.stop === "string" && args.stop.trim()) {
				return ok(await stopRun(agentDir, args.stop.trim(), args.stopChildren === true));
			}
			if (typeof args.steer === "string" && args.steer.trim()) {
				const text = typeof args.message === "string" ? args.message.trim() : "";
				if (!text) return err("workflow steer requires a non-empty `message`.");
				return ok(await steerRun(agentDir, args.steer.trim(), { text }));
			}
			if (typeof args.resume === "string" && args.resume.trim()) {
				const request: ResumeRequest = {
					id: args.resume.trim(),
					...(args.inFlight === "rerun" || args.inFlight === "fail" ? { inFlight: args.inFlight } : {}),
					...(typeof args.budget === "number" ? { budget: args.budget } : {}),
					...(typeof args.code === "string" ? { code: args.code } : {}),
				};
				const env = await makeRunEnv(cwd);
				const result = await resumeWorkflow(request, env);
				return result.details.ok ? ok(result.text) : err(result.text);
			}
			const code = typeof args.code === "string" ? args.code : "";
			if (!code.trim()) return err("workflow requires `code`, `status`, `stop`, `steer`, or `resume`.");
			const budget = typeof args.budget === "number" && args.budget > 0 ? args.budget : 2;
			const env = await makeRunEnv(cwd);
			const result = await runWorkflow({ source: code, filename: INLINE_FILE, inline: true }, budget, env);
			return result.details.ok ? ok(result.text) : err(result.text);
		}

		// Saved workflow tool (e.g. fix_loop or project .pi/workflows/<name>.ts).
		const saved = getSavedWorkflows(cwd).get(name);
		if (saved) {
			const input = { ...args };
			delete input.cwd;
			const budget = typeof args.budget === "number" && args.budget > 0 ? args.budget : saved.meta.budget;
			delete input.budget;
			const env = await makeRunEnv(cwd);
			const result = await runWorkflow({ source: saved.source, filename: saved.file, inline: false, name: saved.name, input }, budget, env);
			return result.details.ok ? ok(result.text) : err(result.text);
		}

		return err(`Unknown tool: ${name}`);
	};

	return {
		name: "pi-harness",
		version: "1.0.0",
		listTools,
		callTool,
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	serveStdio(createHarnessMcpConfig());
}
