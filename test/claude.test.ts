import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { indexTranscript, modelPrices, parseTranscript, requestCost } from "../extensions/metrics/claude.ts";
import { openStore } from "../extensions/metrics/store.ts";
import { taskDigest } from "../extensions/metrics/work.ts";

const line = (entry: object) => JSON.stringify(entry);
const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 10, minute)).toISOString();
const usage = (read: number, write: number, long = 0) => ({
	input_tokens: 2,
	output_tokens: 100,
	cache_read_input_tokens: read,
	cache_creation_input_tokens: write,
	cache_creation: { ephemeral_1h_input_tokens: long, ephemeral_5m_input_tokens: write - long },
});
const base = { sessionId: "s1", cwd: "/repo" };
const assistant = (minute: number, id: string, content: object[], u = usage(1000, 100), extra = {}) =>
	line({ ...base, type: "assistant", uuid: `a${minute}${id}`, timestamp: at(minute), message: { id, model: "claude-opus-5-5", role: "assistant", content, usage: u, stop_reason: "tool_use" }, ...extra });
const user = (minute: number, content: unknown, extra = {}) => line({ ...base, type: "user", uuid: `u${minute}`, timestamp: at(minute), message: { role: "user", content }, ...extra });

describe("prices", () => {
	test("one-hour cache writes cost twice the input price, five-minute ones the write price", () => {
		const prices = modelPrices("claude-opus-5-5")!;
		assert.ok(prices.input > 0 && prices.write > prices.input);
		const short = requestCost(usage(0, 1_000_000, 0), prices).total - requestCost(usage(0, 0), prices).total;
		const long = requestCost(usage(0, 1_000_000, 1_000_000), prices).total - requestCost(usage(0, 0), prices).total;
		assert.ok(Math.abs(short - 1_000_000 * prices.write) < 1e-9);
		assert.ok(Math.abs(long - 2_000_000 * prices.input) < 1e-9);
	});

	test("splits the cost by billing rate, summing to the total", () => {
		const prices = modelPrices("claude-opus-5-5")!;
		const split = requestCost({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40, cache_creation: { ephemeral_1h_input_tokens: 15 } }, prices);
		assert.ok(Math.abs(split.input - 10 * prices.input) < 1e-12);
		assert.ok(Math.abs(split.output - 20 * prices.output) < 1e-12);
		assert.ok(Math.abs(split.read - 30 * prices.read) < 1e-12);
		assert.ok(Math.abs(split.write - (25 * prices.write + 15 * prices.input * 2)) < 1e-12);
		assert.ok(Math.abs(split.total - (split.input + split.output + split.read + split.write)) < 1e-12);
	});
});

describe("parseTranscript", () => {
	test("skips request recordings and lines cut off by a running session", () => {
		const parsed = parseTranscript([line({ type: "api-request-blob", hash: "x" }), '{"type":"user","mess', user(0, "hi")].join("\n"));
		assert.deepEqual(parsed.map((e) => e.type), ["user"]);
	});
});

describe("indexTranscript", () => {
	const prompt = "Find where the planner loads.";
	const main = [
		user(0, "Plan the work"),
		// One request written as two entries (one per content block), plus an older side-chain entry.
		assistant(1, "m1", [{ type: "text", text: "Reading." }]),
		assistant(1, "m1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/src/plan.ts" } }]),
		assistant(1, "side", [{ type: "text", text: "not mine" }], usage(5, 5), { isSidechain: true }),
		user(2, [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(4000) }]),
		assistant(3, "m2", [{ type: "tool_use", id: "t2", name: "Agent", input: { name: "scout", description: "Scout", prompt } }]),
		user(4, [{ type: "tool_result", tool_use_id: "t2", content: "launched" }], { toolUseResult: { agentId: "ag1", status: "async_launched" } }),
		assistant(5, "m3", [{ type: "tool_use", id: "t3", name: "SendMessage", input: { to: "scout", message: "also check X" } }]),
		user(6, [{ type: "tool_result", tool_use_id: "t3", content: "sent" }]),
		line({ ...base, type: "system", subtype: "compact_boundary", uuid: "c1", timestamp: at(7), compactMetadata: { trigger: "auto", preTokens: 900_000 } }),
		line({ ...base, type: "system", subtype: "compact_boundary", uuid: "c1", timestamp: at(7), compactMetadata: { trigger: "auto", preTokens: 900_000 } }),
		user(8, "Next task"),
		assistant(9, "m4", [{ type: "text", text: "Done with plan.ts" }]),
		line({ type: "cost-state", sessionId: "s1", totalCostUSD: 1.5 }),
		line({ type: "custom-title", sessionId: "s1", customTitle: "Planner work" }),
	].join("\n");
	const child = [user(3, prompt), assistant(4, "c1", [{ type: "text", text: "found it" }])].join("\n");

	const indexed = () => {
		const db = openStore(":memory:") as DatabaseSync;
		indexTranscript(db, "/p/proj/s1.jsonl", main, 1, 1);
		indexTranscript(db, "/p/proj/s1/subagents/agent-ag1.jsonl", child, 1, 1);
		return db;
	};

	test("requests are counted once per message id, side chains belong to the subagent files", () => {
		const db = indexed();
		const requests = db.prepare("SELECT entry_id FROM requests WHERE session_id = 's1' ORDER BY ts").all().map((r) => r.entry_id);
		assert.deepEqual(requests, ["m1", "m2", "m3", "m4"]);
		const session = db.prepare("SELECT name, source, reported_cost, requests, compactions, user_messages FROM sessions WHERE id = 's1'").get();
		assert.deepEqual({ ...session }, { name: "Planner work", source: "claude-code", reported_cost: 1.5, requests: 4, compactions: 1, user_messages: 2 });
	});

	test("a result stays in context until the next compaction and counts as used when named later", () => {
		const row = indexed().prepare("SELECT tokens, requests_in_context, referenced_later FROM tool_results WHERE call_id = 't1'").get();
		// Carried by m2 and m3; m4 comes after the compaction.
		assert.deepEqual({ ...row }, { tokens: 1000, requests_in_context: 2, referenced_later: 1 });
	});

	test("a shell edit marks its call as mutating and its file as written; a search does neither", () => {
		const db = openStore(":memory:") as DatabaseSync;
		const transcript = [
			user(0, "fix it"),
			assistant(1, "e1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "cd /repo && sed -i '' 's/a/b/' src/plan.ts" } }]),
			user(2, [{ type: "tool_result", tool_use_id: "b1", content: "" }]),
			assistant(3, "e2", [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "rg -n plan /repo/src" } }]),
			user(4, [{ type: "tool_result", tool_use_id: "b2", content: "src/plan.ts:1" }]),
			assistant(5, "e3", [{ type: "tool_use", id: "b3", name: "Bash", input: { command: "git stash" } }]),
			user(6, [{ type: "tool_result", tool_use_id: "b3", content: "" }]),
		].join("\n");
		indexTranscript(db, "/p/proj/s2.jsonl", transcript, 1, 1);
		const calls = db.prepare("SELECT call_id, mutates FROM tool_results ORDER BY ts").all().map((r) => ({ ...r }));
		assert.deepEqual(calls, [{ call_id: "b1", mutates: 1 }, { call_id: "b2", mutates: 0 }, { call_id: "b3", mutates: 1 }]);
		const files = db.prepare("SELECT call_id, file, write FROM tool_files ORDER BY call_id, file").all().map((r) => ({ ...r }));
		assert.deepEqual(files, [{ call_id: "b1", file: "/repo/src/plan.ts", write: 1 }, { call_id: "b2", file: "/repo/src", write: 0 }]);
	});

	test("an Agent call links to its subagent, a SendMessage by name is a resume of it", () => {
		const db = indexed();
		const rows = db.prepare("SELECT kind, thread_id, task_digest, title FROM delegations ORDER BY ts").all().map((r) => ({ ...r }));
		assert.deepEqual(rows, [
			{ kind: "delegate", thread_id: "s1/ag1", task_digest: taskDigest(prompt), title: "Scout" },
			{ kind: "send", thread_id: "s1/ag1", task_digest: null, title: null },
		]);
		const childRow = db.prepare("SELECT parent_session, prompt_digest FROM sessions WHERE id = 's1/ag1'").get();
		assert.deepEqual({ ...childRow }, { parent_session: "s1", prompt_digest: taskDigest(prompt) });
	});
});
