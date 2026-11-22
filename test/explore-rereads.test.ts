// scripts/evidence/explore-rereads.ts: which reads a bash command makes, and the per-call analysis
// of a session file after explore calls.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyseSession, bashReads, near } from "../scripts/evidence/explore-rereads.ts";

test("bash reads: sed -n ranges, head, cat and nl, after a cd; other commands read nothing", () => {
	assert.deepEqual(bashReads("cd /r && sed -n '10,40p' src/a.ts; head -n 5 b.ts; cat c.md | wc -l; nl d.py; grep -n x e.ts; sed -n 7p f.ts; sed -n '3,$p' g.ts", "/x"), [
		{ path: "/r/src/a.ts", start: 10, end: 40 },
		{ path: "/r/b.ts", start: 1, end: 5 },
		{ path: "/r/c.md", start: 1, end: Infinity },
		{ path: "/r/d.py", start: 1, end: Infinity },
		{ path: "/r/f.ts", start: 7, end: 7 },
		{ path: "/r/g.ts", start: 3, end: Infinity },
	]);
	assert.deepEqual(bashReads("head -20 a.ts", "/x"), [{ path: "/x/a.ts", start: 1, end: 20 }]);
});

test("near: overlapping or within 30 lines in the same file", () => {
	const returned = [{ path: "/a", start: 100, end: 120 }];
	assert.equal(near({ path: "/a", start: 140, end: 160 }, returned), true);
	assert.equal(near({ path: "/a", start: 151, end: 160 }, returned), false);
	assert.equal(near({ path: "/a", start: 1, end: Infinity }, returned), true, "a whole-file read");
	assert.equal(near({ path: "/b", start: 100, end: 120 }, returned), false);
});

test("per explore call: near and elsewhere reads and turns to the first edit, until the next user prompt", () => {
	const dir = mkdtempSync(join(tmpdir(), "explore-rereads-"));
	try {
		const call = (name: string, args: object) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name, arguments: args }] } });
		const lines = [
			{ type: "session", cwd: "/r" },
			{ type: "message", message: { role: "user", content: "go" } },
			call("explore", { question: "q" }),
			{ type: "message", message: { role: "toolResult", toolName: "explore", content: [], details: { shown: [{ path: "src/a.ts", start: 10, end: 40 }] } } },
			call("read", { path: "/r/src/a.ts", offset: 1, limit: 60 }),
			call("bash", { command: "sed -n '1,20p' src/b.ts" }),
			call("edit", { path: "src/a.ts", edits: [] }),
			{ type: "message", message: { role: "user", content: "next" } },
			call("read", { path: "src/a.ts" }),
		];
		writeFileSync(join(dir, "s.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
		assert.deepEqual(analyseSession(join(dir, "s.jsonl")), [{ ranges: 1, nearReads: 1, elsewhereReads: 1, turnsToEdit: 3 }]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
