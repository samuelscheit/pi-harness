// Import Antigravity (`agy`) transcripts into the metrics store (`sessions.source = 'agy'`).
//
// Discovers transcripts from both standalone `agy` CLI (`~/.gemini/antigravity-cli/brain`) and
// T3 Code's isolated Antigravity provider dirs (`~/.t3/userdata/providers/antigravity/*/antigravity-acp/brain`),
// joining each conversation with the metadata & A/B experiment arms logged by our `SessionStart`
// hook (`agy/state.ts` -> `sessions.jsonl`).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type AgySessionRecord, pluginDataDir, readAgySessionRecords } from "../../agy/state.ts";
import { modelPrices } from "./claude.ts";
import { idlePauses, type IndexResult } from "./indexer.ts";
import { deleteSession, markAgyImported, transaction } from "./store.ts";
import { delegatedTaskDigest, delegation, type Effect, referenceIndex, toolEffect } from "./work.ts";

interface AgyToolCall {
	name?: string;
	args?: Record<string, unknown>;
}

interface AgyEntry {
	step_index?: number;
	source?: string;
	type?: string;
	status?: string;
	created_at?: string;
	content?: string;
	thinking?: string;
	exit_code?: number;
	input_tokens?: number;
	cache_read_tokens?: number;
	output_tokens?: number;
	model?: string;
	tool_calls?: AgyToolCall[];
}

const NON_TOOL_TYPES = new Set([
	"USER_INPUT",
	"PLANNER_RESPONSE",
	"CHECKPOINT",
	"EPHEMERAL_MESSAGE",
	"CONVERSATION_COMPACTION",
	"ERROR_MESSAGE",
	"SYSTEM_MESSAGE",
	"CORTEX_STEP_TYPE_UNSPECIFIED",
]);

/** Default directories containing `<conversationId>/.system_generated/logs/transcript.jsonl`. */
export function defaultAgyBrainRoots(home = homedir()): string[] {
	const roots: string[] = [
		join(home, ".gemini", "antigravity-cli", "brain"),
		join(home, ".gemini", "antigravity", "brain"),
	];
	const t3Providers = join(home, ".t3", "userdata", "providers", "antigravity");
	if (existsSync(t3Providers)) {
		try {
			for (const entry of readdirSync(t3Providers, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const brain = join(t3Providers, entry.name, "antigravity-acp", "brain");
				if (existsSync(brain)) roots.push(brain);
			}
		} catch {
			// Ignore unreadable T3 dir.
		}
	}
	return roots.filter((dir) => existsSync(dir));
}

/** Find every `transcript.jsonl` directly under `<root>/<conversationId>/.system_generated/logs/`. */
export function agyTranscriptFiles(roots: readonly string[]): string[] {
	const found: string[] = [];
	for (const root of roots) {
		if (!existsSync(root)) continue;
		let entries;
		try {
			entries = readdirSync(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const file = join(root, entry.name, ".system_generated", "logs", "transcript.jsonl");
			if (existsSync(file)) found.push(file);
		}
	}
	return found;
}

/** Strip T3 Code / Antigravity XML prompt wrappers so titles and dream see clean user text. */
export function unwrapAgyUserText(raw: string): string {
	const trimmed = raw.trim();
	const match = /<user_request>([\s\S]*?)<\/user_request>/.exec(trimmed);
	if (match?.[1] !== undefined) return match[1].trim();
	return trimmed
		.replace(/<t3_code_instructions>[\s\S]*?<\/t3_code_instructions>/g, "")
		.replace(/<runtime_info>[\s\S]*?<\/runtime_info>/g, "")
		.replace(/<\/?USER_REQUEST>/g, "")
		.trim();
}

export function parseAgyTranscript(content: string): AgyEntry[] {
	const entries: AgyEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as AgyEntry);
		} catch {
			// Ignore truncated trailing line while a session is active.
		}
	}
	return entries;
}

function conversationIdFromPath(path: string): string {
	// .../<conversationId>/.system_generated/logs/transcript.jsonl
	return basename(dirname(dirname(dirname(path))));
}

function inferCwd(entries: readonly AgyEntry[], record?: AgySessionRecord): string {
	if (record?.cwd) return record.cwd;
	if (record?.workspacePaths?.length) return record.workspacePaths[0]!;
	for (const entry of entries) {
		for (const call of entry.tool_calls ?? []) {
			const args = call.args;
			if (!args || typeof args !== "object") continue;
			for (const key of ["Cwd", "cwd", "DirectoryPath", "SearchPath"]) {
				const value = args[key];
				if (typeof value === "string" && value.startsWith("/")) return value;
			}
		}
	}
	return "";
}

export interface IndexAgyOptions {
	roots?: readonly string[];
	dataDir?: string;
}

/** Index every changed Antigravity transcript under `roots` (or the default CLI + T3 brain roots). */
export function indexAgySessions(db: DatabaseSync, options: IndexAgyOptions = {}): IndexResult {
	const roots = options.roots ?? defaultAgyBrainRoots();
	const files = agyTranscriptFiles(roots);
	const records = readAgySessionRecords(options.dataDir ?? pluginDataDir());
	const known = db.prepare("SELECT size, mtime_ms FROM files WHERE path = ?");
	const result: IndexResult = { files: files.length, indexed: 0, failed: [] };

	markAgyImported(db);

	const present = new Set(files);
	for (const { path, session_id } of db
		.prepare("SELECT f.path, f.session_id FROM files f JOIN sessions s ON s.id = f.session_id WHERE s.source = 'agy'")
		.all() as { path: string; session_id: string }[]) {
		if (present.has(path)) continue;
		transaction(db, () => {
			deleteSession(db, session_id);
			db.prepare("DELETE FROM files WHERE path = ?").run(path);
		});
	}

	for (const path of files) {
		let stat;
		try {
			stat = statSync(path);
		} catch {
			continue;
		}
		const row = known.get(path) as { size: number; mtime_ms: number } | undefined;
		if (row && row.size === stat.size && row.mtime_ms === stat.mtimeMs) continue;
		const convId = conversationIdFromPath(path);
		try {
			indexAgyTranscript(db, path, readFileSync(path, "utf8"), stat.size, stat.mtimeMs, records.get(convId));
			result.indexed += 1;
		} catch (error) {
			result.failed.push({ path, error: error instanceof Error ? error.message : String(error) });
		}
	}

	return result;
}

export function indexAgyTranscript(
	db: DatabaseSync,
	path: string,
	content: string,
	size: number,
	mtimeMs: number,
	record?: AgySessionRecord,
): void {
	const entries = parseAgyTranscript(content);
	const ts = (e: AgyEntry) => (typeof e.created_at === "string" ? Date.parse(e.created_at) : Number.NaN);
	const timed = entries.filter((e) => !Number.isNaN(ts(e)));
	if (timed.length === 0) throw new Error("no timestamped entries");

	const id = record?.conversationId || conversationIdFromPath(path);
	const cwd = inferCwd(timed, record);
	const defaultModel = record?.modelName || "antigravity";

	transaction(db, () => {
		deleteSession(db, id);

		const insertRequest = db.prepare(
			`INSERT INTO requests (session_id, entry_id, ts, kind, provider, model, thinking, stop_reason, version, input, output,
			cache_read, cache_write, prompt_tokens, cost, cost_input, cost_output, cost_read, cost_write, message_count, trigger,
			trigger_tokens, cache_event, cache_lost, cache_waste, input_rate, read_rate, write_rate, long_retention, tool_calls)
			VALUES (?, ?, ?, 'turn', 'antigravity', ?, NULL, ?, NULL, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, 0, NULL, 0, NULL, 0, 0, ?, ?, 0, 0, ?)`,
		);
		const insertTool = db.prepare(
			`INSERT OR IGNORE INTO tool_results (session_id, call_id, ts, tool, summary, is_error, duration_ms, tokens, requests_in_context, lifetime_cost, version, referenced_later, mutates)
			VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)`,
		);
		const insertFile = db.prepare("INSERT OR IGNORE INTO tool_files (session_id, call_id, ts, file, write) VALUES (?, ?, ?, ?, ?)");
		const insertDelegation = db.prepare(
			"INSERT OR IGNORE INTO delegations (session_id, call_id, ts, kind, thread_id, task_digest, title) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		const insertUser = db.prepare("INSERT OR IGNORE INTO user_messages (session_id, entry_id, ts, kind, text) VALUES (?, ?, ?, ?, ?)");
		const insertCompaction = db.prepare("INSERT OR IGNORE INTO compactions (session_id, entry_id, ts, reason, tokens_before, cost) VALUES (?, ?, ?, ?, 0, 0)");

		const turns: { ts: number; promptTokens: number; cacheRead: number; uncachedCost: number; readRate: number }[] = [];
		const boundaries: number[] = [];
		const texts: { ts: number; text: string }[] = [];
		interface PendingCall {
			name: string;
			args: unknown;
			ts: number;
			effect: Effect;
		}
		interface RecordedTool {
			callId: string;
			ts: number;
			callTs: number;
			name: string;
			args: unknown;
			effect: Effect;
			isError: boolean;
			resultText: string;
		}

		const pendingCalls: PendingCall[] = [];
		const recordedTools: RecordedTool[] = [];
		let cost = 0;
		let errors = 0;
		let compactions = 0;
		let userMessages = 0;
		let firstUserText = "";
		let hadOpenTools = false;

		for (let i = 0; i < timed.length; i += 1) {
			const e = timed[i]!;
			const entryTs = ts(e);
			const stepId = `step-${e.step_index ?? i}`;
			const type = e.type ?? "";

			if (type === "USER_INPUT") {
				const raw = typeof e.content === "string" ? e.content : "";
				const body = unwrapAgyUserText(raw);
				if (body) {
					if (userMessages === 0) firstUserText = body;
					const kind = userMessages === 0 ? "first" : hadOpenTools ? "steer" : "follow-up";
					insertUser.run(id, stepId, entryTs, kind, body.slice(0, 2000));
					userMessages += 1;
				}
				hadOpenTools = false;
				continue;
			}

			if (type === "CONVERSATION_COMPACTION") {
				insertCompaction.run(id, stepId, entryTs, "compaction");
				boundaries.push(entryTs);
				compactions += 1;
				continue;
			}

			if (type === "ERROR_MESSAGE") {
				errors += 1;
				continue;
			}

			if (type === "PLANNER_RESPONSE") {
				const model = e.model || defaultModel;
				const prices = modelPrices(model) ?? { input: 0, output: 0, read: 0, write: 0 };
				const input = Number(e.input_tokens ?? 0);
				const read = Number(e.cache_read_tokens ?? 0);
				const output = Number(e.output_tokens ?? 0);
				const promptTokens = input + read;
				const costInput = input * prices.input;
				const costOutput = output * prices.output;
				const costRead = read * prices.read;
				const turnCost = costInput + costOutput + costRead;
				cost += turnCost;

				const toolCalls = Array.isArray(e.tool_calls) ? e.tool_calls : [];
				const stopReason = toolCalls.length > 0 ? "tool_use" : e.status === "ERROR" ? "error" : "end_turn";
				if (e.status === "ERROR") errors += 1;
				hadOpenTools = toolCalls.length > 0;

				insertRequest.run(
					id,
					stepId,
					entryTs,
					model,
					stopReason,
					input,
					output,
					read,
					promptTokens,
					turnCost,
					costInput,
					costOutput,
					costRead,
					prices.input,
					prices.read,
					toolCalls.length,
				);
				turns.push({ ts: entryTs, promptTokens, cacheRead: read, uncachedCost: costInput, readRate: prices.read });

				const written: string[] = [];
				if (typeof e.content === "string" && e.content) written.push(e.content);
				if (typeof e.thinking === "string" && e.thinking) written.push(e.thinking);
				for (const call of toolCalls) {
					const callName = call.name || "unknown";
					const callArgs = call.args ?? {};
					written.push(JSON.stringify(callArgs));
					pendingCalls.push({ name: callName, args: callArgs, ts: entryTs, effect: toolEffect(callName, callArgs, cwd) });
				}
				if (written.length) texts.push({ ts: entryTs, text: written.join("\n") });
				continue;
			}

			if (NON_TOOL_TYPES.has(type) || !type) continue;

			// Match tool execution step to the corresponding pending tool_call emitted by PLANNER_RESPONSE.
			const normalizedType = type.toUpperCase();
			let matchedIdx = pendingCalls.findIndex((c) => c.name.toUpperCase() === normalizedType);
			if (matchedIdx < 0 && pendingCalls.length > 0) matchedIdx = 0;
			const matched = matchedIdx >= 0 ? pendingCalls.splice(matchedIdx, 1)[0] : undefined;

			const name = matched?.name ?? type.toLowerCase();
			const args = matched?.args ?? {};
			const effect = matched?.effect ?? { files: [], writes: [], mutates: false };
			const resultText = typeof e.content === "string" ? e.content : "";
			const isError = e.status === "ERROR" || (typeof e.exit_code === "number" && e.exit_code !== 0);
			if (isError) errors += 1;

			recordedTools.push({
				callId: stepId,
				ts: entryTs,
				callTs: matched?.ts ?? entryTs,
				name,
				args,
				effect,
				isError,
				resultText,
			});
		}

		turns.sort((a, b) => a.ts - b.ts);
		boundaries.sort((a, b) => a - b);

		const referenced = referenceIndex(
			recordedTools.map((t) => ({ ts: t.callTs, files: t.effect.files })),
			texts,
		);

		for (const t of recordedTools) {
			const tokens = t.resultText.length / 4;
			const nextCompaction = boundaries.find((b) => b > t.ts) ?? Infinity;
			const carriedBy = turns.filter((turn) => turn.ts > t.ts && turn.ts < nextCompaction);
			const used = referenced(t.ts, t.effect.files);
			insertTool.run(
				id,
				t.callId,
				t.ts,
				t.name,
				JSON.stringify(t.args ?? "").slice(0, 200),
				t.isError ? 1 : 0,
				tokens,
				carriedBy.length,
				carriedBy.reduce((sum, turn) => sum + tokens * turn.readRate, 0),
				used === undefined ? null : used ? 1 : 0,
				t.effect.mutates ? 1 : 0,
			);
			for (const file of t.effect.files) {
				insertFile.run(id, t.callId, t.callTs, file, t.effect.writes.includes(file) ? 1 : 0);
			}
			if (!t.isError) {
				const started = delegation(t.name, t.args, t.resultText);
				if (started) {
					insertDelegation.run(id, t.callId, t.callTs, started.kind, started.threadId ?? null, started.taskDigest ?? null, started.title ?? null);
				}
			}
		}

		const insertPause = db.prepare(
			`INSERT INTO idle_pauses (session_id, start_ts, end_ts, minutes, warms, warm_cost, outcome, prompt_tokens, resume_cost)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const timestamps = timed.map(ts);
		const first = Math.min(...timestamps);
		const last = Math.max(...timestamps);
		for (const pause of idlePauses(turns, [], [], last)) {
			insertPause.run(id, pause.start, pause.end ?? null, pause.minutes, pause.warms, pause.warmCost, pause.outcome, pause.promptTokens, pause.resumeCost);
		}

		if (record?.arms?.length) {
			const insertArm = db.prepare(
				`INSERT OR REPLACE INTO experiment_arms (session_id, experiment, arm, forced, assigned_at, ended_at)
				VALUES (?, ?, ?, ?, ?, NULL)`,
			);
			for (const arm of record.arms) {
				insertArm.run(id, arm.experiment, arm.arm, arm.forced ? 1 : 0, arm.assignedAt ?? record.startedAt ?? first);
			}
		}

		const promptDigest = delegatedTaskDigest(firstUserText);
		db.prepare(
			`INSERT INTO sessions (id, file, cwd, parent_session, name, source, reported_cost, prompt_digest, started_at, ended_at, requests, cost, aborted, errors, compactions, user_messages)
			VALUES (?, ?, ?, NULL, NULL, 'agy', NULL, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
		).run(id, path, cwd, promptDigest ?? null, first, last, turns.length, cost, errors, compactions, userMessages);
		db.prepare("INSERT OR REPLACE INTO files (path, session_id, size, mtime_ms) VALUES (?, ?, ?, ?)").run(path, id, size, mtimeMs);
	});
}
