// workflow: the agent writes a TypeScript script that does a task's procedure deterministically and
// calls a model only where a judgment is needed (llm() for one request, delegate() for a child agent
// with tools), instead of doing every step itself turn by turn. The script runs in-process (see
// compile.ts and run.ts; the API is api.d.ts) and only what it returns reaches the conversation.
// delegate() is t3's delegate_task as the harness extends it (delegate-tool.ts: schema, system,
// tools), awaited: t3 delegated tasks in t3, in-process elsewhere (delegate.ts); every session also
// runs the child side (child.ts), which applies a delegated child's spec.
//
// Saved workflows (library.ts) become tools of their own: `<harness>/workflows/*.ts` and
// `<repository>/.pi/workflows/*.ts`. They are read on every run, so a workflow the agent saves is
// callable from its next turn.
//
// All are registered inactive. A rule (lib/rules.ts) switches them on for every session, an
// experiment per arm (lib/experiments.ts): a saved workflow an experiment names follows that
// experiment, the others follow `workflow` as the prompt extension selected it (it runs first).
//
// Runs are durable (run.ts, durable.ts) and visible (render.ts, runs.ts): the session records each
// run's start and end, the thread shows the run's page at its start and end, the dashboard serves
// it live, and a run whose process died is offered for resuming when its session starts again.
// By id, the tool also acts on a run: `status` (render.ts: phases and open delegate calls with
// their titles, thread and task ids), `show`, `stop` (stop.ts) and `steer` (steer.ts: a message
// to the running delegates).

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, getAgentDir, ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { applyToolSwitches, EXPERIMENTS_DIR, listExperiments, recordedArms, toolSwitches } from "../lib/experiments.ts";
import { HARNESS_ROOT } from "../lib/repository.ts";
import { delegatedChild } from "./child.ts";
import { extendDelegateTool } from "./delegate-tool.ts";
import { delegationsDir, sweepDelegations } from "./delegation.ts";

import { HARNESS_WORKFLOWS, loadWorkflows, projectWorkflowsDir, type SavedWorkflow } from "./library.ts";
import { INLINE_FILE, type ResumeRequest, type RunEnv, resumeWorkflow, runWorkflow, type ToolOutcome, type WorkflowDetails, type WorkflowResult } from "./run.ts";
import { sessionJobs } from "../background/jobs.ts";
import { reportWork } from "../background/work.ts";
import { ParentTurn, type ParentTurnOptions, parentTurn, WAKE_MESSAGE, WAKE_TEXT } from "./parent-turn.ts";
import { contextLive, DEFAULT_DASHBOARD, type Executor, flushEndRenders, latestApi, liveUrl, offerInterrupted, recordRun, renderEnd, runHeadline, runName, setLatestApi, showRun, startViews } from "./runs.ts";
import { type SignatureTool, toolsDeclaration } from "./signatures.ts";
import { lockHeld, stopRun } from "./stop.ts";
import { steerRun } from "./steer.ts";
import { phaseStatus } from "./render.ts";
import { runState, sweepRuns } from "./journal.ts";
import { stringify } from "yaml";

export const WORKFLOW_TOOL = "workflow";

/** The script API as the model reads it: api.d.ts below its header. */
const API = readFileSync(new URL("./api.d.ts", import.meta.url), "utf8").split("// ---\n")[1]!.trim();
/** api.d.ts's generic `tools` declaration, which the description replaces with the session's tools. */
const TOOLS_DECLARATION = /declare const tools: [^\n]*\n(?:\t[^\n]*\n)*\};/;

/** The workflow tool's description; with the tools a script can call, their signatures. */
function describe(tools?: readonly SignatureTool[]): string {
	const api = tools ? API.replace(TOOLS_DECLARATION, toolsDeclaration(tools)) : API;
	return [
		"Run a TypeScript script that does a procedure with code and calls a model only where a judgment is needed. `code` is the body of an async function: top-level await and `return` work; only the returned value (a string, or data shown as YAML) reaches you, plus cost and changed files. An object with `ok: false` marks the goal as missed.",
		"A run's id (in its result and live view) also lets you act on it: `status` (its phases and its open delegate calls with their titles, thread and task ids), `show`, `steer` (send its running delegates a message: a new rule or correction), `stop` and `resume`.",
		"Models of llm() and delegate() are checked against what their provider serves before the first request: an unknown one fails at once and the error lists the models served.",
		"Globals:",
		api,
	].join("\n\n");
}

export interface WorkflowExtensionOptions {
	experimentsDir?: string;
	/** Directories with saved workflows, given the working directory; default harness then project. */
	workflowDirs?: (cwd: string) => string[];
	/** Default: the agent dir's models and credentials, loaded once per process. */
	modelRuntime?: () => Promise<ModelRuntime>;
	/** Where delegation specs, child states and run journals live; default Pi's agent dir. */
	agentDir?: string;
	/** The dashboard's base URL for live views; default http://127.0.0.1:4317. */
	dashboardUrl?: string;
	/** How t3 calls that fail in transport are repeated; default t3.ts's. */
	t3Retry?: RunEnv["t3Retry"];
	/** How a delegate start waits for an active run of the parent thread; default parent-turn.ts's. */
	parentTurn?: ParentTurnOptions;
	/** Where harness faults are noted (fault.ts); default the harness repository's backlog. */
	harnessBacklog?: string;
	/** How long a child's report may lag behind the end of its turn; default delegate.ts's. */
	stateWaitMs?: number;
}

let sharedRuntime: Promise<ModelRuntime> | undefined;

/** What a nested call resolves to for the script: structured content when the tool declares an output schema, else its text. */
function outcome(tool: AgentTool | undefined, result: { content: { type: string; text?: string }[]; structuredContent?: unknown; details?: unknown }, isError: boolean): ToolOutcome {
	const text = result.content.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
	const structured = Boolean(tool?.outputSchema) && result.structuredContent !== undefined;
	return { value: structured ? result.structuredContent : text, structured, text, isError, details: result.details };
}

export default function workflow(pi: ExtensionAPI, options: WorkflowExtensionOptions = {}) {
	const experimentsDir = options.experimentsDir ?? EXPERIMENTS_DIR;
	const workflowDirs = options.workflowDirs ?? ((cwd: string) => [HARNESS_WORKFLOWS, projectWorkflowsDir(cwd)]);
	const runtime = options.modelRuntime ?? (() => (sharedRuntime ??= ModelRuntime.create()));
	const agentDir = options.agentDir ?? getAgentDir();
	const dashboardUrl = options.dashboardUrl ?? DEFAULT_DASHBOARD;
	// Delegations of parents that never cleaned up (a crash): at most a day old. Journals: see sweepRuns.
	sweepDelegations(delegationsDir(agentDir));
	sweepRuns(agentDir);
	/** llm() results per session. */
	const caches = new Map<string, Map<string, unknown>>();
	/** The saved workflows registered now, and every name this extension registered in this process. */
	let library = new Map<string, SavedWorkflow>();
	const owned = new Set<string>();
	let reported = "";

	/** The session's turn as t3 needs it for delegate starts; `active` for one created now. */
	const turnOf = (sessionId: string, active = false) =>
		parentTurn(
			sessionId,
			() =>
				new ParentTurn(
					() => (latestApi(sessionId) ?? pi).sendMessage({ customType: WAKE_MESSAGE, content: WAKE_TEXT, display: true }, { triggerTurn: true, deliverAs: "steer" }),
					options.parentTurn,
					active,
				),
		);

	/** The session's tools, called as the model calls them; a stale context (a harness reload) interrupts the run. */
	const executor = (ctx: ExtensionToolContext): Executor => async (name, args, callSignal) => {
		let result: Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;
		try {
			result = await ctx.executeTool(name, args, { signal: callSignal });
		} catch (error) {
			if (error instanceof Error && /\bstale\b/.test(error.message)) throw Object.assign(new Error(`the harness reloaded: ${error.message}`), { name: "ContextStale" });
			throw error;
		}
		return outcome(ctx.tools.find((t) => t.name === name), result.result as never, result.isError);
	};

	type Start = { kind: "new"; entry: Parameters<typeof runWorkflow>[0]; budget: number } | { kind: "resume"; request: ResumeRequest };
	const run = async (callId: string, start: Start, signal: AbortSignal | undefined, onUpdate: ((r: { content: { type: "text"; text: string }[]; details: WorkflowDetails }) => void) | undefined, ctx: ExtensionToolContext) => {
		const session = ctx.sessionManager;
		const sessionId = session.getSessionId();
		// While it runs, the run is background work of the session (../background/work.ts).
		const jobs = sessionJobs(sessionId);
		let runId: string | undefined;
		const llmCache = caches.get(sessionId) ?? caches.set(sessionId, new Map()).get(sessionId)!;
		const parentSessionFile = session.getSessionFile();
		const execute = executor(ctx);
		const toolNames = ctx.tools.map((t) => t.name);
		let headline = "";
		const env: RunEnv = {
			cwd: ctx.cwd,
			runtime: await runtime(),
			agentDir,
			llmCache,
			executeTool: execute,
			toolNames,
			...(options.t3Retry ? { t3Retry: options.t3Retry } : {}),
			...(options.harnessBacklog ? { harnessBacklog: options.harnessBacklog } : {}),
			...(options.stateWaitMs ? { stateWaitMs: options.stateWaitMs } : {}),
			parent: turnOf(sessionId, !ctx.isIdle()),
			...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
			sessionId,
			library: () => library,
			sessionDir: parentSessionFile ? session.getSessionDir() : undefined,
			parentSessionFile,
			signal,
			onStart: ({ id, attempt }) => {
				headline = runHeadline(id, attempt, dashboardUrl);
				recordRun(pi, sessionId, { id, state: "started" });
				runId = id;
				jobs.runs.set(id, { id, name: runName(agentDir, id) ?? "inline", callId, startedAt: Date.now(), url: liveUrl(dashboardUrl, id), stop: () => stopRun(agentDir, id, false) });
				reportWork(jobs);
				startViews({ agentDir, id, toolNames, execute, dashboardUrl });
			},
			onUpdate: (details) => onUpdate?.({ content: [{ type: "text", text: [headline, ...details.log].filter(Boolean).join("\n") }], details }),
		};
		let result: WorkflowResult;
		try {
			result = start.kind === "new" ? await runWorkflow(start.entry, start.budget, env) : await resumeWorkflow(start.request, env);
		} finally {
			if (runId !== undefined && jobs.runs.delete(runId)) reportWork(jobs);
		}
		const { details, usage } = result;
		recordRun(pi, sessionId, { id: details.id, state: "ended", status: details.status });
		const text = renderEnd({ agentDir, id: details.id, sessionId, toolNames, execute, live: () => contextLive(ctx), text: result.text });
		return { content: [{ type: "text" as const, text }], details, ...(usage ? { usage } : {}), ...(details.status === "completed" || details.status === "stopped" ? {} : { isError: true }) };
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
		description: describe(),
		// The signatures of the tools scripts can call (not workflows: those are workflows.*).
		prepareLoadout: (loadout) => ({ descriptions: { [WORKFLOW_TOOL]: describe(loadout.callable.filter((tool) => tool.name !== WORKFLOW_TOOL && !library.has(tool.name))) } }),
		promptSnippet: "Run a TypeScript workflow script: deterministic code with llm() and delegate() calls only where judgment is needed",
		promptGuidelines: [
			"Use workflow when a task is a procedure you can write down: the same step over many items (classify, extract, review each with llm()), a loop until a command passes, or several child agents in parallel. Code does what is mechanical; return only what you need, not raw tool output.",
			'In a longer workflow, name its steps with phase() and what comes next with plan.expect(): the page shows the tree, and workflow { status: "<id>" } returns it as data.',
			"Rerun an edited workflow freely: unchanged llm() calls come from the cache. Save one that this repository will need again as .pi/workflows/<name>.ts (export meta and a default function); it becomes the tool <name>.",
			'A run that was interrupted or stopped continues from its journal with workflow { resume: "<id>" }: its recorded calls are not repeated. Do not start it over.',
			'To tell a running run\'s delegates something new (a rule, a correction), steer them with workflow { steer: "<id>", text: "…" }; `delegates` narrows it to some, by title (or a part of it) or thread id as workflow { status: "<id>" } lists them. Do not look for the delegates\' threads with other tools.',
			'Stop a running run with workflow { stop: "<id>" }: its agents keep running and their results are recorded; stopChildren: true cancels them. To change a run\'s script without losing its paid work, resume it with workflow { resume: "<id>", code: "<new code>" }: calls the new code makes as before come from the journal, from its first other call it runs live. Effects of the old code (commits, files) stay; the new code must cope with them.',
			"When a session template exists for the kind of task a child gets (`template` of delegate() and delegate_task names those here), start the child from it: its prepared context is cached once for every task.",
			"When you are about to run the same kind of long shell command again with different arguments, save it as a workflow with the arguments as parameters (built with sh`…`) and call that tool from then on.",
		],
		parameters: Type.Object({
			code: Type.Optional(Type.String({ description: "TypeScript: the body of an async function using the globals above. With budget, or with resume: the run's changed code." })),
			budget: Type.Optional(
				Type.Number({ exclusiveMinimum: 0, description: "Spending limit of this run in USD for llm() and delegate(); the run stops when it is used up. Small llm() calls cost fractions of a cent, a delegate run cents to dollars. With resume: a new limit for the whole run." }),
			),
			resume: Type.Optional(Type.String({ description: "The id of a run that was interrupted or stopped: continue it from its journal; calls it recorded are not repeated. With code, any ended run." })),
			inFlight: Type.Optional(
				Type.Union([Type.Literal("rerun"), Type.Literal("fail")], { description: "With resume: what shell and tools calls that were in flight do: run again, or throw InterruptedCallError. Needed when the resume names such calls." }),
			),
			show: Type.Optional(Type.String({ description: "The id of a run: show its page (calls, status, cost) in the thread now." })),
			status: Type.Optional(Type.String({ description: "The id of a run: its status, phase tree (done, running, expected; time and cost) and open delegate calls (title, threadId, taskId) as data." })),
			steer: Type.Optional(Type.String({ description: "The id of a running run: send `text` to its delegates whose run is in flight, as a steering message of their current turn." })),
			text: Type.Optional(Type.String({ description: "With steer: the message for the delegates." })),
			delegates: Type.Optional(Type.Array(Type.String(), { description: "With steer: only these delegates, each named by its title (or a part of it), thread id or label (`delegate 2`); default all running ones." })),
			stop: Type.Optional(Type.String({ description: "The id of a running run: stop it, keeping its journal for a resume." })),
			stopChildren: Type.Optional(Type.Boolean({ description: "With stop: cancel its agents too (default: they keep running and their results are recorded)." })),
		}),
		execute: async (callId, params, signal, onUpdate, ctx) => {
			const modes = [params.code !== undefined && params.resume === undefined, params.resume !== undefined, params.show !== undefined, params.stop !== undefined, params.status !== undefined, params.steer !== undefined].filter(Boolean).length;
			if (modes !== 1) throw new Error("pass exactly one of code (with budget), resume (optionally with code), show, status, steer (with text) or stop");
			if ((params.text !== undefined || params.delegates !== undefined) && params.steer === undefined) throw new Error("text and delegates go with steer");
			const answer = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
			if (params.status !== undefined) return answer(stringify(phaseStatus(runState(agentDir, params.status).entries, { processEnded: !lockHeld(agentDir, params.status) }), { lineWidth: 0 }).trimEnd());
			if (params.steer !== undefined) {
				if (!params.text?.trim()) throw new Error("steer needs text: the message for the delegates");
				return answer(await steerRun(agentDir, params.steer, { text: params.text, ...(params.delegates?.length ? { delegates: params.delegates } : {}) }));
			}
			if (params.show !== undefined) return answer(await showRun({ agentDir, id: params.show, toolNames: ctx.tools.map((t) => t.name), execute: executor(ctx), dashboardUrl }));
			if (params.stop !== undefined) return answer(await stopRun(agentDir, params.stop, params.stopChildren === true));
			if (params.resume !== undefined) {
				const request: ResumeRequest = {
					id: params.resume,
					...(params.inFlight ? { inFlight: params.inFlight } : {}),
					...(params.budget !== undefined ? { budget: params.budget } : {}),
					...(params.code !== undefined ? { code: params.code } : {}),
				};
				return run(callId, { kind: "resume", request }, signal, onUpdate, ctx);
			}
			if (params.budget === undefined) throw new Error("code needs a budget (USD)");
			return run(callId, { kind: "new", entry: { source: params.code!, filename: INLINE_FILE, inline: true }, budget: params.budget }, signal, onUpdate, ctx);
		},
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
			execute: (callId, params, signal, onUpdate, ctx) =>
				run(callId, { kind: "new", entry: { source: saved.source, filename: saved.file, inline: false, name: saved.name, input: params }, budget: saved.meta.budget }, signal, onUpdate, ctx),
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

	pi.on("session_start", (_event, ctx) => {
		setLatestApi(ctx.sessionManager.getSessionId(), pi);
		refresh(ctx);
		offerInterrupted(pi, ctx, agentDir);
	});
	// t3 has a run of the thread from a turn's start until Pi reports it settled, which a delegate start waiting for one holds.
	pi.on("agent_start", (_event, ctx) => turnOf(ctx.sessionManager.getSessionId()).started());
	pi.on("agent_settled", (_event, ctx) => turnOf(ctx.sessionManager.getSessionId()).settling());
	// The run a finished workflow's message wakes shows its end page (t3 takes a page only while a run is active).
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") flushEndRenders(ctx.sessionManager.getSessionId());
	});
	pi.on("before_agent_start", (event, ctx) => {
		event.systemPromptOptions.selectedTools = switched(ctx, event.systemPromptOptions.selectedTools);
	});
	// Registered after the switches above: a delegated child's tools replace them.
	const child = delegatedChild(pi, delegationsDir(agentDir));
	// t3's delegate_task with the harness's schema, system and tools, for the model as for delegate().
	extendDelegateTool(pi, agentDir, (ctx) => child.spec(ctx));
	// A workflow saved during a turn is callable from the next turn (not in a delegated child, whose tools are fixed).
	pi.on("turn_end", (_event, ctx) => {
		if (child.active(ctx)) return;
		const active = pi.getActiveTools();
		const next = switched(ctx, active);
		if (next.length !== active.length || next.some((name, i) => name !== active[i])) pi.setActiveTools(next);
	});
}
