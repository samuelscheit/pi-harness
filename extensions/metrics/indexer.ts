// Index Pi's session files into the metrics store.
//
// Every request is re-derived from the session: Pi persists the leading system message (prompt
// sections and tool definitions), every later prompt or tool change, all messages and each
// assistant message's usage and cost. `buildSessionContext` rebuilds the exact context of a
// request (compactions, branches and context edits included), which is then split and priced.
// A session file is re-indexed as a whole whenever it changed.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	buildSessionContext,
	type FileEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionHeader,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { attribute, cacheEvent, type RequestState, requestState, type Usage } from "./attribution.ts";
import { recordedArms } from "../lib/experiments.ts";
import { parsePrompt, summarizeToolInput, versionId } from "./blocks.ts";
import { deleteSession, transaction } from "./store.ts";
import { delegatedTaskDigest, delegation, referenceIndex, toolEffect } from "./work.ts";

const USER_TEXT_LIMIT = 2000;
// A pause longer than the short (5 min) cache lifetime: the cache survives it only if kept warm or long-lived.
export const PAUSE_MS = 5 * 60_000;
// A resumed request that read at least this share of the previous prompt from cache found it warm.
const WARM_RESUME_FRACTION = 0.5;

interface TurnPoint {
	ts: number;
	promptTokens: number;
	cacheRead: number;
	/** What it paid for prompt it did not read from cache: cache writes and uncached input. */
	uncachedCost: number;
}

export interface IdlePause {
	start: number;
	end?: number;
	minutes: number;
	warms: number;
	warmCost: number;
	outcome: "warm" | "compacted" | "cold" | "open";
	promptTokens: number;
	resumeCost: number;
}

/**
 * Pauses longer than {@link PAUSE_MS} between turns, or after the last turn until `lastTs`, with
 * the warm refreshes inside them and how the session resumed.
 */
export function idlePauses(
	turns: TurnPoint[],
	warms: { ts: number; cost: number }[],
	coldCompactions: number[],
	lastTs: number,
): IdlePause[] {
	const pauses: IdlePause[] = [];
	turns.forEach((turn, index) => {
		const next = turns[index + 1];
		const end = next?.ts ?? lastTs;
		if (end - turn.ts <= PAUSE_MS) return;
		const inside = warms.filter((w) => w.ts > turn.ts && w.ts < end);
		const outcome = !next
			? "open"
			: coldCompactions.some((ts) => ts > turn.ts && ts < next.ts)
				? "compacted"
				: next.cacheRead >= turn.promptTokens * WARM_RESUME_FRACTION
					? "warm"
					: "cold";
		pauses.push({
			start: turn.ts,
			end: next?.ts,
			minutes: (end - turn.ts) / 60_000,
			warms: inside.length,
			warmCost: inside.reduce((sum, w) => sum + w.cost, 0),
			outcome,
			promptTokens: turn.promptTokens,
			resumeCost: next?.uncachedCost ?? 0,
		});
	});
	return pauses;
}

export interface IndexResult {
	files: number;
	indexed: number;
	failed: { path: string; error: string }[];
}

function sessionFiles(dir: string): string[] {
	try {
		return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/** Index every changed session file below `sessionsDir`. */
export function indexSessions(db: DatabaseSync, sessionsDir: string): IndexResult {
	const files = sessionFiles(sessionsDir);
	const known = db.prepare("SELECT session_id, size, mtime_ms FROM files WHERE path = ?");
	const result: IndexResult = { files: files.length, indexed: 0, failed: [] };
	const present = new Set(files);
	// Pi's files only: imported Claude Code transcripts are pruned by their own indexer.
	const indexed = db.prepare("SELECT f.path, f.session_id FROM files f JOIN sessions s ON s.id = f.session_id WHERE s.source = 'pi'");
	for (const { path, session_id } of indexed.all() as { path: string; session_id: string }[]) {
		if (present.has(path)) continue;
		transaction(db, () => {
			deleteSession(db, session_id);
			db.prepare("DELETE FROM files WHERE path = ?").run(path);
		});
	}
	for (const path of files) {
		const stat = statSync(path);
		const row = known.get(path) as { size: number; mtime_ms: number } | undefined;
		if (row && row.size === stat.size && row.mtime_ms === stat.mtimeMs) continue;
		try {
			indexFile(db, path, readFileSync(path, "utf8"), stat.size, stat.mtimeMs);
			result.indexed += 1;
		} catch (error) {
			result.failed.push({ path, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return result;
}

const time = (entry: { timestamp: string }) => Date.parse(entry.timestamp);

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((p: { type: string; text?: string }) => (p.type === "text" ? (p.text ?? "") : "")).join("");
}

/** Where a user message fell: the first prompt, a follow-up, a steer during a run, or after an interrupt. */
function userMessageKind(entry: SessionEntry, byId: Map<string, SessionEntry>): string {
	for (let id = entry.parentId; id; ) {
		const parent = byId.get(id);
		if (!parent) break;
		if (parent.type === "message") {
			const message = parent.message;
			if (message.role === "toolResult") return "steer";
			if (message.role === "assistant") {
				if (message.stopReason === "aborted") return "after interrupt";
				if (message.stopReason === "error") return "after error";
				return message.stopReason === "toolUse" ? "steer" : "follow-up";
			}
		}
		id = parent.parentId;
	}
	return "first";
}

export function indexFile(db: DatabaseSync, path: string, content: string, size: number, mtimeMs: number): void {
	const fileEntries: FileEntry[] = parseSessionEntries(content);
	migrateSessionEntries(fileEntries);
	const header = fileEntries.find((e): e is SessionHeader => e.type === "session");
	if (!header) throw new Error("no session header");
	const entries = fileEntries.filter((e): e is SessionEntry => e.type !== "session");
	const byId = new Map(entries.map((e) => [e.id, e]));

	const insertRequest = db.prepare(
		`INSERT INTO requests (session_id, entry_id, ts, kind, provider, model, thinking, stop_reason, version, input, output,
		cache_read, cache_write, prompt_tokens, cost, cost_input, cost_output, cost_read, cost_write, message_count, trigger,
		trigger_tokens, cache_event, cache_lost, cache_waste, input_rate, read_rate, write_rate, long_retention, tool_calls)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const costSplit = (usage: Usage) => [usage.cost.total, usage.cost.input, usage.cost.output, usage.cost.cacheRead, usage.cost.cacheWrite];
	const insertCost = db.prepare(
		`INSERT INTO request_costs (session_id, entry_id, category, blocks, tokens, new_tokens, read_cost, write_cost, uncached_cost)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insertVersion = db.prepare("INSERT OR IGNORE INTO versions (id, sections, tools, first_seen) VALUES (?, ?, ?, ?)");
	const insertBlob = db.prepare("INSERT OR IGNORE INTO blobs (hash, kind, name, text) VALUES (?, ?, ?, ?)");
	const insertTool = db.prepare(
		`INSERT INTO tool_results (session_id, call_id, ts, tool, summary, is_error, duration_ms, tokens, requests_in_context, lifetime_cost, version, referenced_later, mutates)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insertFile = db.prepare("INSERT OR IGNORE INTO tool_files (session_id, call_id, ts, file, write) VALUES (?, ?, ?, ?, ?)");
	const insertDelegation = db.prepare(
		"INSERT INTO delegations (session_id, call_id, ts, kind, thread_id, task_digest, title) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const insertUser = db.prepare("INSERT INTO user_messages (session_id, entry_id, ts, kind, text) VALUES (?, ?, ?, ?, ?)");
	const insertCompaction = db.prepare(
		"INSERT INTO compactions (session_id, entry_id, ts, reason, tokens_before, cost) VALUES (?, ?, ?, ?, ?, ?)",
	);
	const insertPause = db.prepare(
		`INSERT INTO idle_pauses (session_id, start_ts, end_ts, minutes, warms, warm_cost, outcome, prompt_tokens, resume_cost)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const sessionId = header.id;
	const sideCall = (entryId: string, ts: number, kind: string, provider: string, model: string, usage: Usage) =>
		insertRequest.run(sessionId, entryId, ts, kind, provider, model, null, null, null, usage.input, usage.output, usage.cacheRead,
			usage.cacheWrite, usage.input + usage.cacheRead + usage.cacheWrite, ...costSplit(usage), 0, null, 0, null, 0, 0, null, null, null, 0, null);

	transaction(db, () => {
		deleteSession(db, sessionId);
		let previous: RequestState | undefined;
		let cost = 0;
		let requests = 0;
		let aborted = 0;
		let errors = 0;
		let compactions = 0;
		let userMessages = 0;
		let name: string | undefined;
		// Per tool call: the requests that carried its result, the cost they paid for it, and the version that made the call.
		const lifetime = new Map<string, { requests: number; tokens: number; cost: number; version?: string }>();
		const toolCalls = new Map<string, { name: string; args: unknown; summary: string; ts: number; files: string[]; mutates: boolean }>();
		// What the agent wrote after each point (text, thinking, tool arguments), to tell whether a result was used again.
		const agentTexts: { ts: number; text: string }[] = [];
		let promptDigest: string | undefined;
		const turns: TurnPoint[] = [];
		const warms: { ts: number; cost: number }[] = [];
		const coldCompactions: number[] = [];

		for (const entry of entries) {
			const ts = time(entry);
			if (entry.type === "session_info") name = entry.name ?? name;
			else if (entry.type === "compaction") {
				compactions += 1;
				insertCompaction.run(sessionId, entry.id, ts, entry.reason ?? null, entry.tokensBefore, entry.usage?.cost.total ?? 0);
				if (entry.reason === "cold") coldCompactions.push(ts);
				if (entry.usage) {
					sideCall(entry.id, ts, "compaction", entry.provider ?? "", entry.model ?? "", entry.usage);
					cost += entry.usage.cost.total;
				}
			} else if (entry.type === "usage") {
				if (entry.kind === "cache_warm") warms.push({ ts, cost: entry.usage.cost.total });
				sideCall(entry.id, ts, entry.kind, entry.provider, entry.model, entry.usage);
				cost += entry.usage.cost.total;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				// Model work a tool did itself, such as web_search's own request.
				sideCall(entry.id, ts, `tool: ${entry.message.toolName}`, "", "", entry.message.usage as Usage);
				cost += entry.message.usage.cost.total;
			} else if (entry.type === "message" && entry.message.role === "user") {
				if (userMessages === 0) promptDigest = delegatedTaskDigest(messageText(entry.message.content));
				userMessages += 1;
				insertUser.run(sessionId, entry.id, ts, userMessageKind(entry, byId), messageText(entry.message.content).slice(0, USER_TEXT_LIMIT));
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				const message = entry.message;
				const usage = message.usage as Usage;
				const prompt = parsePrompt(buildSessionContext(entries, entry.parentId, byId).messages);
				const attribution = attribute(prompt, usage, previous?.rates);
				const state = requestState(prompt, attribution, usage, ts, message.model, message.thinkingLevel);
				// A request that failed before the provider answered has no usage: it neither read nor
				// wrote the cache, so it is no predecessor for rebuilds and no resume after a pause.
				const answered = attribution.promptTokens > 0;
				const event = answered ? cacheEvent(previous, state, usage) : undefined;
				if (answered) previous = state;
				const version = versionId(prompt.state);
				insertVersion.run(version, JSON.stringify(prompt.state.sections), JSON.stringify(prompt.state.tools), ts);
				for (const [hash, blob] of prompt.texts) insertBlob.run(hash, blob.kind, blob.name, blob.text);
				insertRequest.run(sessionId, entry.id, ts, "turn", message.provider, message.model, message.thinkingLevel ?? null,
					message.stopReason, version, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, attribution.promptTokens,
					...costSplit(usage), prompt.messageCount, attribution.trigger ?? null, attribution.triggerTokens, event?.cause ?? null,
					event?.lostTokens ?? 0, event?.waste ?? 0, attribution.rates.input, attribution.rates.read, attribution.rates.write,
					(usage.cacheWrite1h ?? 0) > 0 ? 1 : 0, message.content.filter((part) => part.type === "toolCall").length);
				for (const [category, c] of attribution.composition) {
					insertCost.run(sessionId, entry.id, category, c.blocks, c.tokens, c.newTokens, c.read, c.write, c.uncached);
				}
				for (const [id, result] of attribution.results) {
					const life = lifetime.get(id) ?? { requests: 0, tokens: 0, cost: 0 };
					if (life.requests === 0) life.tokens = result.tokens;
					life.requests += 1;
					life.cost += result.cost;
					lifetime.set(id, life);
				}
				const written: string[] = [];
				for (const part of message.content) {
					if (part.type === "text") written.push(part.text);
					else if (part.type === "thinking") written.push(part.thinking);
					else if (part.type === "toolCall") written.push(JSON.stringify(part.arguments));
				}
				agentTexts.push({ ts, text: written.join("\n") });
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const { files, writes, mutates } = toolEffect(part.name, part.arguments, header.cwd);
					toolCalls.set(part.id, { name: part.name, args: part.arguments, summary: summarizeToolInput(part.arguments), ts, files, mutates });
					for (const file of files) insertFile.run(sessionId, part.id, ts, file, writes.includes(file) ? 1 : 0);
					lifetime.set(part.id, { ...(lifetime.get(part.id) ?? { requests: 0, tokens: 0, cost: 0 }), version });
				}
				if (answered) turns.push({ ts, promptTokens: attribution.promptTokens, cacheRead: usage.cacheRead, uncachedCost: usage.cost.cacheWrite + usage.cost.input });
				requests += 1;
				cost += usage.cost.total;
				if (message.stopReason === "aborted") aborted += 1;
				if (message.stopReason === "error") errors += 1;
			}
		}

		const referenced = referenceIndex([...toolCalls.values()], agentTexts);
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			const result = (entry as SessionMessageEntry).message as Extract<SessionMessageEntry["message"], { role: "toolResult" }>;
			const life = lifetime.get(result.toolCallId);
			const call = toolCalls.get(result.toolCallId);
			const resultTs = time(entry);
			const used = referenced(resultTs, call?.files ?? []);
			insertTool.run(sessionId, result.toolCallId, resultTs, result.toolName, call?.summary ?? "",
				result.isError ? 1 : 0, result.durationMs ?? null, life?.tokens ?? 0,
				life?.requests ?? 0, life?.cost ?? 0, life?.version ?? null, used === undefined ? null : used ? 1 : 0, call?.mutates ? 1 : 0);
			const started = call && !result.isError ? delegation(call.name, call.args, messageText(result.content)) : undefined;
			if (started) {
				insertDelegation.run(sessionId, result.toolCallId, call!.ts, started.kind, started.threadId ?? null,
					started.taskDigest ?? null, started.title ?? null);
			}
		}

		const last = entries.at(-1);
		turns.sort((a, b) => a.ts - b.ts);
		for (const pause of idlePauses(turns, warms, coldCompactions, last ? time(last) : time(header))) {
			insertPause.run(sessionId, pause.start, pause.end ?? null, pause.minutes, pause.warms, pause.warmCost, pause.outcome,
				pause.promptTokens, pause.resumeCost);
		}
		const insertArm = db.prepare(
			"INSERT INTO experiment_arms (session_id, experiment, arm, forced, assigned_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const [experiment, arm] of recordedArms(entries)) {
			insertArm.run(sessionId, experiment, arm.arm, arm.forced ? 1 : 0, arm.assignedAt, arm.endedAt ?? null);
		}
		db.prepare(
			`INSERT INTO sessions (id, file, cwd, parent_session, name, prompt_digest, started_at, ended_at, requests, cost, aborted, errors, compactions, user_messages)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(sessionId, path, header.cwd, header.parentSession ?? null, name ?? null, promptDigest ?? null, time(header), last ? time(last) : time(header),
			requests, cost, aborted, errors, compactions, userMessages);
		db.prepare("INSERT OR REPLACE INTO files (path, session_id, size, mtime_ms) VALUES (?, ?, ?, ?)").run(path, sessionId, size, mtimeMs);
	});
}
