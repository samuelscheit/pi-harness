// Dreaming, step 1: the messages the user typed into Pi sessions since the last dream.
//
// Source: the metrics index (extensions/metrics), refreshed from the session files before a run.
// Only Pi sessions the user drove count: delegated sessions (a parent agent's delegate_task wrote
// their prompt) and child sessions (a tool's agent, a fork) are left out, and so is anything a
// tool, t3 or the harness wrote into the user's turn (`isHuman`). Messages the user typed are the
// only input, which keeps tool output and fetched web content from writing rules (memory poisoning).

import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { repositoryRoot } from "../../extensions/lib/repository.ts";
import { isHuman } from "../lib/labels.ts";

export interface Observation {
	/** `<session id> <entry id>`, unique. */
	key: string;
	sessionId: string;
	entryId: string;
	ts: number;
	cwd: string;
	/** The repository the session worked in (the closest directory with `.git`, else `cwd`). */
	repo: string;
	text: string;
	/** The agent's last text before the message. */
	before?: string;
}

/** Message kinds after the session's first prompt (the indexer's user_messages.kind). */
const KINDS = ["follow-up", "steer", "after error", "after interrupt"];

interface SessionEntry {
	id?: string;
	step_index?: number;
	type?: string;
	content?: unknown;
	message?: { role?: string; content?: unknown };
}

/** The text of an assistant message's content (text blocks only, no thinking or tool calls). */
const assistantText = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.flatMap((part: { type?: string; text?: string }) => (part?.type === "text" && part.text ? [part.text] : [])).join("\n")
			: "";

/** For each entry id, the last assistant text before it in the session file (by file order). */
export function precedingAgentText(sessionFile: string): Map<string, string> {
	const before = new Map<string, string>();
	let last = "";
	let lines: string[];
	try {
		lines = readFileSync(sessionFile, "utf8").split("\n");
	} catch {
		return before;
	}
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i]!;
		if (!line.trim()) continue;
		let entry: SessionEntry;
		try {
			entry = JSON.parse(line) as SessionEntry;
		} catch {
			continue;
		}
		if (entry.id) before.set(entry.id, last);
		else if (typeof entry.step_index === "number") before.set(`step-${entry.step_index}`, last);
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const text = assistantText(entry.message.content).trim();
			if (text) last = text;
		} else if (entry.type === "PLANNER_RESPONSE" && typeof entry.content === "string") {
			const text = entry.content.trim();
			if (text) last = text;
		}
	}
	return before;
}

/** Every repository a Pi or Antigravity session ever worked in, distinct and sorted. */
export function repositories(db: DatabaseSync): string[] {
	const rows = db.prepare("SELECT DISTINCT cwd FROM sessions WHERE source IN ('pi', 'agy') AND cwd != ''").all() as { cwd: string }[];
	return [...new Set(rows.map((row) => repositoryRoot(row.cwd)))].sort();
}

/** The user's messages after `since` (ms), oldest first. */
export function collect(db: DatabaseSync, since: number): Observation[] {
	const rows = db
		.prepare(
			`SELECT u.session_id, u.entry_id, u.ts, u.text, s.cwd, s.file FROM user_messages u JOIN sessions s ON s.id = u.session_id
			WHERE s.source IN ('pi', 'agy') AND s.prompt_digest IS NULL AND s.parent_session IS NULL AND u.ts > ? AND u.kind IN (${KINDS.map(() => "?").join(", ")})
			ORDER BY u.ts`,
		)
		.all(since, ...KINDS) as { session_id: string; entry_id: string; ts: number; text: string; cwd: string; file: string }[];
	const contexts = new Map<string, Map<string, string>>();
	return rows
		.filter((row) => isHuman(row.text))
		.map((row) => {
			const context = contexts.get(row.file) ?? contexts.set(row.file, precedingAgentText(row.file)).get(row.file)!;
			const before = context.get(row.entry_id);
			return {
				key: `${row.session_id} ${row.entry_id}`,
				sessionId: row.session_id,
				entryId: row.entry_id,
				ts: row.ts,
				cwd: row.cwd,
				repo: repositoryRoot(row.cwd),
				text: row.text,
				...(before ? { before } : {}),
			};
		});
}
