// The session goal (extensions/goal): its state and texts, then real Pi sessions (faux model, real
// bash) where the goal is set by command and by tool, shows in the prompt and status line, survives
// reload, compaction and a new process, holds the run at its end, and lets it end when achieved
// (check passing), blocked, paused, cleared, over budget, stuck (loop guard), or waiting on a
// running background job or delegated task (strict mode); waiting idle again needs a reason, and a
// long idle wait wakes the agent.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, getApiProvider, registerApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, type ExtensionUIContext, ModelRuntime, type SessionEntry, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import bashExtension from "../extensions/bash/index.ts";
import {
	continueText,
	delegatedTasks,
	describeGoal,
	findJob,
	GOAL_ENTRY,
	type Goal,
	goalState,
	overBudget,
	type PendingJob,
	parseBudget,
	parseFlags,
	pendingText,
	sectionText,
	statusLine,
	waitNudgeText,
} from "../extensions/goal/goal.ts";
import goal, { type GoalOptions, MAX_IDLE_CONTINUES, MESSAGE_TYPE } from "../extensions/goal/index.ts";
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
		const task: PendingJob = { key: "task node:t%3A1", command: "delegated task: Review PR #5", ids: ["node:t%3A1", "thread:t%3A1"] };
		assert.equal(findJob([...jobs, task], "task node:t%3A1")?.key, task.key);
		assert.equal(findJob([...jobs, task], "node:t%3A1")?.key, task.key, "the bare task id");
		assert.equal(findJob([...jobs, task], "thread:t%3A1")?.key, task.key, "its child thread");
		assert.equal(findJob([...jobs, task], "review pr")?.key, task.key, "a part of its title");
		assert.equal(findJob([...jobs, task], "task node:other"), undefined);
	});

	test("delegated tasks: running while t3 says their completion wakes the session; ended by any other word from t3 or their completion message", () => {
		let at = 1000;
		const result = (toolName: string, data: unknown, isError = false): SessionEntry =>
			({ type: "message", id: `e${++n}`, parentId: null, timestamp: "", message: { role: "toolResult", toolCallId: `c${n}`, toolName, content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }], isError, timestamp: (at += 1000) } }) as unknown as SessionEntry;
		const user = (text: string): SessionEntry => ({ type: "message", id: `e${++n}`, parentId: null, timestamp: "", message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } }) as unknown as SessionEntry;
		const NEXT = "Completion wakes this thread, so end your turn. Do not wait on it or poll it.";
		const started = (taskId: string, title?: string) => ({ taskId, childThreadId: `thread:${taskId}`, ...(title ? { link: `[${title}](t3-thread://v2/x/thread:${taskId})` } : {}), status: "running", workState: "working", next: NEXT });

		const a = result("mcp__t3-code__delegate_task", started("node:a", "Review [PR] #1"));
		assert.deepEqual(delegatedTasks([a]), { running: [{ key: "task node:a", command: "delegated task: Review [PR] #1", ids: ["node:a", "thread:node:a"], startedAt: 2000 }], ended: new Set() });
		const branch = [
			a,
			result("mcp__t3_code__delegate_task", started("node:b"), false),
			result("mcp__t3-code__delegate_task", { taskId: "node:waited", status: "completed", workState: "result_available", summary: "done" }),
			result("mcp__t3-code__delegate_task", started("node:failed-call"), true),
			result("bash", started("node:not-t3")),
			result("mcp__t3-code__t3_thread_read", "not json {"),
			result("mcp__t3-code__task_status", started("node:a")),
			result("mcp__t3-code__delegate_task", started("node:asks")),
			result("mcp__t3-code__task_status", { taskId: "node:asks", status: "running", workState: "working", hasPendingQuestion: true }),
			result("mcp__t3-code__delegate_task", started("node:c")),
			result("mcp__t3-code__task_cancel", { taskId: "node:c", status: "cancel_requested" }),
		];
		const mid = delegatedTasks(branch);
		assert.deepEqual(
			mid.running.map((t) => [t.key, t.command, t.startedAt]),
			[
				["task node:a", "delegated task: Review [PR] #1", 2000],
				["task node:b", "delegated task", 3000],
			],
			"a status read keeps the title and start; a wait-mode result that finished, an error, another tool and non-JSON add nothing",
		);
		assert.deepEqual([...mid.ended].sort(), ["node:asks", "node:c", "node:waited"]);

		const done = delegatedTasks([
			...branch,
			user("Delegated task node:a (Review [PR] #1) [completed]:\nAll good; see Delegated task node:zzz.\n\nDelegated task node:b [failed]. Use task_status with taskId node:b to read the result."),
			// A send to the finished child thread starts a fresh task under the same id.
			result("mcp__t3-code__t3_thread_send", { threadId: "thread:node:c", link: "[Again](t3-thread://v2/x/thread:node:c)", taskId: "node:c", status: "queued", delivery: "queued" }),
			result("mcp__t3-code__t3_thread_send", { threadId: "thread:node:d", taskId: "node:d", status: "completed", delivery: "started" }),
		]);
		assert.deepEqual(done.running.map((t) => [t.key, t.command, t.ids]), [["task node:c", "delegated task: Again", ["node:c", "thread:node:c"]]]);
		assert.deepEqual([...done.ended].sort(), ["node:a", "node:asks", "node:b", "node:d", "node:waited"]);
	});

	test("the wake-up after idle waiting names the jobs, how long, and what to do instead", () => {
		const text = waitNudgeText([{ key: "call c1", command: "npm test", ids: ["c1"], startedAt: 0 }], 16 * 60_000, 20 * 60_000);
		assert.match(text, /^You have been waiting 16 min on background work without doing anything else:\n- call c1: `npm test` \(running 20 min\)\n\nDo not keep waiting idle; use the time\./);
		assert.match(text, /Cut a job's run time/);
		assert.match(text, /Start independent work in parallel/);
		assert.match(text, /action `wait` again, with a `reason`/);
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
		const pending = pendingText([{ key: "call c1", command: "npm run build", ids: ["c1"], startedAt: 0 }, { key: "pid 7", command: "npm test", ids: ["7"] }], 61_000);
		assert.equal(
			pending,
			[
				"Your turn is about to end while background work runs; its end wakes you with its result:",
				"- call c1: `npm run build` (running 1 min)",
				"- pid 7: `npm test`",
				"",
				"Do not end your turn to wait for it. Continue now with the remaining steps that do not depend on these jobs; where it is safe, assume they succeed and let their result correct you.",
				"Only if every remaining step depends on them, or a job is a server you keep running on purpose, end your turn with one line naming what you wait for.",
			].join("\n"),
		);
		assert.doesNotMatch(pending, /goal/i, "no goal is involved");
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

async function newSession(sessionManager = SessionManager.create(join(dir, "repo"), join(dir, "sessions")), setup: { goal?: GoalOptions; extensions?: ((pi: ExtensionAPI) => void)[] } = {}): Promise<{ s: AgentSession; ui: Ui }> {
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
			(pi: ExtensionAPI) => goal(pi, setup.goal),
			...(setup.extensions ?? []),
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
const nudges = (s: AgentSession) => goalMessages(s).filter((t) => t.startsWith("Your turn is about to end while background work runs"));
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

		// A t3 notification is not the user's reply: the goal stays blocked (patched t3 and the unpatched fallback).
		respond(say("Noted."), say("Noted."));
		await s.prompt("Delegated task abc (Review) [completed]:\nAll good.", { source: "notification" });
		assert.equal(current(s)?.status, "blocked", "a notification does not unblock");
		await s.prompt("Delegated task abc (Review) [completed]:\nAll good.", { source: "rpc" });
		assert.equal(current(s)?.status, "blocked", "an unpatched t3's notification does not unblock");

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
			// It waited on this job before and did nothing since: waiting again takes a reason.
			goalCall({ action: "wait", steps: [{ step: "read the results and fix failures", job: "sleep 2" }], reason: "every step needs the results" }),
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
		assert.match(texts[2]!, /^error: No background job or delegated task is running, so nothing will wake you\./);
		assert.match(texts[4]!, /^error: The goal is blocked; nothing keeps your turn going/);
	});
});

/** t3's tools as its MCP bridge registers them, answering with the JSON t3 returns: a running task (its completion wakes the caller) or a finished one. */
function fakeT3(pi: ExtensionAPI) {
	const NEXT = "Completion wakes this thread, so end your turn. Do not wait on it or poll it.";
	let count = 0;
	const finished = new Set<string>();
	const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: { server: "t3-code" } });
	pi.registerTool({
		name: "mcp__t3-code__delegate_task",
		label: "delegate_task",
		description: "Start a child agent.",
		parameters: Type.Object({ task: Type.String(), title: Type.Optional(Type.String()) }),
		execute: async (_id, params) => {
			const taskId = `node:delegated-task:t${++count}`;
			return json({ taskId, childThreadId: `thread:${taskId}`, link: `[${params.title ?? "Child"}](t3-thread://v2/x/thread:${taskId})`, status: "running", workState: "working", next: NEXT });
		},
	});
	pi.registerTool({
		name: "mcp__t3-code__task_status",
		label: "task_status",
		description: "Read a task.",
		parameters: Type.Object({ taskId: Type.String() }),
		execute: async (_id, { taskId }) => json(finished.has(taskId) ? { taskId, status: "completed", workState: "result_available", summary: "Done." } : { taskId, status: "running", workState: "working", next: NEXT }),
	});
	return { finish: (taskId: string) => finished.add(taskId) };
}
const t3Call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(`mcp__t3-code__${name}`, args)], { stopReason: "toolUse" });
const TASK1 = "node:delegated-task:t1";

describe("waiting on delegated tasks", () => {
	test("a running async task is listed and waitable; the turn ends; its completion message ends it, so waiting on it again is refused", async () => {
		const { s } = await newSession(undefined, { extensions: [(pi) => void fakeT3(pi)] });
		const seen: string[] = [];
		respond(
			goalCall({ action: "set", objective: "Land the reviewed change." }),
			t3Call("delegate_task", { task: "Review the diff.", title: "Review the diff" }),
			say("The review runs."),
			(context) => {
				seen.push(lastText(context));
				return goalCall({ action: "wait", steps: [{ step: "apply the review", job: "task node:delegated-task:t9" }] });
			},
			goalCall({ action: "wait", steps: [{ step: "apply the review", job: `task ${TASK1}` }, { step: "land it", job: "review the diff" }] }),
			say("Every remaining step needs the review; its completion wakes me."),
		);
		await s.prompt("keep going");
		assert.ok(settled(s, "its completion wakes me")());
		assert.equal(faux.getPendingResponseCount(), 0);
		assert.equal(continues(s).length, 1);
		assert.match(seen[0]!, new RegExp(`Background work is still running; its end wakes you with its result:\\\\n- task ${TASK1}: \`delegated task: Review the diff\` \\(running \\d+ s\\)`));
		const texts = toolTexts(s);
		assert.match(texts[2]!, /^error: These steps name no running job: "apply the review" \(task node:delegated-task:t9\)\.\nRunning jobs:\n- task node:delegated-task:t1: /);
		assert.match(texts[3]!, new RegExp(`^Waiting is fine: every remaining step depends on a running job \\("apply the review" → task ${TASK1}; "land it" → task ${TASK1}\\)\\.`));
		assert.equal(nudges(s).length, 0, "without a goal-free settle, no pending-work message");

		// t3 wakes the parent with the completion as a user message.
		respond(
			goalCall({ action: "wait", steps: [{ step: "apply the review", job: `task ${TASK1}` }] }),
			goalCall({ action: "achieved" }),
			say("Landed."),
		);
		await s.prompt(`Delegated task ${TASK1} (Review the diff) [completed]:\nLooks good.`);
		assert.ok(settled(s, "Landed.")());
		assert.match(toolTexts(s).at(-2)!, new RegExp(`^error: No background job or delegated task is running, so nothing will wake you\\. Delegated task ${TASK1} ended already`));
		assert.equal(current(s)?.status, "achieved");
	});

	test("a task_status read of a finished task ends it; a running one keeps it; a background job and a task are waited on together", async () => {
		let t3!: ReturnType<typeof fakeT3>;
		const { s } = await newSession(undefined, { extensions: [(pi) => void (t3 = fakeT3(pi))] });
		respond(
			goalCall({ action: "set", objective: "Ship." }),
			t3Call("delegate_task", { task: "Write docs.", title: "Docs" }),
			t3Call("task_status", { taskId: TASK1 }),
			bash("sleep 20 > /dev/null 2>&1 &"),
			goalCall({ action: "wait", steps: [{ step: "merge the docs", job: "docs" }, { step: "read the build", job: "sleep 20" }] }),
			say("Waiting for the docs and the build."),
		);
		await s.prompt("go");
		assert.match(toolTexts(s)[4]!, new RegExp(`^Waiting is fine: every remaining step depends on a running job \\("merge the docs" → task ${TASK1}; "read the build" → pid \\d+\\)`));
		assert.equal(faux.getPendingResponseCount(), 0);

		t3.finish(TASK1);
		respond(t3Call("task_status", { taskId: TASK1 }), goalCall({ action: "wait", steps: [{ step: "merge the docs", job: TASK1 }] }), goalCall({ action: "blocked", reason: "stop" }), say("Stopped."));
		await s.prompt("status?");
		assert.match(toolTexts(s).at(-2)!, new RegExp(`^error: These steps name no running job: "merge the docs" \\(${TASK1}\\)\\.\\nDelegated task ${TASK1} ended already`));
		assert.doesNotMatch(toolTexts(s).at(-2)!, /- task /, "only the build runs");
	});
});

describe("waiting idle", () => {
	test("waiting again without a tool call since needs a reason; after work it does not; an ended job is forgotten", async () => {
		const { s } = await newSession();
		const wait = (reason?: string) => goalCall({ action: "wait", steps: [{ step: "read the results", job: "sleep 20" }], ...(reason ? { reason } : {}) });
		respond(goalCall({ action: "set", objective: "Test it." }), bash("sleep 20 > /dev/null 2>&1 &"), wait(), say("Waiting."));
		await s.prompt("go");
		assert.match(toolTexts(s).at(-1)!, /^Waiting is fine: .*If you are still waiting idle after a while, you will be woken to use the time\.$/);

		respond(wait(), wait("   "), wait("Every step needs the test results; nothing else is left."), say("Still waiting."));
		await s.prompt("status?");
		const [refused, blank, accepted] = toolTexts(s).slice(-3);
		assert.match(refused!, /^error: You have been waiting on pid \d+ for \d+ s and made no tool call since your last wait: waiting again is not progress\.\nUse the time: .*cut its run time.*\nOnly if every remaining step still depends on it, call `wait` again with a `reason`/s);
		assert.match(blank!, /^error: You have been waiting/, "a blank reason is none");
		assert.match(accepted!, /^Waiting is fine: .*\)\. Your reason to wait again: Every step needs the test results; nothing else is left\. End your turn now/);

		respond(bash("true"), wait(), say("Did a step, waiting again."));
		await s.prompt("anything else?");
		assert.match(toolTexts(s).at(-1)!, /^Waiting is fine: [^]*\)\. End your turn now/, "a tool call in between: no reason needed");
	});

	test("an idle wait wakes the agent after the threshold, then after twice the time; waiting again needs a reason; a blocked goal stops it", async () => {
		const { s } = await newSession(undefined, { goal: { waitNudgeMs: 300 } });
		const seen: { at: number; text: string }[] = [];
		const woken = (reply: ReturnType<typeof say>) => (context: { messages: readonly unknown[] }) => {
			seen.push({ at: Date.now(), text: lastText(context) });
			return reply;
		};
		const wait = (reason?: string) => goalCall({ action: "wait", steps: [{ step: "read the results", job: "sleep 30" }], ...(reason ? { reason } : {}) });
		respond(
			goalCall({ action: "set", objective: "Test it." }),
			bash("sleep 30 > /dev/null 2>&1 &"),
			wait(),
			say("Waiting."),
			woken(wait()),
			wait("The tests gate every step."),
			say("Still waiting."),
			woken(goalCall({ action: "blocked", reason: "the tests take too long" })),
			say("Blocked."),
		);
		const waitedAt = Date.now();
		await s.prompt("go");
		await until("two wake-ups", settled(s, "Blocked."), 15_000);
		assert.equal(seen.length, 2);
		assert.match(seen[0]!.text, /You have been waiting \d+ s on background work without doing anything else:\\n- pid \d+: `sleep 30`/);
		assert.ok(seen[0]!.at - waitedAt >= 300, "not before the threshold");
		// Each is seen when the model answers it, so the gap carries some latency: well above the threshold, not exactly twice it.
		assert.ok(seen[1]!.at - seen[0]!.at >= 450, `the second after twice the time (${seen[1]!.at - seen[0]!.at} ms)`);
		assert.match(toolTexts(s).at(-3)!, /^error: You have been waiting on pid \d+/, "woken, waiting again without work needs a reason");
		assert.match(toolTexts(s).at(-2)!, /^Waiting is fine: .*Your reason to wait again: The tests gate every step\./);
		assert.equal(current(s)?.status, "blocked");
		await new Promise((r) => setTimeout(r, 1500));
		assert.equal(seen.length, 2, "no wake-up once the goal is blocked");
		assert.equal(faux.getPendingResponseCount(), 0);
	});

	test("a single wait on a job that ends before the threshold is never disturbed", async () => {
		const { s } = await newSession(undefined, { goal: { waitNudgeMs: 1500 } });
		const seen: string[] = [];
		respond(
			goalCall({ action: "set", objective: "Test it." }),
			bash("sleep 0.5 > /dev/null 2>&1 &"),
			goalCall({ action: "wait", steps: [{ step: "read the results", job: "sleep 0.5" }] }),
			say("Waiting."),
			(context) => {
				seen.push(lastText(context));
				return goalCall({ action: "achieved" });
			},
			say("Tested."),
		);
		await s.prompt("go");
		await until("the job's end", settled(s, "Tested."));
		assert.match(seen[0]!, /Background process pid \d+ `sleep 0\.5` ended/);
		await new Promise((r) => setTimeout(r, 1800));
		assert.equal(goalMessages(s).filter((t) => t.startsWith("You have been waiting")).length, 0);
		assert.equal(faux.getPendingResponseCount(), 0);
	});
});

describe("without a goal", () => {
	test("no background work: no section, no status, no message; the run ends", async () => {
		const { s, ui } = await newSession();
		const prompts: string[] = [];
		respond(bash("true"), () => {
			prompts.push(s.systemPrompt);
			return say("Done.");
		});
		await s.prompt("do it");
		assert.ok(settled(s, "Done.")());
		assert.doesNotMatch(prompts[0]!, /<goal>/);
		assert.equal(goalMessages(s).length, 0);
		assert.equal(ui.statuses.get("goal"), undefined);
		assert.equal(faux.getPendingResponseCount(), 0);
	});

	test("a new job continues the run once; the same jobs never again, across runs and wakes; a job added continues it once more", async () => {
		const { s } = await newSession();
		const seen: string[] = [];
		respond(bash("sleep 2.5 > /dev/null 2>&1 &"), say("Started the long job."), (context) => {
			seen.push(lastText(context));
			return say("Every remaining step needs it; I wait for the sleep 2.5 job.");
		});
		await s.prompt("start it");
		await until("the first run", settled(s, "I wait for the sleep 2.5 job."));
		assert.equal(nudges(s).length, 1);
		assert.match(seen[0]!, /Your turn is about to end while background work runs; its end wakes you with its result:\\n- pid \d+: `sleep 2\.5` \(running \d+ s\)\\n\\nDo not end your turn to wait for it\./);
		assert.equal(continues(s).length, 0, "not the goal's message");
		assert.equal(faux.getPendingResponseCount(), 0, "the reply naming what it waits for ends the turn");

		// The same job in a new run (a server kept on purpose): no request is spent on it again.
		respond(say("It still runs."));
		await s.prompt("status?");
		assert.ok(settled(s, "It still runs.")());
		assert.equal(nudges(s).length, 1);

		// A job added: told once more, with every job that runs.
		respond(bash("sleep 1 > /dev/null 2>&1 &"), say("Started the short job."), (context) => {
			seen.push(lastText(context));
			return say("Both run; I wait for them.");
		}, say("The short one ended."), say("The long one ended."));
		await s.prompt("start another");
		await until("the second run", settled(s, "Both run; I wait for them."));
		assert.equal(nudges(s).length, 2);
		assert.match(seen[1]!, /- pid \d+: `sleep 2\.5` \(running \d+ s\)\\n- pid \d+: `sleep 1` \(running \d+ s\)/);

		// Wakes by the jobs' ends: fewer jobs, or none, is nothing new.
		await until("both ends wake the session", settled(s, "The long one ended."));
		assert.equal(nudges(s).length, 2);
		assert.equal(faux.getPendingResponseCount(), 0);
	});

	test("an aborted or failed run is not continued; the next completed one is", async () => {
		const { s } = await newSession();
		respond(bash("sleep 3 > /dev/null 2>&1 &"), fauxAssistantMessage("Stopped.", { stopReason: "aborted", errorMessage: "Request was aborted" }));
		await s.prompt("start it");
		await until("the aborted run", () => !s.isStreaming && s.messages.at(-1)?.role === "assistant");
		assert.equal(nudges(s).length, 0);

		respond(fauxAssistantMessage("Broken.", { stopReason: "error", errorMessage: "invalid request body" }));
		await s.prompt("go on");
		await until("the failed run", () => !s.isStreaming && JSON.stringify(s.messages.at(-1)).includes("invalid request body"));
		assert.equal(nudges(s).length, 0);

		respond(say("Fine now."), say("Waiting for the sleep."));
		await s.prompt("again");
		await until("the completed run", settled(s, "Waiting for the sleep."));
		assert.equal(nudges(s).length, 1, "the job was never named to the agent before");
	});

	test("jobs the goal's strict continue or a wait named do not continue the run again once the goal is finished; jobs it did not name do", async () => {
		const { s } = await newSession();
		respond(
			goalCall({ action: "set", objective: "Build and test." }),
			bash("sleep 3 > /dev/null 2>&1 &"),
			say("Started the build."),
			goalCall({ action: "achieved" }),
			say("Achieved; the build runs on."),
		);
		await s.prompt("keep going");
		await until("the goal run", settled(s, "Achieved; the build runs on."));
		assert.equal(continues(s).length, 1, "the goal's strict continue named the job");
		assert.match(continues(s)[0]!, /Background work is still running/);
		assert.equal(nudges(s).length, 0);

		respond(
			goalCall({ action: "set", objective: "Test again." }),
			bash("sleep 3 > /dev/null 2>&1 &"),
			goalCall({ action: "wait", steps: [{ step: "read the results", job: "sleep 3" }] }),
			bash("sleep 3.1 > /dev/null 2>&1 &"),
			goalCall({ action: "blocked", reason: "needs the user" }),
			say("Blocked."),
			say("Carrying on with the docs."),
		);
		await s.prompt("once more");
		await until("the blocked run", settled(s, "Carrying on with the docs."));
		assert.equal(nudges(s).length, 1, "the job started after the wait was never named");
		assert.match(nudges(s)[0]!, /`sleep 3\.1`/);
		assert.equal(faux.getPendingResponseCount(), 0);
	});
});
