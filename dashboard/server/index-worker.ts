// Indexes session files off the server's main thread (node:sqlite is synchronous), so the API
// keeps answering from the previous index while it runs.

import { parentPort, workerData } from "node:worker_threads";
import { indexAll } from "../../extensions/metrics/stats.ts";
import { openStore } from "../../extensions/metrics/store.ts";

const { path, agentDir, claudeDir, claude } = workerData as { path: string; agentDir: string; claudeDir: string; claude: boolean };
const db = openStore(path);
try {
	const results = indexAll(db, { claude, agentDir, claudeDir });
	parentPort!.postMessage({ indexed: results.reduce((sum, r) => sum + r.indexed, 0), failed: results.flatMap((r) => r.failed) });
} finally {
	db.close();
}
