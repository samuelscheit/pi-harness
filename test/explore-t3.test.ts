// The explore tool inside t3 (extensions/explore/t3-explorer.ts): the explorer is a t3 delegated task.
// A fake t3 stands in for the MCP bridge: delegate_task and t3_thread_send "run" the child by
// writing its delegation state (as the child extension does), so the whole path from the tool's
// execute to the rendered ranges runs for real.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EXPLORER_TOOLS } from "../extensions/explore/explorer.ts";
import explore, { type ExploreDetails, MAX_DEPTH } from "../extensions/explore/index.ts";
import { disposeT3Explorers, T3_SYSTEM } from "../extensions/explore/t3-explorer.ts";
import { type DelegationSpec, delegationMessage, delegationsDir, parseMarker, readSpec, writeSpec, writeState } from "../extensions/workflow/delegation.ts";
import { T3_DELEGATE, T3_PREFIX } from "../extensions/workflow/t3.ts";

let dir: string;
let repo: string;
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "explore-t3-")));
	repo = join(dir, "repo");
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "b.ts"), "export function cost() {\n\treturn 1;\n}\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** What the child does for a run: its submitted result, files it wrote, or an error; `hang` never ends the run. */
type ChildRun = { result?: Record<string, unknown>; wrote?: string[]; error?: string; hang?: boolean };

interface Call {
	name: string;
	args: Record<string, unknown>;
}

/** A fake t3: records calls; each started or sent run takes the next scripted child run. */
function fakeT3(runs: ChildRun[]) {
	const calls: Call[] = [];
	let threads = 0;
	const hang = (signal?: AbortSignal) => new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
	let hanging = false;
	const play = (message: string) => {
		const marker = parseMarker(message)!;
		const step = runs.shift() ?? { error: "unscripted run" };
		hanging = step.hang === true;
		if (hanging) return;
		writeState(delegationsDir(dir), marker.id, { sessionId: "child-session", cost: 0, run: marker.run, done: true, ...(step.result ? { submitted: true, result: step.result } : {}), ...(step.wrote ? { wrote: step.wrote } : {}), ...(step.error ? { error: step.error } : {}) });
	};
	const executeTool = async (name: string, args: unknown, options?: { signal?: AbortSignal }) => {
		const bare = name.slice(T3_PREFIX.length);
		const a = args as Record<string, unknown>;
		calls.push({ name: bare, args: a });
		const data = (value: Record<string, unknown>) => ({ result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value }, isError: false });
		switch (bare) {
			case "delegate_task": {
				threads++;
				play(String(a.task));
				return data({ taskId: `task-${threads}`, childThreadId: `thread-${threads}`, link: `t3://thread-${threads}`, childRunId: "run-1", status: hanging ? "running" : "completed", waitTimedOut: hanging });
			}
			case "t3_thread_send":
				play(String(a.message));
				return data({ runId: `run-${calls.length}` });
			case "t3_thread_wait":
				if (hanging) await hang(options?.signal);
				return data({ status: "idle" });
			case "task_status":
				return data({ summary: "done" });
			case "task_cancel":
				return data({ cancelled: true });
			default:
				throw new Error(`unexpected ${name}`);
		}
	};
	return { calls, executeTool, named: (n: string) => calls.filter((c) => c.name === n) };
}

/** The explore tool as registered, and a context for it inside t3 (or outside, without delegate_task). */
function exploreTool(depth?: number) {
	let tool: { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: ExploreDetails }> } | undefined;
	const pi = { registerTool: (t: never) => (tool = t), on: () => undefined, getActiveTools: () => [] } as unknown as ExtensionAPI;
	explore(pi, { agentDir: dir, ...(depth !== undefined ? { depth } : {}), modelRuntime: async () => assert.fail("no in-process explorer inside t3") });
	return tool!;
}

const context = (executeTool: unknown, entries: unknown[] = []) => ({
	cwd: repo,
	tools: [{ name: T3_DELEGATE }, { name: "read" }],
	executeTool,
	sessionManager: { getSessionId: () => "caller", getSessionFile: () => undefined, getSessionDir: () => dir, getBranch: () => [], getEntries: () => entries },
});

const run = (tool: ReturnType<typeof exploreTool>, ctx: unknown, question: string, signal?: AbortSignal) => tool.execute("call", { question }, signal, undefined, ctx);

afterEach(() => disposeT3Explorers("caller", dir));

describe("explore in t3", () => {
	test("the explorer starts as a pi child task; its result renders as ranges; a follow-up goes to the same thread", async () => {
		const t3 = fakeT3([
			{ result: { answer: "cost() is in src/b.ts:1.", ranges: "src/b.ts:1-3 definition" }, wrote: [join(repo, "src/new.ts")] },
			{ result: { answer: "It returns 1.", ranges: "src/b.ts:1-3", changed: ["src/sub.ts"] } },
		]);
		const tool = exploreTool();
		const ctx = context(t3.executeTool);
		const first = await run(tool, ctx, "Where is cost defined?\nmore");
		assert.equal(first.content[0]!.text, "cost() is in src/b.ts:1.\n\n[The explorer changed: src/new.ts]\n\nsrc/b.ts:1-3 (definition)\n```\nexport function cost() {\n\treturn 1;\n}\n```");
		assert.deepEqual(first.details.childSessions, ["child-session"]);
		assert.equal(first.details.explorer, "t3://thread-1");
		assert.equal(first.details.turns, 1);
		const [start] = t3.named("delegate_task");
		assert.equal(start!.args.title, "explore: Where is cost defined?");
		assert.deepEqual(start!.args.target, { providerInstanceId: "pi", model: "anthropic/claude-haiku-5-5", options: { thinking: "low" } });
		assert.equal(start!.args.schema, undefined, "the spec is prepared already: t3 gets no harness keys");
		const spec = readSpec(delegationsDir(dir), parseMarker(String(start!.args.task))!.id)!;
		assert.equal(spec.system, T3_SYSTEM);
		assert.deepEqual(spec.tools, [...EXPLORER_TOOLS, "explore"]);
		assert.equal(spec.exploreDepth, 1);
		assert.deepEqual(Object.keys((spec.schema as { properties: object }).properties), ["answer", "ranges", "changed"]);

		const second = await run(tool, ctx, "And what does it return?");
		assert.equal(t3.named("delegate_task").length, 1, "the idle explorer is reused");
		const [send] = t3.named("t3_thread_send");
		assert.equal(send!.args.threadId, "thread-1");
		assert.match(String(send!.args.message), /run 2\n\nAnd what does it return\?$/);
		assert.equal(second.details.explorer, first.details.explorer);
		assert.deepEqual(second.details.childSessions, [], "linked once");
		assert.deepEqual(second.details.changed, ["src/sub.ts"], "changes are per run; sub-explorers' come from the result");
	});

	test("malformed range lines are sent back once; still malformed, they are dropped", async () => {
		const t3 = fakeT3([{ result: { answer: "x", ranges: "src/b.ts the file" } }, { result: { answer: "fixed", ranges: "src/b.ts:2-2 return\nnot a range" } }]);
		const out = await run(exploreTool(), context(t3.executeTool), "q");
		const [send] = t3.named("t3_thread_send");
		assert.match(String(send!.args.message), /These lines are not ranges .*"src\/b\.ts the file"/);
		assert.equal(out.details.turns, 2);
		assert.equal(out.content[0]!.text, "fixed\n\nsrc/b.ts:2-2 (return)\n```\n\treturn 1;\n```");
	});

	test("a ranges field leaked into the answer is read as the ranges", async () => {
		const t3 = fakeT3([{ result: { answer: 'ok</answer>\n<parameter name="ranges">src/b.ts:1-1 sig', ranges: "" } }]);
		const out = await run(exploreTool(), context(t3.executeTool), "q");
		assert.equal(out.content[0]!.text, "ok\n\nsrc/b.ts:1-1 (sig)\n```\nexport function cost() {\n```");
	});

	test("a failed child run is an error and its explorer is dropped: the next question starts a new task", async () => {
		const t3 = fakeT3([{ error: "the request failed: overloaded" }, { result: { answer: "fine", ranges: "" } }]);
		const tool = exploreTool();
		const ctx = context(t3.executeTool);
		await assert.rejects(run(tool, ctx, "q"), /The explorer failed: the request failed: overloaded/);
		assert.equal(t3.named("task_cancel").length, 1, "the failed task is stopped");
		const out = await run(tool, ctx, "q2");
		assert.equal(out.content[0]!.text, "fine");
		assert.equal(t3.named("delegate_task").length, 2);
	});

	test("an aborted call cancels the task and frees the pool slot", async () => {
		const t3 = fakeT3([{ hang: true }, { result: { answer: "next", ranges: "" } }]);
		const tool = exploreTool();
		const ctx = context(t3.executeTool);
		const controller = new AbortController();
		const pending = run(tool, ctx, "q", controller.signal);
		for (let i = 0; !t3.named("t3_thread_wait").length; i++) {
			if (i > 400) assert.fail(`no wait: ${JSON.stringify(t3.calls.map((c) => c.name))}`);
			await new Promise((r) => setTimeout(r, 5));
		}
		controller.abort(new Error("stopped"));
		await assert.rejects(pending, /stopped/);
		assert.deepEqual(t3.named("task_cancel").map((c) => c.args.taskId), ["task-1"]);
		const out = await run(tool, ctx, "q2");
		assert.equal(out.content[0]!.text, "next");
		assert.equal(t3.named("delegate_task").length, 2, "the aborted thread is not reused");
	});

	test("depth: a t3 explorer child reads its level from its spec; at the limit its explorer gets no explore", async () => {
		// The calling session is itself an explorer child at MAX_DEPTH - 1: its first message names its spec.
		const own: DelegationSpec = { id: "parent-spec", exploreDepth: MAX_DEPTH - 1 };
		writeSpec(delegationsDir(dir), own);
		const entries = [{ type: "message", message: { role: "user", content: [{ type: "text", text: delegationMessage(own, 1, "question") }] } }];
		const t3 = fakeT3([{ result: { answer: "a", ranges: "" } }]);
		await run(exploreTool(), context(t3.executeTool, entries), "q");
		const spec = readSpec(delegationsDir(dir), parseMarker(String(t3.named("delegate_task")[0]!.args.task))!.id)!;
		assert.deepEqual(spec.tools, EXPLORER_TOOLS);
		assert.equal(spec.exploreDepth, MAX_DEPTH);
	});

	test("outside t3 the in-process explorer runs", async () => {
		const tool = exploreTool();
		const ctx = { ...context(() => assert.fail("no t3 call")), tools: [{ name: "read" }] };
		await assert.rejects(run(tool, ctx, "q"), /no in-process explorer inside t3/);
	});
});
