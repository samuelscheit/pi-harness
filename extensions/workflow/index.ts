// workflow: the agent writes a TypeScript script that does a task's procedure deterministically and
// calls a model only where a judgment is needed (llm() for one request, agent() for a child agent
// with tools), instead of doing every step itself turn by turn. The script runs in-process (see
// compile.ts and run.ts; the API is api.d.ts) and only what it returns reaches the conversation.
//
// Saved workflows (library.ts) become tools of their own: `<harness>/workflows/*.ts` and
// `<repository>/.pi/workflows/*.ts`. They are read on every run, so a workflow the agent saves is
// callable from its next turn.
//
// All are registered inactive. A rule (lib/rules.ts) switches them on for every session, an
// experiment per arm (lib/experiments.ts): a saved workflow an experiment names follows that
// experiment, the others follow `workflow` as the prompt extension selected it (it runs first).

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, getAgentDir, ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { applyToolSwitches, EXPERIMENTS_DIR, listExperiments, recordedArms, toolSwitches } from "../lib/experiments.ts";
import { HARNESS_ROOT } from "../lib/repository.ts";
import { HARNESS_WORKFLOWS, loadWorkflows, projectWorkflowsDir, type SavedWorkflow } from "./library.ts";
import { INLINE_FILE, type RunEnv, runWorkflow, type ToolOutcome, type WorkflowDetails } from "./run.ts";

export const WORKFLOW_TOOL = "workflow";

/** The script API as the model reads it: api.d.ts below its header. */
const API = readFileSync(new URL("./api.d.ts", import.meta.url), "utf8").split("// ---\n")[1]!.trim();

export interface WorkflowExtensionOptions {
	experimentsDir?: string;
	/** Directories with saved workflows, given the working directory; default harness then project. */
	workflowDirs?: (cwd: string) => string[];
	/** Default: the agent dir's models and credentials, loaded once per process. */
	modelRuntime?: () => Promise<ModelRuntime>;
}

let sharedRuntime: Promise<ModelRuntime> | undefined;

/** What a nested call resolves to for the script: structured content when the tool declares an output schema, else its text. */
function outcome(tool: AgentTool | undefined, result: { content: { type: string; text?: string }[]; structuredContent?: unknown }, isError: boolean): ToolOutcome {
	const text = result.content.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
	const structured = Boolean(tool?.outputSchema) && result.structuredContent !== undefined;
	return { value: structured ? result.structuredContent : text, structured, text, isError };
}

export default function workflow(pi: ExtensionAPI, options: WorkflowExtensionOptions = {}) {
	const experimentsDir = options.experimentsDir ?? EXPERIMENTS_DIR;
	const workflowDirs = options.workflowDirs ?? ((cwd: string) => [HARNESS_WORKFLOWS, projectWorkflowsDir(cwd)]);
	const runtime = options.modelRuntime ?? (() => (sharedRuntime ??= ModelRuntime.create()));
	/** llm() results per session. */
	const caches = new Map<string, Map<string, unknown>>();
	/** The saved workflows registered now, and every name this extension registered in this process. */
	let library = new Map<string, SavedWorkflow>();
	const owned = new Set<string>();
	let reported = "";

	const run = async (entry: Parameters<typeof runWorkflow>[0], budget: number, signal: AbortSignal | undefined, onUpdate: ((r: { content: { type: "text"; text: string }[]; details: WorkflowDetails }) => void) | undefined, ctx: ExtensionToolContext) => {
		const session = ctx.sessionManager;
		const sessionId = session.getSessionId();
		const llmCache = caches.get(sessionId) ?? caches.set(sessionId, new Map()).get(sessionId)!;
		const parentSessionFile = session.getSessionFile();
		const env: RunEnv = {
			cwd: ctx.cwd,
			runtime: await runtime(),
			agentDir: getAgentDir(),
			llmCache,
			executeTool: async (name, args, callSignal) => {
				const result = await ctx.executeTool(name, args, { signal: callSignal });
				return outcome(ctx.tools.find((t) => t.name === name), result.result as never, result.isError);
			},
			library: () => library,
			sessionDir: parentSessionFile ? session.getSessionDir() : undefined,
			parentSessionFile,
			signal,
			onUpdate: (details) => onUpdate?.({ content: [{ type: "text", text: details.log.join("\n") }], details }),
		};
		const { text, details, usage } = await runWorkflow(entry, budget, env);
		return { content: [{ type: "text" as const, text }], details, ...(usage ? { usage } : {}), ...(details.status === "completed" ? {} : { isError: true }) };
	};

	const common = {
		// The scripts' agents compare the working tree; other calls must not change it meanwhile.
		executionMode: "sequential",
		// Scripts must not start workflows as tools (they call workflows.* directly).
		exposure: "model-only",
		reachesTools: () => "all",
		defaultActive: false,
	} satisfies Partial<ToolDefinition>;

	pi.registerTool({
		...common,
		name: WORKFLOW_TOOL,
		label: "Workflow",
		description: [
			"Run a TypeScript script that does a procedure with code and calls a model only where a judgment is needed. `code` is the body of an async function: top-level await and `return` work; only the returned value (a string, or data shown as YAML) reaches you, plus cost and changed files. An object with `ok: false` marks the goal as missed.",
			"Globals:",
			API,
		].join("\n\n"),
		promptSnippet: "Run a TypeScript workflow script: deterministic code with llm() and agent() calls only where judgment is needed",
		promptGuidelines: [
			"Use workflow when a task is a procedure you can write down: the same step over many items (classify, extract, review each with llm()), a loop until a command passes, or several child agents in parallel. Code does what is mechanical; return only what you need, not raw tool output.",
			"Rerun an edited workflow freely: unchanged llm() calls come from the cache. Save one that this repository will need again as .pi/workflows/<name>.ts (export meta and a default function); it becomes the tool <name>.",
			"When you are about to run the same kind of long shell command again with different arguments, save it as a workflow with the arguments as parameters (built with sh`…`) and call that tool from then on.",
		],
		parameters: Type.Object({
			code: Type.String({ description: "TypeScript: the body of an async function using the globals above." }),
			budget: Type.Number({ exclusiveMinimum: 0, description: "Spending limit of this run in USD for llm() and agent(); the run stops when it is used up. Small llm() calls cost fractions of a cent, an agent run cents to dollars." }),
		}),
		execute: (_id, params, signal, onUpdate, ctx) => run({ source: params.code, filename: INLINE_FILE, inline: true }, params.budget, signal, onUpdate, ctx),
	});

	const register = (saved: SavedWorkflow) => {
		owned.add(saved.name);
		const where = saved.file.startsWith(HARNESS_ROOT) ? `harness workflow ${relative(HARNESS_ROOT, saved.file)}` : `workflow ${saved.file}`;
		pi.registerTool({
			...common,
			name: saved.name,
			label: saved.name,
			description: `${saved.meta.description.trim()}\n\n(${where}; budget $${saved.meta.budget} per run)`,
			promptGuidelines: saved.meta.guidelines,
			// SAFETY: Pi validates arguments against any JSON Schema (pi-schema), not only TypeBox values; metaProblem checked it is an object schema.
			parameters: saved.meta.parameters as unknown as TSchema,
			execute: (_id, params, signal, onUpdate, ctx) =>
				run({ source: saved.source, filename: saved.file, inline: false, name: saved.name, input: params }, saved.meta.budget, signal, onUpdate, ctx),
		});
	};

	/** Register what changed in the workflow files: new and changed ones, and withdraw deleted ones. */
	const refresh = (ctx: ExtensionContext) => {
		const { workflows, problems } = loadWorkflows(ctx.cwd, workflowDirs(ctx.cwd));
		const foreign = new Set(pi.getAllTools().map((t) => t.name).filter((name) => !owned.has(name)));
		for (const name of [...workflows.keys()].filter((n) => foreign.has(n))) {
			problems.push(`${workflows.get(name)!.file}: a tool named ${name} exists already`);
			workflows.delete(name);
		}
		for (const [name, saved] of workflows) if (library.get(name)?.version !== saved.version) register(saved);
		for (const name of library.keys()) {
			if (!workflows.has(name)) pi.registerTool({ name, label: name, description: "withdrawn", parameters: Type.Object({}), exposure: "hidden", execute: async () => ({ content: [], details: undefined }) });
		}
		library = workflows;
		const text = problems.join("\n");
		if (text !== reported && text && ctx.hasUI) ctx.ui.notify(`workflow: skipped invalid workflows:\n${text}`, "warning");
		reported = text;
	};

	/** The selection with the saved workflows switched: by the experiment naming them, else like `workflow`. */
	const switched = (ctx: ExtensionContext, selected: string[]) => {
		refresh(ctx);
		const session = ctx.sessionManager;
		const switches = toolSwitches(listExperiments(experimentsDir), session.getSessionId(), recordedArms(session.getEntries()));
		const on = switches.get(WORKFLOW_TOOL) ?? selected.includes(WORKFLOW_TOOL);
		return applyToolSwitches(selected, new Map([...library.keys()].map((name) => [name, switches.get(name) ?? on])));
	};

	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("before_agent_start", (event, ctx) => {
		event.systemPromptOptions.selectedTools = switched(ctx, event.systemPromptOptions.selectedTools);
	});
	// A workflow saved during a turn is callable from the next turn.
	pi.on("turn_end", (_event, ctx) => {
		const active = pi.getActiveTools();
		const next = switched(ctx, active);
		if (next.length !== active.length || next.some((name, i) => name !== active[i])) pi.setActiveTools(next);
	});
}
