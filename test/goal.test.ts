// The session goal (extensions/goal): its state and texts, then real Pi sessions (faux model, real
// bash) where the goal is set by command and by tool, shows in the prompt and status line, survives
// reload, compaction and a new process, holds the run at its end, and lets it end when achieved
// (check passing), blocked, paused, cleared, over budget, stuck (loop guard), or waiting on a
// running background job (strict mode).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, getApiProvider, registerApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, type ExtensionUIContext, ModelRuntime, type SessionEntry, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import bashExtension from "../extensions/bash/index.ts";
import {
	continueText,
	describeGoal,
	findJob,
	GOAL_ENTRY,
	type Goal,
	goalState,
	overBudget,
	type PendingJob,
	parseBudget,
	parseFlags,
	sectionText,
	statusLine,
} from "../extensions/goal/goal.ts";
import goal, { MAX_IDLE_CONTINUES, MESSAGE_TYPE } from "../extensions/goal/index.ts";
import prompt from "../extensions/prompt/index.ts";

const GOAL: Goal = { id: "g1", objective: "Make the tests pass.", status: "active", setBy: "user" };
let n = 0;
const goalEntry = (g: Goal | null): SessionEntry => ({ type: "custom", customType: GOAL_ENTRY, data: { goal: g }, id: `e${++n}`, parentId: null, timestamp: "" }) as SessionEntry;
const assistantEntry = (usd: number, tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }): SessionEntry =>
	({ type: "message", id: `e${++n}`, parentId: null, timestamp: "", message: { role: "assistant", content: [], usage: { ...tokens, totalTokens: 0, cost: { total: usd } } } }) as unknown as SessionEntry;
const turn = (usd: number) => assistantEntry(usd, { input: 100, output: 10, cacheRead: 5000, cacheWrite: 1 });

describe("goal state", () => {
	test("the last goal entry on the branch is the goal; spend counts only while active, per goal", () => {
		assert.deepEqual(goalState([turn(1)]), { goal: undefined, spent: { usd: 0, tokens: 0 } });
		const branch = [turn(1), goalEntry(GOAL), turn(0.5), { type: "compaction" } as SessionEntry, turn(0.25)];
		assert.deepEqual(goalState(branch), { goal: GOAL, spent: { usd: 0.75, tokens: 222 } }, "cache reads are not counted; a compaction changes nothing");
		const paused = [...branch, goalEntry({ ...GOAL, status: "paused" }), turn(10), goalEntry(GOAL), turn(1)];
		assert.deepEqual(goalState(paused).spent, { usd: 1.75, tokens: 333 }, "not while paused");
		const replaced = [...paused, goalEntry({ ...GOAL, id: "g2", objective: "Other." }), turn(2)];
		assert.deepEqual(goalState(replaced).spent, { usd: 2, tokens: 111 }, "a new goal starts at zero");
		assert.equal(goalState([...replaced, goalEntry(null), turn(1)]).goal, undefined, "cleared");
		assert.equal(goalState(branch.slice(0, 1)).goal, undefined, "another branch without it has none");
	});

	test("budgets: dollars or tokens, either reached ends it", () => {
		assert.deepEqual(["$5", "5", "5usd", "2.5", "200k", "2m", "1.5M", "150000 tokens", "1token"].map(parseBudget), [{ usd: 5 }, { usd: 5 }, { usd: 5 }, { usd: 2.5 }, { tokens: 200_000 }, { tokens: 2_000_000 }, { tokens: 1_500_000 }, { tokens: 150_000 }, { tokens: 1 }]);
		for (const bad of ["", "0", "-1", "$200k", "five", "1.5 tokens", "$"]) assert.equal(parseBudget(bad), undefined, bad);
		const budget = { ...GOAL, budget: { usd: 1, tokens: 1000 } };
		assert.equal(overBudget(budget, { usd: 0.99, tokens: 999 }), false);
		assert.equal(overBudget(budget, { usd: 1, tokens: 0 }), true);
		assert.equal(overBudget(budget, { usd: 0, tokens: 1000 }), true);
		assert.equal(overBudget(GOAL, { usd: 1e9, tokens: 1e9 }), false, "no budget, no limit");
	});

	test("command flags: check, budget, removal, quoting, `--`, errors", () => {
		assert.deepEqual(parseFlags('--check "npm test -- --grep \\"a b\\"" --budget $5 --budget 200k Ship   it now'), { check: 'npm test -- --grep "a b"', budget: { usd: 5, tokens: 200_000 }, objective: "Ship   it now" });
		assert.deepEqual(parseFlags("--no-check --no-budget"), { check: null, budget: null });
		assert.deepEqual(parseFlags("-- --check is the objective"), { objective: "--check is the objective" });
		assert.deepEqual(parseFlags("--check 'make x' fix"), { check: "make x", objective: "fix" });
		assert.match((parseFlags("--budget lots x") as { error: string }).error, /--budget needs an amount/);
		assert.match((parseFlags("--check") as { error: string }).error, /--check needs a command/);
		assert.match((parseFlags("--nope x") as { error: string }).error, /Unknown option --nope/);
	});

	test("jobs are found by key, id, pid or a part of one command only", () => {
		const jobs: PendingJob[] = [
			{ key: "call c1", command: "npm run build", ids: ["c1", "4242"] },
			{ key: "pid 77", command: "npm run test:kernel", ids: ["77"] },
		];
		assert.equal(findJob(jobs, "call c1")?.key, "call c1");
		assert.equal(findJob(jobs, "c1")?.key, "call c1");
		assert.equal(findJob(jobs, "process group 4242")?.key, "call c1");
		assert.equal(findJob(jobs, "pid 77")?.key, "pid 77");
		assert.equal(findJob(jobs, "`build`")?.key, "call c1");
		assert.equal(findJob(jobs, "KERNEL")?.key, "pid 77");
		assert.equal(findJob(jobs, "npm run"), undefined, "ambiguous");
		assert.equal(findJob(jobs, "deploy"), undefined);
		assert.equal(findJob(jobs, "  "), undefined);
	});

	test("texts: section, status line, description, continue (plain and strict)", () => {
		const full: Goal = { ...GOAL, check: "npm test", budget: { usd: 5 }, setBy: "agent" };
		const section = sectionText(full);
		assert.match(section, /^This session has a goal, set by you:\nMake the tests pass\.\n\nIt counts as achieved only when `npm test` exits 0; .* Budget: \$5\.00\.\n\nKeep working/);
		assert.doesNotMatch(section, /spent/i, "no spend: the section stays the same from run to run");
		assert.equal(statusLine(GOAL, { usd: 3, tokens: 1 }), "goal active: Make the tests pass.");
		assert.equal(statusLine({ ...full, objective: "x".repeat(60) }, { usd: 1.234, tokens: 12_345 }), `goal active: ${"x".repeat(47)}… · $1.23 of $5.00, 12.3k tokens`);
		assert.match(describeGoal({ ...full, status: "blocked", reason: "needs a key" }, { usd: 0, tokens: 0 }), /^Goal \(blocked: needs a key, set by the agent\):\nMake the tests pass\.\nCheck: `npm test` must exit 0\.\nBudget: \$5\.00\.\nSpent while active: \$0\.00 of \$5\.00, 0 tokens\.$/);
		assert.match(describeGoal(undefined, { usd: 0, tokens: 0 }), /No goal is set/);
		const plain = continueText(full, { usd: 1, tokens: 10 }, [], 0);
		assert.match(plain, /^Your goal is still active, so your turn does not end yet\.\n\nGoal: Make the tests pass\.\nCheck: `npm test` must exit 0\.\nSpent: \$1\.00 of \$5\.00, 10 tokens\.\n\nDo one of these now:\n- Continue with the next step/);
		assert.doesNotMatch(plain, /wait/);
		const strict = continueText(GOAL, { usd: 0, tokens: 0 }, [{ key: "pid 7", command: "sleep 100", ids: ["7"], startedAt: 0 }], 180_000);
		assert.match(strict, /Background work is still running; its end wakes you with its result:\n- pid 7: `sleep 100` \(running 3 min\)\n\nDo not stop to wait for it\./);
		assert.match(strict, /List the remaining steps of the goal that do not depend on these jobs, and do them now\./);
		assert.match(strict, /action `wait`, naming for each remaining step the job it waits for/);
	});

	test("the prompt extension puts other extensions' sections (the goal) after its own", () => {
		let handler: ((event: unknown, ctx: unknown) => void) | undefined;
		const pi = { on: (name: string, h: typeof handler) => void (name === "before_agent_start" && (handler = h)), appendEntry: () => {} };
		const rules = mkdtempSync(join(tmpdir(), "goal-rules-"));
		try {
			writeFileSync(join(rules, "a-rule.md"), "---\npromoted: 2026-11-14\n---\nRule body.\n");
			prompt(pi as never, join(rules, "none"), rules);
			const options = { contextFiles: [], sections: { goal: "The goal." } as Record<string, string>, selectedTools: ["bash"], toolGuidelines: { bash: ["Use bash."] }, promptGuidelines: [] };
			handler!({ systemPromptOptions: options }, { hasUI: false, sessionManager: { getSessionId: () => "s", getEntries: () => [] } });
			assert.deepEqual(Object.keys(options.sections), ["a-rule", "tool-guidelines", "goal"]);
		} finally {
			rmSync(rules, { recursive: true, force: true });
		}
	});
});

// Real sessions.

let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
let dir: string;
const open: AgentSession[] = [];
const extensionErrors: string[] = [];

before(async () => {
	faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	runtime = await ModelRuntime.create({ authPath: join(mkdtempSync(join(tmpdir(), "goal-runtime-")), "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "faux-1", name: "Faux", api: faux.api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8000 }],
	});
});
after(() => faux.unregister());
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "goal-"));
	mkdirSync(join(dir, "repo"));
});
// Background calls move from extensions/bash to their own extension, extensions/background (in
// progress on 2026-11-14): load it where it exists. The job state is the same process-wide map.
const backgroundModule = new URL("../extensions/background/index.ts", import.meta.url);
const backgroundExtension: ((pi: ExtensionAPI, options: object) => void) | undefined = existsSync(backgroundModule) ? (await import(backgroundModule.href)).default : undefined;
const jobState = (s: AgentSession) => (globalThis as { __harnessJobs?: Map<string, { leftovers?: Map<number, unknown>; poll?: NodeJS.Timeout }> }).__harnessJobs?.get(s.sessionManager.getSessionId());

afterEach(() => {
	assert.deepEqual(extensionErrors.splice(0), [], "no extension errors");
	for (const session of open.splice(0)) {
		const jobs = jobState(session);
		for (const pid of jobs?.leftovers?.keys() ?? []) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		clearInterval(jobs?.poll);
		session.dispose();
	}
	rmSync(dir, { recursive: true, force: true });
});

/** A UI that records the status line and notices; `editor` answers with `editorReply`. */
function recordingUi() {
	const ui = { statuses: new Map<string, string | undefined>(), notices: [] as string[], editorReply: undefined as string | undefined };
	const methods = {
		setStatus: (key: string, text: string | undefined) => ui.statuses.set(key, text),
		notify: (text: string) => ui.notices.push(text),
		editor: async () => ui.editorReply,
	};
	const context = new Proxy(methods, { get: (target, name) => (name in target ? target[name as keyof typeof target] : () => undefined) }) as unknown as ExtensionUIContext;
	return { ui, context };
}

type Ui = ReturnType<typeof recordingUi>["ui"];

async function newSession(sessionManager = SessionManager.create(join(dir, "repo"), join(dir, "sessions"))): Promise<{ s: AgentSession; ui: Ui }> {
	const cwd = join(dir, "repo");
	// Keep almost nothing at a compaction, so a short session can be compacted.
	const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: dir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		extensionFactories: [
			...(backgroundExtension ? [(pi: ExtensionAPI) => backgroundExtension(pi, { detachAfterMs: 30_000, logRoot: join(dir, "logs") })] : []),
			(pi: ExtensionAPI) => bashExtension(pi, { dir: join(dir, "groups"), detachAfterMs: 30_000, pollMs: 100 }),
			goal,
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir: dir, model: runtime.getModel("faux", "faux-1"), modelRuntime: runtime, resourceLoader, sessionManager, settingsManager });
	const { ui, context } = recordingUi();
	await session.bindExtensions({ uiContext: context, onError: (error) => extensionErrors.push(`${error.event}: ${error.error}`) });
	open.push(session);
	return { s: session, ui };
}

const respond = (...steps: FauxResponseStep[]) => faux.setResponses(steps);
const say = (text: string) => fauxAssistantMessage(text);
const goalCall = (args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall("goal", args)], { stopReason: "toolUse" });
const bash = (command: string) => fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
const textOf = (content: string | readonly { type: string; text?: string }[]) => (typeof content === "string" ? content : content.map((c) => c.text ?? "").join(""));
const goalMessages = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "custom" && m.customType === MESSAGE_TYPE ? [textOf(m.content)] : []));
const continues = (s: AgentSession) => goalMessages(s).filter((t) => t.startsWith("Your goal is still active"));
const toolTexts = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "toolResult" ? [`${m.isError ? "error: " : ""}${textOf(m.content)}`] : []));
const lastText = (context: { messages: readonly unknown[] }) => JSON.stringify(context.messages.at(-1));
const current = (s: AgentSession) => goalState(s.sessionManager.getBranch()).goal;
const settled = (s: AgentSession, reply: string) => () => !s.isStreaming && s.messages.at(-1)?.role === "assistant" && JSON.stringify(s.messages.at(-1)).includes(reply);
async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}
/** reload() resets the API providers to the built-in ones; the faux one goes back, as an extension's would. */
async function reload(s: AgentSession) {
	const provider = getApiProvider(faux.api);
	await s.reload();
	if (!getApiProvider(faux.api)) registerApiProvider(provider as never);
}

describe("a goal set by the user", () => {
	test("/goal starts a run with the goal in the prompt (last) and the status line; the run cannot end until the check passes", async () => {
		const { s, ui } = await newSession();
		const seen: Record<string, string | undefined> = {};
		respond(
			(context) => {
				seen.prompt = s.systemPrompt;
				seen.first = lastText(context);
				seen.status = ui.statuses.get("goal");
				return say("I will start soon.");
			},
			(context) => {
				seen.forced = lastText(context);
				return goalCall({ action: "achieved" });
			},
			bash("touch done.txt"),
			goalCall({ action: "achieved" }),
			say("Done."),
		);
		await s.prompt('/goal --check "test -f done.txt" --budget $50 Create done.txt');
		await until("the goal run", settled(s, "Done."));

		assert.match(seen.prompt!, /<\/cwd>\n\n<goal>\nThis session has a goal, set by the user:\nCreate done\.txt\n\nIt counts as achieved only when `test -f done\.txt` exits 0; the check runs when you mark it achieved\. Budget: \$50\.\n\nKeep working toward it[^<]*<\/goal>$/);
		assert.match(seen.first!, /The user set a goal for this session\. Work toward it until it is achieved:/);
		assert.equal(seen.status, "goal active: Create done.txt · $0.00 of $50, 0 tokens");
		assert.match(seen.forced!, /Your goal is still active, so your turn does not end yet\.\\n\\nGoal: Create done\.txt\\nCheck: `test -f done\.txt` must exit 0\./);
		const [refused, , achieved] = toolTexts(s);
		assert.match(refused!, /^error: The goal's check `test -f done\.txt` exited with code 1, so the goal is not achieved and stays active\./);
		assert.match(achieved!, /^Goal achieved \(its check `test -f done\.txt` exited 0\)\. Spent while active: \$0\.00 of \$50, [\d.k]+ tokens\. Report the result to the user\.$/);
		assert.equal(continues(s).length, 1, "only the text-only reply was held");
		assert.equal(current(s)?.status, "achieved");
		assert.match(ui.statuses.get("goal")!, /^goal achieved: Create done\.txt/);
		assert.equal(faux.getPendingResponseCount(), 0);
	});

	test("/goal without arguments shows it; edit changes flags and objective (editor too); bad input is refused", async () => {
		const { s, ui } = await newSession();
		await s.prompt("/goal");
		assert.match(ui.notices.pop()!, /No goal is set/);
		await s.prompt("/goal edit something");
		assert.match(ui.notices.pop()!, /No goal to edit/);
		await s.prompt("/goal --budget lots Ship");
		assert.match(ui.notices.pop()!, /--budget needs an amount/);
		await s.prompt(`/goal ${"x".repeat(4001)}`);
		assert.match(ui.notices.pop()!, /4001 characters; at most 4000/);
		assert.equal(current(s), undefined);

		respond(goalCall({ action: "blocked", reason: "testing edits" }), say("Blocked."));
		await s.prompt("/goal Ship it");
		await until("the goal run", settled(s, "Blocked."));
		await s.prompt("/goal edit --check 'true' --budget 200k");
		assert.deepEqual({ ...current(s), id: "" }, { id: "", objective: "Ship it", check: "true", budget: { tokens: 200_000 }, status: "blocked", reason: "testing edits", setBy: "user" });
		ui.editorReply = "Ship it today";
		await s.prompt("/goal edit");
		assert.equal(current(s)?.objective, "Ship it today");
		await s.prompt("/goal edit --no-check --no-budget");
		assert.equal(current(s)?.check, undefined);
		assert.equal(current(s)?.budget, undefined);
		await s.prompt("/goal");
		assert.match(ui.notices.at(-1)!, /^Goal \(blocked: testing edits, set by the user\):\nShip it today\n/);
		assert.match(ui.statuses.get("goal")!, /^goal blocked: Ship it today$/);
	});

	test("paused: the run ends normally and no section shows; resumed: it holds again; cleared: nothing changes any more", async () => {
		const { s, ui } = await newSession();
		const prompts: string[] = [];
		respond(
			async () => {
				await s.prompt("/goal pause");
				return say("Paused, so I stop.");
			},
		);
		await s.prompt("/goal Write the report");
		await until("the paused run", settled(s, "Paused, so I stop."));
		assert.equal(current(s)?.status, "paused");
		assert.equal(continues(s).length, 0);
		assert.match(ui.statuses.get("goal")!, /^goal paused: Write the report$/);

		respond(() => {
			prompts.push(s.systemPrompt);
			return say("Hello.");
		});
		await s.prompt("hi");
		assert.doesNotMatch(prompts[0]!, /<goal>/);
		assert.equal(continues(s).length, 0);

		respond(
			(context) => {
				prompts.push(s.systemPrompt, lastText(context));
				return say("Resuming.");
			},
			goalCall({ action: "achieved" }),
			say("Report written."),
		);
		await s.prompt("/goal resume");
		await until("the resumed run", settled(s, "Report written."));
		assert.match(prompts[1]!, /<goal>/);
		assert.match(prompts[2]!, /The user resumed the goal\. Continue working toward it:\\n\\nWrite the report/);
		assert.equal(continues(s).length, 1);

		await s.prompt("/goal clear");
		assert.equal(current(s), undefined);
		assert.equal(ui.statuses.get("goal"), undefined);
		respond(say("No goal."));
		await s.prompt("hi again");
		assert.equal(continues(s).length, 1, "no goal: the run ends as before");
	});
});

describe("a goal set by the agent", () => {
	test("set with the tool, held at the end, blocked with a reason; the user's reply makes it active again", async () => {
		const { s, ui } = await newSession();
		const prompts: string[] = [];
		respond(
			goalCall({ action: "set", objective: "Migrate every caller to the new API.", check: "true" }),
			say("Migrated one caller."),
			goalCall({ action: "blocked" }),
			goalCall({ action: "blocked", reason: "The last caller needs an API key only you have." }),
			say("I need the API key."),
		);
		await s.prompt("Brief: keep going until every caller is migrated.");
		const texts = toolTexts(s);
		assert.match(texts[0]!, /^Goal set and active\. Your turn cannot end while it is active/);
		assert.match(texts[1]!, /^error: blocked needs a reason/);
		assert.match(texts[2]!, /^Goal blocked: The last caller needs an API key only you have\./);
		assert.equal(continues(s).length, 1);
		assert.deepEqual({ ...current(s), id: "" }, { id: "", objective: "Migrate every caller to the new API.", check: "true", status: "blocked", reason: "The last caller needs an API key only you have.", setBy: "agent" });
		assert.match(ui.statuses.get("goal")!, /^goal blocked: Migrate every caller/);

		respond(
			() => {
				prompts.push(s.systemPrompt);
				return say("Thanks.");
			},
			goalCall({ action: "achieved" }),
			say("All callers migrated."),
		);
		await s.prompt("The key is in the vault.");
		assert.equal(current(s)?.status, "achieved");
		assert.match(prompts[0]!, /<goal>\nThis session has a goal, set by you:/);
		assert.equal(continues(s).length, 2);
	});

	test("the agent cannot replace or resume the user's goal, but can update its own", async () => {
		const { s } = await newSession();
		respond(goalCall({ action: "set", objective: "Other plan." }), goalCall({ action: "blocked", reason: "stop here" }), say("ok"));
		await s.prompt("/goal Users plan.");
		await until("the run", settled(s, "ok"));
		assert.match(toolTexts(s)[0]!, /^error: The user set this session's goal, and it is active: Users plan\.\nYou cannot replace it/);

		await s.prompt("/goal clear");
		respond(
			goalCall({ action: "set", objective: "Mine.", budget_usd: 2 }),
			goalCall({ action: "set", objective: "Mine.", check: "true" }),
			goalCall({ action: "show" }),
			goalCall({ action: "set", objective: "Mine instead." }),
			goalCall({ action: "achieved" }),
			goalCall({ action: "achieved" }),
			say("done"),
		);
		await s.prompt("go");
		const [, updated, shown, replaced, achieved, again] = toolTexts(s).slice(-6);
		assert.match(updated!, /^Goal updated and active\./);
		assert.match(shown!, /^Goal \(active, set by the agent\):\nMine\.\nCheck: `true` must exit 0\.\nBudget: \$2\.00\.\n/);
		assert.match(replaced!, /^Goal set and active\./);
		assert.match(achieved!, /^Goal achieved\. Spent while active: \$0\.00, [\d.k]+ tokens\. Report the result to the user\.$/);
		assert.equal(again, "The goal is already achieved.");
	});
});

describe("persistence", () => {
	test("the goal survives a reload, compaction, branch navigation and a new process reading the session file", async () => {
		const { s, ui } = await newSession();
		respond(goalCall({ action: "set", objective: "Keep the docs current.", budget_tokens: 10_000_000 }), goalCall({ action: "blocked", reason: "waiting for review" }), say("Blocked for now."));
		await s.prompt("keep going");
		const before = s.sessionManager.getLeafId()!;
		ui.statuses.clear();
		await reload(s);
		assert.match(ui.statuses.get("goal")!, /^goal blocked: Keep the docs current\. · /, "the reloaded extension shows it");

		respond(say("Summary of the conversation."));
		await s.compact();
		assert.equal(current(s)?.status, "blocked", "compaction keeps it");

		// A sibling branch from before the goal existed has none; navigating back restores it.
		const first = s.sessionManager.getBranch().find((e) => e.type === "message" && e.message.role === "user")!;
		await s.navigateTree(first.id);
		assert.equal(current(s), undefined);
		assert.equal(ui.statuses.get("goal"), undefined);
		await s.navigateTree(before);
		assert.equal(current(s)?.status, "blocked");
		assert.match(ui.statuses.get("goal")!, /^goal blocked/);

		const file = s.sessionManager.getSessionFile()!;
		const script = `import { SessionManager } from "@earendil-works/pi-coding-agent"; import { goalState } from ${JSON.stringify(new URL("../extensions/goal/goal.ts", import.meta.url).href)}; const m = SessionManager.open(${JSON.stringify(file)}); console.log(JSON.stringify(goalState(m.getBranch()).goal));`;
		const printed = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" }));
		assert.equal(printed.objective, "Keep the docs current.");
		assert.equal(printed.status, "blocked");

		// A new session on the same file: the user's message makes it active, and it holds the run.
		const reopened = await newSession(SessionManager.open(file));
		assert.match(reopened.ui.statuses.get("goal")!, /^goal blocked: Keep the docs current\./);
		respond(say("Back."), goalCall({ action: "achieved" }), say("Docs current."));
		await reopened.s.prompt("review is done");
		assert.equal(continues(reopened.s).length, 1);
		assert.equal(current(reopened.s)?.status, "achieved");
	});
});

describe("limits", () => {
	test("the budget reached: the goal becomes budget-limited, the agent writes a summary, and the run ends", async () => {
		const { s, ui } = await newSession();
		const seen: string[] = [];
		respond(
			goalCall({ action: "set", objective: "Refactor everything.", budget_tokens: 1 }),
			// Spend counts from the goal on: this reply is the first that does.
			say("Working on the parser."),
			(context) => {
				seen.push(lastText(context));
				return say("Summary: nothing refactored yet; next, the parser.");
			},
		);
		await s.prompt("keep going until done");
		assert.match(seen[0]!, /The budget of your goal is reached \(spent \$0\.00, [\d.k]+ of 1 tokens\); the goal is now budget-limited/);
		assert.equal(current(s)?.status, "budget-limited");
		assert.equal(continues(s).length, 0, "no forcing once limited");
		assert.match(ui.statuses.get("goal")!, /^goal budget-limited: Refactor everything\./);

		await s.prompt("/goal resume");
		assert.match(ui.notices.at(-1)!, /budget is spent; raise it first/);
		respond(goalCall({ action: "set", objective: "Refactor everything." }), say("Cannot."));
		await s.prompt("try again");
		assert.match(toolTexts(s).at(-1)!, /^error: The goal's budget is spent/);
	});

	test("the loop guard: after the limit of continues without a tool call the run ends and the user is told; a user message re-arms it", async () => {
		const { s, ui } = await newSession();
		respond(goalCall({ action: "set", objective: "Finish the port." }), ...Array.from({ length: MAX_IDLE_CONTINUES + 1 }, (_, i) => say(`Thinking ${i}.`)));
		await s.prompt("keep going");
		assert.equal(continues(s).length, MAX_IDLE_CONTINUES);
		assert.equal(faux.getPendingResponseCount(), 0);
		assert.match(ui.notices.at(-1)!, /^Goal: the agent stopped 4 times in a row without a tool call, so its turn ended\. The goal stays active/);
		assert.equal(current(s)?.status, "active");

		// Tool calls reset the count: a reply after real work is held again.
		respond(say("Still thinking."), bash("true"), say("Did a step."), goalCall({ action: "achieved" }), say("Ported."));
		await s.prompt("go on");
		assert.equal(continues(s).length, MAX_IDLE_CONTINUES + 2);
		assert.equal(current(s)?.status, "achieved");
		assert.equal(ui.notices.filter((t) => t.startsWith("Goal: the agent stopped")).length, 1);
	});
});

describe("strict mode: background work pending", () => {
	test("a reply without dependencies continues; a wait naming a running job for every step ends the turn; the job's end wakes the session", async () => {
		const { s } = await newSession();
		const seen: string[] = [];
		respond(
			goalCall({ action: "set", objective: "Run the kernel tests and fix what fails." }),
			bash("sleep 2 > /dev/null 2>&1 &\necho started"),
			goalCall({ action: "wait", steps: [{ step: "read the results", job: "sleep" }] }),
			say("I wait for the kernel tests; their end wakes me."),
			say("Still waiting for the tests."),
			(context) => {
				seen.push(lastText(context));
				return goalCall({ action: "wait", steps: [{ step: "fix failures", job: "sleep" }, { step: "update docs", job: "the docs" }] });
			},
			goalCall({ action: "wait", steps: [{ step: "read the results and fix failures", job: "sleep 2" }] }),
			say("Every remaining step needs the tests."),
			(context) => {
				seen.push(lastText(context));
				return goalCall({ action: "achieved" });
			},
			say("Kernel tests pass."),
		);
		await s.prompt("keep going");
		const texts = toolTexts(s);
		assert.match(texts[1]!, /^started\n\n\nStill running in the background/);
		assert.match(texts[2]!, /^Waiting is fine: every remaining step depends on a running job \("read the results" → pid \d+\)/, "a wait before any continue is accepted too");
		// It waited, then did more work: its reply needs no new wait while the job runs.
		assert.equal(continues(s).length, 0);
		assert.ok(settled(s, "I wait for the kernel tests")());
		assert.equal(faux.getPendingResponseCount(), 6, "the turn ended after the wait");

		// The next prompt is a new run: the old wait no longer counts.
		await s.prompt("status?");
		assert.equal(continues(s).length, 1);
		assert.match(seen[0]!, /Background work is still running; its end wakes you with its result:\\n- pid \d+: `sleep 2` \(running \d+ s\)/);
		assert.match(seen[0]!, /List the remaining steps of the goal that do not depend on these jobs, and do them now\./);
		assert.match(toolTexts(s)[3]!, /^error: These steps name no running job: "update docs" \(the docs\)\.\nRunning jobs:\n- pid \d+: `sleep 2`/);
		assert.match(toolTexts(s)[4]!, /^Waiting is fine/);
		assert.ok(settled(s, "Every remaining step needs the tests.")());

		await until("the job's end wakes the session", settled(s, "Kernel tests pass."));
		assert.match(seen[1]!, /Background process pid \d+ `sleep 2` ended/);
		assert.equal(current(s)?.status, "achieved");
	});

	test("wait is refused without a running job or an active goal", async () => {
		const { s } = await newSession();
		respond(goalCall({ action: "wait", steps: [] }), goalCall({ action: "set", objective: "x" }), goalCall({ action: "wait", steps: [{ step: "a", job: "b" }] }), goalCall({ action: "blocked", reason: "r" }), goalCall({ action: "wait", steps: [] }), say("ok"));
		await s.prompt("go");
		const texts = toolTexts(s);
		assert.equal(texts[0], "error: No goal is set.");
		assert.match(texts[2]!, /^error: No background job is running, so nothing will wake you\./);
		assert.match(texts[4]!, /^error: The goal is blocked; nothing keeps your turn going/);
	});
});

describe("without a goal", () => {
	test("nothing changes: no section, no status, the run ends with background work pending", async () => {
		const { s, ui } = await newSession();
		const prompts: string[] = [];
		respond(bash("sleep 0.5 > /dev/null 2>&1 &"), () => {
			prompts.push(s.systemPrompt);
			return say("Started it.");
		}, say("It ended."));
		await s.prompt("start it");
		assert.ok(settled(s, "Started it.")());
		assert.doesNotMatch(prompts[0]!, /<goal>/);
		assert.equal(goalMessages(s).length, 0);
		assert.equal(ui.statuses.get("goal"), undefined);
		await until("the wake", settled(s, "It ended."));
		assert.equal(goalMessages(s).length, 0);
	});
});
