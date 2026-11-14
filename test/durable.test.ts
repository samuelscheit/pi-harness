// Durable workflow runs: keys, the journal and replay (extensions/workflow/durable.ts, journal.ts),
// resuming runs from their journal (run.ts), and the run's page (render.ts). Crashes are simulated
// here by cutting a finished run's journal back to a point in its life; test/workflow-kill.test.ts
// kills a real host process instead.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { blockingCalls, type CallSpec, DivergenceError, Durable, type InFlightPolicy, inFlightCalls, InterruptedCallError } from "../extensions/workflow/durable.ts";
import { argsHash, canonicalJson, Journal, type JournalEntry, journalPath, listRuns, parseJournal, readJournal, runDir, sweepRuns } from "../extensions/workflow/journal.ts";
import { layout, pageHeight, renderWorkflow, viewOf } from "../extensions/workflow/render.ts";
import { INLINE_FILE, type RunEnv, resumeWorkflow, runWorkflow } from "../extensions/workflow/run.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "durable-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---- Durable over a journal ------------------------------------------------------------------------

let journals = 0;
function durable(entries: readonly JournalEntry[] = [], inFlight: InFlightPolicy = "stop") {
	const journal = new Journal(join(dir, `j${++journals}.jsonl`));
	const diverged: DivergenceError[] = [];
	const replayed: string[] = [];
	const d = new Durable({ journal, entries, inFlight, replayed: (kind) => replayed.push(kind), diverged: (e) => diverged.push(e), stopped: () => false });
	return { d, journal, diverged, replayed, entries: () => readJournal(journal.path) };
}
const spec = (kind: CallSpec["kind"], args: unknown, extra: Partial<CallSpec> = {}): CallSpec => ({ kind, args, label: `${kind} ${JSON.stringify(args)}`, ...extra });
const value = (v: unknown) => async () => ({ value: v });
const never = async (): Promise<never> => {
	throw new Error("must not run");
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const starts = (entries: JournalEntry[]) => entries.flatMap((e) => (e.t === "start" ? [e.key] : []));

describe("keys and the journal", () => {
	test("a key is the kind, a hash of the canonical arguments and the occurrence among equal calls", async () => {
		const { d, entries } = durable();
		await d.call(spec("shell", { command: "x", cwd: null }), value(1));
		await d.call(spec("shell", { cwd: null, command: "x" }), value(2));
		await d.call(spec("llm", { command: "x", cwd: null }), value(3));
		await d.call(spec("shell", { command: "y", cwd: null }), value(4));
		const hash = argsHash({ command: "x", cwd: null });
		assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } }), '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
		assert.deepEqual(starts(entries()), [`shell:${hash}#1`, `shell:${hash}#2`, `llm:${hash}#1`, `shell:${argsHash({ command: "y", cwd: null })}#1`]);
		assert.ok(entries().every((e) => e.t !== "done" || typeof e.at === "number"));
	});

	test("a torn last line (death while writing) is dropped, and the next entry starts on its own line", () => {
		const path = join(dir, "torn.jsonl");
		writeFileSync(path, '{"t":"attempt","n":1,"at":1,"pid":1}\n{"t":"start","key":"sh');
		assert.equal(parseJournal(readFileSync(path, "utf8")).length, 1);
		const journal = new Journal(path);
		journal.append({ t: "attempt", n: 2, at: 2, pid: 2 }, true);
		journal.close();
		assert.deepEqual(readJournal(path).map((e) => e.t === "attempt" && e.n), [1, 2]);
	});

	test("listRuns and the sweep: completed runs go after a day, interrupted ones after a week", () => {
		const agentDir = join(dir, "agent");
		const write = (id: string, entries: JournalEntry[], ageMs: number) => {
			const path = journalPath(agentDir, id);
			mkdirSync(runDir(agentDir, id), { recursive: true });
			writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
			const at = new Date(Date.now() - ageMs);
			utimesSync(path, at, at);
		};
		const header = (id: string): JournalEntry => ({ t: "run", id, at: 0, entry: { source: "", filename: "w.ts", inline: true }, budget: 1, cwd: "/" });
		const end = (status: string): JournalEntry => ({ t: "end", at: 1, status, ok: status === "completed", cost: 0, text: "" });
		const hour = 60 * 60_000;
		write("20261101-000000-aaaaaa", [header("20261101-000000-aaaaaa"), end("completed")], 25 * hour);
		write("20261102-000000-bbbbbb", [header("20261102-000000-bbbbbb"), end("completed")], 2 * hour);
		write("20261103-000000-cccccc", [header("20261103-000000-cccccc"), { t: "attempt", n: 1, at: 0, pid: 1 }], 3 * 24 * hour);
		write("20261104-000000-dddddd", [header("20261104-000000-dddddd"), end("interrupted")], 8 * 24 * hour);
		assert.deepEqual(listRuns(agentDir).map((r) => [r.id, r.end?.status ?? null]), [
			["20261104-000000-dddddd", "interrupted"],
			["20261103-000000-cccccc", null],
			["20261102-000000-bbbbbb", "completed"],
			["20261101-000000-aaaaaa", "completed"],
		]);
		assert.deepEqual(sweepRuns(agentDir).sort(), ["20261101-000000-aaaaaa", "20261104-000000-dddddd"]);
		assert.deepEqual(listRuns(agentDir).map((r) => r.id), ["20261103-000000-cccccc", "20261102-000000-bbbbbb"]);
	});
});

describe("replay", () => {
	test("parallel calls finish in any order; a replay answers each call by its key", async () => {
		const first = durable();
		const delays: Record<string, number> = { a: 150, b: 5, c: 60 };
		const results = await Promise.all(["a", "b", "c"].map((n) => first.d.call(spec("llm", { prompt: n }), async () => (await sleep(delays[n]!), { value: `answer ${n}`, cost: 0.01 }))));
		assert.deepEqual(results, ["answer a", "answer b", "answer c"]);
		assert.deepEqual(first.entries().filter((e) => e.t === "done").map((e) => e.t === "done" && e.value), ["answer b", "answer c", "answer a"], "finished out of order");

		const replay = durable(first.entries());
		// The replay asks in another order; every call still gets its own answer.
		const again = await Promise.all(["c", "a", "b"].map((n) => replay.d.call(spec("llm", { prompt: n }), never)));
		assert.deepEqual(again, ["answer c", "answer a", "answer b"]);
		assert.equal(replay.d.replayedCalls, 3);
		assert.deepEqual(replay.replayed, ["llm", "llm", "llm"]);
		assert.deepEqual(replay.entries(), [], "a replay writes nothing");
	});

	test("occurrence numbers: the nth equal call gets the nth recorded result; the next one runs live", async () => {
		const first = durable();
		let n = 0;
		for (let i = 0; i < 3; i++) await first.d.call(spec("shell", { command: "date" }), async () => ({ value: ++n }));
		const replay = durable(first.entries());
		const got = [];
		for (let i = 0; i < 3; i++) got.push(await replay.d.call(spec("shell", { command: "date" }), never));
		got.push(await replay.d.call(spec("shell", { command: "date" }), value("live")));
		assert.deepEqual(got, [1, 2, 3, "live"]);
		assert.deepEqual(starts(replay.entries()), [`shell:${argsHash({ command: "date" })}#4`]);
	});

	test("failed calls replay their error; undefined and JSON values come back as JSON brings them", async () => {
		const first = durable();
		await assert.rejects(first.d.call(spec("tool", { name: "x" }), async () => Promise.reject(new TypeError("bad input"))), /bad input/);
		assert.equal(await first.d.call(spec("tool", { name: "y" }), value(undefined)), undefined);
		assert.deepEqual(await first.d.call(spec("tool", { name: "z" }), value({ a: undefined, d: new Date(0) })), { d: "1970-01-01T00:00:00.000Z" }, "live returns what a replay would");
		const replay = durable(first.entries());
		await assert.rejects(replay.d.call(spec("tool", { name: "x" }), never), (error: Error) => error.name === "TypeError" && error.message === "bad input");
		assert.equal(await replay.d.call(spec("tool", { name: "y" }), never), undefined);
	});

	test("a script that takes another path stops the resume, naming the recorded call and the new one", async () => {
		const first = durable();
		await first.d.call(spec("shell", { command: "a" }), value("a"));
		await first.d.call(spec("shell", { command: "b" }), value("b"));
		const replay = durable(first.entries());
		assert.equal(await replay.d.call(spec("shell", { command: "a" }), never), "a");
		let ran = false;
		await assert.rejects(
			replay.d.call(spec("shell", { command: "c" }), async () => ((ran = true), { value: "c" })),
			(error: Error) => error instanceof DivergenceError && /journal has shell call shell:\w+#1 \(shell \{"command":"b"\}\) next, the script asked for shell:\w+#1 \(shell \{"command":"c"\}\)/.test(error.message),
		);
		assert.equal(ran, false, "nothing of the new path ran");
		assert.equal(replay.diverged.length, 1);
		await assert.rejects(replay.d.call(spec("shell", { command: "b" }), never), DivergenceError, "the run stays stopped");
	});

	test("a new call waits while a recorded one may still come (a timer or a live call runs), then runs", async () => {
		const first = durable();
		await first.d.call(spec("llm", { p: 1 }), value(1));
		await first.d.call(spec("llm", { p: 2 }), value(2));
		const replay = durable(first.entries());
		const order: string[] = [];
		assert.equal(await replay.d.call(spec("llm", { p: 1 }), never), 1);
		const release = replay.d.hold();
		const fresh = replay.d.call(spec("llm", { p: 3 }), async () => (order.push("new"), { value: 3 }));
		await sleep(20);
		order.push("recorded");
		assert.equal(await replay.d.call(spec("llm", { p: 2 }), never), 2);
		release();
		assert.equal(await fresh, 3);
		assert.deepEqual(order, ["recorded", "new"]);
		assert.deepEqual(replay.diverged, []);
	});

	test("in-flight calls: llm and changes run again, agents reattach, shell and tools wait for a decision unless idempotent", async () => {
		const at = 1;
		const start = (kind: CallSpec["kind"], args: unknown, extra: object = {}): JournalEntry => ({ t: "start", key: `${kind}:${argsHash(args)}#1`, kind, label: `${kind} call`, at, ...extra });
		const entries: JournalEntry[] = [
			start("llm", { p: 1 }),
			start("changes", {}),
			start("agent", { message: "m" }),
			{ t: "meta", key: `agent:${argsHash({ message: "m" })}#1`, at, data: { threadId: "thread-9" } },
			start("shell", { command: "deploy" }),
			start("tool", { name: "write" }),
			start("shell", { command: "build" }, { idempotent: true }),
		];
		assert.deepEqual(inFlightCalls(entries).map((c) => c.kind), ["llm", "changes", "agent", "shell", "tool", "shell"]);
		assert.deepEqual(blockingCalls(entries).map((c) => c.label), ["shell call", "tool call"]);

		const stop = durable(entries);
		assert.equal(await stop.d.call(spec("llm", { p: 1 }), value("again")), "again");
		assert.deepEqual(await stop.d.call(spec("changes", {}), value({ files: [] })), { files: [] });
		let reattached: Record<string, unknown> | undefined;
		assert.equal(await stop.d.call(spec("agent", { message: "m" }), never, async (call) => ((reattached = call.recorded), { value: "reattached" })), "reattached");
		assert.deepEqual(reattached, { threadId: "thread-9" });
		await assert.rejects(stop.d.call(spec("shell", { command: "deploy" }), never), /in flight when the process ended/);
		await assert.rejects(stop.d.call(spec("tool", { name: "write" }), never), /in flight/);
		assert.equal(await stop.d.call(spec("shell", { command: "build" }), value("rebuilt")), "rebuilt", "marked idempotent at its start");

		const fail = durable(entries, "fail");
		await assert.rejects(fail.d.call(spec("shell", { command: "deploy" }), never), (error: Error) => error instanceof InterruptedCallError && /shell \{"command":"deploy"\} was running when the workflow's process ended/.test(error.message));
		const rerun = durable(entries, "rerun");
		assert.equal(await rerun.d.call(spec("shell", { command: "deploy" }), value("deployed again")), "deployed again");
		assert.equal(await rerun.d.call(spec("tool", { name: "write" }, { idempotent: true }), value("written")), "written");
	});

	test("Date.now() and Math.random() values are recorded by occurrence and replayed; later ones are live", () => {
		const first = durable();
		const values = [first.d.now(), first.d.random(), first.d.now()];
		const replay = durable(first.entries());
		assert.deepEqual([replay.d.now(), replay.d.random(), replay.d.now()], values);
		const later = replay.d.now();
		assert.ok(Math.abs(later - Date.now()) < 1000);
		assert.deepEqual(replay.entries(), [{ t: "clock", kind: "now", n: 3, value: later }]);
	});
});

// ---- runs resumed from their journal ---------------------------------------------------------------

let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
let llmRequests = 0;
before(async () => {
	faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	runtime = await ModelRuntime.create({ authPath: join(mkdtempSync(join(tmpdir(), "durable-rt-")), "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "faux-1", name: "Faux", api: faux.api, reasoning: false, input: ["text"], cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, contextWindow: 200_000, maxTokens: 8000 }],
	});
});
after(() => faux.unregister());

let repo: string;
beforeEach(() => {
	repo = join(dir, "repo");
	mkdirSync(repo);
	writeFileSync(join(repo, "README.md"), "x\n");
	for (const args of [["init", "-q"], ["add", "."], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]]) execFileSync("git", args, { cwd: repo });
	llmRequests = 0;
	faux.setResponses(Array.from({ length: 50 }, () => (context: { messages: { role: string; content: unknown }[] }) => {
		llmRequests++;
		return fauxAssistantMessage(`answer ${llmRequests} to ${JSON.stringify(context.messages.at(-1)?.content).slice(1, 20)}`);
	}));
});

const env = (extra: Partial<RunEnv> = {}): RunEnv => ({ cwd: repo, runtime, agentDir: join(dir, "agent"), llmCache: new Map(), library: () => new Map(), ...extra });
const count = (name: string) => (existsSync(join(repo, name)) ? readFileSync(join(repo, name), "utf8").split("\n").filter(Boolean).length : 0);
const resultOf = (text: string) => text.split("\n\n").at(-1)!;

/** Cut a run's journal back to just before the entry `keep` returns false for first (a crash at that point). */
function crashAt(id: string, before: (entry: JournalEntry, index: number) => boolean) {
	const path = journalPath(join(dir, "agent"), id);
	const entries = readJournal(path);
	const cut = entries.findIndex(before);
	writeFileSync(path, entries.slice(0, cut).map((e) => JSON.stringify(e)).join("\n") + "\n");
	return entries.slice(0, cut);
}

const SCRIPT = [
	"const t = Date.now(); const r = Math.random(); const d = new Date().getTime();",
	"await shell('echo shell >> shell-count');",
	"const a = await llm('first question', { model: 'faux/faux-1' });",
	"const [b, c] = await Promise.all([llm('second', { model: 'faux/faux-1' }), llm('third', { model: 'faux/faux-1' })]);",
	"await shell('echo last >> last-count');",
	"return JSON.stringify({ t, r, d, typeofDate: typeof Date(), fixed: new Date(2020, 0, 2).getDate(), a, b, c });",
].join("\n");

describe("resume", () => {
	test("after a crash the same script runs again: recorded calls are not repeated, clock and randomness are the recorded ones", async () => {
		const first = await runWorkflow({ source: SCRIPT, filename: INLINE_FILE, inline: true }, 1, env());
		assert.equal(first.details.status, "completed", first.details.error);
		assert.equal(llmRequests, 3);
		// The process died after the three llm calls, before the last shell call finished.
		const kept = crashAt(first.details.id, (e) => e.t === "start" && e.label.startsWith("echo last"));
		assert.equal(kept.filter((e) => e.t === "done").length, 4);
		writeFileSync(join(repo, "last-count"), "");
		const resumed = await resumeWorkflow({ id: first.details.id }, env());
		assert.equal(resumed.details.status, "completed", resumed.details.error);
		assert.deepEqual(JSON.parse(resultOf(resumed.text)), JSON.parse(resultOf(first.text)), "the same result: same Date, Math.random and answers");
		assert.equal(JSON.parse(resultOf(resumed.text)).typeofDate, "string");
		assert.equal(JSON.parse(resultOf(resumed.text)).fixed, 2);
		assert.equal(count("shell-count"), 1, "the completed shell call did not run again");
		assert.equal(count("last-count"), 1, "the call after the crash ran");
		assert.equal(llmRequests, 3, "no llm call was repeated");
		assert.equal(resumed.details.replayedCalls, 4);
		assert.equal(resumed.details.attempt, 2);
		assert.equal(resumed.details.llmCalls, 3);
		assert.equal(resumed.details.cost, first.details.cost, "recorded costs count against the budget");
		assert.match(resumed.text, /4 replayed from the journal/);
		await assert.rejects(resumeWorkflow({ id: first.details.id }, env()), /ended \(completed\); there is nothing to resume/);
	});

	test("an llm call in flight runs again", async () => {
		const first = await runWorkflow({ source: SCRIPT, filename: INLINE_FILE, inline: true }, 1, env());
		crashAt(first.details.id, (e) => e.t === "done" && e.key.startsWith("llm:") && e.value === JSON.parse(resultOf(first.text)).a);
		const resumed = await resumeWorkflow({ id: first.details.id }, env());
		assert.equal(resumed.details.status, "completed", resumed.details.error);
		assert.equal(llmRequests, 6, "the in-flight call and the two after it ran");
		assert.equal(count("shell-count"), 1);
	});

	test("an in-flight shell call stops the resume until the agent decides; fail lets the script catch it, rerun repeats it, idempotent ones need no decision", async () => {
		const code = (idempotent: boolean) => `try { await shell('echo once >> effect', { idempotent: ${idempotent} }); } catch (e) { return 'caught ' + (e as Error).name; }\nreturn 'effect ran';`;
		const first = await runWorkflow({ source: code(false), filename: INLINE_FILE, inline: true }, 1, env());
		crashAt(first.details.id, (e) => e.t === "done");
		await assert.rejects(resumeWorkflow({ id: first.details.id }, env()), (error: Error) => /were in flight when it stopped.*\n- shell echo once >> effect \(shell:\w+#1\)\n.*inFlight: "rerun".*inFlight: "fail"/s.test(error.message));
		const failed = await resumeWorkflow({ id: first.details.id, inFlight: "fail" }, env());
		assert.equal(resultOf(failed.text), "caught InterruptedCallError");
		assert.equal(count("effect"), 1);

		const again = await runWorkflow({ source: code(false), filename: INLINE_FILE, inline: true }, 1, env());
		crashAt(again.details.id, (e) => e.t === "done");
		assert.equal(resultOf((await resumeWorkflow({ id: again.details.id, inFlight: "rerun" }, env())).text), "effect ran");
		assert.equal(count("effect"), 3, "ran once more");

		const idempotent = await runWorkflow({ source: code(true), filename: INLINE_FILE, inline: true }, 1, env());
		crashAt(idempotent.details.id, (e) => e.t === "done");
		assert.equal(resultOf((await resumeWorkflow({ id: idempotent.details.id }, env())).text), "effect ran");
		assert.equal(count("effect"), 5);
	});

	test("an edited path stops the resume as diverged and keeps the journal resumable for the original script", async () => {
		const first = await runWorkflow({ source: "await shell('echo a >> a');\nawait shell('echo b >> b');\nreturn 'ok';", filename: INLINE_FILE, inline: true }, 1, env());
		const path = journalPath(join(dir, "agent"), first.details.id);
		crashAt(first.details.id, (e) => e.t === "end");
		// The script's source in the journal changed to take another path after the first call.
		const entries = readJournal(path);
		const header = entries[0]!;
		assert.equal(header.t, "run");
		if (header.t === "run") header.entry.source = "await shell('echo a >> a');\nawait shell('echo c >> c');\nreturn 'ok';";
		writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
		const resumed = await resumeWorkflow({ id: first.details.id }, env());
		assert.equal(resumed.details.status, "diverged");
		assert.match(resumed.details.error!, /DivergenceError: the script took another path than its journal: the journal has shell call shell:\w+#1 \(echo b >> b\) next, the script asked for shell:\w+#1 \(echo c >> c\) instead/);
		assert.equal(count("c"), 0, "nothing of the new path ran");
		assert.equal(count("a"), 1);
	});

	test("nested workflows: a replayed one makes none of its calls; equal calls outside keep their occurrence", async () => {
		const saved = join(dir, "inner.ts");
		writeFileSync(saved, "export const meta = { description: 'd', parameters: { type: 'object' }, budget: 1 };\nexport default async function () { await shell('echo inner >> n'); return 'inner done'; }");
		const library = new Map([["inner", { name: "inner", file: saved, source: readFileSync(saved, "utf8"), meta: { description: "d", parameters: { type: "object" as const }, budget: 1 }, version: "1" }]]);
		const code = "const a = await workflows.inner({});\nawait shell('echo inner >> n');\nawait shell('echo outer >> o');\nreturn a;";
		const first = await runWorkflow({ source: code, filename: INLINE_FILE, inline: true }, 1, env({ library: () => library }));
		assert.equal(first.details.status, "completed", first.details.error);
		const keys = readJournal(first.details.journal).flatMap((e) => (e.t === "start" ? [e.key] : []));
		assert.match(keys[1]!, /^workflow:\w+#1\/shell:\w+#1$/, "the nested call's key is inside the workflow's");
		assert.match(keys[2]!, /^shell:\w+#1$/, "the equal call outside counts on its own");
		crashAt(first.details.id, (e) => e.t === "start" && e.label.startsWith("echo outer"));
		const resumed = await resumeWorkflow({ id: first.details.id }, env({ library: () => library }));
		assert.equal(resultOf(resumed.text), "inner done");
		assert.equal(count("n"), 2, "neither the nested nor the outer equal call ran again");
		assert.equal(count("o"), 2);
	});

	test("a run cannot be resumed while a live process holds it, or when it is unknown", async () => {
		await assert.rejects(resumeWorkflow({ id: "20260101-000000-abcdef" }, env()), /no workflow run 20260101-000000-abcdef/);
		let id = "";
		const running = runWorkflow({ source: "await new Promise((r) => setTimeout(r, 300));\nreturn 'slow';", filename: INLINE_FILE, inline: true }, 1, env({ onStart: (run) => (id = run.id) }));
		await sleep(150);
		await assert.rejects(resumeWorkflow({ id }, env()), /is running in another process/);
		assert.equal((await running).details.status, "completed");
	});

	test("a session end interrupts the run; its calls in flight stay open for the resume", async () => {
		const controller = new AbortController();
		let id = "";
		const run = runWorkflow({ source: "await shell('echo s >> started; sleep 5', { idempotent: true });\nreturn 'resumed';", filename: INLINE_FILE, inline: true }, 1, env({ signal: controller.signal, onStart: (r) => (id = r.id) }));
		while (count("started") === 0) await sleep(20);
		controller.abort(Object.assign(new Error("the session ended"), { name: "SessionEnded" }));
		const stopped = await run;
		assert.equal(stopped.details.status, "interrupted");
		assert.match(stopped.text, new RegExp(`call workflow with resume: "${id}"`));
		assert.equal(inFlightCalls(readJournal(stopped.details.journal)).length, 1, "the aborted call recorded no failure");
		writeFileSync(join(repo, "started"), "");
		const fast = readJournal(stopped.details.journal);
		assert.ok(fast.some((e) => e.t === "end" && e.status === "interrupted"));
	});
});

// ---- the page --------------------------------------------------------------------------------------

const H: JournalEntry = { t: "run", id: "20261114-120000-abc123", at: 1_000_000, entry: { source: "…", filename: "workflow.ts", inline: true }, budget: 2, cwd: "/repo" };
const JOURNAL: JournalEntry[] = [
	H,
	{ t: "attempt", n: 1, at: 1_000_000, pid: 1 },
	{ t: "start", key: "shell:aaa#1", kind: "shell", label: "npm run build", at: 1_000_100 },
	{ t: "done", key: "shell:aaa#1", at: 1_004_100, value: { exitCode: 0 } },
	{ t: "start", key: "llm:bbb#1", kind: "llm", label: "Classify <a> & \"b\"", model: "anthropic/claude-haiku-5-5", at: 1_004_200 },
	{ t: "start", key: "llm:ccc#1", kind: "llm", label: "Classify c", model: "anthropic/claude-haiku-5-5", at: 1_004_210 },
	{ t: "start", key: "agent:ddd#1", kind: "agent", label: "agent 1: Review the diff", model: "anthropic/claude-sonnet-5-5", at: 1_004_300 },
	{ t: "meta", key: "agent:ddd#1", at: 1_005_000, data: { threadId: "thread-1", link: "[workflow agent 1](t3-thread://v2/env/thread-1)" } },
	{ t: "done", key: "llm:ccc#1", at: 1_005_210, value: "c", cost: 0.0021 },
	{ t: "failed", key: "llm:bbb#1", at: 1_006_200, error: { name: "Error", message: "llm(): overloaded" }, cost: 0.001 },
	{ t: "start", key: "tool:eee#1", kind: "tool", label: "write {\"path\":\"a\"}", at: 1_006_300 },
];

describe("the page", () => {
	test("the view: statuses, costs, links and open against done calls", () => {
		const view = viewOf(JOURNAL);
		assert.deepEqual(view.calls.map((c) => [c.kind, c.status, c.cost]), [
			["shell", "done", 0],
			["llm", "failed", 0.001],
			["llm", "done", 0.0021],
			["agent", "running", 0],
			["tool", "running", 0],
		]);
		assert.equal(view.calls[3]!.link, "t3-thread://v2/env/thread-1");
		assert.deepEqual([view.open, view.done, view.status], [2, 3, "running"]);
		const resumed = viewOf([...JOURNAL, { t: "attempt", n: 2, at: 2_000_000, pid: 2 }]);
		assert.deepEqual(resumed.calls.map((c) => c.status), ["replayed", "replayed", "replayed", "interrupted", "interrupted"]);
		assert.deepEqual([resumed.attempts, resumed.status], [2, "running"]);
	});

	test("calls overlapping in time are lanes side by side; groups follow each other", () => {
		const groups = layout(viewOf(JOURNAL).calls);
		assert.deepEqual(groups.map((lanes) => lanes.map((lane) => lane.map((c) => c.key))), [[["shell:aaa#1"]], [["llm:bbb#1", "tool:eee#1"], ["llm:ccc#1"], ["agent:ddd#1"]]]);
	});

	test("the same journal gives byte-identical HTML that matches the snapshot; only theme variables, no vh, no page background", () => {
		const html = renderWorkflow(JOURNAL);
		assert.equal(renderWorkflow(structuredClone(JOURNAL)), html);
		const snapshot = new URL("./snapshots/workflow-page.html", import.meta.url);
		if (process.env.UPDATE_SNAPSHOTS || !existsSync(snapshot)) {
			mkdirSync(new URL("./snapshots/", import.meta.url), { recursive: true });
			writeFileSync(snapshot, html);
		}
		assert.equal(html, readFileSync(snapshot, "utf8"));
		assert.doesNotMatch(html, /\dvh|#[0-9a-f]{3,6}\b|rgb\(|body\{[^}]*background/i, "no fixed colours, no vh");
		assert.match(html, /Classify &lt;a&gt; &amp; &quot;b&quot;/, "labels are escaped");
		assert.match(html, /<a href="t3-thread:\/\/v2\/env\/thread-1">thread<\/a>/);
		assert.match(html, /<b>2<\/b> open · <b>3<\/b> done/);
		assert.match(html, /<b>\$0\.0031<\/b> of \$2\.00/);
		assert.match(html, /<b>6\.3 s<\/b> total/);
		assert.equal(pageHeight(JOURNAL), 60 + 3 * 72);
		const ended = renderWorkflow([...JOURNAL, { t: "end", at: 1_010_000, status: "interrupted", ok: false, cost: 0.0031, text: "" }]);
		assert.match(ended, /s-interrupted/);
		assert.notEqual(ended, html);
	});
});
