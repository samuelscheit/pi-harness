// The protocol between agent() (the parent, agent.ts) and its child agent (child.ts), whether the
// child runs as a t3 delegated task in a Pi process of its own or in-process.
//
// agent() writes a spec to `<agentDir>/delegations/<id>.json`: the system prompt, the tool names,
// the result schema, the files it should change (information only) and the caller's session. The
// child's first message starts with a marker line `harness-delegation: <id>`, then a readable
// summary of the spec, then the script's message; later messages start with
// `harness-delegation: <id> run <n>`. The child reads the spec back from its session's first user
// message, so it survives a resume and a restart of the child's Pi.
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
	system: string;
	tools: string[];
	/** JSON Schema of an object: the child returns its result with `submit_result`. */
	schema?: Record<string, unknown>;
	/** The files the child should change; told to it, not enforced. */
	files?: string[];
	/** The session that called agent(). */
	callerSessionId?: string;
}

export interface DelegationState {
	sessionId: string;
	/** The child session's cost in USD so far, over all its runs. */
	cost: number;
	/** The run the rest describes: 1 for the first message, n for `… run <n>`. */
	run: number;
	done: boolean;
	text?: string;
	/** Whether `submit_result` was called successfully in this run, and its arguments. */
	submitted?: boolean;
	result?: unknown;
	/** Why the run failed. */
	error?: string;
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
	if (!spec || spec.id !== id || typeof spec.system !== "string" || !Array.isArray(spec.tools)) return undefined;
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
	const parts = [`system prompt (${chars(spec.system.length)})`, `tools: ${spec.tools.join(", ")}`];
	if (spec.schema) parts.push(`returns its result with ${SUBMIT_TOOL} (a JSON Schema)`);
	return `Started by a workflow script's agent(): ${parts.join("; ")}.`;
}

/** The message of a run: the marker line, on the first run the summary and files, then the script's message. */
export function delegationMessage(spec: DelegationSpec, run: number, message: string): string {
	if (run > 1) return `${MARKER}: ${spec.id} run ${run}\n\n${message}`;
	const files = spec.files ? `\nChange only these files: ${spec.files.join(", ")}.` : "";
	return `${MARKER}: ${spec.id}\n${specSummary(spec)}${files}\n\n${message}`;
}

/** The marker of a message: the delegation id and the run (1 without `run <n>`). Found on any line, since t3 puts a preamble before the task. */
export function parseMarker(text: string): { id: string; run: number } | undefined {
	const match = new RegExp(`^${MARKER}: ([A-Za-z0-9][A-Za-z0-9-]*)(?: run ([1-9]\\d*))?[ \\t]*$`, "m").exec(text);
	return match ? { id: match[1]!, run: match[2] ? Number(match[2]) : 1 } : undefined;
}
