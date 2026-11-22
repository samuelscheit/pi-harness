// Indexes session files off the server's main thread (node:sqlite is synchronous), so the API
// keeps answering from the previous index while it runs.

import { parentPort, workerData } from "node:worker_threads";
import { indexAll } from "../../extensions/metrics/stats.ts";
import { openStore } from "../../extensions/metrics/store.ts";

const { path, agentDir, claudeDir, claude, agy, agyRoots } = workerData as {
	path: string;
	agentDir: string;
	claudeDir: string;
	claude: boolean;
	agy?: boolean;
	agyRoots?: string[];
};
const db = openStore(path);
try {
	const results = indexAll(db, { claude, agy: Boolean(agy), agentDir, claudeDir, ...(agyRoots ? { agyRoots } : {}) });
	parentPort!.postMessage({ indexed: results.reduce((sum, r) => sum + r.indexed, 0), failed: results.flatMap((r) => r.failed) });
} finally {
	db.close();
}
