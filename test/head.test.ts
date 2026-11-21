// Refusal of a push or commit that ignores where HEAD is (extensions/bash/head.ts).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { headRefusal, headState } from "../extensions/bash/head.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();

let root: string;
let onMain: string;
let onFeature: string;
let detached: string;
let rebasing: string;
let plain: string;

const repo = (name: string) => {
	const dir = join(root, name);
	mkdirSync(dir);
	git(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "a"), "1");
	git(dir, "add", "a");
	git(dir, "commit", "-q", "-m", "one");
	return dir;
};

before(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "head-test-")));
	onMain = repo("onmain");
	onFeature = repo("onfeature");
	git(onFeature, "switch", "-q", "-c", "feature");
	detached = repo("detached");
	git(detached, "checkout", "-q", "--detach");
	rebasing = repo("rebasing");
	git(rebasing, "checkout", "-q", "--detach");
	mkdirSync(join(git(rebasing, "rev-parse", "--absolute-git-dir"), "rebase-merge"));
	plain = join(root, "plain");
	mkdirSync(plain);
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("head state", () => {
	test("branch, detached, busy, no repository", () => {
		assert.deepEqual(headState(onMain), { branch: "main", busy: false });
		assert.deepEqual(headState(onFeature), { branch: "feature", busy: false });
		assert.deepEqual(headState(detached), { branch: null, busy: false });
		assert.deepEqual(headState(rebasing), { branch: null, busy: true });
		assert.equal(headState(plain), undefined);
	});
});

const pushNote = /^Not run: this command pushes a local branch that is not what HEAD points to:/;

describe("refused: push of a branch HEAD is not on", () => {
	for (const [command, cwd, dirText] of [
		["git push origin main", detached, "HEAD is detached"],
		["git push origin main", onFeature, "HEAD is on `feature`"],
		["git push -u origin main", detached, "HEAD is detached"],
		["git push --force-with-lease origin main", detached, "HEAD is detached"],
		["git push origin +main", detached, "HEAD is detached"],
		["git push origin main:main", detached, "HEAD is detached"],
		["git push origin main:release", detached, "HEAD is detached"],
		["git push -o ci.skip origin main", detached, "HEAD is detached"],
		["git push origin main && echo done", detached, "HEAD is detached"],
		["env X=1 git push origin main", detached, "HEAD is detached"],
		["bash -c 'git push origin main'", detached, "HEAD is detached"],
		["git push origin feature main", onFeature, "HEAD is on `feature`"],
		["for r in origin up; do git push $r main; done", detached, "HEAD is detached"],
	] as const) {
		test(`${command} in ${cwd.split("/").pop()}`, () => {
			const text = headRefusal(command, cwd)!;
			assert.match(text, pushNote);
			assert.ok(text.includes(dirText), text);
			assert.match(text, /git push <remote> HEAD:<branch>/);
		});
	}

	test("git -C and a preceding cd pick the repository", () => {
		assert.match(headRefusal(`git -C ${detached} push origin main`, plain)!, pushNote);
		assert.match(headRefusal(`cd ${detached} && git push origin main`, plain)!, pushNote);
		assert.match(headRefusal(`cd ${detached} && git -C ../onmain push origin main && git push origin main`, plain)!, pushNote);
		assert.equal(headRefusal(`git -C ${onMain} push origin main`, detached), undefined);
		assert.equal(headRefusal(`cd ${onMain} && git push origin main`, detached), undefined);
		assert.equal(headRefusal(`cd ${detached} && cd ../onmain && git push origin main`, plain), undefined);
	});
});

describe("allowed pushes", () => {
	for (const [command, cwd] of [
		["git push origin HEAD:main", detached],
		["git push origin HEAD:refs/heads/main", detached],
		["git push origin HEAD", detached],
		["git push", detached],
		["git push origin", detached],
		["git push origin main", onMain],
		["git push origin main:main", onMain],
		["git push -u origin feature", onFeature],
		["git push origin refs/heads/main", detached],
		["git push origin :old-branch", detached],
		["git push --delete origin main", detached],
		["git push origin v1.0", detached],
		["git push origin nonexistent-branch", detached],
		["git push origin --tags", detached],
		["git push --all origin", detached],
		["git push -n origin main", detached],
		["git push --dry-run origin main", detached],
		// Not a repository: nothing to check.
		["git push origin main", plain],
		// State unknown after a command that moves HEAD.
		["git switch main && git push origin main", detached],
		["git checkout main; git push origin main", detached],
		["git merge feature && git push origin main", detached],
		// Non-literal directories are not guessed.
		['cd "$DIR" && git push origin main', detached],
		// Text, not commands.
		['echo "git push origin main"', detached],
		["grep 'git push origin main' notes", detached],
		["git commit -m 'git push origin main is wrong' --dry-run", detached],
		["cat <<'EOF'\ngit push origin main\nEOF", detached],
		["# git push origin main", detached],
	] as const) {
		test(`${command} in ${cwd.split("/").pop()}`, () => assert.equal(headRefusal(command, cwd), undefined));
	}
});

describe("commit on a detached HEAD", () => {
	const commitNote = /^Not run: this command commits on a detached HEAD:/;
	for (const command of ["git commit -m x", "git commit -am x", "git commit --amend --no-edit", "git add a && git commit -m x", "git -C . commit -m x", "nohup git commit -m x", "git commit -F - <<'EOF'\nmsg\nEOF"]) {
		test(`refused: ${command}`, () => {
			const text = headRefusal(command, detached)!;
			assert.match(text, commitNote);
			assert.match(text, /PI_DETACHED_COMMIT=1 git commit/);
		});
	}
	for (const [command, cwd] of [
		["PI_DETACHED_COMMIT=1 git commit -m x", detached],
		["env PI_DETACHED_COMMIT=1 git commit -m x", detached],
		["git commit --dry-run", detached],
		["git commit -m x", onMain],
		["git commit -m x", onFeature],
		["git commit -m x", rebasing],
		["git commit -m x", plain],
		["git switch main && git commit -m x", detached],
		["git switch -c work && git commit -m x", detached],
		['echo "git commit -m x"', detached],
		["git log --oneline", detached],
		["git status", detached],
	] as const) {
		test(`allowed: ${command} in ${cwd.split("/").pop()}`, () => assert.equal(headRefusal(command, cwd), undefined));
	}
	test("both a push and a commit are reported", () => {
		const text = headRefusal("git commit -m x && git push origin main", detached)!;
		assert.match(text, /commits on a detached HEAD/);
		assert.match(text, /pushes a local branch/);
	});
	test("-C into a detached repository from elsewhere", () => {
		assert.match(headRefusal(`git -C ${detached} commit -m x`, onMain)!, commitNote);
		assert.equal(headRefusal(`git -C ${onMain} commit -m x`, detached), undefined);
	});
});
