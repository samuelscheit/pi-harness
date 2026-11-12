// A small metrics store with every kind of row, for the query layer and dashboard API tests.
//
// Pi, project /p1 (all at T0 + minutes):
//   A  parent, 4 turns (opus) at 0..3 min, versions v1 (turns 1–2) and v2 (3–4), a model-switch
//      rebuild on turn 2, a cache warm at 10, a threshold compaction at 5, a cold pause 3→20,
//      tool results (bash with a file never used again; read with an error), user messages
//      (first, a steer answered by turn 3, after interrupt answered by turn 4), and two
//      delegations: "Scout" at 1 (child C) and "Second" at 30 (child D).
//   C  subagent of A, 2 turns (sonnet) at 2 and 4.
//   D  subagent of A, 2 turns (sonnet) at 30.5 and 31.
// Pi, project /p2: B, 1 turn two days earlier, version v9.
// Claude Code, project /p1: X, 3 turns an hour later, totals only (no prompt content, no version),
// and its subagent X/agent1 (1 turn, linked by parent_session).

import type { DatabaseSync } from "node:sqlite";

export const MIN = 60_000;
export const T0 = new Date(2026, 10, 10, 10, 0, 0).getTime();
export const RATES = { input: 5e-6, read: 0.5e-6, write: 6.25e-6 };

const TABLES = ["sessions", "requests", "request_costs", "tool_results", "tool_files", "delegations", "user_messages", "compactions", "idle_pauses", "versions", "blobs"] as const;

function insert(db: DatabaseSync, table: (typeof TABLES)[number], row: Record<string, string | number | null>) {
	const keys = Object.keys(row);
	if (!TABLES.includes(table) || !keys.every((key) => /^[a-z_]+$/.test(key))) throw new Error(`not a metrics table or column: ${table}`);
	db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...Object.values(row));
}

interface Turn {
	session: string;
	entry: string;
	at: number;
	model?: string;
	kind?: string;
	version?: string | null;
	split?: { read: number; write: number; uncached: number; output: number };
	prompt?: number;
	cacheRead?: number;
	event?: [string, number, number];
	stop?: string;
	/** Thinking blocks the API dropped from the request. */
	dropped?: number;
}

export const TURN_SPLIT = { read: 0.1, write: 0.2, uncached: 0.01, output: 0.05 };
export const turnCost = (split = TURN_SPLIT) => split.read + split.write + split.uncached + split.output;

function request(db: DatabaseSync, t: Turn) {
	const split = t.split ?? TURN_SPLIT;
	const prompt = t.prompt ?? 100_000;
	insert(db, "requests", {
		session_id: t.session,
		entry_id: t.entry,
		ts: t.at,
		kind: t.kind ?? "turn",
		provider: "anthropic",
		model: t.model ?? "claude-opus",
		thinking: null,
		stop_reason: t.stop ?? "toolUse",
		version: t.version ?? null,
		input: 10,
		output: 500,
		cache_read: t.cacheRead ?? prompt - 10_000,
		cache_write: 10_000,
		prompt_tokens: prompt,
		cost: turnCost(split),
		cost_input: split.uncached,
		cost_output: split.output,
		cost_read: split.read,
		cost_write: split.write,
		message_count: 4,
		trigger: null,
		trigger_tokens: 0,
		cache_event: t.event?.[0] ?? null,
		cache_lost: t.event?.[1] ?? 0,
		cache_waste: t.event?.[2] ?? 0,
		input_rate: (t.kind ?? "turn") === "turn" ? RATES.input : null,
		read_rate: (t.kind ?? "turn") === "turn" ? RATES.read : null,
		write_rate: (t.kind ?? "turn") === "turn" ? RATES.write : null,
		long_retention: 0,
		thinking_dropped: t.dropped ?? 0,
	});
}

/** Prompt content of a Pi turn: its whole cost split over bash results, thinking and output. */
function content(db: DatabaseSync, session: string, entry: string, split = TURN_SPLIT) {
	const rows: [string, number, number, number, number][] = [
		["tool result: bash", 5000, 0.06, 0.1, 0],
		["thinking", 3000, split.read - 0.06, split.write - 0.1, split.uncached],
		["tool definition: bash", 800, 0, 0, 0],
		["model output", 500, 0, 0, split.output],
	];
	for (const [category, tokens, read, write, uncached] of rows) {
		insert(db, "request_costs", { session_id: session, entry_id: entry, category, blocks: 1, tokens, new_tokens: tokens / 10, read_cost: read, write_cost: write, uncached_cost: uncached });
	}
}

function session(db: DatabaseSync, row: { id: string; cwd: string; source?: string; at: number; end: number; name?: string | null; parent?: string | null; digest?: string | null }) {
	insert(db, "sessions", {
		id: row.id,
		file: `/sessions/${row.id}.jsonl`,
		cwd: row.cwd,
		parent_session: row.parent ?? null,
		name: row.name ?? null,
		source: row.source ?? "pi",
		reported_cost: null,
		prompt_digest: row.digest ?? null,
		started_at: row.at,
		ended_at: row.end,
		requests: 0,
		cost: 0,
		aborted: 0,
		errors: 0,
		compactions: 0,
		user_messages: 0,
	});
}

export function seed(db: DatabaseSync) {
	const at = (minutes: number) => T0 + minutes * MIN;
	insert(db, "versions", { id: "v1", sections: JSON.stringify({ base: "h-base1", cwd: "h-cwd1" }), tools: JSON.stringify({ bash: "h-bash" }), first_seen: at(0) });
	insert(db, "versions", { id: "v2", sections: JSON.stringify({ base: "h-base2", cwd: "h-cwd1", skills: "h-skills" }), tools: JSON.stringify({ bash: "h-bash" }), first_seen: at(2) });
	insert(db, "versions", { id: "v9", sections: JSON.stringify({ base: "h-base1", cwd: "h-cwd2" }), tools: JSON.stringify({ bash: "h-bash" }), first_seen: at(-2 * 1440) });
	for (const [hash, kind, name, text] of [
		["h-base1", "section", "base", "You are Pi.\nBe brief.\nUse tools."],
		["h-base2", "section", "base", "You are Pi.\nBe thorough.\nUse tools."],
		["h-cwd1", "section", "cwd", "cwd /p1"],
		["h-cwd2", "section", "cwd", "cwd /p2"],
		["h-skills", "section", "skills", "skill a\nskill b"],
		["h-bash", "tool", "bash", "run a command"],
	]) insert(db, "blobs", { hash: hash!, kind: kind!, name: name!, text: text! });

	session(db, { id: "A", cwd: "/p1", at: at(-0.1), end: at(31), name: "Parent work" });
	for (const [i, minute] of [0, 1, 2, 3].entries()) {
		request(db, { session: "A", entry: `a${i + 1}`, at: at(minute), version: i < 2 ? "v1" : "v2", event: i === 1 ? ["model switched", 10_000, 0.05] : undefined, dropped: i === 2 ? 7 : 0, prompt: 100_000 + i * 50_000 });
		content(db, "A", `a${i + 1}`);
	}
	request(db, { session: "A", entry: "warm", kind: "cache_warm", at: at(10), split: { read: 0.02, write: 0, uncached: 0, output: 0 } });
	request(db, { session: "A", entry: "cmp", kind: "compaction", model: "", at: at(5), split: { read: 0, write: 0, uncached: 0.03, output: 0.01 } });
	insert(db, "compactions", { session_id: "A", entry_id: "cmp", ts: at(5), reason: "threshold", tokens_before: 250_000, cost: 0.04 });
	insert(db, "idle_pauses", { session_id: "A", start_ts: at(3), end_ts: at(20), minutes: 17, warms: 1, warm_cost: 0.02, outcome: "cold", prompt_tokens: 250_000, resume_cost: 0.2 });
	insert(db, "tool_results", { session_id: "A", call_id: "c1", ts: at(0.5), tool: "bash", summary: "cat a.ts", is_error: 0, duration_ms: 100, tokens: 5000, requests_in_context: 3, lifetime_cost: 0.3, version: "v1", referenced_later: 0, mutates: 0 });
	insert(db, "tool_results", { session_id: "A", call_id: "c2", ts: at(2.5), tool: "read", summary: "b.ts", is_error: 1, duration_ms: 3, tokens: 100, requests_in_context: 1, lifetime_cost: 0.01, version: "v2", referenced_later: 1, mutates: 0 });
	insert(db, "tool_files", { session_id: "A", call_id: "c1", ts: at(0.5), file: "/p1/a.ts", write: 0 });
	insert(db, "tool_files", { session_id: "A", call_id: "c2", ts: at(2.5), file: "/p1/b.ts", write: 0 });
	insert(db, "user_messages", { session_id: "A", entry_id: "u1", ts: at(-0.05), kind: "first", text: "Do the parent work" });
	insert(db, "user_messages", { session_id: "A", entry_id: "u2", ts: at(1.5), kind: "steer", text: "not that file" });
	insert(db, "user_messages", { session_id: "A", entry_id: "u3", ts: at(2.5), kind: "after interrupt", text: "stop" });
	insert(db, "delegations", { session_id: "A", call_id: "d1", ts: at(1), kind: "delegate", thread_id: "t1", task_digest: "dig-scout", title: "Scout" });
	insert(db, "delegations", { session_id: "A", call_id: "d2", ts: at(30), kind: "delegate", thread_id: "t2", task_digest: "dig-second", title: "Second" });

	session(db, { id: "C", cwd: "/p1", at: at(1.1), end: at(4), digest: "dig-scout" });
	request(db, { session: "C", entry: "c-1", at: at(2), model: "claude-sonnet", version: "v1", prompt: 20_000, cacheRead: 0 });
	request(db, { session: "C", entry: "c-2", at: at(4), model: "claude-sonnet", version: "v1", prompt: 30_000 });
	// C read a.ts, which its parent had read already: rediscovery.
	insert(db, "tool_results", { session_id: "C", call_id: "cc1", ts: at(3), tool: "read", summary: "a.ts", is_error: 0, duration_ms: 5, tokens: 2000, requests_in_context: 1, lifetime_cost: 0.02, version: "v1", referenced_later: 1, mutates: 0 });
	insert(db, "tool_files", { session_id: "C", call_id: "cc1", ts: at(3), file: "/p1/a.ts", write: 0 });

	session(db, { id: "D", cwd: "/p1", at: at(30.2), end: at(31), digest: "dig-second" });
	request(db, { session: "D", entry: "d-1", at: at(30.5), model: "claude-sonnet", version: "v1", prompt: 20_000, cacheRead: 0 });
	request(db, { session: "D", entry: "d-2", at: at(31), model: "claude-sonnet", version: "v1", prompt: 25_000 });

	session(db, { id: "B", cwd: "/p2", at: at(-2 * 1440), end: at(-2 * 1440 + 1), name: "Other project" });
	request(db, { session: "B", entry: "b1", at: at(-2 * 1440), version: "v9", split: { read: 0.5, write: 0.3, uncached: 0.1, output: 0.1 } });
	content(db, "B", "b1", { read: 0.5, write: 0.3, uncached: 0.1, output: 0.1 });

	session(db, { id: "X", cwd: "/p1", source: "claude-code", at: at(60), end: at(62) });
	for (const i of [0, 1, 2]) request(db, { session: "X", entry: `x${i}`, at: at(60 + i), split: { read: 0.2, write: 0.2, uncached: 0, output: 0.1 } });
	insert(db, "user_messages", { session_id: "X", entry_id: "xu", ts: at(59.9), kind: "first", text: "Claude Code task. Second sentence." });
	session(db, { id: "X/agent1", cwd: "/p1", source: "claude-code", at: at(61), end: at(61.5), parent: "X" });
	request(db, { session: "X/agent1", entry: "xa", at: at(61.2), split: { read: 0.2, write: 0.2, uncached: 0, output: 0.1 } });
	// Session totals as the indexers write them: the sum of their requests.
	db.exec(`UPDATE sessions SET cost = (SELECT SUM(cost) FROM requests r WHERE r.session_id = sessions.id),
		requests = (SELECT COUNT(*) FROM requests r WHERE r.session_id = sessions.id AND r.kind = 'turn'),
		compactions = (SELECT COUNT(*) FROM compactions c WHERE c.session_id = sessions.id),
		user_messages = (SELECT COUNT(*) FROM user_messages u WHERE u.session_id = sessions.id)`);
}
