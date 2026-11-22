// What an agent's tool calls worked on, and which subagents it started or resumed: the inputs for
// measuring rediscovery (a subagent paying again for context its parent already had), stale
// context (tool results carried along but never used again) and resume-versus-new decisions.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { type Effect, shellEffect } from "./shell.ts";

export type { Effect } from "./shell.ts";

const PATH_KEYS = ["path", "file_path", "filePath", "notebook_path", "file", "directory", "cwd", "TargetFile", "AbsolutePath", "DirectoryPath", "SearchPath", "Cwd"];
/** Tools whose path arguments are files they write (Pi's, Claude Code's, and Antigravity's built-ins). */
const WRITE_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "replace_file_content", "multi_replace_file_content", "write_to_file", "edit_blocks"]);

const expand = (path: string, cwd: string) =>
	resolve(cwd, path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path);

/**
 * What a tool call worked on: the files and directories it touched (absolute paths), the ones it
 * wrote, and whether it changed files at all. Path arguments are exact; shell commands are
 * analysed by `shellEffect` (path-like words, redirections, known writers, inline scripts), which
 * cannot tell an argument from a pattern that looks like a path.
 */
export function toolEffect(tool: string, args: unknown, cwd: string): Effect {
	const none: Effect = { files: [], writes: [], mutates: false };
	if (!args || typeof args !== "object") return none;
	const record = args as Record<string, unknown>;
	const name = tool.toLowerCase();
	if (name === "call_mcp_tool" && typeof record.ToolName === "string") {
		return toolEffect(record.ToolName, record.Arguments, cwd);
	}
	if (name === "bash" || name === "run_command") {
		const cmd = typeof record.command === "string" ? record.command : typeof record.CommandLine === "string" ? record.CommandLine : undefined;
		const effectiveCwd = typeof record.Cwd === "string" && record.Cwd.trim() ? record.Cwd.trim() : cwd;
		return cmd ? shellEffect(cmd, effectiveCwd) : none;
	}
	const files = PATH_KEYS.map((key) => record[key]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => expand(v.trim(), cwd));
	if (WRITE_TOOLS.has(name)) return { files, writes: files, mutates: true };
	// pi-lens: rewrites the given paths (or the project) only when applied, otherwise a preview.
	if (name === "ast_grep_replace" && record.apply === true) {
		const paths = Array.isArray(record.paths) ? record.paths.filter((p): p is string => typeof p === "string").map((p) => expand(p, cwd)) : [];
		return { files: [...files, ...paths], writes: paths, mutates: true };
	}
	return { files, writes: [], mutates: false };
}

/** Both effects together. */
export const mergeEffects = (a: Effect, b: Effect): Effect => ({
	files: [...new Set([...a.files, ...b.files])],
	writes: [...new Set([...a.writes, ...b.writes])],
	mutates: a.mutates || b.mutates,
});

/** What a tool's result reports about its own work, beyond its arguments. */
export interface ReportedWork {
	effect: Effect;
	/** Whether the tool reached its goal (details.ok). */
	ok?: boolean;
	/** Sessions the tool ran as its children (details.childSessions). */
	childSessions: string[];
}

/**
 * The work a tool result reports: the effects of the tools it called (Pi's `nestedCalls`, as
 * codemode scripts and tools built on other tools make them) and, from its details, the files it
 * changed (`changedFiles`, absolute or relative to cwd), whether it reached its goal (`ok`) and
 * the sessions it ran as its children (`childSessions`).
 */
export function reportedWork(nested: readonly { name: string; arguments?: unknown }[] | undefined, details: unknown, cwd: string): ReportedWork {
	let effect: Effect = { files: [], writes: [], mutates: false };
	for (const call of nested ?? []) effect = mergeEffects(effect, toolEffect(call.name, call.arguments, cwd));
	const record = (details && typeof details === "object" ? details : {}) as Record<string, unknown>;
	const changed = Array.isArray(record.changedFiles) ? record.changedFiles.filter((f): f is string => typeof f === "string" && f !== "").map((f) => expand(f, cwd)) : [];
	if (changed.length) effect = mergeEffects(effect, { files: changed, writes: changed, mutates: true });
	return {
		effect,
		...(typeof record.ok === "boolean" ? { ok: record.ok } : {}),
		childSessions: Array.isArray(record.childSessions) ? record.childSessions.filter((id): id is string => typeof id === "string" && id !== "") : [],
	};
}

/** Words in an agent's text that can name a file: runs of file-name characters, trailing dots dropped. */
export function namedWords(text: string): string[] {
	return text.split(/[^\w.-]+/).map((word) => word.replace(/\.+$/, "")).filter((word) => word.length >= 3);
}

export interface Touch {
	ts: number;
	files: string[];
}

/**
 * Whether a tool result was referenced again: a later call touched one of its files, or the agent
 * later wrote one's file name. Undefined for results without files. Built in one pass over the
 * session from each file's last touch and each word's last mention.
 */
export function referenceIndex(calls: Touch[], texts: { ts: number; text: string }[]): (ts: number, files: string[]) => boolean | undefined {
	const lastTouched = new Map<string, number>();
	for (const call of calls) for (const file of call.files) lastTouched.set(file, Math.max(lastTouched.get(file) ?? 0, call.ts));
	const lastNamed = new Map<string, number>();
	for (const { ts, text } of texts) for (const word of namedWords(text)) lastNamed.set(word, Math.max(lastNamed.get(word) ?? 0, ts));
	return (ts, files) =>
		files.length === 0 ? undefined : files.some((file) => (lastTouched.get(file) ?? 0) > ts || (lastNamed.get(basename(file)) ?? 0) > ts);
}

export const taskDigest = (task: string): string => createHash("sha256").update(task.trim()).digest("hex").slice(0, 16);

/**
 * The task digest of a session started by `delegate_task`: t3 sends a one-line role preamble, a
 * blank line, then the parent's `task` verbatim. Undefined for a first message without that shape.
 */
export function delegatedTaskDigest(firstUserText: string): string | undefined {
	const split = firstUserText.indexOf("\n\n");
	if (split < 0 || firstUserText.slice(0, split).includes("\n")) return undefined;
	return taskDigest(firstUserText.slice(split + 2));
}

export interface Delegation {
	kind: "delegate" | "send";
	threadId?: string;
	taskDigest?: string;
	title?: string;
}

const isTool = (name: string, tool: string) => name === tool || name.endsWith(`__${tool}`);

/** A subagent start (`delegate_task`) or a message to an existing thread (`t3_thread_send`), from a tool call and its result. */
export function delegation(tool: string, args: unknown, resultText: string): Delegation | undefined {
	const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	if (tool === "call_mcp_tool" && typeof record.ToolName === "string") {
		return delegation(record.ToolName, record.Arguments, resultText);
	}
	const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
	if (isTool(tool, "delegate_task")) {
		const task = str(record.task);
		if (!task) return undefined;
		let threadId: string | undefined;
		try {
			threadId = str((JSON.parse(resultText) as Record<string, unknown>).childThreadId);
		} catch {
			// An error result: the subagent never started.
			return undefined;
		}
		return { kind: "delegate", taskDigest: taskDigest(task), threadId, title: str(record.title) };
	}
	if (isTool(tool, "t3_thread_send")) {
		return { kind: "send", threadId: str(record.threadId) ?? str(record.thread_id) };
	}
	return undefined;
}
