// /context-limit (extensions/context-limit): parsing and texts, then real Pi sessions on a faux
// model with a 200k window. A session limit below the context makes the next prompt compact, where
// the window alone would not; off removes it; it survives a new process on the session file, follows
// tree navigation, stays out of other sessions, and bad or unworkable limits are refused.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionUIContext, ModelRuntime, type SessionEntry, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import contextLimit, { STATUS_KEY } from "../extensions/context-limit/index.ts";
import { type CompactionSettings, describeLimit, formatTokens, LIMIT_ENTRY, parseCommand, parseTokens, refusal, sessionLimit } from "../extensions/context-limit/limit.ts";

const SETTINGS: CompactionSettings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20_000 };

describe("parsing and texts", () => {
	test("token counts: plain, k, m, decimals, separators; anything else is refused", () => {
		assert.deepEqual(["200k", "200K", "1.5m", "150000", "150,000", "150_000", " 64 k ", "0.5k"].map(parseTokens), [200_000, 200_000, 1_500_000, 150_000, 150_000, 150_000, 64_000, 500]);
		for (const bad of ["", "k", "-5k", "0", "0k", "200kb", "2g", "1e5", "lots", "200k off"]) assert.equal(parseTokens(bad), undefined, bad);
	});

	test("the command: show, off and its aliases, a limit, errors", () => {
		assert.deepEqual(parseCommand("  "), { action: "show" });
		for (const off of ["off", "OFF", "reset", "default"]) assert.deepEqual(parseCommand(off), { action: "off" });
		assert.deepEqual(parseCommand("300k"), { action: "set", maxContextTokens: 300_000 });
		assert.match((parseCommand("huge") as { error: string }).error, /^"huge" is not a token count\. Usage: \/context-limit 200k/);
	});

	test("the branch's latest entry sets the limit; null removes it; other entries are ignored", () => {
		let n = 0;
		const entry = (customType: string, data: unknown) => ({ type: "custom", customType, data, id: `e${++n}`, parentId: null, timestamp: "" }) as SessionEntry;
		assert.equal(sessionLimit([]), undefined);
		assert.equal(sessionLimit([entry(LIMIT_ENTRY, { maxContextTokens: 100_000 }), entry("other", { maxContextTokens: 5 })]), 100_000);
		assert.equal(sessionLimit([entry(LIMIT_ENTRY, { maxContextTokens: 100_000 }), entry(LIMIT_ENTRY, { maxContextTokens: 300_000 })]), 300_000);
		assert.equal(sessionLimit([entry(LIMIT_ENTRY, { maxContextTokens: 100_000 }), entry(LIMIT_ENTRY, { maxContextTokens: null })]), undefined);
	});

	test("formatting and the refusal of limits a compaction cannot get under", () => {
		assert.deepEqual([950, 1000, 1500, 200_000, 983_616, 1_000_000, 1_250_000].map(formatTokens), ["950", "1k", "1.5k", "200k", "983.6k", "1M", "1.3M"]);
		assert.match(refusal(20_000, SETTINGS)!, /^A limit of 20k is not above the 20k recent tokens a compaction keeps/);
		assert.equal(refusal(20_001, SETTINGS), undefined);
	});

	test("the description: which threshold wins and why, the window, disabled compaction", () => {
		assert.equal(describeLimit(SETTINGS, 1_000_000, undefined), "Compacts automatically above 983.6k context tokens: the context window 1M minus 16.4k reserve.\nA compaction keeps the last 20k tokens.\nNo session limit: /context-limit 200k sets one.");
		assert.equal(describeLimit({ ...SETTINGS, maxContextTokens: 200_000 }, 1_000_000, 200_000), "Compacts automatically above 200k context tokens: this session's limit (the context window 1M minus 16.4k reserve would be 983.6k).\nA compaction keeps the last 20k tokens.");
		assert.match(describeLimit({ ...SETTINGS, maxContextTokens: 300_000 }, 1_000_000, undefined), /^Compacts automatically above 300k context tokens: compaction\.maxContextTokens in the settings/);
		assert.match(describeLimit({ ...SETTINGS, maxContextTokens: 500_000 }, 200_000, 500_000), /^Compacts automatically above 183\.6k context tokens: the context window 200k minus 16\.4k reserve\.\nThis session's limit \(500k\) is above that, so it changes nothing on this model\./);
		assert.match(describeLimit({ ...SETTINGS, enabled: false, maxContextTokens: 1000 }, 200_000, 1000), /\nAutomatic compaction is off \(compaction\.enabled is false\); \/compact still works\./);
		assert.match(describeLimit(SETTINGS, 0, undefined), /^The model's context window is unknown/);
		assert.match(describeLimit({ ...SETTINGS, maxContextTokens: 300_000 }, 1_000_000, undefined, 300_000), /^Compacts automatically above 300k context tokens: the setting of this session's experiment or rule \(/);
		assert.match(describeLimit({ ...SETTINGS, maxContextTokens: 500_000 }, 200_000, undefined, 500_000), /\nThe setting of this session's experiment or rule \(500k\) is above that/);
	});
});

// Real sessions.

let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
let dir: string;
const open: AgentSession[] = [];
const extensionErrors: string[] = [];

before(async () => {
	faux = registerFauxProvider({ models: [{ id: "limit-1" }] });
	runtime = await ModelRuntime.create({ authPath: join(mkdtempSync(join(tmpdir(), "limit-runtime-")), "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "limit-1", name: "Limit", api: faux.api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8000 }],
	});
});
after(() => faux.unregister());
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "context-limit-"));
	mkdirSync(join(dir, "repo"));
	// Long replies (about 2k tokens each), so the context grows past small limits; summaries too.
	faux.setResponses(Array.from({ length: 100 }, () => fauxAssistantMessage("x".repeat(8000))));
});
afterEach(() => {
	assert.deepEqual(extensionErrors.splice(0), [], "no extension errors");
	for (const session of open.splice(0)) session.dispose();
	rmSync(dir, { recursive: true, force: true });
});

function recordingUi() {
	const ui = { statuses: new Map<string, string | undefined>(), notices: [] as string[] };
	const methods = { setStatus: (key: string, text: string | undefined) => ui.statuses.set(key, text), notify: (text: string) => ui.notices.push(text) };
	const context = new Proxy(methods, { get: (target, name) => (name in target ? target[name as keyof typeof target] : () => undefined) }) as unknown as ExtensionUIContext;
	return { ui, context };
}

/** A session with the extension; a compaction keeps 100 tokens, so small limits are workable. */
async function newSession(sessionManager = SessionManager.create(join(dir, "repo"), join(dir, "sessions"))) {
	const cwd = join(dir, "repo");
	const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 100 } });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, extensionFactories: [contextLimit] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir: dir, model: runtime.getModel("faux", "limit-1"), modelRuntime: runtime, resourceLoader, sessionManager, settingsManager });
	const { ui, context } = recordingUi();
	await session.bindExtensions({ uiContext: context, onError: (error) => extensionErrors.push(`${error.event}: ${error.error}`) });
	open.push(session);
	return { s: session, ui };
}

const compactions = (s: AgentSession) => s.sessionManager.getEntries().filter((e) => e.type === "compaction").length;

describe("a limit in a real session", () => {
	test("without a limit a growing context does not compact on a 200k window", async () => {
		const { s, ui } = await newSession();
		for (const text of ["one", "two", "three"]) await s.prompt(text);
		assert.equal(compactions(s), 0);
		assert.equal(ui.statuses.get(STATUS_KEY), undefined);
		assert.equal(s.getCompactionSettings().maxContextTokens, undefined);
	});

	test("/context-limit 3k: the next prompt compacts; the notice and status line say so; off removes it", async () => {
		const { s, ui } = await newSession();
		await s.prompt("one");
		await s.prompt("two");
		await s.prompt("/context-limit 3k");
		assert.match(ui.notices.pop()!, /^Context limit for this session: 3k\.\nCompacts automatically above 3k context tokens: this session's limit \(the context window 200k minus 16\.4k reserve would be 183\.6k\)\.\nA compaction keeps the last 100 tokens\.\nThe context \([\d.]+k\) is above it: the next prompt compacts first\.$/);
		assert.equal(ui.statuses.get(STATUS_KEY), "compact above 3k");
		assert.equal(s.getCompactionSettings().maxContextTokens, 3000);
		assert.equal(compactions(s), 0, "setting it does not compact by itself");
		await s.prompt("three");
		assert.ok(compactions(s) >= 1, "the prompt after it compacted");

		await s.prompt("/context-limit");
		assert.match(ui.notices.pop()!, /^Compacts automatically above 3k context tokens: this session's limit/);
		await s.prompt("/context-limit off");
		assert.match(ui.notices.pop()!, /^Context limit removed\.\nCompacts automatically above 183\.6k context tokens: the context window 200k minus 16\.4k reserve\./);
		assert.equal(ui.statuses.get(STATUS_KEY), undefined);
		assert.equal(s.getCompactionSettings().maxContextTokens, undefined);
		const before = compactions(s);
		for (const text of ["four", "five"]) await s.prompt(text);
		assert.equal(compactions(s), before, "no compaction after off");
		await s.prompt("/context-limit off");
		assert.match(ui.notices.pop()!, /^This session has no context limit\./);
	});

	test("bad input and a limit at or below keepRecentTokens are refused and change nothing", async () => {
		const { s, ui } = await newSession();
		await s.prompt("/context-limit lots");
		assert.match(ui.notices.pop()!, /^"lots" is not a token count/);
		await s.prompt("/context-limit 100");
		assert.match(ui.notices.pop()!, /^A limit of 100 is not above the 100 recent tokens a compaction keeps/);
		assert.equal(s.getCompactionSettings().maxContextTokens, undefined);
		assert.equal(sessionLimit(s.sessionManager.getBranch()), undefined);
	});

	test("a new process on the session file restores the limit; another session does not have it", async () => {
		const { s } = await newSession();
		await s.prompt("one");
		await s.prompt("/context-limit 250k");
		const file = s.sessionManager.getSessionFile()!;
		s.dispose();
		open.splice(open.indexOf(s), 1);

		const next = await newSession(SessionManager.open(file, join(dir, "sessions")));
		assert.equal(next.s.getCompactionSettings().maxContextTokens, 250_000);
		assert.equal(next.ui.statuses.get(STATUS_KEY), "compact above 250k");
		const other = await newSession();
		assert.equal(other.s.getCompactionSettings().maxContextTokens, undefined);
	});

	test("tree navigation applies the limit of the branch it lands on", async () => {
		const { s, ui } = await newSession();
		await s.prompt("one");
		const beforeLimit = s.sessionManager.getLeafId()!;
		await s.prompt("/context-limit 150k");
		await s.prompt("two");
		const withLimit = s.sessionManager.getLeafId()!;
		await s.navigateTree(beforeLimit);
		assert.equal(s.getCompactionSettings().maxContextTokens, undefined);
		assert.equal(ui.statuses.get(STATUS_KEY), undefined);
		await s.navigateTree(withLimit);
		assert.equal(s.getCompactionSettings().maxContextTokens, 150_000);
		assert.equal(ui.statuses.get(STATUS_KEY), "compact above 150k");
	});
});
