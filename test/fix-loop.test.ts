// fix_loop against a real git repository and a real child session on a faux model: the check
// decides, changes outside the allowed files are refused or put back, abort stops it, and the
// child is stored as its own session naming the parent.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type FixLoopDetails, type FixLoopParams, runFixLoop } from "../extensions/fix-loop/loop.ts";
import { changedPaths, diffSince, isAllowed, restore, snapshot } from "../extensions/fix-loop/workspace.ts";
import { runShell } from "../extensions/lib/process.ts";

let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
let dir: string;
let repo: string;

before(async () => {
	faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	const scratch = mkdtempSync(join(tmpdir(), "fix-loop-runtime-"));
	runtime = await ModelRuntime.create({ authPath: join(scratch, "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "faux-1", name: "Faux", api: faux.api, reasoning: false, input: ["text"], cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, contextWindow: 200_000, maxTokens: 8000 }],
	});
});
after(() => faux.unregister());

/** The repository as git names it (symlinks resolved). */
const real = () => realpathSync(repo);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
const BROKEN = "export const add = (a, b) => a - b;\n";
const FIXED = "export const add = (a, b) => a + b;\n";
const CHECK = "node check.mjs";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fix-loop-"));
	// Under a symlinked temp dir on macOS (/var → /private/var): paths must compare canonically.
	repo = join(dir, "repo");
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "calc.mjs"), BROKEN);
	writeFileSync(join(repo, "check.mjs"), 'import { add } from "./src/calc.mjs";\nif (add(2, 3) !== 5) { console.error(`add(2, 3) = ${add(2, 3)}, expected 5`); process.exit(1); }\nconsole.log("ok");\n');
	writeFileSync(join(repo, "README.md"), "committed\n");
	git("init", "-q");
	git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const params = (extra: Partial<FixLoopParams> = {}): FixLoopParams => ({ goal: "make add() add", files: ["src/calc.mjs"], check: CHECK, model: "faux/faux-1", ...extra });
const env = (extra: { signal?: AbortSignal; updates?: FixLoopDetails[] } = {}) => ({
	cwd: repo,
	modelRuntime: runtime,
	agentDir: join(dir, "agent"),
	sessionDir: join(dir, "sessions"),
	parentSessionFile: join(dir, "sessions", "2026-11-13T10-00-00-000Z_parent-1.jsonl"),
	signal: extra.signal,
	onUpdate: (d: FixLoopDetails) => extra.updates?.push(d),
});
const write = (path: string, content: string) => fauxAssistantMessage([fauxToolCall("write", { path, content })], { stopReason: "toolUse" });
const bash = (command: string) => fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(text);
const respond = (...steps: FauxResponseStep[]) => faux.setResponses(steps);

describe("fix_loop", () => {
	test("green after one round: diff, child session with parent, cost, progress", async () => {
		respond(write("src/calc.mjs", FIXED), say("Changed - to +."));
		const updates: FixLoopDetails[] = [];
		const { text, details } = await runFixLoop(params(), env({ updates }));
		assert.equal(details.ok, true);
		assert.equal(details.rounds, 1);
		assert.equal(details.initialExit, 1);
		assert.equal(details.finalExit, 0);
		assert.deepEqual(details.changedFiles, [join(real(), "src", "calc.mjs")]);
		assert.deepEqual(details.reverted, []);
		assert.match(text, /^fix_loop: green after 1 round\./);
		assert.match(text, /-export const add = \(a, b\) => a - b;\n\+export const add = \(a, b\) => a \+ b;/);
		assert.match(text, /Child's summary: Changed - to \+\./);
		assert.doesNotMatch(text, /Last check output/);
		// Cost and tokens are the sums over the child's requests as its session file records them.
		const recorded = readFileSync(details.childSessionFile!, "utf8").trim().split("\n").map((l) => JSON.parse(l))
			.filter((e) => e.type === "message" && e.message.role === "assistant").map((e) => e.message.usage);
		assert.equal(recorded.length, 2);
		assert.equal(details.tokens.output, recorded.reduce((sum, u) => sum + u.output, 0));
		assert.ok(details.tokens.output > 0);
		assert.equal(details.cost, recorded.reduce((sum, u) => sum + u.cost.total, 0));
		assert.equal(readFileSync(details.diffFile!, "utf8").includes("+export const add = (a, b) => a + b;"), true);
		// The child is a session file of its own that names the parent.
		const header = JSON.parse(readFileSync(details.childSessionFile!, "utf8").split("\n")[0]!);
		assert.equal(header.id, details.childSession);
		assert.equal(header.parentSession, env().parentSessionFile);
		assert.ok(updates.some((u) => u.log.some((line) => line.includes("write src/calc.mjs"))), "progress names the child's calls");
		assert.ok(updates.some((u) => u.log.some((line) => line.includes("running the check"))));
	});

	test("check already green: no child, nothing changed", async () => {
		writeFileSync(join(repo, "src", "calc.mjs"), FIXED);
		const { text, details } = await runFixLoop(params(), env());
		assert.equal(details.ok, true);
		assert.equal(details.rounds, 0);
		assert.equal(details.childSession, undefined);
		assert.match(text, /already passes/);
		assert.equal(existsSync(join(dir, "sessions")), false);
	});

	test("never green: stops after maxRounds with the last failure", async () => {
		const before = faux.state.callCount;
		respond(say("I could not find it."), say("Still no idea."), say("unused"));
		const { text, details } = await runFixLoop(params({ maxRounds: 2 }), env());
		assert.equal(details.ok, false);
		assert.equal(details.rounds, 2);
		assert.equal(faux.state.callCount - before, 2, "one model call per round here");
		assert.match(text, /^fix_loop: not green after 2 rounds \(exit 1\)\./);
		assert.match(text, /Last check output:\n```\nadd\(2, 3\) = -1, expected 5\n```/);
		assert.match(text, /No files changed\./);
	});

	test("the second round gets the new failure; the loop ends when the check passes", async () => {
		const seen: string[] = [];
		respond(
			write("src/calc.mjs", "export const add = (a, b) => a * b;\n"),
			say("Tried *."),
			(context) => {
				seen.push(JSON.stringify(context.messages.at(-1)));
				return write("src/calc.mjs", FIXED);
			},
			say("Now +."),
		);
		const { details } = await runFixLoop(params(), env());
		assert.equal(details.ok, true);
		assert.equal(details.rounds, 2);
		assert.match(seen[0]!, /still fails \(exit 1, round 1 of 6\)/);
		assert.match(seen[0]!, /add\(2, 3\) = 6, expected 5/);
	});

	test("changes outside the files: write is refused, shell changes are put back, and the check decides afterwards", async () => {
		// An uncommitted change the user had before the loop must survive.
		writeFileSync(join(repo, "README.md"), "user's uncommitted edit\n");
		const seen: string[] = [];
		respond(
			write("check.mjs", "process.exit(0)\n"),
			bash("echo 'process.exit(0)' > check.mjs && echo junk > new.txt && echo clobbered > README.md"),
			say("The check passes now."),
			(context) => {
				seen.push(JSON.stringify(context.messages.at(-1)));
				return say("Giving up.");
			},
		);
		const { text, details } = await runFixLoop(params({ maxRounds: 2 }), env());
		assert.equal(details.ok, false, "the cheat was reverted before the check");
		assert.deepEqual(details.reverted.sort(), [join(real(), "README.md"), join(real(), "check.mjs"), join(real(), "new.txt")]);
		assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "user's uncommitted edit\n");
		assert.match(readFileSync(join(repo, "check.mjs"), "utf8"), /expected 5/);
		assert.equal(existsSync(join(repo, "new.txt")), false);
		assert.match(seen[0]!, /Your changes to README\.md, check\.mjs, new\.txt were reverted: change only src\/calc\.mjs/);
		assert.match(text, /Reverted changes outside the allowed files: README\.md, check\.mjs, new\.txt\./);
		assert.deepEqual(details.changedFiles, [], "nothing kept");
		// The refused write never reached the disk; the child saw the refusal.
		const child = readFileSync(details.childSessionFile!, "utf8");
		assert.match(child, /check\.mjs is not one of the files you may change: src\/calc\.mjs/);
	});

	test("directories in files allow everything below them, also new files", async () => {
		respond(write("src/helper.mjs", "export const x = 1;\n"), write("src/calc.mjs", FIXED), say("done"));
		const { details } = await runFixLoop(params({ files: ["src"] }), env());
		assert.equal(details.ok, true);
		assert.deepEqual(details.changedFiles, [join(real(), "src", "calc.mjs"), join(real(), "src", "helper.mjs")]);
	});

	test("abort during a round stops the child, still reverts, and reports aborted", async () => {
		const controller = new AbortController();
		respond(bash("echo cheat > README.md"), () => {
			controller.abort();
			return say("…");
		});
		const { text, details } = await runFixLoop(params(), env({ signal: controller.signal }));
		assert.equal(details.aborted, true);
		assert.equal(details.ok, false);
		assert.equal(details.rounds, 1);
		assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "committed\n");
		assert.match(text, /^fix_loop: aborted in round 1\./);
	});

	test("abort during the first check ends at once without a child", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const started = Date.now();
		const { text, details } = await runFixLoop(params({ check: "sleep 10" }), env({ signal: controller.signal }));
		assert.ok(Date.now() - started < 5000);
		assert.equal(details.aborted, true);
		assert.equal(details.childSession, undefined);
		assert.match(text, /Aborted while running the check/);
	});

	test("invalid input fails before any work", async () => {
		const outside = mkdtempSync(join(tmpdir(), "no-git-"));
		await assert.rejects(runFixLoop(params(), { ...env(), cwd: outside }), /needs a git repository/);
		rmSync(outside, { recursive: true, force: true });
		await assert.rejects(runFixLoop(params({ files: [] }), env()), /at least one file/);
		await assert.rejects(runFixLoop(params({ model: "faux/none" }), env()), /unknown model faux\/none/);
		await assert.rejects(runFixLoop(params({ model: "no-slash" }), env()), /provider\/id/);
	});

	test("without a parent session file the child stays in memory", async () => {
		respond(write("src/calc.mjs", FIXED), say("done"));
		const { details } = await runFixLoop(params(), { ...env(), sessionDir: undefined, parentSessionFile: undefined });
		assert.equal(details.ok, true);
		assert.equal(details.childSessionFile, undefined);
		assert.ok(details.childSession);
	});
});

describe("workspace", () => {
	test("finds changes to tracked, untracked, deleted and renamed files; restores each", async () => {
		writeFileSync(join(repo, "dirty.txt"), "untracked before\n");
		const before = await snapshot(repo);
		writeFileSync(join(repo, "README.md"), "changed\n");
		rmSync(join(repo, "check.mjs"));
		writeFileSync(join(repo, "dirty.txt"), "changed again\n");
		writeFileSync(join(repo, "brand new.txt"), "new\n");
		git("mv", "src/calc.mjs", "src/moved.mjs");
		const changed = await changedPaths(before, await snapshot(repo));
		assert.deepEqual(changed, ["README.md", "brand new.txt", "check.mjs", "dirty.txt", "src/calc.mjs", "src/moved.mjs"].map((p) => join(repo, p)));
		const diff = await diffSince(before, changed);
		assert.match(diff, /--- a\/README\.md\n\+\+\+ b\/README\.md/);
		assert.match(diff, /--- \/dev\/null\n\+\+\+ b\/brand new\.txt/);
		assert.match(diff, /--- a\/check\.mjs\n\+\+\+ \/dev\/null/);
		assert.deepEqual(await restore(before, changed), []);
		assert.deepEqual(await changedPaths(before, await snapshot(repo)), [], "all back (the staged rename stays staged)");
		assert.equal(readFileSync(join(repo, "dirty.txt"), "utf8"), "untracked before\n");
		assert.equal(readdirSync(join(repo, "src")).join(), "calc.mjs");
	});

	test("an uncommitted change undone back to HEAD counts as a change", async () => {
		writeFileSync(join(repo, "README.md"), "uncommitted\n");
		const before = await snapshot(repo);
		git("checkout", "--", "README.md");
		assert.deepEqual(await changedPaths(before, await snapshot(repo)), [join(repo, "README.md")]);
	});

	test("allowed paths: exact files and everything below directories, not prefixes of names", () => {
		const allowed = ["/r/src", "/r/a.ts"];
		assert.equal(isAllowed("/r/src/x/y.ts", allowed), true);
		assert.equal(isAllowed("/r/a.ts", allowed), true);
		assert.equal(isAllowed("/r/srcx/y.ts", allowed), false);
		assert.equal(isAllowed("/r/a.tsx", allowed), false);
	});

	test("runShell reports exit codes, timeouts and kills the whole process group", async () => {
		assert.deepEqual(await runShell("echo out; echo err >&2; exit 3", { cwd: repo }), { exitCode: 3, output: "out\nerr\n", timedOut: false, aborted: false });
		const started = Date.now();
		const slow = await runShell("sleep 20 & sleep 20; wait", { cwd: repo, timeoutMs: 200 });
		assert.equal(slow.timedOut, true);
		assert.equal(slow.exitCode, null);
		assert.ok(Date.now() - started < 5000, "the background sleep did not hold it open");
		const aborted = new AbortController();
		aborted.abort();
		assert.equal((await runShell("echo x", { cwd: repo, signal: aborted.signal })).aborted, true);
	});
});
