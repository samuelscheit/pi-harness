// Index the sessions, then report: the one entry point for `/harness stats` and the CLI.

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { indexSessions } from "./indexer.ts";
import { report, type Scope } from "./report.ts";
import { openStore } from "./store.ts";



export function stats(scope: Scope, agentDir = getAgentDir()): string {
	const db = openStore(join(agentDir, "metrics.db"));
	try {
		const indexed = indexSessions(db, join(agentDir, "sessions"));
		const failures = indexed.failed.map((f) => `could not index ${f.path}: ${f.error}`);
		return [report(db, scope), ...failures].join("\n\n");
	} finally {
		db.close();
	}
}
