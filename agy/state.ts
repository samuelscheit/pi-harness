// Shared persistent state for the Antigravity (`agy`) harness target.
//
// Unlike Pi extensions (which live in a single long-running process), `agy` lifecycle hooks run as
// short-lived subprocesses and MCP tools run in a separate stdio server process. Both share a
// single state directory (`PLUGIN_DATA`, or `~/.pi/agent/agy-data`) with atomic file writes so
// own-writes tracking, active goals, thread-wait guards, A/B experiment arms and session metadata
// stay consistent across hooks, MCP tools, the `tool` CLI and the metrics indexer.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Arm } from "../extensions/lib/experiments.ts";
import type { Goal } from "../extensions/goal/goal.ts";

/** Directory holding all persistent agy harness state. */
export function pluginDataDir(): string {
	return process.env.PLUGIN_DATA || process.env.PI_HARNESS_AGY_DATA || join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"), "agy-data");
}

/** Safe filename component derived from an arbitrary conversation id. */
export function safeId(id: string): string {
	const cleaned = id.replace(/[^a-zA-Z0-9._-]/g, "_");
	return cleaned || "default";
}

/** Read a JSON file if it exists and parses cleanly; otherwise return `fallback`. */
export function readJsonFile<T>(file: string, fallback: T): T {
	if (!existsSync(file)) return fallback;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/** Atomically write JSON via a same-directory temp file + rename. */
export function writeJsonAtomic(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${process.hrtime.bigint()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`);
	renameSync(tmp, file);
}

/** Append one JSONL record to `file`. */
export function appendJsonl(file: string, record: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(record)}\n`);
}

// --- Own-writes file records (extensions/bash/commit.ts) ---

export interface SerializedFileRecord {
	last: string | null;
	foreign?: string;
	changes: number;
}

export interface SerializedPending {
	path: string;
	before: string | null;
	clean: boolean;
	changes: number | undefined;
}

export interface SerializedSessionFiles {
	files: [string, SerializedFileRecord][];
	pending: [string, SerializedPending][];
}

export interface SessionFilesLike {
	files: Map<string, SerializedFileRecord>;
	pending: Map<string, SerializedPending>;
}

export const ownWritesPath = (conversationId: string, dataDir = pluginDataDir()) =>
	join(dataDir, "own-writes", `${safeId(conversationId)}.json`);

export function loadOwnWrites(conversationId: string, dataDir = pluginDataDir()): SessionFilesLike {
	const raw = readJsonFile<SerializedSessionFiles>(ownWritesPath(conversationId, dataDir), { files: [], pending: [] });
	return {
		files: new Map(Array.isArray(raw.files) ? raw.files : []),
		pending: new Map(Array.isArray(raw.pending) ? raw.pending : []),
	};
}

export function saveOwnWrites(conversationId: string, state: SessionFilesLike, dataDir = pluginDataDir()): void {
	const serialized: SerializedSessionFiles = {
		files: [...state.files.entries()],
		pending: [...state.pending.entries()],
	};
	writeJsonAtomic(ownWritesPath(conversationId, dataDir), serialized);
}

// --- Goal state (extensions/goal/goal.ts) ---

export interface WaitRecordState {
	since: number;
	work: number;
	nudges: number;
	nudgeAt: number;
}

export interface AgyGoalState {
	goal: Goal | null;
	/** Transcript token count (input + output) when this goal was set, for incremental spend tracking. */
	baselineTokens: number;
	/** Forced continues in a row without a non-goal tool call. */
	idle: number;
	/** Whether the loop guard already stopped forcing for this stretch. */
	notified: boolean;
	/** Accepted `wait` job keys for the current turn (cleared on new work or turn resume). */
	waiting?: string[];
	/** Count of non-goal tool calls since session start. */
	work: number;
	/** Previous wait stretches by job key. */
	waits: Record<string, WaitRecordState>;
	/** Hash of the last goal prompt section injected by PreInvocation. */
	injectedHash?: string;
	/** Last `lastUserInput` seen, to detect when the user replied to a blocked goal. */
	lastUserInput?: string;
	/** Active delegated tasks seen in this conversation (from delegate_task results). */
	delegatedTasks: { taskId: string; threadId?: string; title?: string; active: boolean; startedAt: number }[];
}

export const freshGoalState = (): AgyGoalState => ({
	goal: null,
	baselineTokens: 0,
	idle: 0,
	notified: false,
	work: 0,
	waits: {},
	delegatedTasks: [],
});

export const goalStatePath = (conversationId: string, dataDir = pluginDataDir()) =>
	join(dataDir, "goals", `${safeId(conversationId)}.json`);

export function loadGoalState(conversationId: string, dataDir = pluginDataDir()): AgyGoalState {
	const raw = readJsonFile<Partial<AgyGoalState>>(goalStatePath(conversationId, dataDir), {});
	return {
		...freshGoalState(),
		...raw,
		waits: raw.waits && typeof raw.waits === "object" ? raw.waits : {},
		delegatedTasks: Array.isArray(raw.delegatedTasks) ? raw.delegatedTasks : [],
	};
}

export function saveGoalState(conversationId: string, state: AgyGoalState, dataDir = pluginDataDir()): void {
	writeJsonAtomic(goalStatePath(conversationId, dataDir), state);
}

// --- Thread-wait guard state (extensions/thread-wait/wait.ts) ---

export interface TrackedChild {
	taskId: string;
	threadId: string;
	title?: string;
}

export interface TimedOutThreadWait {
	threadId: string;
	environmentId?: string;
	runId?: string;
	until: boolean;
	at: number;
	note?: string;
}

export interface ThreadWaitState {
	children: TrackedChild[];
	timedOut: TimedOutThreadWait[];
}

export const threadWaitPath = (conversationId: string, dataDir = pluginDataDir()) =>
	join(dataDir, "thread-waits", `${safeId(conversationId)}.json`);

export function loadThreadWaitState(conversationId: string, dataDir = pluginDataDir()): ThreadWaitState {
	const raw = readJsonFile<Partial<ThreadWaitState>>(threadWaitPath(conversationId, dataDir), {});
	return {
		children: Array.isArray(raw.children) ? raw.children : [],
		timedOut: Array.isArray(raw.timedOut) ? raw.timedOut : [],
	};
}

export function saveThreadWaitState(conversationId: string, state: ThreadWaitState, dataDir = pluginDataDir()): void {
	writeJsonAtomic(threadWaitPath(conversationId, dataDir), state);
}

// --- Rules-seen state (live mid-session rule propagation) ---

export interface RulesSeenState {
	hash: string;
	/** Per-section hashes so PreInvocation can inject only changed/added sections. */
	sections: Record<string, string>;
}

export const rulesSeenPath = (conversationId: string, dataDir = pluginDataDir()) =>
	join(dataDir, "rules-seen", `${safeId(conversationId)}.json`);

export function loadRulesSeen(conversationId: string, dataDir = pluginDataDir()): RulesSeenState | undefined {
	const path = rulesSeenPath(conversationId, dataDir);
	if (!existsSync(path)) return undefined;
	return readJsonFile<RulesSeenState | undefined>(path, undefined);
}

export function saveRulesSeen(conversationId: string, state: RulesSeenState, dataDir = pluginDataDir()): void {
	writeJsonAtomic(rulesSeenPath(conversationId, dataDir), state);
}

// --- Session metadata & experiment arm log (for extensions/metrics/agy.ts) ---

export interface AgySessionRecord {
	conversationId: string;
	cwd: string;
	workspacePaths: string[];
	modelName?: string;
	transcriptPath?: string;
	harnessCommit?: string;
	rulesHash?: string;
	arms: { experiment: string; arm: Arm; forced: boolean; assignedAt: number }[];
	startedAt: number;
}

export const sessionsLogPath = (dataDir = pluginDataDir()) => join(dataDir, "sessions.jsonl");

export function recordAgySession(record: AgySessionRecord, dataDir = pluginDataDir()): void {
	appendJsonl(sessionsLogPath(dataDir), record);
}

/** Read all recorded agy session metadata entries keyed by `conversationId` (latest entry merges arms). */
export function readAgySessionRecords(dataDir = pluginDataDir()): Map<string, AgySessionRecord> {
	const map = new Map<string, AgySessionRecord>();
	const file = sessionsLogPath(dataDir);
	if (!existsSync(file)) return map;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as AgySessionRecord;
			if (!entry.conversationId) continue;
			const prev = map.get(entry.conversationId);
			if (!prev) {
				map.set(entry.conversationId, entry);
			} else {
				const armByName = new Map(prev.arms.map((a) => [a.experiment, a]));
				for (const a of entry.arms ?? []) armByName.set(a.experiment, a);
				map.set(entry.conversationId, {
					...prev,
					...entry,
					cwd: entry.cwd || prev.cwd,
					arms: [...armByName.values()],
				});
			}
		} catch {
			// Ignore truncated trailing line.
		}
	}
	return map;
}
