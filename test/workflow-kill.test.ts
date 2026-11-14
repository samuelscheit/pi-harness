// Durable workflows against a real crash: a Pi process (test/fixtures/workflow-host.ts: a session
// with the background and workflow extensions and a faux model) runs a workflow, the test kills it
// with SIGKILL mid-run, and a new process opens the same session. The harness offers the
// interrupted run, the model resumes it, and the final result arrives. Side effects are counted
// with marker files in the repository.

import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { readJournal } from "../extensions/workflow/journal.ts";

const HOST = new URL("./fixtures/workflow-host.ts", import.meta.url).pathname;
let dir: string;
let repo: string;
let agentDir: string;
const hosts: ChildProcess[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "workflow-kill-"));
	repo = join(dir, "repo");
	agentDir = join(dir, "agent");
	mkdirSync(repo);
	writeFileSync(join(repo, "README.md"), "x\n");
	for (const args of [["init", "-q"], ["add", "."], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]]) execFileSync("git", args, { cwd: repo });
});
afterEach(() => {
	for (const host of hosts.splice(0)) host.kill("SIGKILL");
	// Commands the killed host left running (their own process groups) end with their sleep; the files go now.
	rmSync(dir, { recursive: true, force: true });
});

const count = (name: string) => (existsSync(join(repo, name)) ? readFileSync(join(repo, name), "utf8").split("\n").filter(Boolean).length : 0);
const until = async (what: string, ok: () => boolean, ms = 30_000) => {
	const deadline = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
};

function host(options: Record<string, unknown>): { process: ChildProcess; out: string; log: () => string } {
	const out = join(dir, `out-${hosts.length}.json`);
	const log = join(dir, `host-${hosts.length}.log`);
	writeFileSync(log, "");
	const child = spawn(process.execPath, [HOST, JSON.stringify({ repo, agentDir, sessionsDir: join(dir, "sessions"), out, ...options })], { stdio: ["ignore", "pipe", "pipe"] });
	child.stdout!.on("data", (chunk) => writeFileSync(log, chunk, { flag: "a" }));
	child.stderr!.on("data", (chunk) => writeFileSync(log, chunk, { flag: "a" }));
	hosts.push(child);
	return { process: child, out, log: () => readFileSync(log, "utf8") };
}

/** Start a run, kill its process once `ready` holds, then start the session again and return what it did. */
async function crashAndResume(code: string, ready: () => boolean) {
	const first = host({ mode: "start", code });
	await until("the session file", () => existsSync(first.out));
	const { sessionFile } = JSON.parse(readFileSync(first.out, "utf8")) as { sessionFile: string };
	await until("the run to reach its crash point", ready).catch((error) => {
		throw new Error(`${(error as Error).message}\n${first.log()}`);
	});
	first.process.kill("SIGKILL");
	await new Promise((r) => first.process.once("exit", r));
	const [id] = readdirSync(join(agentDir, "workflows"));
	const second = host({ mode: "resume", sessionFile });
	const exit = await new Promise<number | null>((r) => second.process.once("exit", r));
	assert.equal(exit, 0, second.log());
	const result = JSON.parse(readFileSync(second.out, "utf8")) as { said: string[]; messages: { role: string; text: string }[]; errors: string[] };
	assert.deepEqual(result.errors, []);
	return { ...result, id: id!, journal: readJournal(join(agentDir, "workflows", id!, "journal.jsonl")) };
}

describe("a workflow whose process is killed", () => {
	test("completed shell, tools and llm calls are not repeated; an in-flight shell call stops the resume until the agent decides; the result arrives once", async () => {
		const code = [
			"await shell('echo s >> shell-count');",
			"await tools.bash({ command: 'echo t >> tool-count' });",
			"const answer = await llm('count me', { model: 'faux/faux-1' });",
			"await shell('echo slow >> slow-count; if [ ! -f slow-ready ]; then touch slow-ready; sleep 20; fi');",
			"return 'result: ' + answer;",
		].join("\n");
		const run = await crashAndResume(code, () => existsSync(join(repo, "slow-ready")));
		assert.equal(count("shell-count"), 1, "the completed shell call ran once");
		assert.equal(count("tool-count"), 1, "the completed tool call ran once");
		assert.equal(count("llm-count"), 1, "the completed llm call ran once");
		assert.equal(count("slow-count"), 2, "the in-flight shell call ran again only once the agent chose rerun");
		const toolResults = run.messages.filter((m) => m.role === "toolResult").map((m) => m.text);
		assert.ok(toolResults.some((t) => /was not resumed: these calls were in flight[\s\S]*- shell echo slow >> slow-count/.test(t)), `the first resume named the in-flight call:\n${toolResults.join("\n---\n")}`);
		assert.deepEqual(run.said.filter((s) => s.startsWith("all done")), ["all done: result: counted"], "the final result arrived once");
		assert.equal(run.messages.filter((m) => /Workflow completed/.test(m.text)).length, 1);
		const attempts = run.journal.filter((e) => e.t === "attempt").map((e) => e.t === "attempt" && e.pid);
		assert.equal(attempts.length, 2, "one resume ran (the refused one did not start)");
		assert.notEqual(attempts[0], attempts[1]);
		assert.ok(run.journal.some((e) => e.t === "end" && e.status === "completed"));
	});

	test("an in-flight in-process agent reattaches to its session file and continues", async () => {
		const code = "const run = await agent({ model: 'faux/faux-1', tools: ['bash'] }).run('do the slow thing');\nreturn 'agent: ' + run.text;";
		const run = await crashAndResume(code, () => existsSync(join(repo, "agent-ready")));
		assert.deepEqual(run.said.filter((s) => s.startsWith("all done")), ["all done: agent: agent finished after the restart"]);
		assert.equal(count("agent-count"), 1, "the agent's command was not repeated");
		const metas = run.journal.filter((e) => e.t === "meta" && typeof e.data.sessionFile === "string");
		assert.equal(new Set(metas.map((e) => e.t === "meta" && e.data.sessionFile)).size, 1, "one child session, reopened");
		const childFile = metas[0]!.t === "meta" ? String(metas[0]!.data.sessionFile) : "";
		assert.match(readFileSync(childFile, "utf8"), /interrupted before it finished[\s\S]*agent finished after the restart/);
	});
});
