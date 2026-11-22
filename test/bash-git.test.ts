// Git in the bash tool's shells runs without fsmonitor (extensions/bash/git-env.ts), and a killed
// call's stale index.lock is removed (extensions/bash/locks.ts). Through the tool: test/bash.test.ts.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { withGitConfig } from "../extensions/bash/git-env.ts";
import { isHeld, locksText, removeStaleLocks, wasKilled, workDirs } from "../extensions/bash/locks.ts";

const ENV: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
for (const key of Object.keys(ENV)) if (/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_|PARAMETERS)/.test(key)) delete ENV[key];
const git = (dir: string, args: string[], env: NodeJS.ProcessEnv = ENV) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env }).trim();

let root: string;
let repo: string;
let worktree: string;
before(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "bash-git-")));
	repo = join(root, "repo");
	worktree = join(root, "wt");
	mkdirSync(repo);
	git(repo, ["init", "-q"]);
	writeFileSync(join(repo, "a"), "a\n");
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-qm", "init"]);
	git(repo, ["worktree", "add", "-q", worktree, "-b", "wt"]);
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("withGitConfig", () => {
	test("without a count: core.fsmonitor=false as entry 0; the input is not changed", () => {
		const env = { PATH: "/bin" };
		assert.deepEqual(withGitConfig(env), { PATH: "/bin", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false" });
		assert.deepEqual(env, { PATH: "/bin" });
	});

	test("appended after the user's entries, which stay", () => {
		const env = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "u", GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "true" };
		assert.deepEqual(withGitConfig(env), { ...env, GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_2: "core.fsmonitor", GIT_CONFIG_VALUE_2: "false" });
	});

	test("an empty or padded count is read as git reads it; several entries; applied twice it appends twice", () => {
		assert.equal(withGitConfig({ GIT_CONFIG_COUNT: "" }).GIT_CONFIG_COUNT, "1");
		assert.deepEqual(withGitConfig({ GIT_CONFIG_COUNT: " 1 " }, [["a.b", "1"], ["c.d", "2"]]), { GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_1: "a.b", GIT_CONFIG_VALUE_1: "1", GIT_CONFIG_KEY_2: "c.d", GIT_CONFIG_VALUE_2: "2" });
		assert.equal(withGitConfig(withGitConfig({})).GIT_CONFIG_COUNT, "2");
	});

	test("a bogus count is left as it is (git refuses it either way)", () => {
		for (const count of ["x", "-1", "1.5"]) {
			const env = { GIT_CONFIG_COUNT: count };
			assert.equal(withGitConfig(env), env, count);
		}
	});

	test("git honours it: over the repository's core.fsmonitor=true and the user's own entry; the user's other entries apply; an explicit `git -c` still wins", () => {
		git(repo, ["config", "core.fsmonitor", "true"]);
		try {
			const env = withGitConfig({ ...ENV, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "true", GIT_CONFIG_KEY_1: "user.name", GIT_CONFIG_VALUE_1: "from-user" });
			assert.equal(git(repo, ["config", "--get", "core.fsmonitor"], env), "false");
			assert.equal(git(repo, ["config", "--get", "user.name"], env), "from-user");
			assert.equal(git(repo, ["-c", "core.fsmonitor=true", "config", "--get", "core.fsmonitor"], env), "true");
		} finally {
			git(repo, ["config", "--unset", "core.fsmonitor"]);
		}
	});
});

describe("wasKilled", () => {
	test("a timeout or an abort, by the tool's status line or the signal; other failures are not", () => {
		const aborted = new AbortController();
		aborted.abort();
		assert.equal(wasKilled(new Error("out\n\nCommand timed out after 30 seconds"), undefined), true);
		assert.equal(wasKilled(new Error("Command timed out after 1 seconds. The shell exited with code 0 after 1 seconds, but background processes it started kept writing output until the timeout."), undefined), true);
		assert.equal(wasKilled(new Error("out\n\nCommand aborted"), undefined), true);
		assert.equal(wasKilled(new Error("anything"), aborted.signal), true);
		assert.equal(wasKilled(new Error("out\n\nCommand exited with code 1"), new AbortController().signal), false);
		assert.equal(wasKilled(new Error("Command aborted\n\nCommand exited with code 1"), undefined), false, "only the final status line counts");
		assert.equal(wasKilled("Command aborted", undefined), false);
	});
});

describe("workDirs", () => {
	test("the cwd, literal `cd` targets (relative to the cds before) and `git -C` targets; `~` expands", () => {
		assert.deepEqual(workDirs("echo hi", "/w"), ["/w"]);
		assert.deepEqual(workDirs("cd a && git commit -m x; cd ../b; git -C c status; git -C /abs -C d log", "/w"), ["/w", "/w/a", "/w/b", "/w/b/c", "/abs/d"]);
		assert.deepEqual(workDirs("cd ~/x", "/w"), ["/w", join(homedir(), "x")]);
		assert.deepEqual(workDirs("bash -c 'cd /s && git status'", "/w"), ["/w", "/s"]);
	});

	test("after a `cd` that cannot be resolved, only absolute targets count", () => {
		assert.deepEqual(workDirs('cd "$X" && git -C rel status && git -C /abs status && cd sub && cd /back && cd on', "/w"), ["/w", "/abs", "/back", "/back/on"]);
		assert.deepEqual(workDirs("cd && git -C $D status", "/w"), ["/w"]);
	});
});

describe("removeStaleLocks", () => {
	const lockOf = (dir: string) => join(git(dir, ["rev-parse", "--absolute-git-dir"]), "index.lock");
	const free = async () => false;

	test("the lock the call made is removed, in a worktree's own git dir too; dirs of one repo count once; dirs outside a repository and missing ones are skipped", async () => {
		const since = Date.now() - 1000;
		const [main, wt] = [lockOf(repo), lockOf(worktree)];
		assert.equal(wt, join(repo, ".git", "worktrees", "wt", "index.lock"));
		writeFileSync(main, "");
		writeFileSync(wt, "");
		const outside = mkdtempSync(join(tmpdir(), "no-repo-"));
		try {
			assert.deepEqual(await removeStaleLocks([repo, join(repo, ".git"), worktree, outside, join(root, "missing")], since, free), [main, wt]);
			assert.ok(!existsSync(main) && !existsSync(wt));
			assert.deepEqual(await removeStaleLocks([repo], since, free), [], "nothing left to remove");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("a lock older than the call stays", async () => {
		const lock = lockOf(repo);
		writeFileSync(lock, "");
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);
		try {
			assert.deepEqual(await removeStaleLocks([repo], Date.now() - 1000, free), []);
			assert.ok(existsSync(lock));
		} finally {
			rmSync(lock, { force: true });
		}
	});

	test("a lock a process holds open stays (lsof); once it closes, it is removed", async () => {
		const lock = lockOf(repo);
		const since = Date.now() - 1000;
		const holder = spawn("sh", ["-c", 'exec 3>>"$1"; echo ready; exec sleep 60', "sh", lock], { stdio: ["ignore", "pipe", "ignore"] });
		try {
			await new Promise((ready) => holder.stdout.once("data", ready));
			assert.equal(await isHeld(lock), true);
			assert.deepEqual(await removeStaleLocks([repo], since), []);
			assert.ok(existsSync(lock));
		} finally {
			holder.kill("SIGKILL");
			await new Promise((ended) => holder.once("exit", ended));
		}
		assert.equal(await isHeld(lock), false);
		assert.deepEqual(await removeStaleLocks([repo], since), [lock]);
		assert.equal(await isHeld(lock), false, "a missing file is held by no one");
	});

	test("the note names each removal", () => {
		assert.match(locksText(["/r/.git/index.lock"]), /^Removed the git index lock this killed command's git left behind .*:\n- `\/r\/\.git\/index\.lock`$/);
		assert.match(locksText(["/a", "/b"]), /^Removed the git index locks .*\n- `\/a`\n- `\/b`$/);
	});
});
