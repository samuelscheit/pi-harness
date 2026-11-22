// The protocol between a delegating session (the parent) and its child (child.ts), whether the
// child runs as a t3 delegated task in a Pi process of its own or in-process. The parent is the
// harness's extension of t3's `delegate_task` (delegate-tool.ts), called by the model or by a
// workflow's `delegate()` (delegate.ts); both prepare the call with `prepareDelegation`.
//
// The parent writes a spec to `<agentDir>/delegations/<id>.json`: the system prompt and tool names
// (each optional: without, the child keeps its own), the result schema and the caller's session.
// The child's first message holds a marker line `harness-delegation: <id>`, then a readable summary
// of the spec and the brief, then the task; later messages start with
// `harness-delegation: <id> run <n>`. The child reads the spec back from its session's latest
// first-run marker (a forked child also carries its source's), so it survives a resume and a
// restart of the child's Pi.
//
// The child reports through `<id>.result.json` (its state): its session, the session's cost so far
// (written after every response, so the parent counts it against the budget while the child runs),
// and per run whether it is done, its final text, the submitted result or why it failed.
//
// The parent deletes both files when the agent is done; files older than a day (a parent that
// crashed) are removed when the harness starts.

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MARKER = "harness-delegation";
export const SUBMIT_TOOL = "submit_result";
const MAX_AGE_MS = 24 * 60 * 60_000;

export const delegationsDir = (agentDir: string) => join(agentDir, "delegations");

export interface DelegationSpec {
	id: string;
	/** Replaces the child's system prompt; without, it keeps its own. */
	system?: string;
	/** The child's tools; without, it keeps its own. */
	tools?: string[];
	/** JSON Schema of an object: the child returns its result with `submit_result`. */
	schema?: Record<string, unknown>;
	/** The session that delegated. */
	callerSessionId?: string;
	/** An explorer child (extensions/explore): its level below the agent that first called `explore`. */
	exploreDepth?: number;
	/** The template the child was forked from, and when it was built. */
	template?: { name: string; builtAt: string; note?: string };
}

/** A template resolved for a delegation (template/store.ts `templateUse`): the session file the child forks. */
export interface TemplateUse {
	name: string;
	builtAt: string;
	/** Its session file, under `<agentDir>/templates/`. */
	file: string;
	/** "provider/id": the child runs on it. */
	model: string;
	thinking?: string;
	/** A rebuild or a staleness warning, for the child's first message. */
	note?: string;
}

/** What the harness adds to t3's delegate_task, as JSON Schema properties. */
export const DELEGATE_EXTENSION = {
	schema: {
		type: "object",
		description: "JSON Schema of an object: the child must return its result with submit_result; it comes back in the task's result.",
	},
	system: { type: "string", description: "Replaces the child's system prompt." },
	tools: { type: "array", items: { type: "string" }, minItems: 1, description: "The child's tool names (instead of its default set)." },
	template: {
		type: "string",
		description:
			"Start the child from this session template: a prepared conversation (role, way of working, files read, examples) that every task of its kind forks, so it is cached once. Use one when a template exists for the kind of task. Runs on the template's model (`target.model` must match or be omitted); `system` and `tools` still apply. Not with `fork`.",
	},
} as const;

/** The keys of delegate_task's parameters that the harness, not t3, handles. */
export const HARNESS_KEYS = Object.keys(DELEGATE_EXTENSION) as (keyof typeof DELEGATE_EXTENSION)[];

/** Why delegate_task arguments are invalid for the harness's part, or undefined. */
export function delegateProblem(input: Record<string, unknown>): string | undefined {
	const { schema, system, tools, fork, forkThreadId, template } = input;
	if (schema !== undefined && (typeof schema !== "object" || schema === null || (schema as { type?: unknown }).type !== "object")) {
		return 'schema must be a JSON Schema of an object ({ type: "object", properties: … })';
	}
	if (system !== undefined && (typeof system !== "string" || !system.trim())) return "system must be a non-empty string";
	if (tools !== undefined && (!Array.isArray(tools) || tools.length === 0 || !tools.every((t) => typeof t === "string" && t.trim()))) return "tools must be a non-empty array of tool names";
	if (template !== undefined && (typeof template !== "string" || !template.trim())) return "template must be a template name";
	if (template !== undefined && (fork !== undefined || forkThreadId !== undefined)) return "a template is where the child starts, a fork starts from a thread's conversation: use one of template and fork";
	if (fork !== undefined && typeof fork !== "boolean") return "fork must be a boolean";
	if (forkThreadId !== undefined && fork !== true) return "forkThreadId needs fork: true";
	if (fork === true) {
		const clash = ["target", "system", "tools"].filter((key) => input[key] !== undefined);
		if (clash.length) return `fork takes the source thread's provider, model, options, system prompt and tools: drop ${clash.join(", ")}`;
	}
	return undefined;
}

/**
 * delegate_task arguments as t3 takes them: the harness's keys become a spec (written to `dir`) and
 * the task gets the marker, summary and brief. Without schema, system or tools, and without fork,
 * the arguments stay t3's alone (no spec). A fork always gets a spec: its own marker must follow the
 * source's. `always` makes a spec in any case (a workflow reads every child's state); `inherit` is
 * the source's spec of a fork, whose system prompt and tools the fork keeps. `template` is the
 * resolved `template` argument: t3 forks the child from its session file (`forkSessionFile`) on its
 * model. Throws when the arguments are invalid.
 */
export function prepareDelegation(
	input: Record<string, unknown>,
	dir: string,
	options: { id?: string; callerSessionId?: string; always?: boolean; inherit?: DelegationSpec; template?: TemplateUse } = {},
): { input: Record<string, unknown>; spec?: DelegationSpec } {
	const problem = delegateProblem(input);
	if (problem) throw new Error(`delegate_task: ${problem}`);
	const own = HARNESS_KEYS.filter((key) => input[key] !== undefined);
	// Prepared already (a workflow's delegate() prepares its calls itself).
	const prepared = typeof input.task === "string" ? parseMarker(input.task) : undefined;
	if (!own.length && ((input.fork !== true && !options.always) || (prepared?.run === 1 && readSpec(dir, prepared.id)))) return { input };
	const template = input.template === undefined ? undefined : options.template;
	if (input.template !== undefined && template?.name !== input.template) throw new Error(`delegate_task: template ${String(input.template)} was not resolved`);
	const target = (input.target ?? {}) as { model?: unknown; options?: unknown };
	if (template && target.model !== undefined && target.model !== template.model) {
		throw new Error(`delegate_task: template ${template.name} runs on ${template.model} (its turns belong to that model): omit target.model or pass ${template.model}`);
	}
	const { system, tools, schema } = options.inherit ?? {};
	const spec: DelegationSpec = {
		id: options.id ?? randomUUID(),
		...(system !== undefined ? { system } : {}),
		...(tools !== undefined ? { tools } : {}),
		...(schema !== undefined ? { schema } : {}),
		...(input.system !== undefined ? { system: (input.system as string).trim() } : {}),
		...(input.tools !== undefined ? { tools: input.tools as string[] } : {}),
		...(input.schema !== undefined ? { schema: input.schema as Record<string, unknown> } : {}),
		...(options.callerSessionId ? { callerSessionId: options.callerSessionId } : {}),
		...(template ? { template: { name: template.name, builtAt: template.builtAt, ...(template.note ? { note: template.note } : {}) } } : {}),
	};
	writeSpec(dir, spec);
	const rest = Object.fromEntries(Object.entries(input).filter(([key]) => !(HARNESS_KEYS as string[]).includes(key)));
	return { input: { ...rest, ...(template ? templateArgs(target, template) : {}), task: delegationMessage(spec, 1, String(input.task ?? "")) }, spec };
}

/** What t3 gets for a template: its session file to fork, and `target` on its model (and thinking, unless `target.options` says). */
export function templateArgs(target: { options?: unknown }, template: TemplateUse): { forkSessionFile: string; target: Record<string, unknown> } {
	return {
		forkSessionFile: template.file,
		target: { ...target, model: template.model, ...(target.options === undefined && template.thinking ? { options: { thinking: template.thinking } } : {}) },
	};
}

export interface DelegationState {
	sessionId: string;
	/** The child session's cost in USD so far, over all its runs. */
	cost: number;
	/** The run the rest describes: 1 for the first message, n for `… run <n>`. */
	run: number;
	done: boolean;
	/**
	 * The run is not done: its turn ended while background work it waits for runs (the labels), whose
	 * end wakes the child into another turn of the same run. In t3 that turn is a new t3 run.
	 */
	waiting?: string[];
	/** The child's Pi process: while it lives, a waiting run can still end. */
	pid?: number;
	text?: string;
	/** Whether `submit_result` was called successfully in this run, and its arguments. */
	submitted?: boolean;
	result?: unknown;
	/** Why the run failed. */
	error?: string;
	/** The files the run's own tool calls changed (own-writes.ts): absolute, canonical, sorted. */
	wrote?: string[];
	/** Compactions the session went through (succeeded or failed), and why the latest failed. */
	compactions?: number;
	compactionError?: string;
}

export const specPath = (dir: string, id: string) => join(dir, `${id}.json`);
export const statePath = (dir: string, id: string) => join(dir, `${id}.result.json`);

/** Write a JSON file whole: a reader never sees it half-written. */
function writeJson(path: string, value: unknown): void {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(value));
	renameSync(temporary, path);
}

/** A JSON object file; undefined when it is missing, unreadable or not an object. */
function readObject(path: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function writeSpec(dir: string, spec: DelegationSpec): void {
	mkdirSync(dir, { recursive: true });
	writeJson(specPath(dir, spec.id), spec);
}

/** Mark a spec as in use, so the sweep of old files spares a delegation that runs for long. */
export function touchSpec(dir: string, id: string): void {
	const now = new Date();
	try {
		utimesSync(specPath(dir, id), now, now);
	} catch {
		// Gone: the agent was disposed.
	}
}

/** The spec of a delegation; undefined when its file is gone or not a spec. */
export function readSpec(dir: string, id: string): DelegationSpec | undefined {
	const spec = readObject(specPath(dir, id)) as DelegationSpec | undefined;
	if (!spec || spec.id !== id || (spec.system !== undefined && typeof spec.system !== "string") || (spec.tools !== undefined && !Array.isArray(spec.tools))) return undefined;
	return spec;
}

export function writeState(dir: string, id: string, state: DelegationState): void {
	mkdirSync(dir, { recursive: true });
	writeJson(statePath(dir, id), state);
}

export function readState(dir: string, id: string): DelegationState | undefined {
	const state = readObject(statePath(dir, id)) as DelegationState | undefined;
	return state && typeof state.run === "number" ? state : undefined;
}

export function removeDelegation(dir: string, id: string): void {
	rmSync(specPath(dir, id), { force: true });
	rmSync(statePath(dir, id), { force: true });
}

/** Remove delegation files older than a day; returns how many. */
export function sweepDelegations(dir: string, now = Date.now(), maxAgeMs = MAX_AGE_MS): number {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		const path = join(dir, name);
		try {
			if (now - statSync(path).mtimeMs <= maxAgeMs) continue;
			rmSync(path, { force: true });
			removed++;
		} catch {
			// Removed meanwhile.
		}
	}
	return removed;
}

const chars = (n: number) => (n < 1000 ? `${n} chars` : `${(n / 1000).toFixed(1)}k chars`);

/** One readable line about a spec, for the child's first message (and the user reading its thread). */
export function specSummary(spec: DelegationSpec): string {
	const parts = [
		...(spec.system !== undefined ? [`system prompt (${chars(spec.system.length)})`] : []),
		...(spec.tools ? [`tools: ${spec.tools.join(", ")}`] : []),
		...(spec.schema ? [`returns its result with ${SUBMIT_TOOL} (a JSON Schema)`] : []),
	];
	const from = spec.template ? ` from template ${spec.template.name} (built ${spec.template.builtAt}${spec.template.note ? `; ${spec.template.note}` : ""})` : "";
	return `Delegated by the harness${from}${parts.length ? `: ${parts.join("; ")}` : ""}.`;
}

/** What every delegated child is told on its first run. */
export const BRIEF = "When the plan no longer fits the task, ask with ask_user and options (continue / replan / stop) rather than guess.";

/** The message of a run: the marker line, on the first run the summary and the brief, then the message. */
export function delegationMessage(spec: DelegationSpec, run: number, message: string): string {
	if (run > 1) return `${MARKER}: ${spec.id} run ${run}\n\n${message}`;
	return `${MARKER}: ${spec.id}\n${specSummary(spec)} ${BRIEF}\n\n${message}`;
}

/** The marker of a message: the delegation id and the run (1 without `run <n>`). Found on any line, since t3 puts a preamble before the task. */
export function parseMarker(text: string): { id: string; run: number } | undefined {
	const match = new RegExp(`^${MARKER}: ([A-Za-z0-9][A-Za-z0-9-]*)(?: run ([1-9]\\d*))?[ \\t]*$`, "m").exec(text);
	return match ? { id: match[1]!, run: match[2] ? Number(match[2]) : 1 } : undefined;
}
