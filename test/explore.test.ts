// The explore tool (extensions/explore): range selection (pure), call kinds, then whole runs: a Pi
// session on a scripted model calls `explore`, whose explorer is a real in-process session on the
// same scripted model with real read-only tools.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { JsonObject } from "@earendil-works/pi-ai";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ask, disposeExplorers, reportArguments } from "../extensions/explore/explorer.ts";
import explore, { type ExploreDetails, HINT } from "../extensions/explore/index.ts";
import { MAX_FILE_BYTES, mergeRanges, parseRangeLines, renderSelection, selectRanges } from "../extensions/explore/ranges.ts";
import { callKind } from "../extensions/lib/call-kind.ts";

let dir: string;
let repo: string;
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "explore-")));
	repo = join(dir, "repo");
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "a.ts"), Array.from({ length: 100 }, (_, i) => `const a${i + 1} = ${i + 1};`).join("\n") + "\n");
	writeFileSync(join(repo, "src", "b.ts"), "export function cost() {\n\treturn 1;\n}\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ranges", () => {
	test("overlapping and touching ranges of a file merge, keeping the first's rank and both reasons", () => {
		assert.deepEqual(
			mergeRanges([
				{ path: "a", start: 10, end: 20, why: "x" },
				{ path: "b", start: 1, end: 2 },
				{ path: "a", start: 21, end: 30, why: "y" },
				{ path: "a", start: 50, end: 60 },
			]),
			[
				{ path: "a", start: 10, end: 30, why: "x; y" },
				{ path: "b", start: 1, end: 2 },
				{ path: "a", start: 50, end: 60 },
			],
		);
	});

	test("ranges are read verbatim in rank order, clamped to the file, cut to the budget, later ones still tried", () => {
		const s = selectRanges(repo, [{ path: "src/b.ts", start: 1, end: 99, why: "the function" }, { path: "src/a.ts", start: 1, end: 100 }, { path: join(repo, "src/a.ts"), start: 200, end: 210 }, { path: "missing.ts", start: 1, end: 2 }], 150, []);
		assert.deepEqual(s.shown[0], { path: "src/b.ts", start: 1, end: 3, why: "the function", hash: s.shown[0]!.hash, text: "export function cost() {\n\treturn 1;\n}", cut: false });
		assert.equal(s.shown[1]!.path, "src/a.ts", "an absolute path inside the working directory is shown relative");
		assert.equal(s.shown[1]!.cut, true);
		assert.ok(s.shown[1]!.end >= 8 && s.shown[1]!.end < 100, "cut to what fits");
		assert.deepEqual(s.omitted, [{ path: "src/a.ts", start: s.shown[1]!.end + 1, end: 100 }]);
		assert.deepEqual(s.invalid.map((r) => r.problem.startsWith("ENOENT") || r.problem), ["the file has 100 lines", true]);
		const text = renderSelection("cost() returns 1.", s);
		assert.match(text, /^cost\(\) returns 1\.\n\nsrc\/b\.ts:1-3 \(the function\)\n```\nexport function cost\(\) \{\n\treturn 1;\n\}\n```/);
		assert.match(text, /\[cut to the budget\]/);
		assert.match(text, /Over the budget, not shown .*: src\/a\.ts:\d+-100/);
		assert.match(text, /Not readable: src\/a\.ts:200-210 \(the file has 100 lines\); missing\.ts:1-2/);
	});

	test("a range an earlier call returned is not repeated while its text is unchanged", () => {
		const first = selectRanges(repo, [{ path: "src/a.ts", start: 1, end: 50 }], 10_000, []);
		const seen = first.shown.map(({ path, start, end, hash }) => ({ path, start, end, hash }));
		const again = selectRanges(repo, [{ path: "src/a.ts", start: 10, end: 20 }, { path: "src/a.ts", start: 40, end: 60 }], 10_000, seen);
		assert.deepEqual(again.known, [{ path: "src/a.ts", start: 10, end: 20 }], "inside a returned range");
		assert.deepEqual(again.shown.map((r) => [r.start, r.end]), [[40, 60]], "only partly covered: shown");
		writeFileSync(join(repo, "src", "a.ts"), "changed\n" + Array.from({ length: 99 }, (_, i) => `const a${i + 2} = 0;`).join("\n"));
		assert.equal(selectRanges(repo, [{ path: "src/a.ts", start: 10, end: 20 }], 10_000, seen).shown.length, 1, "the file changed: shown again");
	});

	test("reported range lines: path:start-end with an optional reason in the usual forms; other lines are rejected", () => {
		assert.deepEqual(
			parseRangeLines("src/a.ts:10-42 the parser\n- `lib/b.ts`:7 — entry\n2. /abs/c.py:30–20 (reversed)\n\nd.md:1-3: why\nnot a range\nsrc/e.ts"),
			{
				ranges: [
					{ path: "src/a.ts", start: 10, end: 42, why: "the parser" },
					{ path: "lib/b.ts", start: 7, end: 7, why: "entry" },
					{ path: "/abs/c.py", start: 20, end: 30, why: "reversed" },
					{ path: "d.md", start: 1, end: 3, why: "why" },
				],
				rejected: ["not a range", "src/e.ts"],
			},
		);
		assert.deepEqual(parseRangeLines(""), { ranges: [], rejected: [] });
	});

	test("binary and too large files are not read", () => {
		writeFileSync(join(repo, "bin.dat"), Buffer.from([1, 2, 0, 3, 10, 4]));
		writeFileSync(join(repo, "big.log"), Buffer.alloc(MAX_FILE_BYTES + 1, 97));
		const s = selectRanges(repo, [{ path: "bin.dat", start: 1, end: 1 }, { path: "big.log", start: 1, end: 1 }, { path: "src", start: 1, end: 1 }], 10_000, []);
		assert.deepEqual(s.invalid.map((r) => r.problem), ["binary", "too large (4 MB)", "not a file"]);
	});

	test("a ranges parameter leaked into the answer is cut from it and read as the ranges", () => {
		assert.deepEqual(reportArguments('cost is in b.ts.</answer>\n<parameter name="ranges">src/b.ts:1-3 def\nsrc/a.ts:1-2</answer>', undefined), { answer: "cost is in b.ts.", ranges: "src/b.ts:1-3 def\nsrc/a.ts:1-2" });
		assert.deepEqual(reportArguments('x\n<parameter name="ranges">a.ts:1-2</parameter>', "b.ts:3-4"), { answer: "x", ranges: "b.ts:3-4" }, "the real field wins");
		assert.deepEqual(reportArguments("plain", undefined), { answer: "plain", ranges: "" });
	});

	test("call kinds", () => {
		assert.equal(callKind("read", "", false), "explore");
		assert.equal(callKind("bash", "cd x && grep -n foo src", false), "explore");
		assert.equal(callKind("bash", "npm test", false), "check");
		assert.equal(callKind("bash", "sed -i '' s/a/b/ f && npm test", true), "edit+check");
		assert.equal(callKind("bash", "sleep 30; cat log", false), "wait");
		assert.equal(callKind("bash", "git commit -m x", true), "vcs");
		assert.equal(callKind("edit", "", true), "edit");
	});
});

// ---- whole runs -------------------------------------------------------------------------------

let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
before(async () => {
	faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	runtime = await ModelRuntime.create({ authPath: join(mkdtempSync(join(tmpdir(), "explore-runtime-")), "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "faux-1", name: "Faux", api: faux.api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8000 }],
	});
});
after(() => faux.unregister());

const open: AgentSession[] = [];
afterEach(() => {
	for (const s of open.splice(0)) s.dispose();
});

async function newSession(tools = ["read", "bash", "explore"], maxTurns?: number): Promise<AgentSession> {
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: repo,
		agentDir: dir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		extensionFactories: [(pi: ExtensionAPI) => explore(pi, { modelRuntime: async () => runtime, agentDir: dir, model: "faux/faux-1", ...(maxTurns ? { maxTurns } : {}) })],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd: repo, agentDir: dir, model: runtime.getModel("faux", "faux-1"), modelRuntime: runtime, resourceLoader, sessionManager: SessionManager.create(repo, join(dir, "sessions")), settingsManager, tools });
	await session.bindExtensions({});
	open.push(session);
	return session;
}
afterEach(() => {
	for (const s of open) disposeExplorers(s.sessionId);
});

const respond = (...steps: FauxResponseStep[]) => faux.setResponses(steps);
const call = (name: string, args: JsonObject) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(text);
const textOf = (content: unknown) => (typeof content === "string" ? content : (content as { type: string; text?: string }[]).flatMap((b) => (b.type === "text" ? [b.text ?? ""] : [])).join(""));
const results = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "toolResult" ? [{ name: m.toolName, text: textOf(m.content), details: m.details as ExploreDetails | undefined, error: m.isError }] : []));

describe("explore runs", () => {
	test("the explorer searches, reports; the caller gets the answer and the ranges verbatim; a follow-up reuses the explorer and does not repeat ranges", async () => {
		const s = await newSession();
		const seen: string[] = [];
		respond(
			call("explore", { question: "Where is cost defined?" }),
			// The explorer: a refused write, a search, then its report.
			call("bash", { command: "echo x > src/new.ts" }),
			call("grep", { pattern: "cost", path: "src" }),
			call("report", { answer: "x", ranges: "src/b.ts the file" }),
			call("report", { answer: "cost() is defined in src/b.ts:1.", ranges: "src/b.ts:1-3 definition" }),
			// The caller.
			call("explore", { question: "And what does it return?" }),
			(context) => {
				seen.push(JSON.stringify(context.messages.at(-1)));
				return call("report", { answer: "It returns 1 (src/b.ts:2).", ranges: "src/b.ts:1-3" });
			},
			say("cost() returns 1."),
		);
		await s.prompt("find cost");
		assert.equal(faux.getPendingResponseCount(), 0);
		const [first, second] = results(s);
		assert.equal(first!.name, "explore");
		assert.equal(first!.text, "cost() is defined in src/b.ts:1.\n\nsrc/b.ts:1-3 (definition)\n```\nexport function cost() {\n\treturn 1;\n}\n```");
		assert.equal(first!.details!.shown.length, 1);
		assert.equal(first!.details!.turns, 4, "a malformed report is sent back once");
		assert.match(second!.text, /^It returns 1 \(src\/b\.ts:2\)\.\n\nAlready returned by an earlier explore call and unchanged, not repeated: src\/b\.ts:1-3$/);
		assert.equal(second!.details!.explorer, first!.details!.explorer, "the same explorer answered the follow-up");
		assert.deepEqual(second!.details!.childSessions, [], "its session is linked once, by the call that created it");
		assert.match(seen[0]!, /And what does it return\?/, "the follow-up reached the explorer as a new message");
		const explorer = SessionManager.open(join(dir, "sessions", (await import("node:fs")).readdirSync(join(dir, "sessions")).find((f) => f.includes(first!.details!.childSessions[0]!))!));
		const refused = explorer.getBranch().flatMap((e) => (e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "bash" ? [textOf(e.message.content)] : []));
		assert.match(refused[0]!, /You are read-only/);
		const reports = explorer.getBranch().flatMap((e) => (e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "report" ? [textOf(e.message.content)] : []));
		assert.match(reports[0]!, /These lines are not ranges .*"src\/b\.ts the file"/);
		assert.equal(explorer.getHeader()?.parentSession, s.sessionManager.getSessionFile(), "the explorer's session names the caller as parent");
	});

	test("an explorer that answers in text is asked once to call report; answering in text again, its text is the answer", async () => {
		const s = await newSession();
		const asked: string[] = [];
		respond(
			call("explore", { question: "Is there a b.ts?" }),
			say("<report>answer: yes</report>"),
			(context) => {
				asked.push(JSON.stringify(context.messages.at(-1)));
				return call("report", { answer: "Yes, src/b.ts.", ranges: "src/b.ts:1-3 the file" });
			},
			call("explore", { question: "And c.ts?" }),
			say("No c.ts."),
			say("Still no c.ts."),
			say("ok"),
		);
		await s.prompt("check");
		assert.match(asked[0]!, /You answered in text\. Call the `report` tool now/);
		const [first, second] = results(s);
		assert.match(first!.text, /^Yes, src\/b\.ts\.\n\nsrc\/b\.ts:1-3 \(the file\)\n```/);
		assert.equal(second!.text, "Still no c.ts.");
		assert.equal(faux.getPendingResponseCount(), 0);
	});

	test("an explorer past its turns is told to report, and stopped later; its last words are the answer", async () => {
		const s = await newSession(undefined, 1);
		const contexts: string[] = [];
		const grep = (context: { messages: readonly unknown[] }) => {
			contexts.push(JSON.stringify(context.messages.at(-1)));
			return call("grep", { pattern: "a", path: "src" });
		};
		respond(call("explore", { question: "Find a." }), ...Array.from({ length: 7 }, () => grep), say("done"));
		await s.prompt("go");
		assert.match(contexts[1]!, /You have used 1 turns\. Stop exploring and call report now/, "the steer reached the explorer's next request");
		const result = results(s)[0]!;
		assert.match(result.text, /^\[The explorer was stopped after 7 turns without a report; its last words:\]\n\(the explorer gave no answer\)$/);
		assert.equal(faux.getPendingResponseCount(), 0);
	});

	test("an explorer that fails is an error, not an empty answer; an aborted call frees its explorer", async () => {
		const s = await newSession();
		respond(call("explore", { question: "Find a." }), fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request: bad schema" }), say("the explorer failed"));
		await s.prompt("go");
		const failed = results(s)[0]!;
		assert.equal(failed.error, true);
		assert.match(failed.text, /The explorer failed: invalid request: bad schema/);

		const env = { cwd: repo, agentDir: dir, runtime, model: "faux/faux-1" };
		const aborted = new AbortController();
		aborted.abort(new Error("stop"));
		await assert.rejects(ask("direct", env, "q", aborted.signal), /stop/);
		respond(call("report", { answer: "yes", ranges: "" }));
		const answer = await ask("direct", env, "q");
		assert.equal(answer.report.answer, "yes", "the pool is not stuck after the abort");
		assert.equal(answer.link, true);
		respond(call("report", { answer: "again", ranges: "" }));
		const again = await ask("direct", env, "q2");
		assert.equal(again.sessionId, answer.sessionId);
		assert.equal(again.link, false);
		disposeExplorers("direct");
		respond(call("report", { answer: "fresh", ranges: "" }));
		assert.notEqual((await ask("direct", env, "q3")).sessionId, answer.sessionId, "disposed: a new explorer");
		disposeExplorers("direct");
	});

	test("parallel calls get one explorer each, on an empty pool and with an idle explorer", async () => {
		const env = { cwd: repo, agentDir: dir, runtime, model: "faux/faux-1" };
		const report = (answer: string) => call("report", { answer, ranges: "" });
		respond(report("a"), report("b"));
		const [a, b] = await Promise.all([ask("parallel", env, "qa"), ask("parallel", env, "qb")]);
		assert.notEqual(a.sessionId, b.sessionId, "empty pool: two explorers");
		assert.deepEqual([a.report.answer, b.report.answer].sort(), ["a", "b"]);
		disposeExplorers("parallel");

		respond(report("warm"));
		const warm = await ask("parallel", env, "q1");
		respond(report("c"), report("d"));
		const [c, d] = await Promise.all([ask("parallel", env, "qc"), ask("parallel", env, "qd")]);
		assert.notEqual(c.sessionId, d.sessionId, "one idle explorer: the second call gets a new one");
		assert.ok([c.sessionId, d.sessionId].includes(warm.sessionId), "the idle explorer is reused");
		assert.deepEqual([c.report.answer, d.report.answer].sort(), ["c", "d"]);
		assert.equal(faux.getPendingResponseCount(), 0);
		disposeExplorers("parallel");
	});

	test("a read-only call right after a read-only turn gets the hint once per stretch; not without the tool", async () => {
		const s = await newSession();
		respond(
			call("read", { path: "src/a.ts", limit: 5 }),
			call("read", { path: "src/b.ts" }),
			call("bash", { command: "grep -n a1 src/a.ts" }),
			call("bash", { command: "echo y > src/c.ts" }),
			call("read", { path: "src/b.ts" }),
			call("read", { path: "src/a.ts", limit: 2 }),
			say("done"),
		);
		await s.prompt("read around");
		const texts = results(s).map((r) => r.text.endsWith(HINT));
		assert.deepEqual(texts, [false, true, false, false, false, true], "the second read-only turn of each stretch; a file change ends a stretch");

		const without = await newSession(["read", "bash"]);
		respond(call("read", { path: "src/a.ts", limit: 5 }), call("read", { path: "src/b.ts" }), say("done"));
		await without.prompt("read");
		assert.ok(results(without).every((r) => !r.text.includes(HINT)));
	});
});
