// Import Claude Code sessions (~/.claude/projects) into the metrics store, for analysis only.
//
// They are a different harness (prompt, tools, compaction, subagents), so they never feed harness
// versions or the improvement loop: every row is tagged `sessions.source = 'claude-code'` and the
// report only includes them when asked (`--source claude-code` or `all`). What transfers is the
// economics: context sizes, cache behaviour, compaction break-even, rediscovery, resume or new.
//
// Layout: <project>/<session>.jsonl is the main transcript, <project>/<session>/subagents/
// agent-<id>.jsonl one per subagent (session id `<session>/<agentId>`, parent `<session>`).
// Claude Code writes an assistant message once per content block (same message id), so requests
// are grouped by id. Request recordings (`api-request*` lines) are skipped unparsed. Costs come
// from Pi's model catalog; Claude Code's own total (`cost-state`) is kept to check them.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { IndexResult } from "./indexer.ts";
import { idlePauses } from "./indexer.ts";
import { deleteSession, markClaudeImported, transaction } from "./store.ts";
import { delegatedTaskDigest, delegation, type Effect, referenceIndex, taskDigest, toolEffect } from "./work.ts";

type Entry = Record<string, any>;

/** Dollars per token. */
interface Prices {
	input: number;
	output: number;
	read: number;
	write: number;
}

const priceCache = new Map<string, Prices | undefined>();

/** Prices of a model id from Pi's catalog, Anthropic's listing first. */
export function modelPrices(id: string): Prices | undefined {
	if (!priceCache.has(id)) {
		const providers = [...getBuiltinProviders()].sort((a, b) => Number(b === "anthropic") - Number(a === "anthropic"));
		const model = providers.flatMap((provider) => getBuiltinModels(provider)).find((m) => m.id === id);
		priceCache.set(id, model && { input: model.cost.input / 1e6, output: model.cost.output / 1e6, read: model.cost.cacheRead / 1e6, write: model.cost.cacheWrite / 1e6 });
	}
	return priceCache.get(id);
}

interface ClaudeUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
}

export interface CostSplit {
	input: number;
	output: number;
	read: number;
	write: number;
	total: number;
}

/** A request's cost by billing rate; a one-hour cache write costs twice the input price (as Pi's calculateCost). */
export function requestCost(usage: ClaudeUsage, prices: Prices): CostSplit {
	const long = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
	const short = (usage.cache_creation_input_tokens ?? 0) - long;
	const split = {
		input: (usage.input_tokens ?? 0) * prices.input,
		output: (usage.output_tokens ?? 0) * prices.output,
		read: (usage.cache_read_input_tokens ?? 0) * prices.read,
		write: short * prices.write + long * prices.input * 2,
	};
	return { ...split, total: split.input + split.output + split.read + split.write };
}

const text = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: Entry) => (part?.type === "text" ? (part.text ?? "") : "")).join("\n");
};

/** Approximate tokens of a tool result: four characters per token, a fixed size per image. */
const resultTokens = (content: unknown): number =>
	typeof content === "string"
		? content.length / 4
		: Array.isArray(content)
			? content.reduce((sum: number, part: Entry) => sum + (part?.type === "image" ? 1_500 : String(part?.text ?? "").length / 4), 0)
			: 0;

export function parseTranscript(content: string): Entry[] {
	const entries: Entry[] = [];
	for (const line of content.split("\n")) {
		// Request recordings are large and not needed here.
		if (!line || line.startsWith('{"type":"api-request')) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// A line cut off by a session that is still being written.
		}
	}
	return entries;
}

function transcriptFiles(projectsDir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(projectsDir, { recursive: true }) as string[];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	// Main transcripts sit directly in a project directory; subagents in <session>/subagents/.
	return names
		.filter((name) => name.endsWith(".jsonl") && (name.split("/").length === 2 || /\/subagents\/agent-[^/]+\.jsonl$/.test(name)))
		.map((name) => join(projectsDir, name));
}

/** Index every changed Claude Code transcript below `projectsDir`. */
export function indexClaudeSessions(db: DatabaseSync, projectsDir: string): IndexResult {
	const files = transcriptFiles(projectsDir);
	const known = db.prepare("SELECT size, mtime_ms FROM files WHERE path = ?");
	const result: IndexResult = { files: files.length, indexed: 0, failed: [] };
	markClaudeImported(db);
	const present = new Set(files);
	for (const { path, session_id } of db.prepare("SELECT f.path, f.session_id FROM files f JOIN sessions s ON s.id = f.session_id WHERE s.source = 'claude-code'").all() as { path: string; session_id: string }[]) {
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
			indexTranscript(db, path, readFileSync(path, "utf8"), stat.size, stat.mtimeMs);
			result.indexed += 1;
		} catch (error) {
			result.failed.push({ path, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return result;
}

export function indexTranscript(db: DatabaseSync, path: string, content: string, size: number, mtimeMs: number): void {
	const agentId = /\/subagents\/agent-([^/]+)\.jsonl$/.exec(path)?.[1];
	const subagent = agentId !== undefined;
	// Older versions wrote subagent turns into the main file as side chains; they are not this agent's.
	const entries = parseTranscript(content).filter((e) => subagent || e.isSidechain !== true);
	const sessionId = entries.find((e) => typeof e.sessionId === "string")?.sessionId as string | undefined;
	if (!sessionId) throw new Error("no session id");
	const id = subagent ? `${sessionId}/${agentId}` : sessionId;
	const ts = (e: Entry) => Date.parse(e.timestamp);
	const timed = entries.filter((e) => typeof e.timestamp === "string" && !Number.isNaN(ts(e)));
	if (timed.length === 0) throw new Error("no timestamped entries");

	transaction(db, () => {
		deleteSession(db, id);
		// Requests: assistant entries grouped by message id; the last entry carries the final usage.
		const requests = new Map<string, { ts: number; entry: Entry }>();
		const calls = new Map<string, { name: string; input: unknown; ts: number } & Effect>();
		const texts: { ts: number; text: string }[] = [];
		const cwd = (entries.find((e) => typeof e.cwd === "string")?.cwd as string | undefined) ?? "";
		for (const e of timed) {
			if (e.type !== "assistant" || !e.message) continue;
			const key = e.message.id ?? e.uuid;
			const previous = requests.get(key);
			requests.set(key, { ts: previous?.ts ?? ts(e), entry: e });
			const written: string[] = [];
			for (const part of e.message.content ?? []) {
				if (part.type === "text") written.push(part.text ?? "");
				else if (part.type === "thinking") written.push(part.thinking ?? "");
				else if (part.type === "tool_use") {
					written.push(JSON.stringify(part.input ?? {}));
					calls.set(part.id, { name: part.name, input: part.input, ts: ts(e), ...toolEffect(part.name, part.input, cwd) });
				}
			}
			texts.push({ ts: ts(e), text: written.join("\n") });
		}

		const insertRequest = db.prepare(
			`INSERT INTO requests (session_id, entry_id, ts, kind, provider, model, thinking, stop_reason, version, input, output,
			cache_read, cache_write, prompt_tokens, cost, cost_input, cost_output, cost_read, cost_write, message_count, trigger,
			trigger_tokens, cache_event, cache_lost, cache_waste, input_rate, read_rate, write_rate, long_retention)
			VALUES (?, ?, ?, 'turn', 'claude-code', ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, NULL, 0, 0, ?, ?, ?, ?)`,
		);
		const turns: { ts: number; promptTokens: number; cacheRead: number; uncachedCost: number; readRate: number }[] = [];
		let cost = 0;
		for (const [key, { ts: requestTs, entry }] of requests) {
			const message = entry.message;
			if (message.model === "<synthetic>") continue;
			const usage: ClaudeUsage = message.usage ?? {};
			const prices = modelPrices(message.model) ?? { input: 0, output: 0, read: 0, write: 0 };
			const long = (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0;
			const writeRate = long ? prices.input * 2 : prices.write;
			const read = usage.cache_read_input_tokens ?? 0;
			const write = usage.cache_creation_input_tokens ?? 0;
			const input = usage.input_tokens ?? 0;
			const split = requestCost(usage, prices);
			cost += split.total;
			insertRequest.run(id, key, requestTs, message.model, message.stop_reason ?? null, input, usage.output_tokens ?? 0, read, write,
				input + read + write, split.total, split.input, split.output, split.read, split.write, prices.input, prices.read, writeRate, long ? 1 : 0);
			turns.push({ ts: requestTs, promptTokens: input + read + write, cacheRead: read, uncachedCost: split.write + split.input, readRate: prices.read });
		}
		turns.sort((a, b) => a.ts - b.ts);

		// Compactions bound how long a result stays in context.
		// Some transcripts log the same boundary twice.
		const compactions = [...new Map(timed.filter((e) => e.type === "system" && e.subtype === "compact_boundary").map((e) => [e.uuid, e])).values()];
		const insertCompaction = db.prepare("INSERT INTO compactions (session_id, entry_id, ts, reason, tokens_before, cost) VALUES (?, ?, ?, ?, ?, 0)");
		for (const c of compactions) insertCompaction.run(id, c.uuid, ts(c), c.compactMetadata?.trigger ?? null, c.compactMetadata?.preTokens ?? 0);
		const boundaries = compactions.map(ts).sort((a, b) => a - b);

		const referenced = referenceIndex([...calls.values()], texts);
		const insertTool = db.prepare(
			`INSERT OR IGNORE INTO tool_results (session_id, call_id, ts, tool, summary, is_error, duration_ms, tokens, requests_in_context, lifetime_cost, version, referenced_later, mutates)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
		);
		const insertFile = db.prepare("INSERT OR IGNORE INTO tool_files (session_id, call_id, ts, file, write) VALUES (?, ?, ?, ?, ?)");
		const insertDelegation = db.prepare(
			"INSERT OR IGNORE INTO delegations (session_id, call_id, ts, kind, thread_id, task_digest, title) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		const insertUser = db.prepare("INSERT OR IGNORE INTO user_messages (session_id, entry_id, ts, kind, text) VALUES (?, ?, ?, ?, ?)");
		// Subagent names, so a SendMessage to a name resolves to the agent.
		const agentsByName = new Map<string, string>();
		let userMessages = 0;
		let lastStop: string | undefined;
		for (const e of timed) {
			if (e.type === "assistant") {
				lastStop = e.message?.stop_reason ?? lastStop;
				continue;
			}
			if (e.type !== "user" || !e.message) continue;
			const content = e.message.content;
			const results = Array.isArray(content) ? content.filter((part: Entry) => part?.type === "tool_result") : [];
			if (results.length === 0) {
				if (e.isMeta || e.isCompactSummary) continue;
				const body = text(content);
				if (!body.trim()) continue;
				insertUser.run(id, e.uuid, ts(e), userMessages === 0 ? "first" : lastStop === "tool_use" ? "steer" : "follow-up", body.slice(0, 2000));
				userMessages += 1;
				continue;
			}
			for (const result of results) {
				const call = calls.get(result.tool_use_id);
				const resultTs = ts(e);
				const tokens = resultTokens(result.content);
				const nextCompaction = boundaries.find((b) => b > resultTs) ?? Infinity;
				const carriedBy = turns.filter((t) => t.ts > resultTs && t.ts < nextCompaction);
				const used = referenced(resultTs, call?.files ?? []);
				insertTool.run(id, result.tool_use_id, resultTs, call?.name ?? "unknown", JSON.stringify(call?.input ?? "").slice(0, 200),
					result.is_error ? 1 : 0, null, tokens, carriedBy.length, carriedBy.reduce((sum, t) => sum + tokens * t.readRate, 0),
					used === undefined ? null : used ? 1 : 0, call?.mutates ? 1 : 0);
				for (const file of call?.files ?? []) insertFile.run(id, result.tool_use_id, call!.ts, file, call!.writes.includes(file) ? 1 : 0);
				if (!call) continue;
				const toolResult: Entry = e.toolUseResult && typeof e.toolUseResult === "object" ? e.toolUseResult : {};
				const input = (call.input ?? {}) as Entry;
				if (call.name === "Agent" || call.name === "Task") {
					const agent = toolResult.agentId as string | undefined;
					if (typeof input.name === "string" && agent) agentsByName.set(input.name, agent);
					if (typeof input.prompt === "string" && !result.is_error) {
						insertDelegation.run(id, result.tool_use_id, call.ts, "delegate", agent ? `${sessionId}/${agent}` : null,
							taskDigest(input.prompt), (input.description ?? input.name ?? null) as string | null);
					}
				} else if (call.name === "SendMessage" && typeof input.to === "string") {
					const agent = agentsByName.get(input.to) ?? input.to;
					insertDelegation.run(id, result.tool_use_id, call.ts, "send", `${sessionId}/${agent}`, null, null);
				} else {
					// t3's delegate_task and t3_thread_send, called from Claude Code.
					const started = !result.is_error ? delegation(call.name, call.input, text(result.content)) : undefined;
					if (started) {
						insertDelegation.run(id, result.tool_use_id, call.ts, started.kind, started.threadId ?? null, started.taskDigest ?? null, started.title ?? null);
					}
				}
			}
		}

		const insertPause = db.prepare(
			`INSERT INTO idle_pauses (session_id, start_ts, end_ts, minutes, warms, warm_cost, outcome, prompt_tokens, resume_cost)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const last = Math.max(...timed.map(ts));
		for (const pause of idlePauses(turns, [], [], last)) {
			insertPause.run(id, pause.start, pause.end ?? null, pause.minutes, pause.warms, pause.warmCost, pause.outcome, pause.promptTokens, pause.resumeCost);
		}

		const firstUser = timed.find((e) => e.type === "user" && !e.isMeta && text(e.message?.content).trim());
		const firstText = firstUser ? text(firstUser.message.content) : "";
		// A subagent's first message is its prompt; a t3-started main session has t3's preamble first.
		const promptDigest = subagent ? taskDigest(firstText) : delegatedTaskDigest(firstText);
		const title = [...entries].reverse().find((e) => e.type === "custom-title")?.customTitle as string | undefined;
		const costState = [...entries].reverse().find((e) => e.type === "cost-state");
		const reported = costState ? Number(costState.totalCostUSD) : undefined;
		db.prepare(
			`INSERT INTO sessions (id, file, cwd, parent_session, name, source, reported_cost, prompt_digest, started_at, ended_at, requests, cost, aborted, errors, compactions, user_messages)
			VALUES (?, ?, ?, ?, ?, 'claude-code', ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
		).run(id, path, cwd, subagent ? sessionId : null, title ?? null,
			reported !== undefined && Number.isFinite(reported) ? reported : null, promptDigest ?? null, Math.min(...timed.map(ts)), last,
			turns.length, cost, compactions.length, userMessages);
		db.prepare("INSERT OR REPLACE INTO files (path, session_id, size, mtime_ms) VALUES (?, ?, ?, ?)").run(path, id, size, mtimeMs);
	});
}
