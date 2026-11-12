// node dashboard/scripts/fixtures.ts — regenerates src/usage/fixtures.json, the frontend tests'
// API responses, from the seeded test store (test/seed.ts) through the real API routes.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../extensions/metrics/store.ts";
import { seed, T0 } from "../../test/seed.ts";
import { route } from "../server/api.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-fixtures-"));
const db = openStore(join(dir, "metrics.db"));
seed(db);
const now = T0 + 2 * 60 * 60_000;
const get = (path: string, params: Record<string, string> = {}) => route(db, path, new URLSearchParams(params), now);
const fixtures = {
	overview: get("overview"),
	content: get("breakdown", { group: "content" }),
	models: get("breakdown", { group: "model" }),
	context: get("context"),
	sessions: get("sessions"),
	sessionA: get("sessions/A"),
	sessionC: get("sessions/C"),
	sessionX1: get(`sessions/${encodeURIComponent("X/agent1")}`),
	waste: get("waste"),
	subagents: get("subagents"),
	versions: get("versions"),
	diff: get("versions/diff", { from: "v1", to: "v2" }),
	options: get("options", { source: "all" }),
};
db.close();
rmSync(dir, { recursive: true, force: true });
writeFileSync(new URL("../src/usage/fixtures.json", import.meta.url), `${JSON.stringify(fixtures, null, "\t")}\n`);
