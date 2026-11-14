// The workflow runtime against real git repositories, real child sessions and a faux model: the
// script API (api.d.ts), its errors, llm() with schemas, retries and the cache, budgets, abort,
// in-process agents (also in parallel), saved workflows and the fix_loop workflow. agent() through
// t3 and the child side of the delegation protocol: test/delegation.test.ts.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { compile, evaluate, inlineModule, scriptStack } from "../extensions/workflow/compile.ts";
import { HARNESS_WORKFLOWS, loadWorkflows, metaProblem, type SavedWorkflow } from "../extensions/workflow/library.ts";

import { INLINE_FILE, type RunEnv, runWorkflow, type WorkflowDetails } from "../extensions/workflow/run.ts";
import { priced } from "./priced.ts";

let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
let dir: string;
let repo: string;
const MODEL = "faux/faux-1";

before(async () => {
	faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	const scratch = mkdtempSync(join(tmpdir(), "workflow-runtime-"));
	runtime = await ModelRuntime.create({ authPath: join(scratch, "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "faux-1", name: "Faux", api: faux.api, reasoning: false, input: ["text"], cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, contextWindow: 200_000, maxTokens: 8000 }],
	});
});
after(() => faux.unregister());

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
const real = () => realpathSync(repo);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "workflow-"));
	repo = join(dir, "repo");
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "calc.mjs"), BROKEN);
	writeFileSync(join(repo, "check.mjs"), 'import { add } from "./src/calc.mjs";\nif (add(2, 3) !== 5) { console.error(`add(2, 3) = ${add(2, 3)}, expected 5`); process.exit(1); }\nconsole.log("ok");\n');
	writeFileSync(join(repo, "README.md"), "committed\n");
	git("init", "-q");
	git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
	faux.setResponses([]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BROKEN = "export const add = (a, b) => a - b;\n";
const FIXED = "export const add = (a, b) => a + b;\n";

const env = (extra: Partial<RunEnv> = {}): RunEnv => ({
	cwd: repo,
	runtime,
	agentDir: join(dir, "agent"),
	llmCache: new Map(),
	library: () => new Map(),
	sessionDir: join(dir, "sessions"),
	parentSessionFile: join(dir, "sessions", "2026-11-13T10-00-00-000Z_parent-1.jsonl"),
	...extra,
});
const inline = (code: string) => ({ source: code, filename: INLINE_FILE, inline: true });
const run = (code: string, budget = 1, extra: Partial<RunEnv> = {}) => runWorkflow(inline(code), budget, env(extra));
const respond = (...steps: FauxResponseStep[]) => faux.setResponses(steps);
const say = (text: string) => fauxAssistantMessage(text);
const tool = (name: string, args: JsonObject) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
/** The text of a transcript context, for matching what a request saw. */
const seen = (context: unknown) => JSON.stringify(context);

describe("scripts", () => {
	test("TypeScript runs; a string comes back verbatim, data as YAML; `ok: false` marks the goal missed", async () => {
		const text = await run("const n: number = await Promise.resolve(2);\ninterface X { a: string }\nreturn `n=${n as number}`;");
		assert.equal(text.details.status, "completed");
		assert.equal(text.details.ok, true);
		assert.match(text.text, /^Workflow completed · [\d.]+ s · \$0\.0000 of \$1\.00 · 0 llm calls · 0 agent runs\n\nn=2$/);
		const data = await run('return { ok: false, items: ["a", "b"], diff: "line 1\\nline 2" };');
		assert.equal(data.details.status, "completed");
		assert.equal(data.details.ok, false);
		assert.match(data.text, /\nok: false\nitems:\n {2}- a\n {2}- b\ndiff: \|-?\n {2}line 1\n {2}line 2$/);
		const nothing = await run("log('only a log line');");
		assert.match(nothing.text, /^Workflow completed[^\n]*$/, "no value, no body; logs only show on failure");
	});

	test("a thrown error fails the run with the script's own line numbers and the last log lines", async () => {
		const { text, details } = await run("console.log('first', { a: 1 });\nlog('second');\nconst f = () => {\n  throw new TypeError('bad thing');\n};\nf();");
		assert.equal(details.status, "failed");
		assert.equal(details.ok, false);
		assert.match(details.error!, /^TypeError: bad thing\n {4}at f \(workflow\.ts:4:\d+\)\n {4}at .*workflow\.ts:6:\d+/);
		assert.match(text, /Last log lines:\nfirst a: 1\nsecond$/);
	});

	test("syntax errors, imports and Node globals: the script sees only its API", async () => {
		const syntax = await run("const = 1;");
		assert.equal(syntax.details.status, "failed");
		assert.match(syntax.details.error!, /^SyntaxError: workflow\.ts:1:\d+: Unexpected token/);
		const imported = await run('import { readFileSync } from "node:fs";\nreturn readFileSync("x");');
		assert.equal(imported.details.status, "failed");
		assert.match(imported.details.error!, /'import' and 'export' may only appear at the top level/, "inline code is a function body");
		assert.throws(() => evaluate(compile('import { readFileSync } from "node:fs";\nexport default async function () { return readFileSync; }', "m.ts"), "m.ts", {}), /cannot import modules \("node:fs"\)/);
		const globals = await run("return [typeof process, typeof require === 'function' ? 'guarded' : 'none', typeof fetch, typeof llm, typeof setTimeout, typeof cwd].join(',');");
		assert.equal(globals.text.split("\n\n")[1], "undefined,guarded,undefined,function,function,string");
	});

	test("compile keeps lines; evaluate refuses modules without a default function; scriptStack keeps script frames only", async () => {
		const thrower = evaluate(compile(inlineModule("const a: string = 'x';\ninterface I { b: number }\n\nthrow new Error(a);"), "inline.ts"), "inline.ts", {});
		await assert.rejects(thrower.run(), (error: Error) => /inline\.ts:4:/.test(error.stack ?? ""));
		assert.throws(() => evaluate(compile("export const meta = 1;", "m.ts"), "m.ts", {}), /m\.ts has no default export function/);
		const module = evaluate(compile("export const meta = { a: 1 };\nexport default async function (input: number) { return input * 2; }", "m.ts"), "m.ts", {});
		assert.deepEqual({ ...(module.meta as object) }, { a: 1 });
		assert.equal(scriptStack("plain", "x.ts"), "plain");
		assert.equal(scriptStack(new RangeError("r"), "x.ts"), "RangeError: r", "host frames are dropped");
		assert.throws(() => evaluate(compile("while (true) {}\nexport default async function () {}", "loop.ts"), "loop.ts", {}), /timed out/);
	});

	test("shell: exit codes without rejecting, cwd, timeouts and invalid arguments", async () => {
		const { text } = await run(
			"const a = await shell('echo out; echo err >&2; exit 3');\nconst b = await shell('pwd', { cwd: 'src' });\nconst c = await shell('sleep 5', { timeoutSeconds: 0.2 });\nreturn JSON.stringify([a, b.output.trim().endsWith('/src'), c.timedOut, c.exitCode]);",
		);
		assert.equal(text.split("\n\n")[1], JSON.stringify([{ exitCode: 3, output: "out\nerr\n", timedOut: false }, true, true, null]));
		const bad = await run("await shell('');");
		assert.match(bad.details.error!, /command must be a non-empty string/);
	});

	test("map: limits concurrency, keeps order, stops starting items after the first error", async () => {
		const { text } = await run(
			"let active = 0, peak = 0;\nconst out = await map([1, 2, 3, 4, 5, 6, 7], async (n) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 20)); active--; return n * 10; }, { concurrency: 3 });\nreturn JSON.stringify({ out, peak });",
		);
		assert.deepEqual(JSON.parse(text.split("\n\n")[1]!), { out: [10, 20, 30, 40, 50, 60, 70], peak: 3 });
		const failing = await run(
			"const started: number[] = [];\ntry {\n  await map([0, 1, 2, 3, 4, 5], async (n) => { started.push(n); await new Promise((r) => setTimeout(r, n === 1 ? 5 : 30)); if (n === 1) throw new Error('item 1'); return n; }, { concurrency: 2 });\n} catch (e) { return `${(e as Error).message} after ${started.join(',')}`; }",
		);
		assert.equal(failing.text.split("\n\n")[1], "item 1 after 0,1", "item 2 never started");
		const bad = await run("await map([1], async (n) => n, { concurrency: 0 });");
		assert.match(bad.details.error!, /concurrency must be a positive integer/);
	});

	test("abort stops a running command at once and reports aborted", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const started = Date.now();
		const { details } = await run("await shell('sleep 10');\nreturn 'never';", 1, { signal: controller.signal });
		assert.ok(Date.now() - started < 5000);
		assert.equal(details.status, "aborted");
		assert.equal(details.ok, false);
	});

	test("changes(): the files changed since the run started and their diff; changedFiles for the metrics", async () => {
		writeFileSync(join(repo, "README.md"), "user's edit before the run\n");
		const { text, details } = await run("await shell('echo new > notes.txt && echo changed > src/calc.mjs');\nconst c = await changes();\nreturn c.files.join(',') + '\\n' + c.diff;");
		assert.equal(details.status, "completed");
		assert.match(text, /\n\nnotes\.txt,src\/calc\.mjs\n/);
		assert.match(text, /\+\+\+ b\/src\/calc\.mjs\n@@ -1,1 \+1,1 @@\n-export const add = \(a, b\) => a - b;\n\+changed/);
		assert.doesNotMatch(text, /README/, "changes before the run are not the run's");
		assert.deepEqual(details.changedFiles, [join(real(), "notes.txt"), join(real(), "src", "calc.mjs")]);
		assert.match(text, /Changed files: notes\.txt, src\/calc\.mjs/);
		const outside = mkdtempSync(join(tmpdir(), "no-git-"));
		const noGit = await run("return await changes();", 1, { cwd: outside });
		assert.match(noGit.details.error!, /changes\(\) needs a git repository/);
		rmSync(outside, { recursive: true, force: true });
	});

	test("long reports are cut and kept in a file", async () => {
		const { text, details } = await run("return Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\\n');");
		assert.match(text, /\[cut; the full report is in .*\]$/);
		assert.match(readFileSync(details.outputFile!, "utf8"), /line 1999$/);
	});

	test("tools are only available in a session; budgets must be positive", async () => {
		const { details } = await run("await tools.read({ path: 'README.md' });");
		assert.match(details.error!, /tools are only available in a session/);
		await assert.rejects(runWorkflow(inline("return 1;"), 0, env()), /budget must be a positive number/);
	});
});

describe("llm()", () => {
	test("text answers; the session cache answers repeated input, cache: false asks again", async () => {
		const prompts: string[] = [];
		const answer = (text: string) => (context: unknown) => {
			prompts.push(seen(context));
			return say(text);
		};
		respond(answer("Paris"), answer("Lyon"), answer("Nice"));
		const shared = env();
		const first = await runWorkflow(inline("const a = await llm('Capital of France?', { model: 'faux/faux-1', system: 'Be terse.' });\nconst b = await llm('Capital of France?', { model: 'faux/faux-1', system: 'Be terse.' });\nreturn a + ' ' + b;"), 1, shared);
		assert.equal(first.text.split("\n\n")[1], "Paris Paris");
		assert.equal(first.details.llmCalls, 2);
		assert.equal(first.details.cachedCalls, 1);
		assert.match(prompts[0]!, /Be terse\./);
		assert.match(prompts[0]!, /Capital of France\?/);
		assert.ok(first.usage && first.usage.output > 0, "llm() usage is reported for the metrics");
		// A second run in the same session: the unchanged call is cached, a changed one asks.
		const second = await runWorkflow(inline("return [await llm('Capital of France?', { model: 'faux/faux-1', system: 'Be terse.' }), await llm('Second city?', { model: 'faux/faux-1' }), await llm('Second city?', { model: 'faux/faux-1', cache: false })].join(' ');"), 1, shared);
		assert.equal(second.text.split("\n\n")[1], "Paris Lyon Nice");
		assert.equal(second.details.cachedCalls, 1);
		assert.equal(prompts.length, 3);
		assert.match(second.text, /3 llm calls \(1 cached\)/);
	});

	test("schema answers are validated and coerced; missing or invalid calls are sent back with the problem", async () => {
		const contexts: string[] = [];
		const step = (message: AssistantMessage) => (context: unknown) => {
			contexts.push(seen(context));
			return message;
		};
		respond(
			step(say("I think it is positive.")),
			step(tool("respond", { label: "maybe", score: 1 })),
			step(tool("respond", { label: "positive", score: "0.9" })),
		);
		const schema = '{ type: "object", properties: { label: { type: "string", enum: ["positive", "negative"] }, score: { type: "number" } }, required: ["label", "score"] }';
		const { text, details } = await run(`const r = await llm('Classify: great product', { model: 'faux/faux-1', schema: ${schema} });\nreturn JSON.stringify(r);`);
		assert.equal(details.status, "completed", details.error);
		assert.deepEqual(JSON.parse(text.split("\n\n")[1]!), { label: "positive", score: 0.9 });
		assert.match(contexts[0]!, /Answer only by calling the respond tool/);
		assert.match(contexts[1]!, /Answer by calling the respond tool/);
		assert.match(contexts[2]!, /label.*must be equal to one of the allowed values|label/);
		assert.match(contexts[2]!, /"isError":true/);
	});

	test("three invalid answers fail the call with the last problem", async () => {
		respond(say("no"), say("still no"), say("never"));
		const { details } = await run("await llm('x', { model: 'faux/faux-1', schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } });");
		assert.equal(details.status, "failed");
		assert.match(details.error!, /no valid respond call after 3 attempts; last problem: no respond tool call/);
		assert.equal(details.llmCalls, 1);
	});

	test("invalid options and models fail before any request", async () => {
		const before = faux.state.callCount;
		for (const [code, error] of [
			["await llm('')", /prompt must be a non-empty string/],
			["await llm('x', { modle: 'a' })", /unknown option modle/],
			["await llm('x', { schema: { type: 'string' } })", /schema must be a JSON Schema of an object/],
			["await llm('x', { thinking: 'huge', model: 'faux/faux-1' })", /thinking must be one of off, minimal, low, medium, high/],
			["await llm('x', { model: 'faux/none' })", /unknown model faux\/none/],
			["await llm('x', { model: 'nope' })", /model must be "provider\/id"/],
		] as const) {
			const { details } = await run(code);
			assert.match(details.error!, error, code);
		}
		assert.equal(faux.state.callCount, before);
	});

	test("an exhausted budget aborts the run: calls in flight stop, no new ones start", async () => {
		respond(...Array.from({ length: 20 }, (_, i) => say(`answer ${i}`)));
		const before = faux.state.callCount;
		const updates: WorkflowDetails[] = [];
		const { text, details } = await run(
			"const out = await map(Array.from({ length: 20 }, (_, i) => i), (i) => llm(`item ${i}`, { model: 'faux/faux-1' }), { concurrency: 2 });\nreturn out.length;",
			0.25,
			{ runtime: priced(runtime, 0.1), onUpdate: (d) => updates.push(d) },
		);
		assert.equal(details.status, "over budget");
		assert.equal(details.ok, false);
		assert.ok(details.cost > 0.25 && details.cost <= 0.45, `cost ${details.cost}`);
		assert.ok(faux.state.callCount - before <= 4, "at most the calls in flight when the budget ran out");
		assert.match(details.error!, /the budget of \$0\.25 is used up/);
		assert.match(text, /^Workflow over budget · [\d.]+ s · \$0\.\d+ of \$0\.25/);
		assert.ok(updates.some((u) => u.cost > 0), "progress reports the spending");
		const spentReadable = await run("return budget.limit + ' ' + budget.spent;", 0.5);
		assert.equal(spentReadable.text.split("\n\n")[1], "0.5 0");
	});
});

describe("agent()", () => {
	test("a child session per agent, linked to the parent; runs continue one conversation; cost and runs counted", async () => {
		const contexts: string[] = [];
		respond(
			(context) => {
				contexts.push(seen(context));
				return say("first answer");
			},
			(context) => {
				contexts.push(seen(context));
				return say("second answer");
			},
		);
		const { text, details } = await run(
			"const a = agent({ model: 'faux/faux-1', system: 'You are a careful reviewer.', tools: ['read'] });\nconst one = await a.run('Look at README.md');\nconst two = await a.run('And again');\nreturn [one.text, two.text, typeof a.cost].join(' | ');",
		);
		assert.equal(details.status, "completed", details.error);
		assert.equal(text.split("\n\n").at(-1), "first answer | second answer | number");
		assert.equal(details.agentRuns, 2);
		assert.equal(details.childSessions.length, 1);
		assert.match(contexts[0]!, /You are a careful reviewer\./);
		assert.match(contexts[1]!, /Look at README\.md.*first answer.*And again/, "the second run continues the conversation");
		const file = readFileSync(join(dir, "sessions", (await import("node:fs")).readdirSync(join(dir, "sessions")).find((f) => f.includes(details.childSessions[0]!))!), "utf8");
		const header = JSON.parse(file.split("\n")[0]!);
		assert.equal(header.parentSession, env().parentSessionFile);
	});

	test("files are told to the agent, not enforced; each run returns the files changed meanwhile and its cost", async () => {
		writeFileSync(join(repo, "README.md"), "user's uncommitted edit\n");
		let first = "";
		respond(
			(context) => {
				first = seen(context);
				return tool("bash", { command: "echo junk > new.txt" });
			},
			tool("write", { path: "src/calc.mjs", content: FIXED }),
			say("done"),
			say("nothing to do"),
		);
		const { text, details } = await run(
			"const a = agent({ model: 'faux/faux-1', files: ['src'] });\nconst r = await a.run('fix it');\nconst again = await a.run('anything else?');\nreturn JSON.stringify({ r, again, total: a.cost });",
			1,
			{ runtime: priced(runtime, 0.01) },
		);
		assert.equal(details.status, "completed", details.error);
		const { r, again, total } = JSON.parse(text.split("\n\n").at(-1)!);
		assert.match(first, /Change only these files: src\./);
		assert.equal(r.text, "done");
		assert.deepEqual(r.changed, ["new.txt", "src/calc.mjs"]);
		assert.deepEqual(again.changed, [], "the second run changed nothing");
		assert.equal(r.result, undefined, "no schema, no result");
		assert.ok(Math.abs(r.cost - 0.03) < 1e-9, `three responses: ${r.cost}`);
		assert.ok(Math.abs(again.cost - 0.01) < 1e-9, `one response: ${again.cost}`);
		assert.ok(Math.abs(total - 0.04) < 1e-9, "agent().cost sums the runs");
		assert.ok(Math.abs(details.cost - 0.04) < 1e-9, "the runs' cost counts against the budget");
		assert.equal(r.sessionId, details.childSessions[0]);
		assert.equal(r.threadId, undefined, "no t3 thread in-process");
		assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "user's uncommitted edit\n");
		assert.deepEqual(details.changedFiles, [join(real(), "new.txt"), join(real(), "src", "calc.mjs")]);
	});

	test("agents run in parallel in the same working tree", async () => {
		writeFileSync(join(repo, "a.txt"), "a\n");
		writeFileSync(join(repo, "b.txt"), "b\n");
		git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ab");
		let active = 0;
		let peak = 0;
		// Each agent writes its own file with bash (not refused, only checked afterwards), slowly.
		const step = async (context: unknown) => {
			const text = seen(context);
			const own = /Change only these files: (\w)\.txt/.exec(text)![1]!;
			if (text.includes('"role":"toolResult"')) return say(`${own} done`);
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 150));
			active--;
			return tool("bash", { command: `echo changed > ${own}.txt` });
		};
		respond(step, step, step, step);
		const { text, details } = await run(
			"const out = await map(['a', 'b'], async (f) => (await agent({ model: 'faux/faux-1', files: [`${f}.txt`] }).run('change your file')), { concurrency: 2 });\nreturn JSON.stringify(out);",
		);
		assert.equal(details.status, "completed", details.error);
		const out = JSON.parse(text.split("\n\n").at(-1)!) as { text: string; changed: string[] }[];
		assert.deepEqual(out.map((r) => r.text), ["a done", "b done"]);
		for (const r of out) assert.ok(r.changed.includes(`${r.text[0]}.txt`), "its own change is among the run's changes");
		assert.equal(peak, 2, "both ran at once");
		assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "changed\n");
		assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "changed\n");
		assert.equal(details.childSessions.length, 2);
	});

	test("invalid options fail at agent(); outside a repository nothing is reported as changed; abort stops a running agent", async () => {
		for (const [code, error] of [
			["agent({ files: [] })", /files must be a non-empty array/],
			["agent({ tools: 'read' })", /tools must be a non-empty array/],
			["agent({ model: 'faux/none' })", /unknown model faux\/none/],
			["agent({ colour: 1 })", /unknown option colour/],
			["agent({ system: ' ' })", /system must be a non-empty string/],
			["agent({ schema: { type: 'array' } })", /schema must be a JSON Schema of an object/],
			["agent(5)", /options must be an object/],
			["await agent({ model: 'faux/faux-1' }).run('')", /message must be a non-empty string/],
		] as const) {
			const { details } = await run(code);
			assert.match(details.error!, error, code);
		}
		const outside = mkdtempSync(join(tmpdir(), "no-git-"));
		respond(tool("bash", { command: "echo x > made.txt" }), say("made"));
		const noGit = await run("return JSON.stringify(await agent({ model: 'faux/faux-1', files: ['x'] }).run('make it'));", 1, { cwd: outside, sessionDir: undefined });
		assert.equal(noGit.details.status, "completed", noGit.details.error);
		assert.deepEqual(JSON.parse(noGit.text.split("\n\n").at(-1)!).changed, []);
		rmSync(outside, { recursive: true, force: true });

		const controller = new AbortController();
		respond(tool("bash", { command: "sleep 10" }), say("never"));
		setTimeout(() => controller.abort(), 300);
		const started = Date.now();
		const aborted = await run("await agent({ model: 'faux/faux-1', files: ['src'] }).run('wait');", 1, { signal: controller.signal });
		assert.ok(Date.now() - started < 8000);
		assert.equal(aborted.details.status, "aborted");
	});
});

describe("prompt cache retention", () => {
	const previous = process.env.PI_CACHE_RETENTION;
	beforeEach(() => {
		process.env.PI_CACHE_RETENTION = "long";
	});
	afterEach(() => {
		if (previous === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = previous;
	});

	test("llm() and agent() requests use the 5-minute cache even when Pi was started with PI_CACHE_RETENTION=long", async () => {
		const retention: unknown[] = [];
		const record = (text: string): FauxResponseStep => (_context, options) => {
			retention.push(options?.cacheRetention);
			return say(text);
		};
		respond(record("plain"), record("first"), record("second"));
		const { details } = await run(
			"await llm('hi', { model: 'faux/faux-1', cache: false });\nconst a = agent({ model: 'faux/faux-1', tools: ['read'] });\nawait a.run('one');\nawait a.run('two');\nreturn 'ok';",
		);
		assert.equal(details.status, "completed", details.error);
		assert.deepEqual(retention, ["short", "short", "short"], "one llm() request and both agent() runs");
	});
});


describe("saved workflows", () => {
	const save = (folder: string, name: string, source: string) => {
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, `${name}.ts`), source);
	};
	const double = 'export const meta: WorkflowMeta = { description: "Double a number.", parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] }, budget: 0.5 };\nexport default async function ({ n }: { n: number }) {\n  log(`doubling ${n}`);\n  return n * 2;\n}\n';

	test("found in the harness and project folders; the project's replaces; invalid files are named with their problem", () => {
		const harness = join(dir, "harness");
		const project = join(dir, "project");
		save(harness, "double", double);
		save(harness, "shared_one", double.replace("Double a number.", "harness version"));
		save(project, "shared_one", double.replace("Double a number.", "project version"));
		save(project, "Bad-Name", double);
		save(project, "workflow", double);
		save(project, "no_meta", "export default async function () {}\n");
		save(project, "no_budget", double.replace("budget: 0.5", "budget: 0"));
		save(project, "broken", "export const meta = {;\n");
		save(project, "top_level_call", `llm("x");\n${double}`);
		writeFileSync(join(project, "types.d.ts"), "declare const x: number;\n");
		const { workflows, problems } = loadWorkflows(repo, [harness, project]);
		assert.deepEqual([...workflows.keys()].sort(), ["double", "shared_one"]);
		assert.equal(workflows.get("shared_one")!.meta.description, "project version");
		const byFile = (name: string) => problems.find((p) => p.includes(`${name}.ts`)) ?? "";
		assert.match(byFile("Bad-Name"), /file name must be a tool name/);
		assert.match(byFile("workflow"), /file name must be a tool name/);
		assert.match(byFile("no_meta"), /no `export const meta/);
		assert.match(byFile("no_budget"), /meta\.budget must be a positive number/);
		assert.match(byFile("broken"), /Unexpected token/);
		assert.match(byFile("top_level_call"), /llm is not defined/);
		assert.equal(problems.length, 6);
	});

	test("a changed file is read again", () => {
		const folder = join(dir, "w");
		save(folder, "double", double);
		const first = loadWorkflows(repo, [folder]).workflows.get("double")!;
		save(folder, "double", double.replace("Double a number.", "Double it, longer."));
		const second = loadWorkflows(repo, [folder]).workflows.get("double")!;
		assert.notEqual(first.version, second.version);
		assert.equal(second.meta.description, "Double it, longer.");
	});

	test("meta checks", () => {
		assert.equal(metaProblem({ description: "d", parameters: { type: "object" }, budget: 1 }), undefined);
		assert.match(metaProblem({ description: " ", parameters: { type: "object" }, budget: 1 })!, /description/);
		assert.match(metaProblem({ description: "d", parameters: { type: "array" }, budget: 1 })!, /type "object"/);
		assert.match(metaProblem({ description: "d", parameters: { type: "object" }, budget: 1, guidelines: [1] })!, /guidelines/);
	});

	test("workflows.* runs a saved workflow with validated, coerced input inside the same run", async () => {
		const folder = join(dir, "w");
		save(folder, "double", double);
		const library = () => loadWorkflows(repo, [folder]).workflows as ReadonlyMap<string, SavedWorkflow>;
		const { text, details } = await run("const a = await workflows.double({ n: '21' });\nreturn String(a);", 1, { library });
		assert.equal(details.status, "completed", details.error);
		assert.equal(text.split("\n\n").at(-1), "42");
		const invalid = await run("await workflows.double({});", 1, { library });
		assert.match(invalid.details.error!, /n/);
		const missing = await run("await workflows.triple({ n: 1 });", 1, { library });
		assert.match(missing.details.error!, /no saved workflow triple; saved: double/);
	});
});

describe("fix_loop workflow", () => {
	const fixLoop = () => loadWorkflows(repo, [HARNESS_WORKFLOWS]).workflows.get("fix_loop")!;
	const runFixLoop = (input: Record<string, unknown>, extra: Partial<RunEnv> = {}) => {
		const saved = fixLoop();
		return runWorkflow({ source: saved.source, filename: saved.file, inline: false, name: "fix_loop", input: { goal: "make add() add", files: ["src/calc.mjs"], check: "node check.mjs", model: MODEL, ...input } }, saved.meta.budget, env(extra));
	};

	test("it is a valid harness workflow", () => {
		const { workflows, problems } = loadWorkflows(repo, [HARNESS_WORKFLOWS]);
		assert.deepEqual(problems, []);
		assert.ok(workflows.get("fix_loop")!.meta.description.includes("Make a failing check pass"));
	});

	test("green after one round: the diff and the child's summary", async () => {
		let first = "";
		respond(
			(context) => {
				first = seen(context);
				return tool("write", { path: "src/calc.mjs", content: FIXED });
			},
			say("Changed - to +."),
		);
		const { text, details } = await runFixLoop({ context: "The operator is wrong." });
		assert.equal(details.status, "completed", details.error);
		assert.equal(details.ok, true);
		assert.match(text, /^Workflow fix_loop completed/);
		assert.match(text, /\nok: true\nrounds: 1\n/);
		assert.match(text, /-export const add = \(a, b\) => a - b;\n\s+\+export const add = \(a, b\) => a \+ b;/);
		assert.match(text, /summary: Changed - to \+\./);
		assert.doesNotMatch(text, /lastCheckOutput/);
		assert.match(first, /Goal: make add\(\) add/);
		assert.match(first, /The operator is wrong\./);
		assert.match(first, /add\(2, 3\) = -1, expected 5/);
		assert.deepEqual(details.changedFiles, [join(real(), "src", "calc.mjs")]);
		assert.equal(details.childSessions.length, 1);
	});

	test("check already green: no child", async () => {
		writeFileSync(join(repo, "src", "calc.mjs"), FIXED);
		const { text, details } = await runFixLoop({});
		assert.equal(details.ok, true);
		assert.deepEqual(details.childSessions, []);
		assert.match(text, /already passes/);
	});

	test("never green: stops after maxRounds with the last failure; the second round sees the new failure", async () => {
		const seenSecond: string[] = [];
		respond(
			tool("write", { path: "src/calc.mjs", content: "export const add = (a, b) => a * b;\n" }),
			say("Tried *."),
			(context) => {
				seenSecond.push(seen(context));
				return say("No idea.");
			},
		);
		const { text, details } = await runFixLoop({ maxRounds: 2 });
		assert.equal(details.status, "completed");
		assert.equal(details.ok, false);
		assert.match(text, /\nok: false\nrounds: 2\n/);
		assert.match(text, /lastCheckOutput:[^]*add\(2, 3\) = 6, expected 5/);
		assert.match(seenSecond[0]!, /still fails \(exit 1, round 1 of 2\)/);
	});

	test("cheating outside the files is not green: the child is told to undo it, and it is reported while it remains", async () => {
		const later: string[] = [];
		respond(
			tool("bash", { command: "echo 'process.exit(0)' > check.mjs" }),
			say("The check passes now."),
			(context) => {
				later.push(seen(context));
				return say("Giving up.");
			},
		);
		const { text, details } = await runFixLoop({ maxRounds: 2 });
		assert.equal(details.ok, false, "a passing check with a change outside the files is not green");
		assert.match(text, /\nok: false\nrounds: 2\noutside:\n\s+- check\.mjs/);
		assert.doesNotMatch(text, /lastCheckOutput/, "the check itself passed");
		assert.match(later[0]!, /The check passes \(round 1 of 2\), but not with only the allowed files changed\.\\nYou changed files outside src\/calc\.mjs: check\.mjs\. Undo those changes/);
	});

	test("a change outside the files that the child undoes leaves the round green", async () => {
		respond(
			tool("bash", { command: "echo 'process.exit(0)' > check.mjs" }),
			say("Cheated."),
			tool("bash", { command: "git checkout check.mjs" }),
			tool("write", { path: "src/calc.mjs", content: FIXED }),
			say("Undone and fixed."),
		);
		const { text, details } = await runFixLoop({ maxRounds: 3 });
		assert.equal(details.ok, true, details.error);
		assert.match(text, /\nok: true\nrounds: 2\n/);
		assert.doesNotMatch(text, /outside:/);
	});
});
