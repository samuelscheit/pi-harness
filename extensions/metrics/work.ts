// What an agent's tool calls worked on, and which subagents it started or resumed: the inputs for
// measuring rediscovery (a subagent paying again for context its parent already had), stale
// context (tool results carried along but never used again) and resume-versus-new decisions.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

const PATH_KEYS = ["path", "file_path", "filePath", "file", "directory", "cwd"];
// A path-like token in a shell command: has a slash (`src/a`, `docs/`) or a file extension (`a.ts`).
const COMMAND_PATH = /(?:^|[\s"'=(])((?:~|\.{1,2}|[\w@.-]+)?(?:\/[\w@.+-]+)+\/?|[\w@.+-]+\/|[\w@+-]+(?:\.[\w-]+)*\.[A-Za-z][\w]{0,5})(?=$|[\s"'),;:|&>])/g;

const expand = (path: string, cwd: string) =>
	resolve(cwd, path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path);

/** Directories a shell command changes into with `cd`, in order, so later relative paths resolve correctly. */
function commandCwd(command: string, cwd: string): string {
	let current = cwd;
	for (const match of command.matchAll(/(?:^|&&|;|\|\|)\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
		current = expand(match[1]!.replace(/^["']|["']$/g, ""), current);
	}
	return current;
}

/**
 * A command without the parts that are data rather than arguments: heredoc bodies and quoted
 * strings with whitespace (inline scripts, SQL, messages). Their words would look like paths.
 */
function shellWords(command: string): string {
	return command
		.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g, " ")
		.replace(/"(?:[^"\\]|\\.)*\s(?:[^"\\]|\\.)*"|'[^']*\s[^']*'/g, " ");
}

/**
 * The files and directories a tool call touched, as absolute paths. Path arguments are exact;
 * for shell commands it is the path-like words, resolved after any leading `cd`: an
 * approximation that finds `sed -n 1,80p src/a.ts` and `rg foo extensions/` but cannot tell an
 * argument from a pattern that looks like a path.
 */
export function toolFiles(tool: string, args: unknown, cwd: string): string[] {
	if (!args || typeof args !== "object") return [];
	const record = args as Record<string, unknown>;
	const files = new Set<string>();
	for (const key of PATH_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) files.add(expand(value.trim(), cwd));
	}
	if (tool === "bash" && typeof record.command === "string") {
		const command = record.command;
		const base = commandCwd(command, cwd);
		const withoutCd = shellWords(command).replace(/(?:^|&&|;|\|\|)\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g, " ");
		for (const match of withoutCd.matchAll(COMMAND_PATH)) {
			const word = match[1]!.replace(/\/$/, "");
			// URLs, flags and version-like numbers are not files.
			if (/^[\d.]+$/.test(word) || word.includes("://") || word.startsWith("-")) continue;
			files.add(isAbsolute(word) || word.startsWith("~") ? expand(word, base) : resolve(base, word));
		}
	}
	return [...files];
}

/** Whether `text` names `file` (by its file name, which is how agents refer to files they read). */
export function mentions(text: string, file: string): boolean {
	const name = basename(file);
	if (name.length < 3) return false;
	let at = text.indexOf(name);
	while (at >= 0) {
		const before = text[at - 1];
		const after = text[at + name.length];
		if ((!before || !/[\w.-]/.test(before)) && (!after || !/[\w-]/.test(after))) return true;
		at = text.indexOf(name, at + 1);
	}
	return false;
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
