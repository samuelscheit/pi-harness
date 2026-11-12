// The metrics index: a SQLite database rebuilt from Pi's session files.
//
// Session files are the source of truth; this database only makes them queryable. A schema
// change bumps SCHEMA_VERSION, which drops every table and re-indexes all sessions. What a store
// imported besides Pi's sessions (Claude Code transcripts, see claude.ts) is remembered across that
// rebuild in `meta`, so the next index imports it again (see `importedClaude`).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 10;

/** Meta key set once Claude Code transcripts were imported; it survives schema rebuilds. */
const CLAUDE_IMPORTED = "claude_imported";

const TABLES = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- One row per indexed session file, to skip files that did not change.
CREATE TABLE files (path TEXT PRIMARY KEY, session_id TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL);
CREATE TABLE sessions (
	-- name: the session's own title when it has one (Pi's session name, Claude Code's custom title).
	-- parent_session: the id of the session this one was forked from or started by (Pi records a path; resolved to the id).
	id TEXT PRIMARY KEY, file TEXT NOT NULL, cwd TEXT NOT NULL, parent_session TEXT, name TEXT,
	-- 'pi', or 'claude-code' for sessions imported for analysis only (see claude.ts).
	source TEXT NOT NULL DEFAULT 'pi',
	-- The cost the client itself reported for the session, when it does (Claude Code), to check ours.
	reported_cost REAL,
	-- Digest of the delegated task when a parent's delegate_task started this session (see delegations).
	prompt_digest TEXT,
	started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
	requests INTEGER NOT NULL, cost REAL NOT NULL, aborted INTEGER NOT NULL, errors INTEGER NOT NULL,
	compactions INTEGER NOT NULL, user_messages INTEGER NOT NULL
);
-- One row per model call: kind 'turn' for an assistant message (with a cost split and harness
-- version), else Pi's side calls such as 'compaction' and 'cache_warm', and 'tool: <name>' for
-- model work a tool reported in its result (web_search's own request).
CREATE TABLE requests (
	session_id TEXT NOT NULL, entry_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL,
	provider TEXT NOT NULL, model TEXT NOT NULL, thinking TEXT, stop_reason TEXT, version TEXT,
	input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
	prompt_tokens INTEGER NOT NULL, cost REAL NOT NULL, message_count INTEGER NOT NULL,
	-- The cost by billing rate: uncached input, output, cache reads and cache writes (sums to cost).
	cost_input REAL NOT NULL, cost_output REAL NOT NULL, cost_read REAL NOT NULL, cost_write REAL NOT NULL,
	trigger TEXT, trigger_tokens INTEGER NOT NULL, cache_event TEXT, cache_lost INTEGER NOT NULL, cache_waste REAL NOT NULL,
	-- Dollars per token this request paid (turns only), and whether it wrote its cache for one hour.
	input_rate REAL, read_rate REAL, write_rate REAL, long_retention INTEGER NOT NULL DEFAULT 0,
	-- Tool calls the assistant message made (Pi turns; NULL for imported Claude Code turns).
	tool_calls INTEGER,
	PRIMARY KEY (session_id, entry_id)
);
-- What each request's cost paid for, by content category and billing rate.
CREATE TABLE request_costs (
	session_id TEXT NOT NULL, entry_id TEXT NOT NULL, category TEXT NOT NULL,
	blocks INTEGER NOT NULL, tokens REAL NOT NULL, new_tokens REAL NOT NULL,
	read_cost REAL NOT NULL, write_cost REAL NOT NULL, uncached_cost REAL NOT NULL,
	PRIMARY KEY (session_id, entry_id, category)
);
-- Every tool call, with what its result cost over the requests that carried it.
CREATE TABLE tool_results (
	session_id TEXT NOT NULL, call_id TEXT NOT NULL, ts INTEGER NOT NULL, tool TEXT NOT NULL, summary TEXT NOT NULL,
	is_error INTEGER NOT NULL, duration_ms INTEGER, tokens REAL NOT NULL,
	requests_in_context INTEGER NOT NULL, lifetime_cost REAL NOT NULL, version TEXT,
	-- Whether a later call touched one of its files or the agent later named one (NULL: no files).
	referenced_later INTEGER,
	-- Whether the call changed files: an edit/write tool, or a shell command that writes (redirection,
	-- sed -i, cp/mv/rm, formatters, an inline script writing a file; see shell.ts), also when the
	-- written files are not known statically. A failed call still counts (join is_error).
	mutates INTEGER NOT NULL,
	-- Whether the tool reached its goal, for tools that report one (details.ok; fix_loop: the check passed). NULL otherwise.
	ok INTEGER,
	PRIMARY KEY (session_id, call_id)
);
-- The files and directories each tool call touched (see work.ts), for rediscovery and stale context.
CREATE TABLE tool_files (
	session_id TEXT NOT NULL, call_id TEXT NOT NULL, ts INTEGER NOT NULL, file TEXT NOT NULL,
	-- 1 when the call wrote, created, moved or deleted the file; 0 when it only named it.
	write INTEGER NOT NULL,
	PRIMARY KEY (session_id, call_id, file)
);
-- Subagents a session started (delegate_task, linked to the child by sessions.prompt_digest) or
-- messaged again (t3_thread_send, linked by thread_id), and child sessions a tool ran in this
-- process (kind 'tool', thread_id = the child's session id from details.childSession, title = tool).
CREATE TABLE delegations (
	session_id TEXT NOT NULL, call_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL,
	thread_id TEXT, task_digest TEXT, title TEXT,
	PRIMARY KEY (session_id, call_id)
);
-- User messages with where they fell in the run: raw signals for corrections and interruptions.
CREATE TABLE user_messages (
	session_id TEXT NOT NULL, entry_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
	PRIMARY KEY (session_id, entry_id)
);
-- Compactions with what triggered them (manual, threshold, overflow, cold) and what they cost.
CREATE TABLE compactions (
	session_id TEXT NOT NULL, entry_id TEXT NOT NULL, ts INTEGER NOT NULL, reason TEXT, tokens_before INTEGER NOT NULL,
	cost REAL NOT NULL, PRIMARY KEY (session_id, entry_id)
);
-- Pauses longer than the short cache lifetime between two requests (or after the last one), with the
-- warm refreshes sent during them and how the session resumed: 'warm' (read the cache), 'compacted'
-- (a cold-cache compaction ran first), 'cold' (wrote the context again), or 'open' (no request yet).
-- resume_cost: what the request after the pause paid for prompt it did not read from cache
-- (cache writes and uncached input).
CREATE TABLE idle_pauses (
	session_id TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER, minutes REAL NOT NULL,
	warms INTEGER NOT NULL, warm_cost REAL NOT NULL, outcome TEXT NOT NULL,
	prompt_tokens INTEGER NOT NULL, resume_cost REAL NOT NULL,
	PRIMARY KEY (session_id, start_ts)
);
-- A/B experiment arms recorded in the session (see extensions/lib/experiments.ts): the arm, whether
-- it was ever set by hand (left out of the random comparison), when the session was first assigned
-- and when the experiment last ended for it (NULL while it runs). Turns count in [assigned_at, ended_at).
CREATE TABLE experiment_arms (
	session_id TEXT NOT NULL, experiment TEXT NOT NULL, arm TEXT NOT NULL, forced INTEGER NOT NULL,
	assigned_at INTEGER NOT NULL, ended_at INTEGER,
	PRIMARY KEY (session_id, experiment)
);
-- Harness versions: the prompt sections and tool definitions a request ran with, as hashes.
CREATE TABLE versions (id TEXT PRIMARY KEY, sections TEXT NOT NULL, tools TEXT NOT NULL, first_seen INTEGER NOT NULL);
-- The text behind each section and tool hash, to diff versions.
CREATE TABLE blobs (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX requests_version ON requests (version);
CREATE INDEX requests_ts ON requests (ts);
CREATE INDEX tool_results_tool ON tool_results (tool);
CREATE INDEX tool_files_file ON tool_files (file);
CREATE INDEX sessions_prompt ON sessions (prompt_digest);
CREATE INDEX delegations_task ON delegations (task_digest);
`;

const SESSION_TABLES = ["sessions", "requests", "request_costs", "tool_results", "tool_files", "delegations", "user_messages", "compactions", "idle_pauses", "experiment_arms"];

export function openStore(path: string): DatabaseSync {
	mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL");
	// The dashboard indexes in a worker while Pi may index for `/harness stats`: wait for the other writer.
	db.exec("PRAGMA busy_timeout = 10000");
	const current = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()
		? (db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | undefined)?.value
		: undefined;
	// Never downgrade: a Pi process still running older harness code would otherwise drop the index a
	// newer one built, and both would rebuild it in turn. The older process has to reload instead.
	if (current !== undefined && Number(current) > SCHEMA_VERSION) {
		db.close();
		throw new Error(`the metrics index ${path} has schema ${current}, newer than this harness code (${SCHEMA_VERSION}); run /reload to load the newer code`);
	}
	if (current !== String(SCHEMA_VERSION)) {
		const claude = current !== undefined && heldClaude(db);
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
		for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
		db.exec(TABLES);
		db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
		if (claude) markClaudeImported(db);
	}
	return db;
}

/** Whether a store of any earlier schema held Claude Code sessions: its flag, or (before the flag existed) its rows. */
function heldClaude(db: DatabaseSync): boolean {
	const flag = db.prepare("SELECT value FROM meta WHERE key = ?").get(CLAUDE_IMPORTED);
	if (flag) return true;
	try {
		return db.prepare("SELECT 1 FROM sessions WHERE source = 'claude-code' LIMIT 1").get() !== undefined;
	} catch {
		// No sessions table or no source column: nothing was imported.
		return false;
	}
}

export const markClaudeImported = (db: DatabaseSync) => db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, '1')").run(CLAUDE_IMPORTED);

/** Whether Claude Code transcripts were imported into this store (also before its last rebuild). */
export const importedClaude = (db: DatabaseSync) => db.prepare("SELECT 1 FROM meta WHERE key = ?").get(CLAUDE_IMPORTED) !== undefined;

export function deleteSession(db: DatabaseSync, sessionId: string): void {
	for (const table of SESSION_TABLES) {
		db.prepare(`DELETE FROM ${table} WHERE ${table === "sessions" ? "id" : "session_id"} = ?`).run(sessionId);
	}
}

export function transaction<T>(db: DatabaseSync, run: () => T): T {
	db.exec("BEGIN");
	try {
		const result = run();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
