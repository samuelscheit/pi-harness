// The harness's bash (extensions/bash): the record line and messages, then real Pi sessions (faux
// model, real bash) where commands leave processes running and each one's end wakes the session,
// where `setsid` and git commands that discard or take other agents' work are refused, and where a
// long command moves to the background and its end wakes the session.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { ImageContent } from "@earendil-works/pi-ai";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, getApiProvider, registerApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import background from "../extensions/background/index.ts";
import { JOB_MESSAGE_TYPE, type Job, sessionJobs } from "../extensions/background/jobs.ts";
import bashExtension, { jobsFile, readGroup, readJobs, recordLine } from "../extensions/bash/index.ts";

describe("record line", () => {
	test("the record line writes the shell's pid, also into a path with quotes", () => {
		const dir = mkdtempSync(join(tmpdir(), "bg-line-"));
		try {
			const file = join(dir, "it's here");
			const out = execFileSync("bash", ["-c", `${recordLine(file)}echo $$`], { encoding: "utf8" }).trim();
			assert.equal(execFileSync("cat", [file], { encoding: "utf8" }), out);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the jobs file lists the shell's jobs at exit, each process of a pipeline and disowned ones; the command's own EXIT trap runs with its status, also under set -e", () => {
		const d = mkdtempSync(join(tmpdir(), "bg-jobs-"));
		try {
			const file = join(d, "it's here");
			const script = 'set -euo pipefail; trap "echo trap saw \\$?" EXIT INT; sleep 0.3 | sleep 0.3 & echo "pipe $!"; sleep 0.3 & echo "disowned $!"; disown; bash -c "sleep 0.3 &"; false';
			const run = spawnSync("bash", ["-c", `${recordLine(file)}${script}`], { encoding: "utf8" });
			assert.equal(run.status, 1, "the command's exit status");
			assert.match(run.stdout, /trap saw 1\n$/);
			const pipe = Number(/pipe (\d+)/.exec(run.stdout)![1]);
			const disowned = Number(/disowned (\d+)/.exec(run.stdout)![1]);
			const jobs = readJobs(jobsFile(file))!;
			assert.ok(jobs.has(pipe) && jobs.has(disowned), [...jobs].join(","));
			assert.equal(jobs.size, 3, "both pipeline processes and the disowned job; the nested shell's job is not the shell's");
			// `trap - EXIT` drops only the command's handler; other signals reach the builtin.
			const reset = spawnSync("bash", ["-c", `${recordLine(file)}trap "echo no" EXIT; trap - EXIT; trap "echo int" INT; trap -p INT; exit 4`], { encoding: "utf8" });
			assert.deepEqual([reset.status, reset.stdout], [4, "trap -- 'echo int' SIGINT\n"]);
			rmSync(jobsFile(file));
			spawnSync("bash", ["-c", `${recordLine(file)}exec true`]);
			assert.equal(readJobs(jobsFile(file)), undefined, "a shell replaced by exec writes nothing");
			assert.deepEqual(readJobs(join(d, "none")), undefined);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	test("readGroup reads a positive integer, else nothing", () => {
		const d = mkdtempSync(join(tmpdir(), "bg-group-"));
		try {
			for (const [content, expected] of [["123", 123], ["", undefined], ["-4", undefined], ["1.5", undefined], ["x", undefined]] as const) {
				writeFileSync(join(d, "f"), content);
				assert.equal(readGroup(join(d, "f")), expected, content);
			}
			assert.equal(readGroup(join(d, "missing")), undefined);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

});

const kill = (pid: number) => {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone.
	}
};

let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
let dir: string;
const open: AgentSession[] = [];

before(async () => {
	faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	const scratch = mkdtempSync(join(tmpdir(), "bg-runtime-"));
	runtime = await ModelRuntime.create({ authPath: join(scratch, "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "faux-1", name: "Faux", api: faux.api, reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8000 }],
	});
});
after(() => faux.unregister());
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "bg-"));
	mkdirSync(join(dir, "repo"));
	slowCalls.clear();
});
afterEach(async () => {
	assert.deepEqual(extensionErrors.splice(0), [], "no extension errors");
	// End the sessions as Pi does: that stops what a test left running, its jobs and its leftovers.
	for (const session of open.splice(0)) {
		const jobs = sessionJobs(session.sessionManager.getSessionId());
		const leftovers = [...jobs.leftovers.keys()];
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		for (const pid of leftovers) kill(pid);
		session.dispose();
	}
	rmSync(dir, { recursive: true, force: true });
});

/** Calls of the `slow` tool, by their `text`. */
const slowCalls = new Map<string, { signal: AbortSignal | undefined; ended: boolean }>();

/** A tool that runs bash through `ctx.executeTool`, as codemode and workflow scripts do; and `slow`, which sleeps. */
function nestedBash(pi: ExtensionAPI) {
	pi.registerTool({
		name: "slow",
		label: "slow",
		description: "Sleeps, then answers, fails or returns an image.",
		parameters: Type.Object({ ms: Type.Number(), text: Type.String(), image: Type.Optional(Type.Boolean()), fail: Type.Optional(Type.Boolean()) }),
		async execute(_id, params, signal) {
			const call = { signal, ended: false };
			slowCalls.set(params.text, call);
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, params.ms);
				signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("slow: aborted"))), { once: true });
			});
			call.ended = true;
			if (params.fail) throw new Error(`slow failed: ${params.text}`);
			return { content: [{ type: "text", text: `slept: ${params.text}` }, ...(params.image ? [{ type: "image" as const, data: PNG.toString("base64"), mimeType: "image/png" }] : [])], details: undefined };
		},
	});
	pi.registerTool({
		name: "script",
		label: "script",
		description: "Runs a bash command from a script.",
		parameters: Type.Object({ command: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const outcome = await ctx.executeTool("bash", { command: params.command });
			return { content: outcome.result.content, details: undefined };
		},
	});
}

const DETACH_MS = 600;
const extensionErrors: string[] = [];

async function newSession(detachAfterMs = DETACH_MS): Promise<AgentSession> {
	const cwd = join(dir, "repo");
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: dir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		extensionFactories: [
			(pi: ExtensionAPI) => background(pi, { detachAfterMs, logRoot: join(dir, "logs") }),
			(pi: ExtensionAPI) => bashExtension(pi, { dir: join(dir, "groups"), detachAfterMs, pollMs: 100 }),
			nestedBash,
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: dir,
		model: runtime.getModel("faux", "faux-1"),
		modelRuntime: runtime,
		resourceLoader,
		sessionManager: SessionManager.create(cwd, join(dir, "sessions")),
		settingsManager,
	});
	// Like the RPC mode: an error listener is a binding, so a reload emits session_start.
	await session.bindExtensions({ onError: (error) => extensionErrors.push(`${error.event}: ${error.error}`) });
	session.setActiveToolsByName([...session.getActiveToolNames(), "script"]);
	open.push(session);
	return session;
}

const bash = (command: string, timeout?: number) => fauxAssistantMessage([fauxToolCall("bash", timeout === undefined ? { command } : { command, timeout })], { stopReason: "toolUse" });
const respond = (...steps: FauxResponseStep[]) => faux.setResponses(steps);
const marker = () => join(dir, `marker-${Math.random().toString(36).slice(2)}`);
const leftoversOf = (s: AgentSession) => sessionJobs(s.sessionManager.getSessionId()).leftovers;
const groupFiles = () => (existsSync(join(dir, "groups")) ? readdirSync(join(dir, "groups")).flatMap((d) => readdirSync(join(dir, "groups", d))) : []);

describe("processes a command leaves running", () => {
	test("each is named in the result, and each one's end wakes the session with its own message", async () => {
		const s = await newSession();
		const work = workEvents(s);
		respond(
			bash("sleep 0.4 > /dev/null 2>&1 &\nsleep 1.4 > /dev/null 2>&1 &\necho started"),
			fauxAssistantMessage("Both run."),
			fauxAssistantMessage("The first ended."),
			fauxAssistantMessage("The second ended."),
		);
		await s.prompt("start them");
		assert.match(toolTexts(s)[0]!, /^started\n\n\nStill running in the background, left by this command \(2 processes\):\n- pid \d+: `sleep 0\.4`\n- pid \d+: `sleep 1\.4`\nEach one's end reaches you/);
		assert.equal(leftoversOf(s).size, 2);
		assert.deepEqual(groupFiles(), [], "the call's group file is gone once its leftovers are adopted");
		const call = s.messages.find((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall"));
		assert.doesNotMatch(JSON.stringify(call), /printf/, "the transcript keeps the original command");

		await until("both end messages", () => jobMessages(s).length === 2 && settled(s, "The second ended.")());
		const [first, second] = jobMessages(s);
		assert.match(first!, /^Background process pid \d+ `sleep 0\.4` ended \(running at least \d s since your command `sleep 0\.4 > \/dev\/null 2>&1 & sleep 1\.4 > \/dev\/null 2>&1 & echo started` returned\)\. Its exit code is not known/);
		assert.match(second!, /^Background process pid \d+ `sleep 1\.4` ended/);
		assert.equal(leftoversOf(s).size, 0);
		assert.equal(sessionJobs(s.sessionManager.getSessionId()).poll, undefined, "the check stops with the last leftover");
		assert.deepEqual(work, [2, 1, 0]);
	});

	test("a job that leaves a child when it ends: the child is tracked, and its end is reported too", async () => {
		const s = await newSession();
		respond(bash("bash -c 'sleep 0.3; sleep 0.8 > /dev/null 2>&1 & exit 0' > /dev/null 2>&1 &"), fauxAssistantMessage("Started."), fauxAssistantMessage("Parent ended."), fauxAssistantMessage("Child ended."));
		await s.prompt("go");
		assert.match(toolTexts(s)[0]!, /\(1 process\):\n- pid \d+: `bash -c sleep 0\.3; sleep 0\.8 > \/dev\/null 2>&1 & exit 0`/);
		await until("both end messages", () => jobMessages(s).length === 2 && settled(s, "Child ended.")());
		const [parent, child] = jobMessages(s);
		assert.match(parent!, /`bash -c sleep 0\.3; .*` ended .*\nIt left running, now tracked as well:\n- pid \d+: `sleep 0\.8`$/);
		assert.match(child!, /^Background process pid \d+ `sleep 0\.8` ended/);
	});

	test("one entry per job: a subshell and its children are one process; a failing command names its leftovers too", async () => {
		const s = await newSession();
		const [release, done] = [marker(), marker()];
		// The job runs until the test releases it, so it is still there when the call ends, however slow the machine.
		respond(bash(`(until [ -e '${release}' ]; do sleep 0.05; done; touch '${done}') > /dev/null 2>&1 &\nexit 3`), fauxAssistantMessage("Noted."), fauxAssistantMessage("Ended."));
		await s.prompt("go");
		const [result] = s.messages.filter((m) => m.role === "toolResult");
		assert.equal(result!.isError, true);
		assert.match(textOf(result!.content), /exited with code 3[\s\S]*\(1 process\):\n- pid \d+: /);
		writeFileSync(release, "");
		await until("the end message", () => jobMessages(s).length === 1 && settled(s, "Ended.")());
		assert.ok(existsSync(done));
	});

	test("jobs the command waits for or stops leave nothing", async () => {
		const s = await newSession();
		respond(bash("sleep 0.2 & sleep 0.1 & wait; echo waited; sleep 30 & pid=$!; kill $pid; echo stopped"), fauxAssistantMessage("Done."));
		await s.prompt("go");
		assert.equal(toolTexts(s)[0], "waited\nstopped\n");
		assert.equal(leftoversOf(s).size, 0);
		assert.deepEqual(groupFiles(), []);
	});

	test("a script's command (ctx.executeTool) names its leftovers in its result, and their end wakes the session", async () => {
		const s = await newSession();
		respond(fauxAssistantMessage([fauxToolCall("script", { command: "sleep 0.3 > /dev/null 2>&1 & echo nested" })], { stopReason: "toolUse" }), fauxAssistantMessage("ok"), fauxAssistantMessage("Ended."));
		await s.prompt("go");
		assert.match(toolTexts(s)[0]!, /^nested\n\n\nStill running in the background, left by this command \(1 process\):\n- pid \d+: `sleep 0\.3`/);
		await until("the end message", () => jobMessages(s).length === 1 && settled(s, "Ended.")());
	});

	test("a job that moved to the background names what it left in its report", async () => {
		const s = await newSession();
		respond(bash("sleep 2 > /dev/null 2>&1 & sleep 1; echo done"), fauxAssistantMessage("In the background."), fauxAssistantMessage("Job ended."), fauxAssistantMessage("Leftover ended."));
		await s.prompt("go");
		await until("both reports", () => jobMessages(s).length === 2 && settled(s, "Leftover ended.")());
		const [job, leftover] = jobMessages(s);
		assert.match(job!, /^Your background `bash` call .* finished after \d s:\n\ndone\n\n\nStill running in the background, left by this command \(1 process\):\n- pid \d+: `sleep 2`/);
		assert.match(leftover!, /`sleep 2` ended/);
	});

	test("leftovers survive a reload and still report; the session's end stops them", async () => {
		const s = await newSession();
		respond(bash("sleep 0.8 > /dev/null 2>&1 & sleep 30 > /dev/null 2>&1 &"), fauxAssistantMessage("Started."), fauxAssistantMessage("Short one ended."));
		await s.prompt("go");
		const pids = [...leftoversOf(s).keys()];
		assert.equal(pids.length, 2);
		const provider = getApiProvider(faux.api);
		await s.reload();
		if (!getApiProvider(faux.api)) registerApiProvider(provider as never);
		await until("the short one's report", () => jobMessages(s).length === 1 && settled(s, "Short one ended.")());
		const [long] = [...leftoversOf(s).keys()];
		assert.ok(long !== undefined && pids.includes(long));
		await s.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await until("the long one stopped", () => {
			try {
				process.kill(long!, 0);
				return false;
			} catch {
				return true;
			}
		}, 3000);
	});
});

describe("processes programs leave running", () => {
	/** Whether a process runs. */
	const alive = (pid: number) => spawnSync("kill", ["-0", String(pid)]).status === 0;

	test("a program's own process (a nested shell's job) is named once, not tracked, not reported as work, and outlives the session; the command's job is tracked", async () => {
		const s = await newSession();
		const work = workEvents(s);
		respond(
			bash("bash -c 'sleep 30 > /dev/null 2>&1 &'\nsleep 0.4 > /dev/null 2>&1 &\necho started"),
			fauxAssistantMessage("Started."),
			fauxAssistantMessage("The job ended."),
		);
		await s.prompt("go");
		const [text] = toolTexts(s);
		assert.match(text!, /^started\n\n\nStill running in the background, left by this command \(1 process\):\n- pid \d+: `sleep 0\.4`\n/);
		const daemon = Number(/\n\nLeft running by programs this command ran, not by its own `&` jobs, so not tracked \(their end is not reported, and they outlive the session\):\n- pid (\d+): `sleep 30`\nStop one with `kill <pid>` if it is not wanted\.$/.exec(text!)?.[1]);
		assert.ok(daemon > 0, text);
		try {
			assert.deepEqual([...leftoversOf(s).values()].map((l) => l.command), ["sleep 0.4"]);
			await until("the job's end", () => jobMessages(s).length === 1 && settled(s, "The job ended.")());
			assert.match(jobMessages(s)[0]!, /`sleep 0\.4` ended/);
			assert.doesNotMatch(jobMessages(s)[0]!, /It left running/, "the program's process is no orphan of the job");
			assert.equal(leftoversOf(s).size, 0);
			assert.deepEqual(work, [1, 0], "only the job counted as background work");
			assert.deepEqual(groupFiles(), [], "the group and jobs files are gone");
			await s.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			assert.ok(alive(daemon), "not stopped with the session");
		} finally {
			kill(daemon);
		}
	});

	test("git's fsmonitor daemon, started by `git status`, is not a job", async () => {
		const repo = join(dir, "repo", "fsmonitor");
		mkdirSync(repo);
		execFileSync("git", ["-C", repo, "init", "-q"]);
		writeFileSync(join(repo, "a"), "a\n");
		const s = await newSession();
		respond(bash("cd fsmonitor && git -c core.fsmonitor=true status --short"), fauxAssistantMessage("Done."));
		try {
			await s.prompt("go");
			const [text] = toolTexts(s);
			assert.match(text!, /^\?\? a\n\n\nLeft running by programs this command ran, not by its own `&` jobs, so not tracked[^\n]*\n- pid \d+: `[^`]*git fsmonitor--daemon run --detach[^`]*`\n/);
			assert.doesNotMatch(text!, /Still running in the background/);
			assert.equal(leftoversOf(s).size, 0);
			assert.equal(sessionJobs(s.sessionManager.getSessionId()).poll, undefined, "nothing to watch");
		} finally {
			spawnSync("git", ["-C", repo, "fsmonitor--daemon", "stop"]);
		}
	});

	test("a command with its own EXIT trap: the trap runs, and its jobs are still tracked", async () => {
		const s = await newSession();
		respond(bash("trap 'echo cleaned up' EXIT\nsleep 0.3 > /dev/null 2>&1 &\necho started"), fauxAssistantMessage("Started."), fauxAssistantMessage("Ended."));
		await s.prompt("go");
		assert.match(toolTexts(s)[0]!, /^started\ncleaned up\n\n\nStill running in the background, left by this command \(1 process\):\n- pid \d+: `sleep 0\.3`\n/);
		await until("the job's end", () => jobMessages(s).length === 1 && settled(s, "Ended.")());
	});
});

describe("setsid", () => {
	test("is refused before the command runs, also from a script; nohup and & run", async () => {
		const s = await newSession();
		const ran = marker();
		const nested = marker();
		const allowed = marker();
		respond(
			bash(`touch '${ran}'; setsid nohup bash -c 'sleep 30' > /dev/null 2>&1 &`),
			fauxAssistantMessage([fauxToolCall("script", { command: `touch '${nested}'; setsid sleep 30` })], { stopReason: "toolUse" }),
			bash(`nohup touch '${allowed}' > /dev/null 2>&1 & wait`),
			fauxAssistantMessage("ok"),
		);
		await s.prompt("embed everything");
		assert.ok(!existsSync(ran), "the refused command did not run");
		assert.ok(!existsSync(nested), "the refused nested command did not run");
		assert.ok(existsSync(allowed), "nohup and & run");
		const results = s.messages.filter((m) => m.role === "toolResult");
		assert.ok(results[0]?.isError, "the refusal is an error result");
		const [top, fromScript] = results.map((m) => textOf(m.content));
		assert.match(top!, /^Not run: this command uses `setsid`:\n- `setsid nohup bash -c 'sleep 30' > \/dev\/null 2>&1`\n/);
		assert.match(top!, /Start the job with `&` instead/);
		assert.match(fromScript!, /Not run: this command uses `setsid`:\n- `setsid sleep 30`/);
	});
});

describe("a publish gated on a filtered pipeline", () => {
	test("is refused before anything of the command runs; with pipefail it runs and the failure holds the push", async () => {
		const s = await newSession();
		const ran = marker();
		respond(
			bash(`touch '${ran}'; sh -c 'echo "1 fail"; exit 1' | grep -E " pass$| fail$" && git push`),
			bash(`set -o pipefail; sh -c 'echo "1 fail"; exit 1' | grep -E " fail$" && git push || echo held`),
			fauxAssistantMessage("ok"),
		);
		await s.prompt("test and push");
		const texts = toolTexts(s);
		assert.ok(!existsSync(ran), "nothing of the refused command ran");
		assert.match(texts[0]!, /^Not run: this command runs `git push` only if a pipeline ending in a filter succeeds:\n- `sh -c 'echo "1 fail"; exit 1' \| grep -E " pass\$\| fail\$"`\nGated: `git push`\./);
		assert.equal(texts[1], "1 fail\nheld\n");
	});
});

describe("shared checkouts", () => {
	const repoGit = (...args: string[]) =>
		execFileSync("git", ["-C", join(dir, "repo"), ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
	const initRepo = () => {
		repoGit("init", "-q");
		writeFileSync(repoFile("a.ts"), "a\n");
		writeFileSync(repoFile("b.ts"), "b\n");
		repoGit("add", "-A");
		repoGit("commit", "-qm", "init");
	};
	const write = (path: string, content: string) => fauxAssistantMessage([fauxToolCall("write", { path, content })], { stopReason: "toolUse" });
	const commitEnv = "GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t";

	test("git stash, reset --hard, clean -f and whole-tree discards are refused before they run; other agents' work stays", async () => {
		initRepo();
		writeFileSync(repoFile("a.ts"), "another agent's work\n");
		writeFileSync(repoFile("new.ts"), "another agent's new file\n");
		const s = await newSession();
		respond(
			bash("git stash; echo measured; git stash pop"),
			bash(`git -C '${join(dir, "repo")}' reset --hard`),
			bash("cd . && nohup git clean -fd"),
			bash("git checkout -- ."),
			bash("git stash list && echo listed"),
			fauxAssistantMessage("ok"),
		);
		await s.prompt("measure on a clean tree");
		const texts = toolTexts(s);
		assert.match(texts[0]!, /^Not run: this command runs `git stash`:\n- `git stash`\n- `git stash pop`\n/);
		assert.doesNotMatch(texts[0]!, /measured/, "nothing of the command ran");
		assert.match(texts[1]!, /^Not run: this command runs `git reset --hard`/);
		assert.match(texts[2]!, /^Not run: this command runs `git clean` with `-f`:\n- `nohup git clean -fd`/);
		assert.match(texts[3]!, /^Not run: this command discards the changes of the whole tree/);
		assert.equal(texts[4], "listed\n");
		assert.equal(readFileSync(repoFile("a.ts"), "utf8"), "another agent's work\n");
		assert.ok(existsSync(repoFile("new.ts")));
		assert.equal(repoGit("stash", "list"), "");
	});

	test("a commit of the session's own writes and `tool edit`s runs; one that takes another agent's later change is refused until checked", async () => {
		initRepo();
		const s = await newSession(FOREGROUND_MS);
		respond(
			write("a.ts", "mine\n"),
			bash("tool edit - <<'EOF'\nb.ts\n<<<<<<< SEARCH\nb\n=======\nb mine\n>>>>>>> REPLACE\nEOF"),
			bash(`${commitEnv} git commit -qm mine a.ts b.ts && git log --oneline | wc -l`),
			write("a.ts", "mine again\n"),
			() => {
				appendFileSync(repoFile("a.ts"), "another agent's line\n");
				return bash(`git add a.ts && ${commitEnv} git commit -qm again`);
			},
			bash(`PI_COMMIT_CHECKED=1 ${commitEnv} git commit -qam checked && git log --oneline | wc -l`),
			fauxAssistantMessage("ok"),
		);
		await s.prompt("commit");
		const texts = toolTexts(s);
		assert.match(texts[2]!, /^\s*2\n$/, `the own commit ran: ${texts[2]}`);
		assert.match(texts[4]!, /^Not run: this command commits changes your edit and write tools did not make:\n- `GIT_AUTHOR_NAME=t [^`]* git commit -qm again`\nPaths:\n- `a\.ts`: changed since your last edit/);
		assert.equal(repoGit("diff", "--cached", "--name-only"), "", "the refused command's git add did not run");
		assert.match(texts[5]!, /^\s*3\n$/, `the checked commit ran: ${texts[5]}`);
	});
});

const textOf = (content: string | readonly { type: string; text?: string }[]) => (typeof content === "string" ? content : content.map((c) => c.text ?? "").join(""));
const jobMessages = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "custom" && m.customType === JOB_MESSAGE_TYPE ? [textOf(m.content)] : []));
const toolTexts = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((c) => (c.type === "text" ? c.text : "")).join("")] : []));
const lastText = (context: { messages: readonly unknown[] }) => JSON.stringify(context.messages.at(-1));
const jobsOf = (s: AgentSession) => sessionJobs(s.sessionManager.getSessionId()).jobs;
/** A bash job's process group. */
const pgidOf = (job: Job | undefined) => job?.pgid ?? Number.NaN;
const alive = (pgid: number) => {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
};
/** Waits until `check` holds; on a timeout fails with `details` (the state to debug it). */
async function until(what: string, check: () => boolean, ms = 10_000, details?: () => string): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) assert.fail(`timed out after ${ms} ms waiting for ${what}${details ? `; ${details()}` : ""}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}
const settled = (s: AgentSession, reply: string) => () => !s.isStreaming && s.messages.at(-1)?.role === "assistant" && JSON.stringify(s.messages.at(-1)).includes(reply);
function workEvents(s: AgentSession): number[] {
	const seen: number[] = [];
	s.subscribe((event) => {
		if (event.type === "background_work") seen.push(event.pending);
	});
	return seen;
}

describe("long commands move to the background", () => {
	test("after the limit: the tool returns the output so far, the run ends, and the job's end wakes the session with its result", async () => {
		const s = await newSession();
		const work = workEvents(s);
		let detachedSeen = "";
		let wakeSeen = "";
		respond(
			bash("echo first; sleep 2; echo second"),
			(context) => {
				detachedSeen = lastText(context);
				return fauxAssistantMessage("It runs in the background.");
			},
			(context) => {
				wakeSeen = lastText(context);
				return fauxAssistantMessage("It finished.");
			},
		);
		await s.prompt("build it");
		assert.match(detachedSeen, /It still ran after \d s, so the call moved to the background/);
		assert.match(detachedSeen, /process group \d+; stop it with `kill -- -\d+`/);
		assert.match(detachedSeen, /Output so far:\\nfirst/);

		const [job] = [...jobsOf(s).values()];
		assert.ok(alive(pgidOf(job)), "the run ended before the command");
		assert.match(readFileSync(job.log, "utf8"), /first/);
		assert.deepEqual(work, [1]);

		await until("the wake run", settled(s, "It finished."));
		assert.match(wakeSeen, /Your background `bash` call `echo first; sleep 2; echo second`/, "the wake run starts from the job's report");
		const [message] = jobMessages(s);
		assert.match(message!, /^Your background `bash` call `echo first; sleep 2; echo second` \(call [^)]+\) finished after \d s:\n\nfirst\nsecond\n$/);
		assert.equal(jobsOf(s).size, 0);
		assert.deepEqual(work, [1, 0]);
		assert.match(readFileSync(job.log, "utf8"), /first\nsecond/, "the log has the latest output");
	});

	test("a message arriving during the command: the tool returns at once, the agent reads the message, and the job's end still reports (killed: exit 143)", async () => {
		const s = await newSession();
		let steered = "";
		respond(
			bash("echo waiting; sleep 30"),
			(context) => {
				steered = JSON.stringify(context.messages.slice(-2));
				const [job] = [...jobsOf(s).values()];
				return bash(`kill -- -${pgidOf(job)}`);
			},
			fauxAssistantMessage("Stopped it."),
			fauxAssistantMessage("Noted."),
		);
		const t0 = Date.now();
		const run = s.prompt("build it");
		await new Promise((r) => setTimeout(r, 200));
		await s.steer("stop that, do something else");
		await run;
		const [detached] = toolTexts(s);
		assert.match(detached!, /^A new message arrived while it ran, so the call moved to the background/);
		assert.match(steered, /stop that, do something else/);
		assert.match(steered, /A new message arrived/, "the agent got the tool result and the message in one go");
		await until("the job's report", () => jobMessages(s).length === 1 && !s.isStreaming);
		assert.ok(Date.now() - t0 < 5000, "nothing waited for the 30 s sleep");
		assert.match(jobMessages(s)[0]!, /failed with exit code 143 after/);
		assert.match(jobMessages(s)[0]!, /waiting/);
	});

	test("an abort stops a foreground command, but not one already in the background", async () => {
		// No command reaches the detach limit, however slow the machine: a message moves the first one
		// to the background, so the second stays in the foreground until the abort.
		const s = await newSession(FOREGROUND_MS);
		// Durations of their own, so no other test run's `sleep` matches.
		const id = `${process.pid}${Date.now() % 1000}`;
		const [first, second] = [`sleep 30.${id}`, `sleep 31.${id}`];
		respond(bash(first), bash(second), fauxAssistantMessage("unused"));
		const run = s.prompt("go");
		// pgrep, not every command line from ps: those exceed spawnSync's output limit when many processes run.
		const running = (command: string) => () => spawnSync("pgrep", ["-x", "-f", command]).status === 0;
		const sleeping = running(second);
		const state = () =>
			`jobs: ${JSON.stringify([...jobsOf(s).values()].map((j) => [j.input, j.pgid]))}, foreground calls: ${sessionJobs(s.sessionManager.getSessionId()).foreground.size}, first running: ${running(first)()}, second running: ${sleeping()}, tool results: ${JSON.stringify(toolTexts(s))}`;
		// Its process runs, so its shell has recorded the process group the job gets.
		await until("the first command running", running(first), 30_000, state);
		await s.steer("go on");
		await until("the first command in the background", () => jobsOf(s).size === 1, 30_000, state);
		const [job] = [...jobsOf(s).values()];
		await until("the second command running", sleeping, 30_000, state);
		assert.equal(jobsOf(s).size, 1, `the second command runs in the foreground; ${state()}`);
		await s.abort();
		await run;
		await until("the foreground command stopped", () => !sleeping(), 30_000, state);
		assert.ok(alive(pgidOf(job)), `the background job survives the abort; ${state()}`);
		assert.equal(jobsOf(s).size, 1, state());
	});

	test("a command's own timeout still ends it in the background, and the report says so", async () => {
		const s = await newSession();
		respond(bash("echo started; sleep 10", 1.5), fauxAssistantMessage("In the background."), fauxAssistantMessage("It timed out."));
		await s.prompt("go");
		await until("the wake run", settled(s, "It timed out."));
		assert.match(jobMessages(s)[0]!, /^Your background `bash` call `\{"command":"echo started; sleep 10","timeout":1\.5\}` \(call [^)]+\) failed after \d s:\n\nstarted\n+Command timed out after 1\.5 seconds$/);
	});

	test("a command a script runs through ctx.executeTool stays in the foreground of the script: only the script moves", async () => {
		const s = await newSession();
		respond(fauxAssistantMessage([fauxToolCall("script", { command: "sleep 1.2; echo nested-done" })], { stopReason: "toolUse" }), fauxAssistantMessage("ok"), fauxAssistantMessage("Seen."));
		await s.prompt("go");
		assert.match(toolTexts(s)[0]!, /so the call moved to the background/);
		assert.deepEqual([...jobsOf(s).values()].map((j) => j.toolName), ["script"], "the nested bash call is no job of its own");
		await until("the script's report", settled(s, "Seen."));
		assert.match(jobMessages(s)[0]!, /^Your background `script` call `sleep 1\.2; echo nested-done` \(call [^)]+\) finished after \d s:\n\nnested-done\n$/);
	});

	test("a fast command returns as before", async () => {
		const s = await newSession();
		const work = workEvents(s);
		respond(bash("echo quick"), fauxAssistantMessage("ok"));
		await s.prompt("go");
		assert.equal(toolTexts(s)[0], "quick\n");
		assert.deepEqual(work, []);
	});

	test("a reload while a job runs (a harness release): its end reaches the reloaded extension and wakes the session", async () => {
		const s = await newSession();
		const work = workEvents(s);
		respond(bash("sleep 1.5; echo after-reload"), fauxAssistantMessage("In the background."), fauxAssistantMessage("Done after reload."));
		await s.prompt("go");
		assert.equal(jobsOf(s).size, 1);
		// reload() resets the API providers to the built-in ones; the faux one goes back, as an extension's would.
		const provider = getApiProvider(faux.api);
		await s.reload();
		if (!getApiProvider(faux.api)) registerApiProvider(provider as never);
		await until("the wake run", settled(s, "Done after reload."));
		assert.match(jobMessages(s)[0]!, /finished after \d s:\n\nafter-reload\n$/);
		assert.deepEqual(work, [1, 0]);
	});
});

/** A detach limit no bridge test reaches: several `tool` calls (each a Node start) can pass 600 ms under load. */
const FOREGROUND_MS = 30_000;
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const toolResults = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "toolResult" ? [m] : []));
const imagesOf = (content: string | readonly { type: string }[]) => (typeof content === "string" ? [] : content.filter((c): c is ImageContent => c.type === "image"));
const repoFile = (name: string) => join(dir, "repo", name);

describe("tools from bash", () => {
	test("a script chains a command and the tools that look at its output; images come with the bash result", async () => {
		writeFileSync(repoFile("shot.png"), PNG);
		const s = await newSession(FOREGROUND_MS);
		respond(bash("echo built > out.txt && tool read out.txt && tool read shot.png && echo after"), fauxAssistantMessage("ok"));
		await s.prompt("go");
		const [result] = toolResults(s);
		assert.equal(result!.isError, false);
		const text = textOf(result!.content);
		assert.match(text, /^built\n/);
		assert.match(text, /\[image 1 \(image\/png\) is attached to this bash call's result\]\nafter\n$/);
		assert.deepEqual(imagesOf(result!.content).map((c) => c.mimeType), ["image/png"]);
		assert.deepEqual(result!.nestedCalls?.calls.map((c) => [c.name, c.status]), [["read", "ok"], ["read", "ok"]], "recorded as nested calls of the bash call");
	});

	test("failures: a failed call exits 1 with its error on stderr, usage errors and unknown tools exit 2", async () => {
		const s = await newSession(FOREGROUND_MS);
		respond(bash("tool read missing.txt; echo \"read $?\"; tool read --bogus x; echo \"usage $?\"; tool nope; echo \"unknown $?\""), fauxAssistantMessage("ok"));
		await s.prompt("go");
		const text = textOf(toolResults(s)[0]!.content);
		assert.match(text, /ENOENT|not found|No such file/i);
		assert.match(text, /\nread 1\n/);
		assert.match(text, /tool read: unknown option --bogus; options: --path, --offset, --limit\nRun `tool read --help` for its arguments\.\nusage 2\n/);
		assert.match(text, /tool: unknown tool "nope"\. Tools: [^\n]*\bbash\b[^\n]*\nunknown 2\n$/);
	});

	test("set -e stops the script at a failed tool call", async () => {
		const s = await newSession(FOREGROUND_MS);
		respond(bash("set -e; tool read missing.txt; echo unreachable"), fauxAssistantMessage("ok"));
		await s.prompt("go");
		const [result] = toolResults(s);
		assert.equal(result!.isError, true);
		assert.doesNotMatch(textOf(result!.content), /unreachable/);
		assert.match(textOf(result!.content), /Command exited with code 1/);
	});

	test("JSON arguments from a heredoc, nested bash, and help", async () => {
		const s = await newSession(FOREGROUND_MS);
		respond(
			bash(`tool write --args - <<'EOF'\n{"path": "w.txt", "content": "from 'json'"}\nEOF\ntool bash 'cat w.txt'; echo; tool --help; tool read --help`),
			fauxAssistantMessage("ok"),
		);
		await s.prompt("go");
		const text = textOf(toolResults(s)[0]!.content);
		assert.equal(readFileSync(repoFile("w.txt"), "utf8"), "from 'json'");
		assert.match(text, /\nfrom 'json'\n/);
		assert.match(text, /Usage: tool <name> \[arguments\]/);
		assert.match(text, /^ {2}read {2,}\S/m);
		assert.match(text, /Usage: tool read <path> \[--offset <number>\] \[--limit <number>\]/);
	});

	test("tool edit - changes several files from blocks after a cd, as edit calls, and the check runs after it", async () => {
		mkdirSync(repoFile("sub"), { recursive: true });
		writeFileSync(repoFile("sub/a.txt"), "alpha $HOME `x`\n");
		writeFileSync(repoFile("b.txt"), "beta\n");
		const s = await newSession(FOREGROUND_MS);
		const blocks = ["a.txt", "<<<<<<< SEARCH", "alpha $HOME `x`", "=======", "ALPHA $HOME `x`", ">>>>>>> REPLACE", "../b.txt", "<<<<<<< SEARCH", "beta", "=======", "BETA", ">>>>>>> REPLACE"].join("\n");
		respond(
			bash(`cd sub && tool edit - <<'EOF'\n${blocks}\nEOF\ncat a.txt ../b.txt; tool edit - <<'EOF' || echo "refused $?"\na.txt\n<<<<<<< SEARCH\nnot there\n=======\nx\n>>>>>>> REPLACE\nEOF\ntool edit --help | grep -c 'SEARCH'`),
			fauxAssistantMessage("ok"),
		);
		await s.prompt("go");
		const [result] = toolResults(s);
		const text = textOf(result!.content);
		assert.match(text, /Successfully replaced 1 block\(s\) in \S*sub\/a\.txt\.\nSuccessfully replaced 1 block\(s\) in \S*b\.txt\.\n/);
		assert.match(text, /ALPHA \$HOME `x`\nBETA\n/);
		assert.match(text, /tool edit: nothing changed, 1 of 1 files do not match:\n\S*sub\/a\.txt: [^\n]+\nrefused 1\n/);
		assert.match(text, /\n[1-9]\n$/, "help shows the block format");
		assert.equal(readFileSync(repoFile("sub/a.txt"), "utf8"), "ALPHA $HOME `x`\n");
		assert.deepEqual(result!.nestedCalls?.calls.map((c) => [c.name, c.status]), [["edit", "ok"], ["edit", "ok"]], "a refused run makes no edit call");
	});

	test("a tool command killed by its caller aborts its call, while the script goes on", async () => {
		const s = await newSession(FOREGROUND_MS);
		const started = marker();
		const done = marker();
		respond(
			bash(`timeout 0.6 tool bash 'touch ${started}; sleep 1; touch ${done}'; echo "exit $?"; sleep 1.2; [ -e ${started} ] && echo started; [ -e ${done} ] && echo touched || echo stopped`),
			fauxAssistantMessage("ok"),
		);
		await s.prompt("go");
		assert.equal(textOf(toolResults(s)[0]!.content), "exit 124\nstarted\nstopped\n");
	});

	test("a command that moves to the background keeps its tools; its images come with the job's report", async () => {
		writeFileSync(repoFile("shot.png"), PNG);
		const s = await newSession();
		respond(bash("sleep 1; tool read shot.png"), fauxAssistantMessage("In the background."), fauxAssistantMessage("Seen it."));
		await s.prompt("go");
		await until("the wake run", settled(s, "Seen it."));
		const report = s.messages.find((m) => m.role === "custom" && m.customType === JOB_MESSAGE_TYPE);
		assert.ok(report?.role === "custom");
		assert.match(textOf(report.content), /finished after \d s:\n\nRead image file \[image\/png\]\n\[image 1 \(image\/png\) is attached to this bash call's result\]/);
		assert.equal(imagesOf(report.content).length, 1);
	});

	test("outside a bash call, and after it ended, the command says it cannot reach the agent", async () => {
		const client = new URL("../extensions/bash/cli.mjs", import.meta.url).pathname;
		const run = (env: NodeJS.ProcessEnv) => {
			try {
				execFileSync(process.execPath, [client, "read", "x"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
				return assert.fail("exits non-zero");
			} catch (error) {
				const { status, stderr } = error as { status: number; stderr: string };
				return { status, stderr };
			}
		};
		assert.deepEqual(run({ PATH: process.env.PATH }), { status: 2, stderr: "tool: works only inside the agent's bash tool\n" });
		const s = await newSession(FOREGROUND_MS);
		respond(bash("printf %s \"$PI_TOOL_SOCKET\""), fauxAssistantMessage("ok"));
		await s.prompt("go");
		const socket = textOf(toolResults(s)[0]!.content);
		assert.match(socket, /pi-tool-\d+-\d+\.sock$/);
		assert.equal(existsSync(socket), false, "the socket is removed with the call");
		const after = run({ PATH: process.env.PATH, PI_TOOL_SOCKET: socket });
		assert.equal(after.status, 2);
		assert.match(after.stderr, /cannot reach the agent/);
	});
});

const alivePid = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
/** Wait past a few leftover checks, so a second report of an end would have arrived. */
const quiet = () => new Promise((r) => setTimeout(r, 600));

describe("tool commands left running (`tool … &`)", () => {
	test("returns at once, the job is listed, and its end brings its exit code and result; its output still goes where it was sent", async () => {
		const s = await newSession();
		const work = workEvents(s);
		const command = "tool slow --ms 1000 --text a > a.out 2>&1 &";
		respond(bash(command), fauxAssistantMessage("It runs."), fauxAssistantMessage("It ended."));
		const t0 = Date.now();
		await s.prompt("go");
		assert.ok(Date.now() - t0 < 1000, "the command did not wait for the tool");
		const [listed] = toolTexts(s);
		assert.match(listed!, /^\(no output\)\n\nStill running in the background, left by this command \(1 process\):\n- pid (\d+): `tool slow --ms 1000 --text a`\nEach one's end reaches you as a new message \(a `tool` command's with its exit code and result\), also after your turn/);
		const pid = Number(/pid (\d+)/.exec(listed!)![1]);
		assert.deepEqual([...leftoversOf(s).keys()], [pid]);
		assert.equal(jobsOf(s).size, 0, "no tool call of the model's runs in the background");

		await until("its end message", () => jobMessages(s).length === 1 && settled(s, "It ended.")());
		assert.equal(jobMessages(s)[0], `Your background \`tool slow --ms 1000 --text a\` (pid ${pid}, left running by your command \`${command}\`) exited with code 0 after 1 s:\n\nslept: a`);
		// The message goes out before the client writes its answer.
		await until("the client's output", () => readFileSync(repoFile("a.out"), "utf8") === "slept: a\n");
		await quiet();
		assert.equal(jobMessages(s).length, 1, "reported once");
		assert.equal(leftoversOf(s).size, 0);
		assert.equal(work.at(-1), 0);
		assert.equal(work.filter((n) => n > 1).length, 0, "counted once");
	});

	test("two jobs started in one command, with more work after them, give two messages; a failing call exits 1 with its error", async () => {
		const s = await newSession(FOREGROUND_MS);
		respond(
			bash("tool slow --ms 900 --text a > a.out 2>&1 &\ntool slow --ms 1300 --text b --fail > b.out 2>&1 &\nsleep 0.5; echo more"),
			fauxAssistantMessage("Both run."),
			fauxAssistantMessage("One."),
			fauxAssistantMessage("Two."),
		);
		await s.prompt("go");
		const [listed] = toolTexts(s);
		assert.match(listed!, /^more\n\n\nStill running in the background, left by this command \(2 processes\):\n- pid \d+: `tool slow --ms 900 --text a`\n- pid \d+: `tool slow --ms 1300 --text b --fail`\n/);
		await until("both end messages", () => jobMessages(s).length === 2 && settled(s, "Two.")());
		const [a, b] = jobMessages(s);
		assert.match(a!, /^Your background `tool slow --ms 900 --text a` \(pid \d+, .*\) exited with code 0 after \d s:\n\nslept: a$/);
		assert.match(b!, /^Your background `tool slow --ms 1300 --text b --fail` \(pid \d+, .*\) exited with code 1 after \d s:\n\nslow failed: b$/);
		await until("the client's error output", () => readFileSync(repoFile("b.out"), "utf8") === "slow failed: b\n");
		await quiet();
		assert.equal(jobMessages(s).length, 2, "each reported once");
	});

	test("images come with the end message", async () => {
		const s = await newSession();
		respond(bash("tool slow --ms 300 --text shot --image > shot.out &"), fauxAssistantMessage("Started."), fauxAssistantMessage("Seen it."));
		await s.prompt("go");
		await until("the end message", settled(s, "Seen it."));
		const report = s.messages.find((m) => m.role === "custom" && m.customType === JOB_MESSAGE_TYPE);
		assert.ok(report?.role === "custom");
		assert.match(textOf(report.content), /exited with code 0 after \d s:\n\nslept: shot\n\[image 1 \(image\/png\) is attached to the message that reports this command's end\]$/);
		assert.deepEqual(imagesOf(report.content).map((c) => c.mimeType), ["image/png"]);
		await until("the client's output", () => /\[image 1 \(image\/png\) is attached/.test(readFileSync(repoFile("shot.out"), "utf8")));
	});

	test("a job waited for and a fast one that ends before the command returns leave nothing", async () => {
		const s = await newSession(FOREGROUND_MS);
		const work = workEvents(s);
		respond(bash("tool slow --ms 300 --text w > w.out & wait; tool slow --ms 10 --text f > f.out & sleep 1.5; cat w.out f.out"), fauxAssistantMessage("Done."));
		await s.prompt("go");
		assert.equal(toolTexts(s)[0], "slept: w\nslept: f\n");
		await quiet();
		assert.equal(leftoversOf(s).size, 0);
		assert.deepEqual(jobMessages(s), []);
		assert.deepEqual(work, []);
	});

	test("killing the client aborts its call, and the message says so once", async () => {
		const s = await newSession();
		respond(bash("tool slow --ms 30000 --text k > k.out 2>&1 &"), fauxAssistantMessage("Started."), fauxAssistantMessage("Killed."));
		await s.prompt("go");
		await until("the call", () => slowCalls.has("k"));
		const [pid] = [...leftoversOf(s).keys()];
		process.kill(pid!, "SIGTERM");
		await until("the end message", () => jobMessages(s).length === 1 && settled(s, "Killed.")());
		assert.equal(slowCalls.get("k")!.signal?.aborted, true);
		assert.match(jobMessages(s)[0]!, new RegExp(`^Your background \`tool slow --ms 30000 --text k\` \\(pid ${pid}, .*\\) was killed after \\d s, so its call was aborted\\.$`));
		await quiet();
		assert.equal(jobMessages(s).length, 1);
		assert.equal(leftoversOf(s).size, 0);
	});

	test("a reload keeps the jobs and their ends reach the reloaded extension; the session's end stops them", async () => {
		const s = await newSession();
		respond(bash("tool slow --ms 1200 --text short > s.out & tool slow --ms 30000 --text long > l.out &"), fauxAssistantMessage("Started."), fauxAssistantMessage("Short ended."));
		await s.prompt("go");
		await until("both calls", () => slowCalls.size === 2);
		const provider = getApiProvider(faux.api);
		await s.reload();
		if (!getApiProvider(faux.api)) registerApiProvider(provider as never);
		await until("the short one's end", () => jobMessages(s).length === 1 && settled(s, "Short ended.")());
		assert.match(jobMessages(s)[0]!, /`tool slow --ms 1200 --text short` .* exited with code 0 after \d s:\n\nslept: short$/);
		const [pid] = [...leftoversOf(s).keys()];
		await s.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await until("the long call aborted", () => slowCalls.get("long")!.signal?.aborted === true, 3000);
		await until("its client gone", () => !alivePid(pid!), 3000);
	});

	test("a tool started in the background from a script's bash (nested) is a job too; without `&` it stays in the foreground", async () => {
		const s = await newSession(FOREGROUND_MS);
		respond(
			fauxAssistantMessage([fauxToolCall("script", { command: "tool slow --ms 200 --text fg; tool slow --ms 600 --text bg > bg.out &" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
			fauxAssistantMessage("Ended."),
		);
		await s.prompt("go");
		assert.match(toolTexts(s)[0]!, /^slept: fg\n\n\nStill running in the background, left by this command \(1 process\):\n- pid \d+: `tool slow --ms 600 --text bg`/);
		assert.equal(slowCalls.get("fg")!.ended, true, "without `&` the call ended within the command");
		await until("the end message", () => jobMessages(s).length === 1 && settled(s, "Ended.")());
		assert.match(jobMessages(s)[0]!, /exited with code 0 after \d s:\n\nslept: bg$/);
	});
});
