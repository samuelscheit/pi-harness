// Harness releases: deploying committed code only, refusing commits that do not load, atomic
// switching, locking, pruning, and sessions reloading into a new release when idle.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { changedBetween, commitToSource, currentLink, currentRelease, type DeployResult, deploy, harnessDir, heldReleases, holdRelease, switchTo } from "../extensions/lib/release.ts";
import { inSource, type ReleaseMarker } from "../extensions/lib/repository.ts";
import release from "../extensions/release/index.ts";

let dir: string;
let source: string;
let agentDir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "release-"));
	source = join(dir, "source");
	agentDir = join(dir, "agent");
	mkdirSync(join(source, "extensions", "a"), { recursive: true });
	mkdirSync(join(source, "vendor", "pi"), { recursive: true });
	writeFileSync(join(source, "extensions", "a", "index.ts"), 'import { value } from "../../lib/value.ts";\nexport default () => value;\n');
	mkdirSync(join(source, "lib"));
	writeFileSync(join(source, "lib", "value.ts"), 'export const value = "one";\n');
	writeFileSync(join(source, "vendor", "pi", "core.txt"), "pi 1\n");
	writeFileSync(join(source, "package.json"), '{ "type": "module" }\n');
	git("init", "-q", "-b", "main");
	commit("first");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function git(...args: string[]): string {
	return execFileSync("git", ["-C", source, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
}
function commit(message: string): string {
	git("add", "-A");
	git("commit", "-qm", message);
	return git("rev-parse", "HEAD");
}
/** Wait until `done` holds (polling), failing after `ms`. */
async function until(done: () => boolean, ms = 15_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!done()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((wait) => setTimeout(wait, 25));
	}
}
const deployMain = (validate?: (root: string) => Promise<void>) => deploy({ source, branch: "main", agentDir, ...(validate ? { validate } : {}) });

describe("deploy", () => {
	test("builds a snapshot of the branch's commit; uncommitted edits stay out; shared parts are links", async () => {
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "uncommitted";\n');
		writeFileSync(join(source, "untracked.txt"), "x");
		const result = await deployMain();
		const head = git("rev-parse", "HEAD");
		assert.deepEqual(result, { status: "deployed", commit: head });
		const root = realpathSync(currentLink(agentDir));
		assert.equal(root, realpathSync(join(harnessDir(agentDir), "releases", head)));
		assert.equal(readFileSync(join(root, "lib", "value.ts"), "utf8"), 'export const value = "one";\n', "the committed content");
		assert.equal(existsSync(join(root, "untracked.txt")), false);
		assert.ok(lstatSync(join(root, "vendor")).isSymbolicLink(), "vendor is the source's, not copied");
		assert.equal(readFileSync(join(root, "vendor", "pi", "core.txt"), "utf8"), "pi 1\n");
		const marker = currentRelease(agentDir)!;
		assert.deepEqual({ commit: marker.commit, source: marker.source, branch: marker.branch, subject: marker.subject }, { commit: head, source, branch: "main", subject: "first" });
		assert.deepEqual(await deployMain(), { status: "current", commit: head });
	});

	test("a commit that does not load is refused once and remembered; the running release stays", async () => {
		const good = (await deployMain()).commit;
		writeFileSync(join(source, "extensions", "a", "index.ts"), 'import { missing } from "../../lib/nope.ts";\nexport default () => missing;\n');
		const bad = commit("broken import");
		const failed = (await deployMain()) as Extract<DeployResult, { status: "failed" }>;
		assert.equal(failed.status, "failed");
		assert.equal(failed.fresh, true);
		assert.match(failed.error, /nope\.ts/);
		assert.match(failed.error, new RegExp(`releases/${bad.slice(0, 9)}/extensions/a/index\\.ts`), "names the release, not the build directory");
		assert.doesNotMatch(failed.error, /releases\/\./);
		assert.equal(currentRelease(agentDir)!.commit, good);
		assert.equal(existsSync(join(harnessDir(agentDir), "releases", bad)), false, "no half-built release left");
		const again = (await deployMain()) as Extract<DeployResult, { status: "failed" }>;
		assert.deepEqual([again.status, again.fresh], ["failed", false]);
		writeFileSync(join(source, "extensions", "a", "index.ts"), 'import { value } from "../../lib/value.ts";\nexport default () => value;\n');
		const fixed = commit("fix");
		assert.deepEqual(await deployMain(), { status: "deployed", commit: fixed, previous: good });
	});

	test("a syntax error or a throwing module also fails the import check", async () => {
		await deployMain();
		writeFileSync(join(source, "lib", "value.ts"), "export const value = ;\n");
		commit("syntax");
		assert.equal((await deployMain()).status, "failed");
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = 1;\nthrow new Error("boom at import");\n');
		commit("throws");
		const thrown = (await deployMain()) as Extract<DeployResult, { status: "failed" }>;
		assert.match(thrown.error, /boom at import/);
	});

	test("only the deployed branch counts; another branch's commits are not deployed", async () => {
		const main = (await deployMain()).commit;
		git("checkout", "-qb", "feature");
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "feature";\n');
		commit("feature work");
		assert.deepEqual(await deployMain(), { status: "current", commit: main });
	});

	/** A pid no process has: a short-lived child that has exited. */
	const deadPid = () => {
		const child = spawnSync(process.execPath, ["-e", ""]);
		return child.pid!;
	};
	const lockDir = () => join(harnessDir(agentDir), ".lock");
	const holdLock = (pid: number, touchedMsAgo = 0) => {
		mkdirSync(lockDir(), { recursive: true });
		writeFileSync(join(lockDir(), "pid"), String(pid));
		const at = new Date(Date.now() - touchedMsAgo);
		utimesSync(lockDir(), at, at);
	};

	test("a lock held by a live process with a fresh heartbeat makes others wait", async () => {
		holdLock(process.pid);
		assert.equal((await deployMain()).status, "busy");
		assert.equal(existsSync(lockDir()), true, "a live holder's lock stays");
	});

	test("a lock whose holder died is taken over at once, also with a fresh heartbeat", async () => {
		holdLock(deadPid());
		assert.equal((await deployMain()).status, "deployed");
		assert.equal(existsSync(lockDir()), false, "released after deploying");
		assert.deepEqual(readdirSync(harnessDir(agentDir)).filter((n) => n.startsWith(".lock")), [], "nothing moved aside is left");
	});

	test("a lock without a heartbeat for 15 s is taken over even if its pid runs (reused or hung)", async () => {
		holdLock(process.pid, 20_000);
		assert.equal((await deployMain()).status, "deployed");
		mkdirSync(lockDir());
		assert.equal((await deployMain(async () => {})).status, "current", "a deployed commit needs no lock");
		rmSync(lockDir(), { recursive: true });
		holdLock(process.pid, 10_000);
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "next";\n');
		commit("next");
		assert.equal((await deployMain()).status, "busy", "10 s without a touch is not yet abandoned");
	});

	test("a lock just created, its pid not yet written, makes others wait", async () => {
		mkdirSync(lockDir(), { recursive: true });
		assert.equal((await deployMain()).status, "busy");
	});

	test("the holder touches the lock while deploying, so a slow deploy is not taken over", async () => {
		const touches: number[] = [];
		const result = await deployMain(async () => {
			const first = statSync(lockDir()).mtimeMs;
			await new Promise((r) => setTimeout(r, 4_500));
			touches.push(first, statSync(lockDir()).mtimeMs);
			assert.equal(readFileSync(join(lockDir(), "pid"), "utf8"), String(process.pid));
		});
		assert.equal(result.status, "deployed");
		assert.ok(touches[1]! > touches[0]!, "touched during the validation");
	});

	test("builds left by dead processes are removed; a live process's build stays", async () => {
		const releases = join(harnessDir(agentDir), "releases");
		const orphan = join(releases, `.${"a".repeat(40)}.${deadPid()}`);
		const running = join(releases, `.${"b".repeat(40)}.${process.ppid}`);
		mkdirSync(orphan, { recursive: true });
		mkdirSync(running, { recursive: true });
		assert.equal((await deployMain()).status, "deployed");
		assert.equal(existsSync(orphan), false);
		assert.equal(existsSync(running), true);
	});

	test("two deploys at once: one deploys, the other waits; one release results", async () => {
		const results = await Promise.all([deployMain(), deployMain()]);
		assert.deepEqual(results.map((r) => r.status).sort(), ["busy", "deployed"]);
		assert.equal(readdirSync(join(harnessDir(agentDir), "releases")).filter((n) => !n.startsWith(".")).length, 1);
		assert.equal((await deployMain()).status, "current");
	});

	test("keeps the current release and the five newest others", async () => {
		const validate = async () => {};
		const commits: string[] = [];
		for (let i = 0; i < 8; i++) {
			writeFileSync(join(source, "lib", "value.ts"), `export const value = ${i};\n`);
			commits.push(commit(`c${i}`));
			await deployMain(validate);
		}
		const kept = readdirSync(join(harnessDir(agentDir), "releases")).sort();
		assert.equal(kept.length, 6);
		assert.ok(kept.includes(commits.at(-1)!));
		assert.ok(!kept.includes(commits[0]!) && !kept.includes(commits[1]!));
		// Going back is switching the link.
		switchTo(agentDir, commits.at(-2)!);
		assert.equal(currentRelease(agentDir)!.commit, commits.at(-2));
	});

	test("a release a live process holds is never pruned; holds of exited processes are dropped", async () => {
		const validate = async () => {};
		const first = (await deployMain(validate)).commit;
		holdRelease(agentDir, first, process.ppid);
		writeFileSync(join(source, "lib", "value.ts"), "export const value = 'second';\n");
		const second = commit("second");
		await deployMain(validate);
		holdRelease(agentDir, second, deadPid());
		for (let i = 0; i < 7; i++) {
			writeFileSync(join(source, "lib", "value.ts"), `export const value = ${i};\n`);
			commit(`c${i}`);
			await deployMain(validate);
		}
		const kept = readdirSync(join(harnessDir(agentDir), "releases"));
		assert.ok(kept.includes(first), "held by a live process: kept although older than the five newest");
		assert.ok(!kept.includes(second), "its holder exited: pruned like any other");
		assert.equal(kept.length, 7, "current, five newest, and the held one");
		assert.deepEqual([...heldReleases(agentDir)], [first]);
		assert.deepEqual(readdirSync(join(harnessDir(agentDir), "in-use")), [String(process.ppid)], "the dead holder's file is gone");
		// The holder reloads into the current release: the old one becomes prunable.
		holdRelease(agentDir, currentRelease(agentDir)!.commit, process.ppid);
		writeFileSync(join(source, "lib", "value.ts"), "export const value = 'last';\n");
		commit("last");
		await deployMain(validate);
		assert.ok(!readdirSync(join(harnessDir(agentDir), "releases")).includes(first));
	});
});

describe("source writes", () => {
	test("paths in a release map to the same paths in the source", () => {
		assert.equal(inSource("/agent/harness/releases/abc/prompt/experiments/x.md", "/agent/harness/releases/abc", "/repo"), "/repo/prompt/experiments/x.md");
	});

	test("commitToSource commits only the given paths and leaves other staged work alone", () => {
		writeFileSync(join(source, "staged.txt"), "someone else's work\n");
		git("add", "staged.txt");
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "stopped";\n');
		const text = commitToSource(source, [join(source, "lib", "value.ts")], "chore(experiments): stop x");
		assert.match(text, /^Committed [0-9a-f]{9} \(chore\(experiments\): stop x\)/);
		assert.equal(git("log", "-1", "--format=%s"), "chore(experiments): stop x");
		assert.deepEqual(git("show", "--name-only", "--format=", "HEAD").split("\n"), ["lib/value.ts"]);
		assert.match(git("status", "--short"), /^A {2}staged\.txt$/m, "still staged, not committed");
		assert.match(commitToSource(source, [join(source, "nope.txt")], "x"), /^Not committed/);
	});
});

describe("release extension", () => {
	type Handler = (event: unknown, ctx: unknown) => unknown;
	const marker = (commit: string): ReleaseMarker => ({ commit, source, branch: "main", subject: "s", deployedAt: "" });

	/** The extension with a fake Pi that counts reload requests. */
	function load(loaded: string, options: { deploy?: () => Promise<DeployResult> } = {}) {
		const handlers = new Map<string, Handler>();
		const notes: [string, string][] = [];
		const restarted: string[] = [];
		const reloads = { requested: 0 };
		const ctx = { ui: { notify: (text: string, level: string) => notes.push([text, level]) } };
		const pi = {
			on: (name: string, handler: Handler) => handlers.set(name, handler),
			requestReload: () => reloads.requested++,
		};
		release(pi as never, {
			agentDir,
			pollMs: 20,
			release: marker(loaded),
			deploy: options.deploy ?? (() => deployMain()),
			ensureDashboard: async () => restarted.push(currentRelease(agentDir)!.commit),
		});
		const start = async (reason = "startup") => {
			await handlers.get("session_start")!({ reason }, ctx);
		};
		return { handlers, reloads, notes, restarted, ctx, start, stop: () => handlers.get("session_shutdown")?.({}, ctx) };
	}
	afterEach(() => {
		delete (globalThis as { __harnessRelease?: unknown }).__harnessRelease;
	});

	test("a session deploys a new commit and requests a reload into it, idle or running; the dashboard follows", async () => {
		const first = (await deployMain()).commit;
		const session = load(first);
		assert.equal(readFileSync(join(harnessDir(agentDir), "in-use", String(process.pid)), "utf8"), first, "loading holds the release");
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "two";\n');
		const second = commit("second");
		await session.start();
		await until(() => session.reloads.requested > 0 && session.restarted.length > 0);
		session.stop();
		assert.equal(currentRelease(agentDir)!.commit, second);
		assert.deepEqual(session.restarted, [second]);
		assert.deepEqual([...session.handlers.keys()].sort(), ["session_shutdown", "session_start"], "no waiting for the run to settle: Pi picks the moment");
	});

	test("an up-to-date session does nothing; a failed commit is reported once", async () => {
		const first = (await deployMain()).commit;
		const session = load(first);
		await session.start();
		await new Promise((wait) => setTimeout(wait, 100));
		assert.equal(session.reloads.requested, 0);
		writeFileSync(join(source, "lib", "value.ts"), "export const value = ;\n");
		const bad = commit("broken");
		await until(() => session.notes.length > 0);
		await new Promise((wait) => setTimeout(wait, 100));
		session.stop();
		assert.equal(session.reloads.requested, 0, "stays on the release that loads");
		assert.equal(session.notes.length, 1);
		assert.match(session.notes[0]![0], new RegExp(`Harness commit ${bad.slice(0, 9)} was not deployed; this session keeps ${first.slice(0, 9)}`));
	});

	test("after a reload it says what changed, and once that Pi itself needs a restart", async () => {
		const first = (await deployMain()).commit;
		const old = load(first);
		await old.start();
		await new Promise((wait) => setTimeout(wait, 100));
		old.stop();
		writeFileSync(join(source, "vendor", "pi", "core.txt"), "pi 2\n");
		const second = commit("new pi");
		await deployMain();
		const reloaded = load(second, { deploy: async () => ({ status: "current", commit: second }) });
		await reloaded.start("reload");
		await until(() => reloaded.notes.length >= 2);
		reloaded.stop();
		const texts = reloaded.notes.map(([text]) => text);
		assert.ok(texts.includes(`Harness reloaded: ${first.slice(0, 9)} → ${second.slice(0, 9)} s`), texts.join("\n"));
		assert.ok(texts.some((text) => /Pi itself \(vendor\/pi\) changed/.test(text)));
		const again = load(second, { deploy: async () => ({ status: "current", commit: second }) });
		await again.start("reload");
		await new Promise((wait) => setTimeout(wait, 100));
		again.stop();
		assert.equal(again.notes.length, 0, "no repeated notices");
	});

	test("changes to Pi itself are found from the commits alone, whatever the working tree holds", async () => {
		const first = git("rev-parse", "HEAD");
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "x";\n');
		const harnessOnly = commit("harness only");
		// A working tree whose vendor/ is a symlink (as in a clone wired to another checkout) must not count as a change.
		rmSync(join(source, "vendor"), { recursive: true });
		mkdirSync(join(dir, "elsewhere"));
		execFileSync("ln", ["-s", join(dir, "elsewhere"), join(source, "vendor")]);
		assert.equal(await changedBetween(source, first, harnessOnly, "vendor/pi"), false);
		rmSync(join(source, "vendor"), { recursive: true, force: true });
		git("checkout", "-q", "HEAD", "--", "vendor");
		writeFileSync(join(source, "vendor", "pi", "core.txt"), "pi 2\n");
		const piChanged = commit("pi");
		assert.equal(await changedBetween(source, harnessOnly, piChanged, "vendor/pi"), true);
		assert.equal(await changedBetween(source, first, piChanged, "nowhere"), false, "absent in both");
	});

	test("running from a repository checkout it does nothing", () => {
		const handlers: string[] = [];
		release({ on: (name: string) => handlers.push(name), requestReload: () => handlers.push("reload") } as never, { agentDir });
		assert.deepEqual(handlers, []);
	});
});
