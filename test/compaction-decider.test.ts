// The compaction decider (extensions/context-limit/decider.ts): the question in its four framings,
// answers and their fallbacks, where it asks next, the hook with a scripted Pi, Pi's askAside and
// summary instructions in real sessions on a faux model, the whole decider in real sessions, and
// the metrics of decisions by framing.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionUIContext,
	ModelRuntime,
	type SessionEntry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type Answer,
	DECISION_ENTRY,
	type DecisionData,
	deciderThreshold,
	draw,
	type Facts,
	FRAMINGS,
	filesOf,
	parseAnswer,
	preserveInstructions,
	question,
	STEP_TOKENS,
	settle,
} from "../extensions/context-limit/decider.ts";
import contextLimit, { decideCompaction, decisionFacts, STATUS_KEY } from "../extensions/context-limit/index.ts";
import { LIMIT_ENTRY } from "../extensions/context-limit/limit.ts";
import { indexSessions } from "../extensions/metrics/indexer.ts";
import { compactionDecisions, Scope } from "../extensions/metrics/queries/index.ts";
import { openStore } from "../extensions/metrics/store.ts";
import { spendFacts } from "../scripts/dream/spend.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "decider-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const FACTS: Facts = { contextTokens: 312_000, keepTokens: 20_000, nextTokens: 412_000, requestNow: 0.156, requestAfter: 0.0115, compaction: 1.72, files: ["src/a.ts", "src/b.ts"] };

describe("the question", () => {
	test("four framings: the option order and the cost line vary, nothing else", () => {
		const texts = Object.fromEntries(FRAMINGS.map((f) => [f, question(f, FACTS)]));
		for (const text of Object.values(texts)) {
			assert.match(text, /^\[A question from the harness, not from the user\./);
			assert.match(text, /The context of this session is 312k tokens\. Choose one:/);
			assert.match(text, /Files read or changed in the older part:\n- src\/a\.ts\n- src\/b\.ts/);
			assert.match(text, /Reply with only JSON: \{"decision": "compact" or "keep"/);
			assert.match(text, /the harness asks again at 412k tokens/);
			assert.match(text, /the most recent ~20k tokens stay as they are/);
		}
		const firstOption = (text: string) => /\n- "(\w+)"/.exec(text)![1];
		assert.deepEqual(FRAMINGS.map((f) => firstOption(texts[f]!)), ["compact", "keep", "compact", "keep"]);
		assert.doesNotMatch(texts["plain-compact-first"]!, /Costs:/);
		assert.match(texts["costs-keep-first"]!, /Costs: a request now costs about \$0\.156 for the context alone, about \$0\.011 after compacting; compacting costs about \$1\.72 once\./);
		// Same options, other order: the option texts themselves are identical.
		const options = (text: string) => text.split("\n").filter((l) => l.startsWith('- "')).sort();
		assert.deepEqual(options(texts["plain-compact-first"]!), options(texts["costs-keep-first"]!));
		assert.match(question("plain-keep-first", { ...FACTS, files: [] }), /The older part read or changed no files\./);
	});

	test("answers: JSON anywhere in the reply; anything else is no answer", () => {
		assert.deepEqual(parseAnswer("plain-keep-first", 'Thinking…\n{"decision": "compact", "preserve": ["src/a.ts", "", 3, "the plan"], "reason": "done with it"}'), {
			framing: "plain-keep-first",
			decision: "compact",
			preserve: ["src/a.ts", "the plan"],
			reason: "done with it",
		});
		assert.deepEqual(parseAnswer("plain-keep-first", '{"decision":"keep"}'), { framing: "plain-keep-first", decision: "keep", preserve: [], reason: "" });
		for (const bad of [undefined, "", "keep", '{"decision":"maybe"}', "{broken", '{"decision": "compact"'])
			assert.equal(parseAnswer("costs-keep-first", bad).decision, null, String(bad));
		assert.equal(parseAnswer("costs-keep-first", `{"decision":"compact","preserve":${JSON.stringify(Array.from({ length: 30 }, (_, i) => `f${i}`))}}`).preserve.length, 20);
	});

	test("draw: two different framings, every pair and order and both acting slots occur", () => {
		let seed = 1;
		const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
		const seen = new Set<string>();
		const acting = new Set<number>();
		for (let i = 0; i < 2000; i++) {
			const d = draw(random);
			assert.notEqual(d.framings[0], d.framings[1]);
			seen.add(d.framings.join(" "));
			acting.add(d.acting);
		}
		assert.equal(seen.size, 12, "4 × 3 ordered pairs");
		assert.deepEqual([...acting].sort(), [0, 1]);
	});

	test("settle: the acting answer, else the other's, else keep", () => {
		const a = (framing: Answer["framing"], decision: Answer["decision"]): Answer => ({ framing, decision, preserve: [], reason: "" });
		assert.deepEqual(settle([a("plain-compact-first", "compact"), a("costs-keep-first", "keep")], 1), { acting: "costs-keep-first", decision: "keep" });
		assert.deepEqual(settle([a("plain-compact-first", "compact"), a("costs-keep-first", "keep")], 0), { acting: "plain-compact-first", decision: "compact" });
		assert.deepEqual(settle([a("plain-compact-first", "compact"), a("costs-keep-first", null)], 1), { acting: "plain-compact-first", decision: "compact" });
		assert.deepEqual(settle([a("plain-compact-first", null), a("costs-keep-first", null)], 0), { acting: null, decision: "keep" });
		assert.equal(preserveInstructions([]), undefined);
		assert.equal(preserveInstructions(["src/a.ts", "the open question"]), "The session decided to compact and still needs these; keep them in detail in the summary:\n- src/a.ts\n- the open question");
		assert.deepEqual(filesOf({ read: new Set(["r", "e"]), written: new Set(["w"]), edited: new Set(["e"]) }), ["e", "w", "r"]);
	});

	test("where it asks next: the setting after a compaction, 100k above each keep since", () => {
		let n = 0;
		const entry = (type: string, data?: Partial<DecisionData>) => ({ type, id: `e${++n}`, parentId: null, timestamp: "", ...(type === "custom" ? { customType: DECISION_ENTRY, data } : {}) }) as unknown as SessionEntry;
		assert.equal(deciderThreshold([], undefined), undefined);
		assert.equal(deciderThreshold([], 300_000), 300_000);
		const keep = (contextTokens: number) => entry("custom", { contextTokens, decision: "keep" });
		assert.equal(deciderThreshold([keep(305_000)], 300_000), 405_000);
		assert.equal(deciderThreshold([keep(305_000), keep(410_000)], 300_000), 510_000);
		assert.equal(deciderThreshold([keep(305_000), entry("compaction")], 300_000), 300_000, "a compaction starts over");
		assert.equal(deciderThreshold([keep(305_000), entry("custom", { contextTokens: 420_000, decision: "compact" })], 300_000), 405_000, "a compact decision does not move it");
		assert.equal(deciderThreshold([keep(100_000)], 300_000), 300_000, "never below the setting");
	});

	test("facts: the context's cost per request now and after, and the compaction's own cost, from the model's prices", () => {
		const facts = decisionFacts({ model: { cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } } as never }, 400_000, 20_000, ["a"]);
		const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);
		near(facts.requestNow, 0.2);
		near(facts.requestAfter, 23_000 * 0.5e-6);
		near(facts.compaction, 400_000 * 5e-6 + 3_000 * 25e-6 + 23_000 * 6.25e-6);
		assert.equal(facts.nextTokens, 400_000 + STEP_TOKENS);
	});
});

describe("the hook with a scripted Pi", () => {
	/** A pi and ctx whose session has `entries`, a 1M window, and rules in `rulesDir`; `replies` answer the asides in order. */
	function scripted(replies: (string | undefined)[], entries: SessionEntry[] = []) {
		const rulesDir = join(dir, "rules");
		mkdirSync(rulesDir, { recursive: true });
		writeFileSync(join(rulesDir, "decide.md"), "---\nsettings:\n  decideCompactionAbove: 300000\n---\n");
		const asked: string[] = [];
		const state = { overrides: undefined as unknown, status: undefined as string | undefined };
		const pi = {
			askAside: async (text: string, options: { kind: string }) => {
				assert.equal(options.kind, "compaction-decision");
				asked.push(text);
				const reply = replies.shift();
				if (reply === "throw") throw new Error("network");
				return reply === undefined ? undefined : { text: reply, usage: {} as never, provider: "p", model: "m" };
			},
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data, id: `d${entries.length}`, parentId: null, timestamp: "" } as unknown as SessionEntry),
			getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
			setCompactionOverrides: (o: unknown) => {
				state.overrides = o;
			},
		};
		const ctx = {
			model: { contextWindow: 1_000_000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
			sessionManager: { getBranch: () => entries, getEntries: () => entries },
			ui: { setStatus: (_k: string, text: string | undefined) => (state.status = text) },
		};
		const sources = { rulesDir, experimentsDir: join(dir, "none") };
		const event = (tokensBefore: number, reason = "threshold") =>
			({ type: "session_before_compact", reason, preparation: { tokensBefore, fileOps: { read: new Set(["src/r.ts"]), written: new Set(), edited: new Set(["src/e.ts"]) } }, signal: new AbortController().signal }) as never;
		const decide = (tokens: number, random: () => number, reason?: string) => decideCompaction(pi as never, ctx as never, event(tokens, reason), { random, sources });
		const decisions = () => entries.filter((e) => e.type === "custom" && e.customType === DECISION_ENTRY).map((e) => (e as { data: DecisionData }).data);
		return { asked, state, decide, decisions, entries };
	}
	/** A random source playing back `values`. */
	const playback = (...values: number[]) => () => values.shift() ?? 0;

	test("keep: cancels, records both answers, and moves the next check 100k up", async () => {
		const s = scripted(['{"decision":"keep","reason":"still editing"}', '{"decision":"compact","preserve":["src/e.ts"]}']);
		// draw: first framing index 0 (plain-compact-first), second 0 of the rest (plain-keep-first), acting slot 0.
		const result = await s.decide(310_000, playback(0, 0, 0));
		assert.deepEqual(result, { cancel: true });
		assert.equal(s.asked.length, 2);
		assert.match(s.asked[0]!, /^\[A question from the harness[\s\S]*\n- "compact"[\s\S]*\n- "keep"/);
		assert.match(s.asked[1]!, /\n- "keep"[\s\S]*\n- "compact"/);
		assert.match(s.asked[0]!, /- src\/e\.ts\n- src\/r\.ts/);
		const [d] = s.decisions();
		assert.deepEqual(
			{ ...d, answers: d!.answers.map((a) => [a.framing, a.decision]) },
			{ contextTokens: 310_000, threshold: 300_000, answers: [["plain-compact-first", "keep"], ["plain-keep-first", "compact"]], acting: "plain-compact-first", decision: "keep", files: ["src/e.ts", "src/r.ts"] },
		);
		assert.deepEqual([s.state.overrides, s.state.status], [{ maxContextTokens: 410_000 }, "compaction check at 410k"]);
	});

	test("compact: lets the compaction run with what the acting answer said it still needs", async () => {
		const s = scripted(['{"decision":"keep"}', '{"decision":"compact","preserve":["src/e.ts","the failing test"]}']);
		const result = await s.decide(320_000, playback(0, 0, 0.9));
		assert.deepEqual(result, { customInstructions: "The session decided to compact and still needs these; keep them in detail in the summary:\n- src/e.ts\n- the failing test" });
		assert.equal(s.decisions()[0]!.acting, "plain-keep-first");
		const quiet = scripted(['{"decision":"compact"}', '{"decision":"compact"}']);
		assert.equal(await quiet.decide(320_000, playback(0, 0, 0)), undefined, "nothing to preserve: Pi's own summary");
	});

	test("a failed or unreadable acting answer falls back to the other; none at all keeps", async () => {
		const s = scripted(["throw", '{"decision":"compact"}']);
		assert.equal(await s.decide(310_000, playback(0, 0, 0)), undefined);
		assert.deepEqual(s.decisions().map((d) => [d.acting, d.decision, d.answers.map((a) => a.decision)]), [["plain-keep-first", "compact", [null, "compact"]]]);
		const none = scripted([undefined, "no idea"]);
		assert.deepEqual(await none.decide(310_000, playback(0, 0, 0)), { cancel: true });
		assert.deepEqual(none.decisions().map((d) => [d.acting, d.decision]), [[null, "keep"]]);
	});

	test("not asked: other compactions, near the model's own limit, with a session or fixed limit", async () => {
		const s = scripted([]);
		assert.equal(await s.decide(310_000, Math.random, "overflow"), undefined);
		assert.equal(await s.decide(310_000, Math.random, "manual"), undefined);
		assert.equal(await s.decide(1_000_000 - 16_384 - STEP_TOKENS, Math.random), undefined, "keeping would run into the model's limit");
		const own = scripted([], [{ type: "custom", customType: LIMIT_ENTRY, data: { maxContextTokens: 200_000 }, id: "l", parentId: null, timestamp: "" } as unknown as SessionEntry]);
		assert.equal(await own.decide(310_000, Math.random), undefined, "the user's /context-limit decides");
		assert.deepEqual([s.asked, own.asked], [[], []]);
	});
});

// Real sessions on a faux model: Pi's askAside and summary instructions, then the whole decider.

let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
const open: AgentSession[] = [];
const extensionErrors: string[] = [];
/** What the faux model was asked: every request's last user text and the whole request as JSON. */
let requests: { last: string; all: string }[] = [];
/** How the faux model answers the decision questions. */
let decisionReply = '{"decision":"keep"}';

const lastUserText = (context: { messages: { role: string; content: unknown }[] }) => {
	const user = context.messages.findLast((m) => m.role === "user");
	const content = user?.content;
	return typeof content === "string" ? content : Array.isArray(content) ? content.map((p: { type: string; text?: string }) => (p.type === "text" ? p.text : "")).join("") : "";
};

before(async () => {
	faux = registerFauxProvider({ models: [{ id: "decide-1" }] });
	runtime = await ModelRuntime.create({ authPath: join(mkdtempSync(join(tmpdir(), "decider-runtime-")), "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "decide-1", name: "Decide", api: faux.api, reasoning: false, input: ["text"], cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, contextWindow: 200_000, maxTokens: 8000 }],
	});
});
after(() => faux.unregister());
beforeEach(() => {
	requests = [];
	decisionReply = '{"decision":"keep"}';
	// Replies of about 10k tokens, so the context grows fast; decision questions and summaries get their own answers.
	type Step = Parameters<typeof faux.setResponses>[0][number];
	faux.setResponses(
		Array.from({ length: 200 }, (): Step => (context) => {
			const last = lastUserText(context as never);
			requests.push({ last, all: JSON.stringify(context) });
			if (last.startsWith("[A question from the harness")) return fauxAssistantMessage(decisionReply);
			if (last.includes("<conversation>")) return fauxAssistantMessage("SUMMARY of the work so far.");
			return fauxAssistantMessage("y".repeat(40_000));
		}),
	);
});
afterEach(() => {
	assert.deepEqual(extensionErrors.splice(0), [], "no extension errors");
	for (const session of open.splice(0)) session.dispose();
});

async function newSession(factories: ((pi: ExtensionAPI) => void)[]) {
	const cwd = join(dir, "repo");
	mkdirSync(cwd, { recursive: true });
	const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 100 } });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, extensionFactories: factories });
	await resourceLoader.reload();
	const sessionManager = SessionManager.create(cwd, join(dir, "sessions"));
	const { session } = await createAgentSession({ cwd, agentDir: dir, model: runtime.getModel("faux", "decide-1"), modelRuntime: runtime, resourceLoader, sessionManager, settingsManager });
	const statuses = new Map<string, string | undefined>();
	const ui = new Proxy({ setStatus: (key: string, text: string | undefined) => statuses.set(key, text) }, { get: (t, n) => (n in t ? t[n as keyof typeof t] : () => undefined) }) as unknown as ExtensionUIContext;
	await session.bindExtensions({ uiContext: ui, onError: (error) => extensionErrors.push(`${error.event}: ${error.error}`) });
	open.push(session);
	return { s: session, statuses };
}

const entriesOf = (s: AgentSession, type: string) => s.sessionManager.getEntries().filter((e) => e.type === type);

describe("Pi: askAside and summary instructions", () => {
	test("askAside sends the whole context and the question, answers, records its cost, and adds nothing to the conversation", async () => {
		let api: ExtensionAPI | undefined;
		const { s } = await newSession([(pi) => void (api = pi)]);
		await s.prompt("first task");
		const before = s.messages.length;
		const answer = await api!.askAside("[A question from the harness] keep?", { kind: "test" });
		assert.equal(answer?.text, '{"decision":"keep"}');
		assert.equal(s.messages.length, before, "the conversation is unchanged");
		const asked = requests.at(-1)!;
		assert.equal(asked.last, "[A question from the harness] keep?");
		assert.match(asked.all, /first task/, "the conversation is in the request");
		assert.match(asked.all, /y{1000}/, "the reply too");
		const usage = entriesOf(s, "usage") as { kind: string }[];
		assert.deepEqual(usage.map((u) => u.kind), ["aside: test"]);
		await s.prompt("second task");
		assert.doesNotMatch(requests.at(-1)!.all, /A question from the harness/, "the next turn never sees the question");
	});

	test("instructions a session_before_compact handler returns reach the summary of an automatic compaction", async () => {
		const { s } = await newSession([
			(pi) => {
				pi.on("session_start", () => pi.setCompactionOverrides({ maxContextTokens: 15_000 }));
				pi.on("session_before_compact", () => ({ customInstructions: "KEEP src/vital.ts IN DETAIL" }));
			},
		]);
		for (const text of ["one", "two", "three"]) await s.prompt(text);
		assert.ok(entriesOf(s, "compaction").length >= 1);
		const summary = requests.find((r) => r.last.includes("<conversation>"));
		assert.match(summary!.last, /Additional focus: KEEP src\/vital\.ts IN DETAIL/);
	});
});

describe("the decider in a real session", () => {
	/** The extension with a rule that sets the decider at 50k (the faux window is 200k, its own limit 183.6k). */
	function withDecider() {
		const rulesDir = join(dir, "rules");
		mkdirSync(rulesDir, { recursive: true });
		writeFileSync(join(rulesDir, "decide.md"), "---\nsettings:\n  decideCompactionAbove: 50000\n---\n");
		return (pi: ExtensionAPI) => contextLimit(pi, { rulesDir, experimentsDir: join(dir, "none") });
	}

	test("keep: no compaction at 50k; the next check (100k later) is near the model's limit, so Pi compacts there without asking", async () => {
		const { s, statuses } = await newSession([withDecider()]);
		assert.equal(statuses.get(STATUS_KEY), "compaction check at 50k");
		let prompts = 0;
		while (entriesOf(s, "compaction").length === 0 && prompts < 40) {
			await s.prompt(`task ${prompts++}`);
		}
		const decisions = (entriesOf(s, "custom") as { customType: string; data: DecisionData }[]).filter((e) => e.customType === DECISION_ENTRY).map((e) => e.data);
		assert.equal(decisions.length, 1, `asked once: ${decisions.map((d) => d.contextTokens)}`);
		const [first] = decisions;
		assert.ok(first!.decision === "keep" && first!.answers.length === 2 && first!.answers.every((a) => a.decision === "keep"));
		assert.ok(first!.contextTokens >= 50_000 && first!.contextTokens < 70_000, `first at ${first!.contextTokens}`);
		const compaction = entriesOf(s, "compaction")[0] as { tokensBefore: number };
		assert.ok(compaction.tokensBefore >= first!.contextTokens + STEP_TOKENS, `compacted at ${compaction.tokensBefore}, not before the next check`);
		assert.ok(compaction.tokensBefore + STEP_TOKENS >= 200_000 - 16_384, "there, keeping would run into the model's limit: no question");
		const asides = (entriesOf(s, "usage") as { kind: string }[]).filter((u) => u.kind === "aside: compaction-decision");
		assert.equal(asides.length, decisions.length * 2);
		assert.equal(statuses.get(STATUS_KEY), "compaction check at 50k", "after the compaction it starts over");
		assert.ok(s.messages.every((m) => !JSON.stringify(m).includes("A question from the harness")), "no question in the conversation");
	});

	test("compact: the compaction runs at the first check, with what the session said it needs in the summary request", async () => {
		decisionReply = '{"decision":"compact","preserve":["src/vital.ts"],"reason":"phase done"}';
		const { s } = await newSession([withDecider()]);
		let prompts = 0;
		while (entriesOf(s, "compaction").length === 0 && prompts < 20) await s.prompt(`task ${prompts++}`);
		const compaction = entriesOf(s, "compaction")[0] as { tokensBefore: number };
		assert.ok(compaction.tokensBefore >= 50_000 && compaction.tokensBefore < 70_000, `compacted at ${compaction.tokensBefore}`);
		assert.match(requests.find((r) => r.last.includes("<conversation>"))!.last, /Additional focus: The session decided to compact and still needs these; keep them in detail in the summary:\n- src\/vital\.ts/);
	});
});

describe("metrics: decisions by framing", () => {
	test("indexed from the session file: answers, disagreement by what differs, re-reads after compacting, keep cost", () => {
		const sessions = join(dir, "sessions");
		mkdirSync(sessions, { recursive: true });
		const T = Date.parse("2026-11-20T10:00:00Z");
		let id = 0;
		const at = (minute: number) => new Date(T + minute * 60_000).toISOString();
		const line = (minute: number, body: object) => ({ id: `e${++id}`, parentId: id > 1 ? `e${id - 1}` : null, timestamp: at(minute), ...body });
		const usage = { input: 0, output: 10, cacheRead: 300_000, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0.15, cacheWrite: 0, total: 0.15 } };
		const turn = (minute: number, calls: { name: string; path: string }[] = []) =>
			line(minute, {
				type: "message",
				message: { role: "assistant", content: calls.map((c, i) => ({ type: "toolCall", id: `c${minute}-${i}`, name: c.name, arguments: { path: c.path } })), api: "anthropic-messages", provider: "anthropic", model: "opus", usage, stopReason: calls.length ? "toolUse" : "stop", timestamp: 0 },
			});
		const result = (minute: number, callId: string, name: string) => line(minute, { type: "message", message: { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: "x".repeat(4000) }], isError: false, timestamp: 0 } });
		const decision = (minute: number, data: DecisionData) => line(minute, { type: "custom", customType: DECISION_ENTRY, data });
		const answer = (framing: Answer["framing"], decision: Answer["decision"]): Answer => ({ framing, decision, preserve: [], reason: "" });
		const lines = [
			{ type: "session", version: 3, id: "s1", timestamp: at(0), cwd: "/p" },
			line(0, { type: "message", message: { role: "user", content: "go", timestamp: 0 } }),
			turn(1),
			decision(2, { contextTokens: 300_000, threshold: 300_000, answers: [answer("plain-compact-first", "keep"), answer("plain-keep-first", "keep")], acting: "plain-compact-first", decision: "keep", files: [] }),
			turn(3),
			turn(4),
			decision(5, { contextTokens: 400_000, threshold: 400_000, answers: [answer("costs-keep-first", "compact"), answer("plain-keep-first", "keep")], acting: "costs-keep-first", decision: "compact", files: ["src/a.ts", "src/b.ts"] }),
			turn(6, [{ name: "read", path: "/p/src/a.ts" }]),
			result(6, "c6-0", "read"),
			turn(7),
			decision(8, { contextTokens: 310_000, threshold: 300_000, answers: [answer("costs-compact-first", null), answer("plain-keep-first", "keep")], acting: "plain-keep-first", decision: "keep", files: [] }),
			turn(9),
		];
		writeFileSync(join(sessions, "s.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		const db = openStore(join(dir, "metrics.db"));
		assert.deepEqual(indexSessions(db, sessions).failed, []);
		const stats = compactionDecisions(new Scope(db, {}));
		assert.equal(stats.decisions, 3);
		const answers = Object.fromEntries(stats.answers.map((a) => [a.framing, [a.asked, a.answered, a.compact]]));
		assert.deepEqual(answers, { "plain-compact-first": [1, 1, 0], "plain-keep-first": [3, 3, 0], "costs-compact-first": [1, 0, 0], "costs-keep-first": [1, 1, 1] });
		assert.deepEqual(
			stats.pairs.map((p) => [p.pair, p.differs, p.both, p.disagree]),
			[
				[["plain-compact-first", "plain-keep-first"], "order", 1, 0],
				[["costs-keep-first", "plain-keep-first"], "costs", 1, 1],
			],
		);
		const outcome = Object.fromEntries(stats.outcomes.map((o) => [o.framing, o]));
		assert.deepEqual([outcome["costs-keep-first"]!.compacted, outcome["costs-keep-first"]!.reread], [1, 1], "src/a.ts was read again after the compaction");
		assert.ok(outcome["costs-keep-first"]!.rereadTokens > 0);
		// Keep at minute 2: turns 3 and 4 until the next decision, each carrying 300k tokens beyond the 23k a compacted context would.
		const rate = 0.15 / 300_000;
		const carried = (prompt: number) => (prompt - 23_000) * rate;
		assert.ok(Math.abs(outcome["plain-compact-first"]!.keepCost - 2 * carried(300_000)) < 1e-6, `${outcome["plain-compact-first"]!.keepCost}`);
		assert.ok(Math.abs(outcome["plain-keep-first"]!.keepCost - carried(300_000)) < 1e-6, "the last keep: the turn after it");

		// The dream's spend facts show them per framing and pair.
		const { text } = spendFacts(db, { start: T, end: T + 3_600_000 }, { start: T - 7 * 86_400_000, end: T });
		assert.match(text, /Compaction decisions: 3 \(each asked two framings; one acted\)/);
		assert.match(text, /costs-keep-first\s+1\/1\s+100%\s+1\s+1\s+100%/);
		assert.match(text, /costs-keep-first \/ plain-keep-first\s+costs\s+1\s+100%/);
		assert.match(text, /plain-compact-first \/ plain-keep-first\s+order\s+1\s+0%/);
		db.close();
	});
});
