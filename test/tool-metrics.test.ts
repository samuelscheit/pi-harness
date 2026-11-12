// The metrics of tool experiments: what tool results report (nested calls, changed files, goal,
// child session), child sessions linked to their parent and counted in its cost, per-tool usage
// per arm, and a schema rebuild that keeps imported Claude Code sessions.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ARM_ENTRY } from "../extensions/lib/experiments.ts";
import { indexSessions, parentSessionId } from "../extensions/metrics/indexer.ts";
import { experiments, Scope } from "../extensions/metrics/queries/index.ts";
import { indexAll } from "../extensions/metrics/stats.ts";
import { importedClaude, openStore, SCHEMA_VERSION } from "../extensions/metrics/store.ts";
import { reportedWork } from "../extensions/metrics/work.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tool-metrics-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const T = Date.parse("2026-11-13T10:00:00Z");
const at = (minute: number) => new Date(T + minute * 60_000).toISOString();
const usage = (cost: number, read = 0) => ({
	input: 10, output: 10, cacheRead: 100, cacheWrite: 0, totalTokens: 120,
	cost: { input: 0, output: cost - read, cacheRead: read, cacheWrite: 0, total: cost },
});

/** A Pi session file: header, then entries chained by parentId. */
function sessionFile(dirPath: string, id: string, body: object[], header: Record<string, unknown> = {}): string {
	mkdirSync(dirPath, { recursive: true });
	let n = 0;
	const lines = [
		{ type: "session", version: 3, id, timestamp: at(0), cwd: "/repo", ...header },
		...body.map((entry) => ({ id: `${id}-${++n}`, parentId: n > 1 ? `${id}-${n - 1}` : null, ...entry })),
	];
	const path = join(dirPath, `2026-11-13T10-00-00-000Z_${id}.jsonl`);
	writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	return path;
}

const user = (minute: number, text: string) => ({ type: "message", timestamp: at(minute), message: { role: "user", content: text, timestamp: 0 } });
const assistant = (minute: number, cost: number, calls: { id: string; name: string; arguments: object }[] = [], read = 0) => ({
	type: "message",
	timestamp: at(minute),
	message: {
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", ...c })),
		api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5",
		usage: usage(cost, read), stopReason: calls.length ? "toolUse" : "stop", timestamp: 0,
	},
});
const result = (minute: number, id: string, name: string, extra: object = {}) => ({
	type: "message",
	timestamp: at(minute),
	message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0, ...extra },
});
const arm = (minute: number, experiment: string, armName: "A" | "B") => ({ type: "custom", timestamp: at(minute), customType: ARM_ENTRY, data: { experiment, arm: armName, forced: false } });

describe("reported work", () => {
	test("nested calls, changed files, goal and child sessions from a tool result", () => {
		const work = reportedWork(
			[{ name: "edit", arguments: { path: "src/a.ts" } }, { name: "bash", arguments: { command: "sed -i 's/x/y/' src/b.ts" } }, { name: "read", arguments: { path: "c.ts" } }, { name: "write" }],
			{ changedFiles: ["src/d.ts", "/abs/e.ts", 3, ""], ok: false, childSessions: ["child-1", 7, "", "child-2"] },
			"/repo",
		);
		assert.deepEqual(work.effect.writes.sort(), ["/abs/e.ts", "/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/d.ts"]);
		assert.ok(work.effect.files.includes("/repo/c.ts"), "a nested read names its file");
		assert.equal(work.effect.mutates, true);
		assert.equal(work.ok, false);
		assert.deepEqual(work.childSessions, ["child-1", "child-2"]);
		const none = { effect: { files: [], writes: [], mutates: false }, childSessions: [] };
		assert.deepEqual(reportedWork(undefined, "text details", "/repo"), none);
		assert.deepEqual(reportedWork([], { ok: "yes", childSessions: "child-1" }, "/repo"), none);
	});

	test("a parent named by path resolves to its id: from its header, else its file name; an id stays", () => {
		const path = sessionFile(join(dir, "s"), "parent-id", []);
		assert.equal(parentSessionId(path), "parent-id");
		assert.equal(parentSessionId("/gone/2026-11-13T10-00-00-000Z_abc-123.jsonl"), "abc-123");
		assert.equal(parentSessionId("plain-id"), "plain-id");
		assert.equal(parentSessionId(undefined), undefined);
		const odd = join(dir, "noheader.jsonl");
		writeFileSync(odd, "not json\n");
		assert.equal(parentSessionId(odd), "noheader");
	});
});

describe("fix_loop sessions in the index and the comparison", () => {
	const sessions = () => join(dir, "sessions");

	/** A parent in `armName` of fix-loop with one fix_loop call that ran `child` and changed a.ts, then read it again (or not). */
	function parent(id: string, armName: "A" | "B", options: { child?: string; children?: string[]; ok?: boolean; reread?: boolean; cost?: number } = {}): string {
		const body: object[] = [user(0, "go"), arm(0, "fix-loop", armName), assistant(1, options.cost ?? 1, [{ id: `${id}-c1`, name: "bash", arguments: { command: "npm test" } }]), result(1, `${id}-c1`, "bash")];
		if (options.child) {
			body.push(
				assistant(2, 0.5, [{ id: `${id}-fl`, name: "fix_loop", arguments: { goal: "g", files: ["a.ts"], check: "npm test" } }]),
				result(3, `${id}-fl`, "fix_loop", { details: { ok: options.ok ?? true, changedFiles: ["/repo/a.ts"], childSessions: options.children ?? [options.child] } }),
			);
			if (options.reread) body.push(assistant(4, 0.25, [{ id: `${id}-r`, name: "read", arguments: { path: "a.ts" } }]), result(4, `${id}-r`, "read"));
		}
		body.push(assistant(5, 0.25));
		return sessionFile(sessions(), id, body);
	}
	const child = (id: string, parentPath: string, cost: number, read: number) =>
		sessionFile(sessions(), id, [user(2, "The check fails"), assistant(2, cost, [], read), assistant(3, cost, [], read)], { parentSession: parentPath });

	test("the child names its parent, the call links it, the result's files and goal are indexed", () => {
		const p = parent("P1", "B", { child: "K1", ok: true, reread: true });
		child("K1", p, 0.1, 0.04);
		const db = openStore(join(dir, "metrics.db"));
		assert.deepEqual(indexSessions(db, sessions()).failed, []);
		assert.equal((db.prepare("SELECT parent_session p FROM sessions WHERE id = 'K1'").get() as { p: string }).p, "P1");
		assert.deepEqual({ ...db.prepare("SELECT kind, thread_id, title FROM delegations WHERE session_id = 'P1'").get() }, { kind: "tool", thread_id: "K1", title: "fix_loop" });
		assert.deepEqual({ ...db.prepare("SELECT ok, mutates FROM tool_results WHERE call_id = 'P1-fl'").get() }, { ok: 1, mutates: 1 });
		assert.deepEqual(db.prepare("SELECT file, write FROM tool_files WHERE call_id = 'P1-fl'").all().map((r) => ({ ...r })), [{ file: "/repo/a.ts", write: 1 }]);
		assert.equal((db.prepare("SELECT ok FROM tool_results WHERE call_id = 'P1-c1'").get() as { ok: null }).ok, null, "tools without a goal report none");
		db.close();
	});

	test("a tool that ran several children links each of them", () => {
		const p = parent("P2", "B", { child: "K2", children: ["K2", "K3"] });
		child("K2", p, 0.1, 0);
		child("K3", p, 0.2, 0);
		const db = openStore(join(dir, "metrics.db"));
		assert.deepEqual(indexSessions(db, sessions()).failed, []);
		assert.deepEqual(
			db.prepare("SELECT call_id, kind, thread_id FROM delegations WHERE session_id = 'P2' ORDER BY call_id").all().map((r) => ({ ...r })),
			[{ call_id: "P2-fl/1", kind: "tool", thread_id: "K2" }, { call_id: "P2-fl/2", kind: "tool", thread_id: "K3" }],
		);
		db.close();
	});

	test("arm B's cost includes its children; usage, goal and re-read shares per arm", () => {
		// Arm A: two sessions without fix_loop, $1.25 each. Arm B: two sessions that ran children.
		parent("A1", "A");
		parent("A2", "A");
		const b1 = parent("B1", "B", { child: "K1", ok: true, reread: true, cost: 0.5 });
		const b2 = parent("B2", "B", { child: "K2", ok: false, reread: false, cost: 0.5 });
		child("K1", b1, 0.2, 0.1);
		child("K2", b2, 0.3, 0.1);
		// A child of an arm A session through another experiment's tool would count the same way; a fork does not.
		sessionFile(sessions(), "FORK", [user(1, "forked"), arm(1, "fix-loop", "A"), assistant(2, 9)], { parentSession: join(sessions(), "2026-11-13T10-00-00-000Z_A1.jsonl") });
		const db = openStore(join(dir, "metrics.db"));
		indexSessions(db, sessions());
		const [c] = experiments(new Scope(db, {}), [["fix-loop"]], (name) => (name === "fix-loop" ? ["fix_loop"] : []));
		const metric = (key: string) => c!.metrics.find((m) => m.key === key)!;
		assert.deepEqual(c!.sessions, { A: 3, B: 2 }, "the fork is a session of its own");
		// A: (1.25 + 1.25 + 9) / 3. B1: 0.5 + 0.5 (fix_loop) + 0.25 (re-read) + 0.25 + 0.4 child; B2: 0.5 + 0.5 + 0.25 + 0.6 child.
		assert.ok(Math.abs(metric("costPerSession").values.A! - 11.5 / 3) < 1e-9);
		assert.ok(Math.abs(metric("costPerSession").values.B! - (1.9 + 1.85) / 2) < 1e-9, `B ${metric("costPerSession").values.B}`);
		assert.ok(Math.abs(metric("childCostPerSession").values.B! - 0.5) < 1e-9);
		assert.equal(metric("childCostPerSession").values.A, 0);
		assert.ok(Math.abs(metric("readCostPerSession").values.B! - (0.2 + 0.2) / 2) < 1e-9, "children's cache reads count too");
		assert.deepEqual(metric("fix_loop:sessions").values, { A: 0, B: 1 });
		// B: 1 of 4 turns per session call fix_loop (P has 4 or 5 turns).
		assert.deepEqual(metric("fix_loop:turns").values, { A: 0, B: 2 / 7 });
		assert.deepEqual(metric("fix_loop:ok").values, { A: null, B: 0.5 });
		assert.deepEqual(metric("fix_loop:reread").values, { A: null, B: 0.5 });
		// Without tools to follow, the tool metrics are not reported.
		const [plain] = experiments(new Scope(db, {}), [["fix-loop"]]);
		assert.equal(plain!.metrics.some((m) => m.key.startsWith("fix_loop:")), false);
		db.close();
	});

	test("tool metrics undefined in every cell are left out", () => {
		parent("A1", "A");
		parent("B1", "B");
		const db = openStore(join(dir, "metrics.db"));
		indexSessions(db, sessions());
		const [c] = experiments(new Scope(db, {}), [["fix-loop"]], () => ["fix_loop"]);
		assert.deepEqual(c!.metrics.filter((m) => m.key.startsWith("fix_loop:")).map((m) => m.key), ["fix_loop:sessions", "fix_loop:turns"]);
		db.close();
	});
});

describe("schema rebuild", () => {
	const transcript = (session: string) =>
		[
			{ type: "user", sessionId: session, cwd: "/repo", uuid: "u1", timestamp: at(1), message: { role: "user", content: "hi" } },
			{
				type: "assistant", sessionId: session, cwd: "/repo", uuid: "a1", timestamp: at(2),
				message: { id: "m1", model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "hello" }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" },
			},
		].map((l) => JSON.stringify(l)).join("\n");
	const claudeDir = () => join(dir, "claude");
	const addTranscript = (session: string) => {
		mkdirSync(join(claudeDir(), "proj"), { recursive: true });
		writeFileSync(join(claudeDir(), "proj", `${session}.jsonl`), transcript(session));
	};
	const agentDir = () => join(dir, "agent");
	const claudeCount = (db: ReturnType<typeof openStore>) => (db.prepare("SELECT COUNT(*) n FROM sessions WHERE source = 'claude-code'").get() as { n: number }).n;
	/** Make the store look like one of an older schema, so the next open rebuilds it. */
	const age = (path: string, withFlag = true) => {
		const db = openStore(path);
		db.prepare("UPDATE meta SET value = '9' WHERE key = 'schema'").run();
		if (!withFlag) db.prepare("DELETE FROM meta WHERE key != 'schema'").run();
		db.close();
	};

	test("imported Claude Code sessions are imported again after a rebuild, without being asked", () => {
		addTranscript("c1");
		const path = join(dir, "metrics.db");
		let db = openStore(path);
		indexAll(db, { claude: true, agentDir: agentDir(), claudeDir: claudeDir() });
		assert.equal(claudeCount(db), 1);
		assert.equal(importedClaude(db), true);
		db.close();

		age(path);
		db = openStore(path);
		assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string }).value, String(SCHEMA_VERSION));
		assert.equal(claudeCount(db), 0, "the rebuild dropped them");
		indexAll(db, { agentDir: agentDir(), claudeDir: claudeDir() });
		assert.equal(claudeCount(db), 1, "re-imported by a Pi-only index");
		// With them in, a Pi-only index leaves Claude Code alone (as before the fix).
		addTranscript("c2");
		indexAll(db, { agentDir: agentDir(), claudeDir: claudeDir() });
		assert.equal(claudeCount(db), 1);
		indexAll(db, { claude: true, agentDir: agentDir(), claudeDir: claudeDir() });
		assert.equal(claudeCount(db), 2);
		db.close();
	});

	test("a store from before the flag counts as imported when it held Claude Code rows", () => {
		addTranscript("c1");
		const path = join(dir, "metrics.db");
		let db = openStore(path);
		indexAll(db, { claude: true, agentDir: agentDir(), claudeDir: claudeDir() });
		db.close();
		age(path, false);
		db = openStore(path);
		assert.equal(importedClaude(db), true);
		indexAll(db, { agentDir: agentDir(), claudeDir: claudeDir() });
		assert.equal(claudeCount(db), 1);
		db.close();
	});

	test("a store that never imported Claude Code does not start to after a rebuild", () => {
		addTranscript("c1");
		const path = join(dir, "metrics.db");
		let db = openStore(path);
		indexAll(db, { agentDir: agentDir(), claudeDir: claudeDir() });
		db.close();
		age(path);
		db = openStore(path);
		assert.equal(importedClaude(db), false);
		indexAll(db, { agentDir: agentDir(), claudeDir: claudeDir() });
		assert.equal(claudeCount(db), 0);
		db.close();
		// A fresh database has no schema to inherit from.
		const fresh = openStore(join(dir, "fresh.db"));
		assert.equal(importedClaude(fresh), false);
		fresh.close();
	});

	test("older code never downgrades a newer index: it refuses to open it and leaves the data", () => {
		addTranscript("c1");
		const path = join(dir, "metrics.db");
		const db = openStore(path);
		indexAll(db, { claude: true, agentDir: agentDir(), claudeDir: claudeDir() });
		db.prepare("UPDATE meta SET value = ? WHERE key = 'schema'").run(String(SCHEMA_VERSION + 1));
		db.close();
		assert.throws(() => openStore(path), new RegExp(`schema ${SCHEMA_VERSION + 1}, newer than this harness code \\(${SCHEMA_VERSION}\\); run /reload`));
		assert.throws(() => openStore(path), /newer than this harness code/, "still refused, nothing was dropped");
		const raw = new DatabaseSync(path);
		assert.equal(claudeCount(raw as ReturnType<typeof openStore>), 1, "the newer index keeps its rows");
		raw.close();
	});
});
