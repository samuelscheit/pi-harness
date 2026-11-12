// Replayed thinking in the metrics: sized at the reasoning tokens the model reported, not scaled,
// free when the API dropped it (thinking_dropped paths mapped back through the request layout), and
// cache rebuilds labelled only with what the session file shows.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { attribute, CHANGED_OUTSIDE_SESSION } from "../extensions/metrics/attribution.ts";
import { parsePrompt, thinkingDigest } from "../extensions/metrics/blocks.ts";
import { indexSessions } from "../extensions/metrics/indexer.ts";
import { droppedPaths, droppedThinking, thinkingPositions } from "../extensions/metrics/payload.ts";
import { report } from "../extensions/metrics/report.ts";
import { openStore } from "../extensions/metrics/store.ts";
import { assistant, dropDiagnostic, PRICE, system, thinking, toolCall, toolResult, usage, user } from "./metrics-fixtures.ts";

const head = system({ preamble: "p".repeat(400) }, []);
const thinkingBlocks = (messages: AgentMessage[], dropped?: Set<string>) => parsePrompt(messages, dropped).blocks.filter((b) => b.category === "thinking");
const close = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ""} ${actual} != ${expected}`);

describe("thinking block sizes", () => {
	// Estimates: 400 chars / 4 + 400 signature chars * 0.75 / 4 = 175; 1200 / 4 + 75 = 375.
	const short = thinking("a".repeat(400));
	const long = thinking("b".repeat(1200));

	test("one block takes the message's reported reasoning tokens, marked exact", () => {
		const [block] = thinkingBlocks([head, user("go"), assistant([short, toolCall("c1")], "toolUse", usage(1, 0, 0, 900, 820))]);
		assert.equal(block!.tokens, 820);
		assert.equal(block!.exact, true);
	});

	test("several blocks in one message split the reported tokens by their estimates", () => {
		const blocks = thinkingBlocks([head, user("go"), assistant([short, toolCall("c1"), long], "toolUse", usage(1, 0, 0, 900, 1100))]);
		assert.deepEqual(blocks.map((b) => b.tokens), [350, 750]);
		assert.ok(blocks.every((b) => b.exact));
	});

	test("without reported reasoning tokens a block keeps the text + signature estimate, to be scaled", () => {
		const blocks = thinkingBlocks([head, user("go"), assistant([short, long], "stop", usage(1, 0, 0, 900))]);
		assert.deepEqual(blocks.map((b) => b.tokens), [175, 375]);
		assert.ok(blocks.every((b) => b.exact === undefined));
	});

	test("a reported 0 stands", () => {
		const [block] = thinkingBlocks([head, user("go"), assistant([short], "stop", usage(1, 0, 0, 9, 0))]);
		assert.equal(block!.tokens, 0);
		assert.equal(block!.exact, true);
	});

	test("an unsigned block goes back as text: sized as text, no share of the reasoning", () => {
		const unsigned = { type: "thinking", thinking: "u".repeat(800) };
		const blocks = thinkingBlocks([head, user("go"), assistant([unsigned, short], "stop", usage(1, 0, 0, 900, 600))]);
		assert.deepEqual(blocks.map((b) => [b.tokens, b.exact]), [[200, undefined], [600, true]]);
	});

	test("a redacted block shares the reasoning like a signed one", () => {
		const redacted = { type: "thinking", thinking: "", thinkingSignature: "r".repeat(400 * 4), redacted: true };
		// Estimates 300 (signature only) and 175.
		const blocks = thinkingBlocks([head, user("go"), assistant([redacted, short], "stop", usage(1, 0, 0, 900, 950))]);
		assert.deepEqual(blocks.map((b) => b.tokens), [600, 350]);
	});

	test("blocks the API dropped count 0 tokens; the others keep their size", () => {
		const first = assistant([short, toolCall("c1")], "toolUse", usage(1, 0, 0, 9, 500));
		const second = assistant([long, toolCall("c2")], "toolUse", usage(1, 0, 0, 9, 700));
		const messages = [head, user("go"), first, toolResult("c1", "bash", "x"), second, toolResult("c2", "bash", "y")];
		const blocks = thinkingBlocks(messages, new Set([thinkingDigest(short)]));
		assert.deepEqual(blocks.map((b) => [b.tokens, b.exact]), [[0, true], [700, true]]);
		assert.deepEqual(thinkingBlocks(messages).map((b) => b.tokens), [500, 700], "a later request without drops prices both again");
	});
});

describe("attribution with reported sizes", () => {
	// Estimated: preamble 100 + user 100 + tool call ~4; thinking reported at 300.
	const messages = [head, user("u".repeat(400)), assistant([thinking("t".repeat(40)), toolCall("c1")], "toolUse", usage(1, 0, 0, 9, 300)), toolResult("c1", "bash", "r".repeat(400))];
	const prompt = parsePrompt(messages);
	const estimated = prompt.blocks.reduce((sum, b) => sum + (b.exact ? 0 : b.tokens), 0);

	test("reported sizes stand and estimates fill the rest of the prompt", () => {
		const u = usage(10, 1000, 290, 5);
		const result = attribute(prompt, u);
		assert.equal(result.composition.get("thinking")!.tokens, 300);
		const rest = [...result.composition].filter(([c]) => c !== "thinking" && c !== "model output").reduce((sum, [, c]) => sum + c.tokens, 0);
		close(rest, 1300 - 300, "estimated blocks scaled to the remainder");
		close(result.composition.get("user prompt")!.tokens, (100 * 1000) / estimated);
		const total = [...result.composition.values()].reduce((sum, c) => sum + c.read + c.write + c.uncached, 0);
		close(total, u.cost.total, "the split adds up to the recorded cost");
	});

	test("reported sizes larger than the prompt are scaled down to it, leaving nothing for estimates", () => {
		const result = attribute(prompt, usage(0, 200, 0, 1));
		assert.equal(result.composition.get("thinking")!.tokens, 200);
		assert.equal(result.composition.get("user prompt")!.tokens, 0);
	});

	test("with nothing estimated the reported sizes fill the prompt", () => {
		const onlyThinking = parsePrompt([assistant([thinking("t")], "stop", usage(1, 0, 0, 9, 100))]);
		assert.equal(attribute(onlyThinking, usage(0, 0, 400, 1)).composition.get("thinking")!.tokens, 400);
	});

	test("a dropped block costs nothing, also when it sits in the cached prefix", () => {
		const [block] = thinkingBlocks(messages);
		const dropped = parsePrompt(messages, new Set([block!.digest]));
		const result = attribute(dropped, usage(0, 1000, 0, 1));
		const c = result.composition.get("thinking")!;
		assert.deepEqual([c.blocks, c.tokens, c.read + c.write + c.uncached], [1, 0, 0]);
		close(result.composition.get("user prompt")!.read, ((100 * 1000) / estimated) * PRICE.read);
	});
});

describe("payload positions of thinking blocks", () => {
	const t1 = thinking("one");
	const t3 = thinking("three");
	const t5a = thinking("five a");
	const t5b = thinking("five b");
	const t5c = { type: "thinking" as const, thinking: "", thinkingSignature: "opaque", redacted: true };
	const levels = { providerThinkingLevel: "medium" };
	const conversation: AgentMessage[] = [
		head,
		user("go"),
		assistant([t1, toolCall("c1")], "toolUse", undefined, levels),
		toolResult("c1", "bash", "out"),
		// An appended update: held until the next assistant message that is sent.
		system({ preamble: "new" }, []),
		// Errored replies are not sent at all (nor their tool calls).
		assistant([thinking("lost"), toolCall("c9")], "error", undefined, levels),
		// Empty text is skipped and an unsigned block goes as text, so t3 is block 1.
		assistant([{ type: "text", text: " " }, { type: "thinking", thinking: "plain" }, t3, toolCall("c2"), toolCall("c3")], "toolUse", undefined, levels),
		toolResult("c2", "bash", "a"),
		toolResult("c3", "bash", "b"),
		// Another model's thinking is not sent; its effort marker is, since the provider is the same.
		assistant([thinking("other"), { type: "text", text: "hi" }, toolCall("c4")], "toolUse", undefined, { ...levels, model: "claude-sonnet-5-5" }),
		// c4 got no result: a synthetic one is sent; an empty user message is not.
		user("  "),
		{ role: "custom", customType: "note", content: "a note", display: true, timestamp: 0 } as AgentMessage,
		// No recorded effort: no marker before it.
		assistant([t5a, t5b, t5c, toolCall("c5")], "toolUse"),
		// c5 unanswered again; an assistant message with nothing to send is left out.
		assistant([{ type: "text", text: "  " }], "stop", undefined, levels),
	];
	const reply = (extra: Record<string, unknown> = {}) => assistant([], "stop", usage(1, 0, 0, 1), { providerThinkingLevel: "high", ...extra }) as AssistantMessage;

	test("with effort markers", () => {
		// 0 go, 1 marker, 2 a1, 3 result, 4 update, 5 marker, 6 a3, 7 results, 8 marker, 9 other model, 10 synthetic, 11 note, 12 a5, 13 synthetic.
		assert.deepEqual(Object.fromEntries(thinkingPositions(conversation, reply())), {
			"messages.2.content.0": thinkingDigest(t1),
			"messages.6.content.1": thinkingDigest(t3),
			"messages.12.content.0": thinkingDigest(t5a),
			"messages.12.content.1": thinkingDigest(t5b),
			"messages.12.content.2": thinkingDigest(t5c),
		});
	});

	test("without effort markers (the reply recorded no effort)", () => {
		assert.deepEqual([...thinkingPositions(conversation, reply({ providerThinkingLevel: undefined })).keys()], [
			"messages.1.content.0",
			"messages.4.content.1",
			"messages.9.content.0",
			"messages.9.content.1",
			"messages.9.content.2",
		]);
	});

	test("a request for another model sends none of this model's thinking", () => {
		assert.deepEqual([...thinkingPositions(conversation, reply({ model: "claude-sonnet-5-5" })).values()], [thinkingDigest(thinking("other"))]);
	});

	test("reads only thinking_dropped transformations and counts paths it cannot place", () => {
		const diagnostics = dropDiagnostic("messages.2.content.0", "messages.12.content.1", "messages.3.content.0").diagnostics;
		diagnostics[0]!.details.transformations.push({ type: "other_transformation", path: "messages.6.content.1", reason: "x" });
		const withOthers = reply({ diagnostics: [...diagnostics, { type: "anthropic_response_failure", timestamp: 0, details: { transformations: "none" } }] });
		assert.deepEqual(droppedPaths(withOthers), ["messages.2.content.0", "messages.12.content.1", "messages.3.content.0"]);
		const dropped = droppedThinking(conversation, withOthers);
		assert.equal(dropped.count, 3, "the API's count, also for the path that is no thinking block");
		assert.deepEqual([...dropped.digests], [thinkingDigest(t1), thinkingDigest(t5b)]);
		assert.deepEqual(droppedThinking(conversation, reply()), { count: 0, digests: new Set() });
	});
});

describe("indexing drops and rebuild causes", () => {
	let dir: string;
	let sessionsDir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-thinking-"));
		sessionsDir = join(dir, "sessions", "--project--");
		mkdirSync(sessionsDir, { recursive: true });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	let clock = Date.parse("2026-11-12T10:00:00Z");
	const entry = (id: string, parentId: string | null, body: Record<string, unknown>) => ({ id, parentId, timestamp: new Date((clock += 1000)).toISOString(), ...body });
	const message = (id: string, parentId: string | null, m: AgentMessage) => entry(id, parentId, { type: "message", message: m });
	const modelChange = (id: string, parentId: string | null) => entry(id, parentId, { type: "model_change", provider: "anthropic", modelId: "claude-opus-5-5" });

	/** A tool loop, then (after `between`) a request that lost the cache and reported `drops`. */
	function index(between: (parent: string) => object[], drops: string[]) {
		const t1 = thinking("x".repeat(400));
		const t2 = thinking("y".repeat(400));
		const middle = between("t2");
		const last = (middle.at(-1) as { id: string } | undefined)?.id ?? "t2";
		const lines = [
			{ type: "session", version: 3, id: "session-t", timestamp: new Date(clock).toISOString(), cwd: "/work" },
			modelChange("mc1", null),
			message("sys", "mc1", system({ preamble: "P".repeat(4000) })),
			message("u1", "sys", user("go")),
			message("a1", "u1", assistant([t1, toolCall("c1")], "toolUse", usage(1, 0, 2000, 20, 500))),
			message("t1", "a1", toolResult("c1", "bash", "out")),
			message("a2", "t1", assistant([t2, toolCall("c2")], "toolUse", usage(1, 2000, 500, 20, 300))),
			message("t2", "a2", toolResult("c2", "bash", "out")),
			...middle,
			message("u2", last, user("next")),
			message("a3", "u2", assistant([{ type: "text", text: "done" }], "stop", usage(1, 100, 3000, 5), dropDiagnostic(...drops))),
		];
		writeFileSync(join(sessionsDir, "t.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		const db = openStore(join(dir, "metrics.db"));
		assert.deepEqual(indexSessions(db, join(dir, "sessions")).failed, []);
		return db;
	}
	const row = (db: ReturnType<typeof openStore>, entryId: string) =>
		db.prepare(
			`SELECT r.cache_event, r.thinking_dropped, c.tokens thinking_tokens, c.read_cost + c.write_cost + c.uncached_cost thinking_cost
			FROM requests r LEFT JOIN request_costs c ON c.session_id = r.session_id AND c.entry_id = r.entry_id AND c.category = 'thinking' WHERE r.entry_id = ?`,
		).get(entryId) as { cache_event: string | null; thinking_dropped: number; thinking_tokens: number | null; thinking_cost: number | null };

	test("records the API's drops, prices those blocks at 0, and names a restart in the rebuild", () => {
		// u1 0, a1 1, t1 2, a2 3, t2 4, u2 5 (no effort markers recorded).
		const db = index((parent) => [modelChange("mc2", parent), entry("info", "mc2", { type: "session_info", name: "resumed" })], ["messages.1.content.0", "messages.3.content.0"]);
		const a2 = row(db, "a2");
		assert.deepEqual([a2.cache_event, a2.thinking_dropped, a2.thinking_tokens], [null, 0, 500], "a1's thinking at its reported 500");
		assert.ok(a2.thinking_cost! > 500 * PRICE.read && a2.thinking_cost! < 500 * PRICE.write, "partly read, partly written");
		const a3 = row(db, "a3");
		assert.equal(a3.cache_event, `${CHANGED_OUTSIDE_SESSION}, after a Pi restart`);
		assert.equal(a3.thinking_dropped, 2);
		assert.deepEqual([a3.thinking_tokens, a3.thinking_cost], [0, 0]);
		const parts = db.prepare("SELECT SUM(read_cost + write_cost + uncached_cost) c FROM request_costs WHERE entry_id = 'a3'").get() as { c: number };
		close(parts.c, usage(1, 100, 3000, 5).cost.total, "the dropped blocks' share goes to the rest");
		assert.match(report(db), /Thinking dropped by the API .*: 2 blocks in 1 requests of 1 sessions/);
		db.close();
	});

	test("a drop the request layout cannot place is counted but keeps its price", () => {
		const db = index(() => [], ["messages.1.content.0", "messages.2.content.0"]);
		const a3 = row(db, "a3");
		assert.equal(a3.thinking_dropped, 2);
		assert.ok(a3.thinking_tokens! > 0, "a2's thinking is still priced");
		assert.equal(a3.cache_event, CHANGED_OUTSIDE_SESSION, "no restart, no update: nothing in the session explains it");
		db.close();
	});

	test("an appended prompt update is named next to the cause, not as it", () => {
		const db = index((parent) => [message("upd", parent, system({ preamble: "Q".repeat(40) }, []))], []);
		assert.equal(row(db, "a3").cache_event, `${CHANGED_OUTSIDE_SESSION}, alongside a prompt or tools update`);
		assert.doesNotMatch(report(db), /Thinking dropped/, "no drops, no line");
		db.close();
	});
});
