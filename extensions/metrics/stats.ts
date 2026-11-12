// Index the sessions, then report: the one entry point for `/harness stats` and the CLI.

import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { indexClaudeSessions } from "./claude.ts";
import { indexSessions } from "./indexer.ts";
import { report, type Scope } from "./report.ts";
import { openStore } from "./store.ts";

export const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");

export function stats(scope: Scope, agentDir = getAgentDir()): string {
	const db = openStore(join(agentDir, "metrics.db"));
	try {
		const indexed = [indexSessions(db, join(agentDir, "sessions"))];
		// Claude Code transcripts are imported only when a report asks for them.
		if (scope.source === "claude-code" || scope.source === "all") indexed.push(indexClaudeSessions(db, CLAUDE_PROJECTS));
		const failures = indexed.flatMap((i) => i.failed).map((f) => `could not index ${f.path}: ${f.error}`);
		return [report(db, scope), ...failures].join("\n\n");
	} finally {
		db.close();
	}
}
