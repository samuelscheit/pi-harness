import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { attribute, cacheEvent, ratesOf, type RequestState, requestState, type Usage } from "../extensions/metrics/attribution.ts";
import { imageTokens, parsePrompt, versionId } from "../extensions/metrics/blocks.ts";
import { idlePauses, indexSessions } from "../extensions/metrics/indexer.ts";
import { diffState, report } from "../extensions/metrics/report.ts";
import { openStore, SCHEMA_VERSION } from "../extensions/metrics/store.ts";

// Opus-like prices per token.
const PRICE = { input: 5e-6, read: 0.5e-6, write: 6.25e-6, output: 25e-6 };

function usage(input: number, cacheRead: number, cacheWrite: number, output: number): Usage {
	const cost = {
		input: input * PRICE.input,
		cacheRead: cacheRead * PRICE.read,
		cacheWrite: cacheWrite * PRICE.write,
		output: output * PRICE.output,
		total: 0,
	};
	cost.total = cost.input + cost.cacheRead + cost.cacheWrite + cost.output;
	return { input, output, cacheRead, cacheWrite, cacheWrite1h: 0, cost };
}

const tool = (name: string, description = `${name} tool`) => ({ name, description, parameters: { type: "object", properties: {} } });

const system = (sections: Record<string, string | null>, toolsAdded = [tool("bash"), tool("read")]): AgentMessage =>
	({ role: "system", content: "", sections, toolsAdded, timestamp: 0 }) as AgentMessage;

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 0 });

function assistant(content: unknown[], stopReason = "toolUse", u = usage(1, 0, 0, 10), extra: Record<string, unknown> = {}): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		thinkingLevel: "medium",
		usage: u,
		stopReason,
		timestamp: 0,
		...extra,
	} as AgentMessage;
}

const toolResult = (id: string, name: string, text: string, extra: Record<string, unknown> = {}): AgentMessage =>
	({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 0, ...extra }) as AgentMessage;

function png(width: number, height: number): string {
	const header = Buffer.alloc(24);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
	header.writeUInt32BE(width, 16);
	header.writeUInt32BE(height, 20);
	return header.toString("base64");
}

describe("blocks", () => {
	test("orders tool definitions, then system sections, then messages, and marks what is new", () => {
		const prompt = parsePrompt([
			system({ preamble: "P".repeat(400), cwd: "Current working directory: /x" }),
			user("do it"),
			assistant([{ type: "thinking", thinking: "hmm", thinkingSignature: "sig" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la" } }]),
			toolResult("c1", "bash", "file\n".repeat(100)),
		]);
		assert.deepEqual(
			prompt.blocks.map((b) => b.category),
			["tool definition: bash", "tool definition: read", "system: preamble", "system: cwd", "user prompt", "thinking", "tool call: bash", "tool result: bash"],
		);
		assert.deepEqual(prompt.sectionEnds, [2, 4]);
		assert.deepEqual(prompt.blocks.map((b) => b.isNew), [false, false, false, false, false, false, false, true]);
		assert.equal(prompt.blocks[2]!.tokens, 100);
		assert.equal(prompt.blocks.at(-1)!.toolCallId, "c1");
		assert.deepEqual(prompt.toolCalls.get("c1"), { name: "bash", summary: "ls -la" });
		assert.equal(prompt.messageCount, 3);
	});

	test("without an assistant message every message block is new", () => {
		const prompt = parsePrompt([system({ preamble: "p" }), user("a"), user("b")]);
		assert.deepEqual(prompt.blocks.filter((b) => b.isNew).map((b) => b.category), ["user prompt", "user prompt"]);
	});

	test("categorises coding-agent roles and skips bash output excluded from context", () => {
		const prompt = parsePrompt([
			system({ preamble: "p" }),
			{ role: "compactionSummary", summary: "earlier work", tokensBefore: 1000, timestamp: 0 } as AgentMessage,
			{ role: "branchSummary", summary: "other branch", fromId: null, timestamp: 0 } as AgentMessage,
			{ role: "custom", customType: "notice", content: "hello", display: true, timestamp: 0 } as AgentMessage,
			{ role: "bashExecution", command: "ls", output: "a", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 } as AgentMessage,
			{ role: "bashExecution", command: "secret", output: "b", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 0 } as AgentMessage,
			system({ skills: "new skills" }, []),
		]);
		assert.deepEqual(
			prompt.blocks.slice(prompt.sectionEnds[1]).map((b) => b.category),
			["compaction summary", "branch summary", "custom: notice", "user bash", "system update"],
		);
	});

	test("prices images by their downsized dimensions, and folds them into their tool result", () => {
		assert.equal(Math.round(imageTokens(png(1000, 750))), 1000);
		// 4000x2000 is scaled to fit 1568 px, then to 1.15 MP: 1516.6 x 758.3 / 750.
		assert.equal(Math.round(imageTokens(png(4000, 2000))), 1533);
		assert.equal(imageTokens("not an image"), 1600);
		const prompt = parsePrompt([
			system({ preamble: "p" }),
			{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: png(1000, 750), mimeType: "image/png" }], timestamp: 0 } as AgentMessage,
			{ role: "toolResult", toolCallId: "s", toolName: "screenshot", content: [{ type: "image", data: png(1000, 750), mimeType: "image/png" }], isError: false, timestamp: 0 } as AgentMessage,
		]);
		const image = prompt.blocks.find((b) => b.category === "image");
		const result = prompt.blocks.at(-1);
		assert.equal(image!.category, "image");
		assert.equal(Math.round(image!.tokens), 1000);
		assert.equal(result!.category, "tool result: screenshot");
		assert.equal(Math.round(result!.tokens), 1000);
	});

	test("a harness version follows prompt sections and initial tools, not tools loaded later", () => {
		const head = system({ preamble: "p", cwd: "c" });
		const base = versionId(parsePrompt([head, user("a")]).state);
		assert.equal(versionId(parsePrompt([system({ preamble: "p", cwd: "c" }), user("b")]).state), base, "same configuration, same id");
		const searched = [head, user("a"), system({}, [tool("mcp__t3__delegate")])];
		assert.equal(versionId(parsePrompt(searched).state), base, "tool search keeps the version");
		const patched = [head, user("a"), system({ preamble: "p2" }, [])];
		assert.notEqual(versionId(parsePrompt(patched).state), base, "a section update is a new version");
		const removed = [head, user("a"), system({ cwd: null }, [])];
		assert.deepEqual(Object.keys(parsePrompt(removed).state.sections), ["preamble"]);
		assert.notEqual(versionId(parsePrompt([system({ preamble: "p", cwd: "c" }, [tool("bash", "changed")])]).state), base);
	});
});

describe("attribution", () => {
	// 3 blocks of 100 estimated tokens; the provider counted 600, so each is 200.
	const prompt = parsePrompt([system({ a: "x".repeat(400), b: "y".repeat(400) }, []), user("z".repeat(400))]);

	test("walks the cache prefix: read, then write, then uncached, split inside a block", () => {
		const u = usage(100, 300, 200, 50);
		const result = attribute(prompt, u);
		const a = result.composition.get("system: a")!;
		const b = result.composition.get("system: b")!;
		const z = result.composition.get("user prompt")!;
		assert.equal(a.tokens, 200);
		assert.ok(Math.abs(a.read - 200 * PRICE.read) < 1e-12);
		assert.ok(Math.abs(b.read - 100 * PRICE.read) < 1e-12 && Math.abs(b.write - 100 * PRICE.write) < 1e-12);
		assert.ok(Math.abs(z.write - 100 * PRICE.write) < 1e-12 && Math.abs(z.uncached - 100 * PRICE.input) < 1e-12);
		assert.equal(z.newTokens, 200);
		const total = [...result.composition.values()].reduce((sum, c) => sum + c.read + c.write + c.uncached, 0);
		assert.ok(Math.abs(total - u.cost.total) < 1e-12, "the split adds up to the recorded cost");
		assert.equal(result.trigger, "user prompt");
		assert.equal(result.triggerTokens, 200);
	});

	test("takes a rate the request does not reveal from the previous request, else from typical ratios", () => {
		const noRead = usage(10, 0, 500, 1);
		assert.equal(ratesOf(noRead, { input: 1, read: 0.3, write: 2 }).read, 0.3);
		assert.ok(Math.abs(ratesOf(noRead).read - PRICE.input * 0.1) < 1e-15);
		assert.equal(ratesOf(usage(0, 0, 0, 1)).input, 0);
	});

	const state = (overrides: Partial<RequestState>): RequestState => ({
		ts: 0,
		promptTokens: 20_000,
		digests: ["t", "s", "m1", "m2"],
		categories: ["tool definition: bash", "system: preamble", "user prompt", "tool result: bash"],
		sectionEnds: [1, 2],
		messageCount: 10,
		newCategories: ["tool result: bash"],
		model: "m",
		thinking: "medium",
		longRetention: false,
		rates: { input: PRICE.input, read: PRICE.read, write: PRICE.write },
		...overrides,
	});
	const rebuilt = usage(1, 1_000, 21_000, 10);

	test("reports no event while the cache holds or loses only a little", () => {
		assert.equal(cacheEvent(undefined, state({}), rebuilt), undefined);
		assert.equal(cacheEvent(state({}), state({ ts: 1000, promptTokens: 21_000 }), usage(1, 19_990, 1_000, 1)), undefined);
		assert.equal(cacheEvent(state({}), state({ ts: 1000 }), usage(1, 18_500, 1_500, 1)), undefined, "1.5k lost stays below the threshold");
	});

	const cases: [string, Partial<RequestState>, string, boolean][] = [
		["idle past the 5 min TTL", { ts: 301_000 }, "cache expired after idle (5 min TTL)", true],
		["a model switch", { ts: 1000, model: "other" }, "model switched", true],
		["a thinking change", { ts: 1000, thinking: "high" }, "thinking level changed", true],
		["a compaction", { ts: 1000, messageCount: 3, digests: ["t", "s", "c"] }, "compaction", false],
		["a tool change", { ts: 1000, digests: ["T", "s", "m1", "m2"] }, "tool definitions changed", true],
		["a prompt change", { ts: 1000, digests: ["t", "S", "m1", "m2"] }, "system prompt changed", true],
		["an edited message", { ts: 1000, digests: ["t", "s", "m1", "M2"] }, "earlier tool result: bash changed", true],
		["a mid-conversation update", { ts: 1000, digests: ["t", "s", "m1", "m2", "u"], newCategories: ["system update"] }, "prompt or tools updated mid-conversation", true],
		["nothing visible", { ts: 1000, digests: ["t", "s", "m1", "m2", "r"] }, "cache missed without a prompt change", true],
	];
	for (const [name, overrides, cause, avoidable] of cases) {
		test(`explains a rebuild after ${name}`, () => {
			const event = cacheEvent(state({}), state(overrides), rebuilt)!;
			assert.equal(event.cause, cause);
			assert.equal(event.avoidable, avoidable);
			assert.equal(event.lostTokens, 19_000);
			const waste = avoidable ? 19_000 * (PRICE.write - PRICE.read) : 0;
			assert.ok(Math.abs(event.waste - waste) < 1e-12);
		});
	}

	test("a 1 h cache write extends the idle window", () => {
		assert.equal(cacheEvent(state({ longRetention: true }), state({ ts: 301_000, digests: ["t", "s", "m1", "m2", "x"] }), rebuilt)!.cause, "cache missed without a prompt change");
		assert.equal(cacheEvent(state({ longRetention: true }), state({ ts: 3_601_000 }), rebuilt)!.cause, "cache expired after idle (1 h TTL)");
	});

	test("records the predecessor state of a request", () => {
		const u = usage(1, 0, 600, 1);
		const s = requestState(prompt, attribute(prompt, u), { ...u, cacheWrite1h: 600 }, 5, "m", "low");
		assert.equal(s.promptTokens, 601);
		assert.equal(s.longRetention, true);
		assert.deepEqual(s.newCategories, ["user prompt"]);
	});
});

describe("indexer", () => {
	let dir: string;
	let sessionsDir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-metrics-"));
		sessionsDir = join(dir, "sessions", "--project--");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	let clock = Date.parse("2026-11-01T10:00:00Z");
	const entry = (id: string, parentId: string | null, body: Record<string, unknown>) => ({
		id,
		parentId,
		timestamp: new Date((clock += 1000)).toISOString(),
		...body,
	});
	const message = (id: string, parentId: string | null, m: AgentMessage) => entry(id, parentId, { type: "message", message: m });

	/** A session with a tool run, a steer, an interrupt, a branch, a compaction and a cache warm. */
	function writeSession(name: string, cwd = "/work/project", extra: object[] = []): string {
		const head = system({ preamble: "P".repeat(4000), cwd: `cwd ${cwd}` });
		const lines = [
			{ type: "session", version: 3, id: `session-${name}`, timestamp: new Date(clock).toISOString(), cwd },
			message("sys", null, head),
			message("u1", "sys", user("list files")),
			message("a1", "u1", assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], "toolUse", usage(1, 0, 1100, 20))),
			message("t1", "a1", toolResult("c1", "bash", "x".repeat(4000), { durationMs: 120 })),
			message("a2", "t1", assistant([{ type: "toolCall", id: "c2", name: "read", arguments: { path: "a.ts" } }], "toolUse", usage(1, 1100, 1000, 20))),
			message("t2", "a2", toolResult("c2", "read", "y".repeat(400), { isError: true, durationMs: 3, usage: usage(500, 0, 0, 100) })),
			message("s1", "t2", user("use rg instead")),
			message("a3", "s1", assistant([{ type: "text", text: "done" }], "stop", usage(1, 2100, 200, 5))),
			message("u2", "a3", user("now the tests")),
			message("a4", "u2", assistant([], "aborted", usage(1, 2300, 10, 0))),
			message("u3", "a4", user("stop, wrong file")),
			// A branch from a3: a request that does not carry u2/a4/u3.
			message("u4", "a3", user("other branch")),
			message("a5", "u4", assistant([{ type: "text", text: "ok" }], "stop", usage(1, 2300, 10, 5))),
			entry("cmp", "a5", {
				type: "compaction",
				summary: "summary of everything",
				firstKeptEntryId: "u4",
				tokensBefore: 2300,
				usage: usage(2300, 0, 0, 300),
				systemMessage: head,
			}),
			message("u5", "cmp", user("continue")),
			message("a6", "u5", assistant([{ type: "text", text: "continuing" }], "stop", usage(1, 1050, 30, 5))),
			entry("warm", "a6", { type: "usage", kind: "cache_warm", provider: "anthropic", model: "claude-opus-5-5", usage: usage(0, 1080, 0, 1) }),
			entry("info", "warm", { type: "session_info", name: "Listing files" }),
			...extra,
		];
		const path = join(sessionsDir, `${name}.jsonl`);
		writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, { flag: "w" });
		return path;
	}

	function store() {
		mkdirSync(sessionsDir, { recursive: true });
		return openStore(join(dir, "metrics.db"));
	}

	test("indexes requests, costs, tools, user messages and side calls of a session", () => {
		const db = store();
		writeSession("one");
		assert.deepEqual(indexSessions(db, join(dir, "sessions")), { files: 1, indexed: 1, failed: [] });

		const session = db.prepare("SELECT * FROM sessions").get() as Record<string, unknown>;
		assert.equal(session.name, "Listing files");
		assert.equal(session.requests, 6);
		assert.equal(session.aborted, 1);
		assert.equal(session.compactions, 1);
		assert.equal(session.user_messages, 6);
		const allCost = db.prepare("SELECT SUM(cost) c FROM requests").get() as { c: number };
		assert.ok(Math.abs((session.cost as number) - allCost.c) < 1e-12, "session cost includes side calls");

		const kinds = db.prepare("SELECT kind, COUNT(*) n FROM requests GROUP BY kind ORDER BY kind").all();
		assert.deepEqual(kinds.map((k) => ({ ...k })), [
			{ kind: "cache_warm", n: 1 },
			{ kind: "compaction", n: 1 },
			{ kind: "tool: read", n: 1 },
			{ kind: "turn", n: 6 },
		]);

		for (const row of db.prepare(
			`SELECT r.entry_id, r.cost, SUM(c.read_cost + c.write_cost + c.uncached_cost) parts
			FROM requests r JOIN request_costs c USING (session_id, entry_id) GROUP BY r.entry_id`,
		).all() as { entry_id: string; cost: number; parts: number }[]) {
			assert.ok(Math.abs(row.cost - row.parts) < 1e-12, `${row.entry_id}: split adds up`);
		}

		const triggers = Object.fromEntries((db.prepare("SELECT entry_id, trigger FROM requests WHERE kind = 'turn'").all() as { entry_id: string; trigger: string }[]).map((r) => [r.entry_id, r.trigger]));
		// a3 answers both the failed read and the steer; the tool result counts as the trigger.
		assert.deepEqual(triggers, { a1: "user prompt", a2: "tool result: bash", a3: "tool result: read", a4: "user prompt", a5: "user prompt", a6: "user prompt" });

		const users = Object.fromEntries((db.prepare("SELECT entry_id, kind FROM user_messages").all() as { entry_id: string; kind: string }[]).map((r) => [r.entry_id, r.kind]));
		assert.deepEqual(users, { u1: "first", s1: "steer", u2: "follow-up", u3: "after interrupt", u4: "follow-up", u5: "follow-up" });

		const tools = db.prepare("SELECT call_id, tool, summary, is_error, duration_ms, requests_in_context, lifetime_cost > 0 paid FROM tool_results ORDER BY call_id").all();
		assert.deepEqual(tools.map((t) => ({ ...t })), [
			// c1 is carried by a2, a3, a4 and the branch a5; the compaction then drops it.
			{ call_id: "c1", tool: "bash", summary: "ls", is_error: 0, duration_ms: 120, requests_in_context: 4, paid: 1 },
			{ call_id: "c2", tool: "read", summary: "a.ts", is_error: 1, duration_ms: 3, requests_in_context: 3, paid: 1 },
		]);

		assert.equal((db.prepare("SELECT COUNT(DISTINCT version) n FROM requests WHERE kind = 'turn'").get() as { n: number }).n, 1);
		const blobs = db.prepare("SELECT kind, name FROM blobs ORDER BY kind, name").all().map((b) => ({ ...b }));
		assert.deepEqual(blobs, [
			{ kind: "section", name: "cwd" },
			{ kind: "section", name: "preamble" },
			{ kind: "tool", name: "bash" },
			{ kind: "tool", name: "read" },
		]);
		assert.deepEqual(
			db.prepare("SELECT entry_id, reason, tokens_before, cost > 0 paid FROM compactions").all().map((r) => ({ ...r })),
			[{ entry_id: "cmp", reason: null, tokens_before: 2300, paid: 1 }],
		);
		const afterCompaction = db.prepare("SELECT message_count FROM requests WHERE entry_id = 'a6'").get() as { message_count: number };
		assert.equal(afterCompaction.message_count, 4, "the summary, the kept u4 and a5, then u5");
		db.close();
	});

	test("re-indexes only changed files and forgets deleted ones", () => {
		const db = store();
		const one = writeSession("one");
		writeSession("two", "/work/other");
		assert.equal(indexSessions(db, join(dir, "sessions")).indexed, 2);
		assert.equal(indexSessions(db, join(dir, "sessions")).indexed, 0, "nothing changed");

		writeSession("one", "/work/project", [message("u9", "info", user("one more"))]);
		utimesSync(one, new Date(), new Date(Date.now() + 5000));
		assert.equal(indexSessions(db, join(dir, "sessions")).indexed, 1);
		assert.equal((db.prepare("SELECT user_messages FROM sessions WHERE id = 'session-one'").get() as { user_messages: number }).user_messages, 7);
		assert.equal((db.prepare("SELECT COUNT(*) n FROM requests WHERE session_id = 'session-one'").get() as { n: number }).n, 9, "no duplicates");

		unlinkSync(one);
		indexSessions(db, join(dir, "sessions"));
		assert.deepEqual(db.prepare("SELECT id FROM sessions").all().map((r) => ({ ...r })), [{ id: "session-two" }]);
		assert.equal((db.prepare("SELECT COUNT(*) n FROM requests WHERE session_id = 'session-one'").get() as { n: number }).n, 0);
		db.close();
	});

	test("reports a broken session file and keeps indexing the rest", () => {
		const db = store();
		writeSession("good");
		writeFileSync(join(sessionsDir, "broken.jsonl"), "{\"type\":\"message\"}\n");
		const result = indexSessions(db, join(dir, "sessions"));
		assert.equal(result.indexed, 1);
		assert.equal(result.failed.length, 1);
		assert.match(result.failed[0]!.error, /no session header/);
		db.close();
	});

	test("rebuilds the store when the schema version changes", () => {
		const path = join(dir, "metrics.db");
		const db = store();
		writeSession("one");
		indexSessions(db, join(dir, "sessions"));
		db.prepare("UPDATE meta SET value = '0' WHERE key = 'schema'").run();
		db.close();
		const reopened = openStore(path);
		assert.equal((reopened.prepare("SELECT COUNT(*) n FROM sessions").get() as { n: number }).n, 0);
		assert.equal((reopened.prepare("SELECT value FROM meta").get() as { value: string }).value, String(SCHEMA_VERSION));
		reopened.close();
		assert.ok(new DatabaseSync(path));
	});

	test("reports per scope", () => {
		const db = store();
		writeSession("one");
		writeSession("two", "/work/other");
		indexSessions(db, join(dir, "sessions"));
		const scoped = report(db, { cwd: "/work/project" });
		assert.match(scoped, /^1 sessions, 6 model requests/);
		assert.match(scoped, /1 interrupted/);
		assert.match(scoped, /1 after interrupt/);
		assert.match(scoped, /Where the cost goes/);
		assert.match(scoped, /bash\s+1\s+0%\s+120ms/);
		assert.doesNotMatch(scoped, /project\s+first seen/, "one project: no project column");
		const all = report(db);
		assert.match(all, /^2 sessions, 12 model requests/);
		assert.match(all, /version\s+project/);
		assert.equal(report(db, { cwd: "/nowhere" }), "No Pi sessions recorded for this scope yet.");
		db.close();
	});
});

describe("idle pauses", () => {
	const min = 60_000;
	const turn = (ts: number, cacheRead = 0, promptTokens = 100_000, writeCost = 0) => ({ ts, promptTokens, cacheRead, writeCost });

	test("classifies how a session resumed after a pause, and ignores short gaps", () => {
		const turns = [
			turn(0),
			turn(4 * min, 99_000), // 4 min: no pause
			turn(54 * min, 99_000), // warm after 50 min, kept by two refreshes
			turn(120 * min, 0, 100_000, 0.8), // cold: rebuilt
			turn(200 * min, 0, 40_000, 0.2), // compacted first
		];
		const warms = [{ ts: 20 * min, cost: 0.02 }, { ts: 45 * min, cost: 0.02 }, { ts: 300 * min, cost: 0.03 }];
		const pauses = idlePauses(turns, warms, [199 * min], 310 * min);
		assert.deepEqual(
			pauses.map((p) => [p.outcome, Math.round(p.minutes), p.warms, Math.round(p.warmCost * 100) / 100, p.resumeWriteCost]),
			[
				["warm", 50, 2, 0.04, 0],
				["cold", 66, 0, 0, 0.8],
				["compacted", 80, 0, 0, 0.2],
				["open", 110, 1, 0.03, 0],
			],
		);
		assert.equal(pauses.at(-1)!.end, undefined);
	});

	test("has no open pause when the session just ended", () => {
		assert.deepEqual(idlePauses([turn(0), turn(min, 99_000)], [], [], 2 * min), []);
	});
});

test("diffState names changed, added and removed sections and tools", () => {
	assert.equal(diffState({ sections: { a: "1", b: "1" }, tools: { x: "1" } }, { sections: { a: "2", c: "1" }, tools: { x: "1" } }), "a -b +c");
	assert.equal(diffState({ sections: {}, tools: {} }, { sections: {}, tools: {} }), "same");
	const many = Object.fromEntries(["a", "b", "c", "d", "e"].map((k) => [k, "1"]));
	assert.equal(diffState({ sections: {}, tools: {} }, { sections: {}, tools: many }), "5 tools");
});
