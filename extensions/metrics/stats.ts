// Index the sessions, then report: the one entry point for `/harness stats` and the CLI.

import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { indexClaudeSessions } from "./claude.ts";
import { type IndexResult, indexSessions } from "./indexer.ts";
import type { Filters, Source } from "./queries/index.ts";
import { report } from "./report.ts";
import { importedClaude, openStore } from "./store.ts";

export const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");

export const metricsPath = (agentDir = getAgentDir()) => join(agentDir, "metrics.db");

/** Whether a source filter needs the Claude Code transcripts imported. */
export const needsClaude = (source: Source | undefined) => source === "claude-code" || source === "all";

/**
 * Index changed Pi sessions, and Claude Code transcripts (imported for analysis only) when asked
 * or when the store imported them before a rebuild dropped them (see store.ts).
 */
export function indexAll(db: DatabaseSync, { claude = false, agentDir = getAgentDir(), claudeDir = CLAUDE_PROJECTS } = {}): IndexResult[] {
	const results = [indexSessions(db, join(agentDir, "sessions")), ...(claude || claudeDropped(db) ? [indexClaudeSessions(db, claudeDir)] : [])];
	// Planner statistics: without them a time window scans every source's requests by time instead
	// of the few sessions in scope (2 s instead of 60 ms for Pi's sessions next to Claude Code's).
	// Cheap when they are current: optimize only analyzes tables never analyzed or grown a lot since.
	db.exec("PRAGMA analysis_limit = 1000; PRAGMA optimize = 0x10002");
	return results;
}

/** Whether Claude Code transcripts were imported but none are in the store: a schema rebuild dropped them. */
const claudeDropped = (db: DatabaseSync) =>
	importedClaude(db) && db.prepare("SELECT 1 FROM sessions WHERE source = 'claude-code' LIMIT 1").get() === undefined;

export function stats(filters: Filters, agentDir = getAgentDir()): string {
	const db = openStore(metricsPath(agentDir));
	try {
		const indexed = indexAll(db, { claude: needsClaude(filters.source), agentDir });
		const failures = indexed.flatMap((i) => i.failed).map((f) => `could not index ${f.path}: ${f.error}`);
		return [report(db, filters), ...failures].join("\n\n");
	} finally {
		db.close();
	}
}
