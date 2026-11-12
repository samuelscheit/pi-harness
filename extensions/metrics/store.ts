// The metrics index: a SQLite database rebuilt from Pi's session files.
//
// Session files are the source of truth; this database only makes them queryable. A schema
// change bumps SCHEMA_VERSION, which drops every table and re-indexes all sessions.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;

const TABLES = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- One row per indexed session file, to skip files that did not change.
CREATE TABLE files (path TEXT PRIMARY KEY, session_id TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL);
CREATE TABLE sessions (
	id TEXT PRIMARY KEY, file TEXT NOT NULL, cwd TEXT NOT NULL, parent_session TEXT, name TEXT,
	started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
	requests INTEGER NOT NULL, cost REAL NOT NULL, aborted INTEGER NOT NULL, errors INTEGER NOT NULL,
	compactions INTEGER NOT NULL, user_messages INTEGER NOT NULL
);
-- One row per model call: kind 'turn' for an assistant message (with a cost split and harness
-- version), else Pi's side calls such as 'compaction' and 'cache_warm'.
CREATE TABLE requests (
	session_id TEXT NOT NULL, entry_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL,
	provider TEXT NOT NULL, model TEXT NOT NULL, thinking TEXT, stop_reason TEXT, version TEXT,
	input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
	prompt_tokens INTEGER NOT NULL, cost REAL NOT NULL, message_count INTEGER NOT NULL,
	trigger TEXT, trigger_tokens INTEGER NOT NULL, cache_event TEXT, cache_lost INTEGER NOT NULL, cache_waste REAL NOT NULL,
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
	PRIMARY KEY (session_id, call_id)
);
-- User messages with where they fell in the run: raw signals for corrections and interruptions.
CREATE TABLE user_messages (
	session_id TEXT NOT NULL, entry_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
	PRIMARY KEY (session_id, entry_id)
);
-- Harness versions: the prompt sections and tool definitions a request ran with, as hashes.
CREATE TABLE versions (id TEXT PRIMARY KEY, sections TEXT NOT NULL, tools TEXT NOT NULL, first_seen INTEGER NOT NULL);
-- The text behind each section and tool hash, to diff versions.
CREATE TABLE blobs (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX requests_version ON requests (version);
CREATE INDEX tool_results_tool ON tool_results (tool);
`;

const SESSION_TABLES = ["sessions", "requests", "request_costs", "tool_results", "user_messages"];

export function openStore(path: string): DatabaseSync {
	mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL");
	const current = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()
		? (db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | undefined)?.value
		: undefined;
	if (current !== String(SCHEMA_VERSION)) {
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
		for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
		db.exec(TABLES);
		db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
	}
	return db;
}

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
