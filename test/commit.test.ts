// The commit check (extensions/bash/commit.ts): a commit is refused when it would take changes the
// session's edit and write tools did not make. Real git repositories; "another agent" writes files
// directly, the session's changes go through changeStarts/changeEnds as the edit and write tools'
// events do.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { changeEnds, changeStarts, commitRefusal, dropSessionFiles, fileBlob, sessionFiles } from "../extensions/bash/commit.ts";

let repo: string;
let session: string;
let calls = 0;
const files = () => sessionFiles(session);
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
/** A change by this session's edit or write tool. */
const own = (path: string, content: string) => {
	const id = `call-${++calls}`;
	changeStarts(files(), id, join(repo, path));
	writeFileSync(join(repo, path), content);
	changeEnds(files(), id, false);
};
/** A change by another agent. */
const other = (path: string, content: string) => writeFileSync(join(repo, path), content);
const refusal = (command: string, cwd = repo) => commitRefusal(files(), command, cwd);
/** The refused paths and why, from the refusal. */
const refused = (command: string, cwd = repo) => [...(refusal(command, cwd) ?? "").matchAll(/^- `([^`]+)`: (.*)$/gm)].map((m) => `${m[1]}: ${m[2]}`);

beforeEach(() => {
	// tmpdir() is a symlink on macOS (/var → /private/var): the session's paths go through it, git's do not.
	repo = mkdtempSync(join(tmpdir(), "commit-guard-"));
	session = `s-${Math.random()}`;
	git("init", "-q");
	writeFileSync(join(repo, "a.ts"), "a\n");
	writeFileSync(join(repo, "b.ts"), "b\n");
	mkdirSync(join(repo, "sub"));
	writeFileSync(join(repo, "sub", "c.ts"), "c\n");
	git("add", "-A");
	git("commit", "-qm", "init");
});
afterEach(() => {
	dropSessionFiles(session);
	rmSync(repo, { recursive: true, force: true });
});

describe("commits of the session's own changes run", () => {
	test("edits and new files, by --only, pathspecs, -a, a git add in the same command, and the index", () => {
		own("a.ts", "a2\n");
		own("a.ts", "a3\n");
		own("new.ts", "n\n");
		assert.equal(refusal("git commit --only a.ts -m x"), undefined);
		assert.equal(refusal("git commit -m x -- a.ts"), undefined);
		assert.equal(refusal("git commit -am x"), undefined);
		assert.equal(refusal("git add a.ts new.ts && git commit -m x"), undefined);
		assert.equal(refusal("git add -A && git commit -m x"), undefined);
		git("add", "a.ts", "new.ts");
		assert.equal(refusal("git commit -m 'x'"), undefined);
		assert.equal(refusal("git commit --amend --no-edit"), undefined);
	});

	test("other agents' changes in paths the commit does not take do not count", () => {
		own("a.ts", "a2\n");
		other("b.ts", "theirs\n");
		other("untracked.ts", "theirs\n");
		assert.equal(refusal("git commit --only a.ts -m x"), undefined);
		assert.equal(refusal("git add a.ts && git commit -m x"), undefined);
		assert.equal(refusal("git commit -m x"), undefined, "nothing staged");
	});

	test("a plain commit takes the index: a later change in the working tree is not committed", () => {
		own("a.ts", "a2\n");
		git("add", "a.ts");
		other("a.ts", "a2\ntheirs\n");
		assert.equal(refusal("git commit -m x"), undefined);
		assert.deepEqual(refused("git commit -a -m x"), ["a.ts: changed since your last edit (by another agent or a command)"]);
	});

	test("paths resolve from a cd, git -C and a subdirectory", () => {
		own("sub/c.ts", "c2\n");
		other("b.ts", "theirs\n");
		assert.equal(refusal("git commit --only c.ts -m x", join(repo, "sub")), undefined);
		assert.equal(refusal(`cd ${repo}/sub && git commit -m x c.ts`, "/"), undefined);
		assert.equal(refusal(`git -C ${repo} -C sub commit -m x -- c.ts`, "/"), undefined);
		assert.deepEqual(refused(`cd ${repo} && git commit -m x c.ts sub/c.ts b.ts`, "/"), ["b.ts: not changed by your edit or write tools in this session"]);
	});

	test("a commit not in a repository, a dry run and a refused-then-checked commit run", () => {
		other("b.ts", "theirs\n");
		assert.equal(refusal("git commit -am x", tmpdir()), undefined);
		assert.equal(refusal("git commit --dry-run -am x"), undefined);
		assert.equal(refusal("PI_COMMIT_CHECKED=1 git commit -am x"), undefined);
		assert.equal(refusal("env PI_COMMIT_CHECKED=1 git commit -am x"), undefined);
		assert.notEqual(refusal("PI_COMMIT_CHECKED= git commit -am x"), undefined, "an empty value is no confirmation");
	});
});

describe("commits that take changes the session did not make are refused", () => {
	test("(2026-11-14) another agent changes a file after this session's last edit, before its commit", () => {
		own("a.ts", "a2\n");
		appendFileSync(join(repo, "a.ts"), "theirs\n");
		const reason = ["a.ts: changed since your last edit (by another agent or a command)"];
		assert.deepEqual(refused("git commit --only a.ts -m x"), reason);
		assert.deepEqual(refused("git commit -m x a.ts"), reason);
		assert.deepEqual(refused("git commit -am x"), reason);
		assert.deepEqual(refused("git add a.ts && git commit -m x"), reason);
		assert.deepEqual(refused("git add . && git commit -m x"), reason);
		assert.deepEqual(refused("git add -u && git commit -m x"), reason);
	});

	test("another agent's change before this session's first edit, or between two of its edits, stays even when the content is this session's last", () => {
		other("a.ts", "theirs\n");
		own("a.ts", "theirs\nmine\n");
		own("b.ts", "b2\n");
		other("b.ts", "b2\ntheirs\n");
		own("b.ts", "b2\ntheirs\nmine\n");
		assert.deepEqual(refused("git commit -am x"), ["a.ts: had uncommitted changes before your first edit", "b.ts: changed by someone else between your edits"]);
	});

	test("files the session never changed: modified, deleted, staged and untracked ones a git add takes", () => {
		other("a.ts", "theirs\n");
		unlinkSync(join(repo, "b.ts"));
		other("staged.ts", "theirs\n");
		git("add", "staged.ts");
		other("untracked.ts", "theirs\n");
		const why = "not changed by your edit or write tools in this session";
		assert.deepEqual(refused("git commit -m x"), [`staged.ts: ${why}`]);
		assert.deepEqual(refused("git commit -am x").sort(), [`a.ts: ${why}`, `b.ts: ${why}`, `staged.ts: ${why}`]);
		assert.deepEqual(refused("git add untracked.ts; git commit -m x").sort(), [`staged.ts: ${why}`, `untracked.ts: ${why}`]);
		assert.deepEqual(refused("git add -u && git commit -m x").sort(), [`a.ts: ${why}`, `b.ts: ${why}`, `staged.ts: ${why}`], "-u adds no untracked file");
	});

	test("another agent stages its own content of a file this session changed", () => {
		own("a.ts", "a2\n");
		other("a.ts", "theirs\n");
		git("add", "a.ts");
		other("a.ts", "a2\n");
		assert.deepEqual(refused("git commit -m x"), ["a.ts: changed since your last edit (by another agent or a command)"]);
		assert.equal(refusal("git commit --only a.ts -m x"), undefined, "--only takes the working tree, which is the session's");
	});

	test("a commit inside bash -c, behind wrappers and in a chain is checked; quoted text is not a commit", () => {
		other("a.ts", "theirs\n");
		assert.equal(refused("bash -c 'git commit -am x'").length, 1);
		assert.equal(refused("make && nohup git commit -am x").length, 1);
		assert.equal(refusal("echo 'git commit -am x'"), undefined);
	});
});

describe("the record of a file", () => {
	test("a change that starts from HEAD starts a new record: committed, or discarded by its owner", () => {
		other("a.ts", "theirs\n");
		own("a.ts", "theirs\nmine\n");
		assert.equal(refused("git commit -am x").length, 1);
		git("commit", "-qam", "checked");
		own("a.ts", "next\n");
		assert.equal(refusal("git commit -am x"), undefined);
		other("b.ts", "theirs\n");
		own("b.ts", "theirs\nmine\n");
		other("b.ts", "b\n");
		own("b.ts", "b2\n");
		assert.equal(refusal("git commit --only b.ts -m x"), undefined);
	});

	test("parallel changes of the session (both start before either ends) are its own", () => {
		own("a.ts", "a2\n");
		changeStarts(files(), "p1", join(repo, "a.ts"));
		changeStarts(files(), "p2", join(repo, "a.ts"));
		writeFileSync(join(repo, "a.ts"), "a3\n");
		changeEnds(files(), "p1", false);
		writeFileSync(join(repo, "a.ts"), "a4\n");
		changeEnds(files(), "p2", false);
		assert.equal(refusal("git commit -am x"), undefined);
	});

	test("a failed first change records nothing; a failed later one keeps the record; an unknown call is ignored", () => {
		other("a.ts", "theirs\n");
		changeStarts(files(), "f1", join(repo, "a.ts"));
		changeEnds(files(), "f1", true);
		assert.equal(files().files.size, 0);
		changeEnds(files(), "never-started", false);
		own("b.ts", "b2\n");
		changeStarts(files(), "f2", join(repo, "b.ts"));
		changeEnds(files(), "f2", true);
		assert.equal(refusal("git commit --only b.ts -m x"), undefined);
		assert.equal(files().pending.size, 0);
	});

	test("the content is a git blob id; a missing file is null", () => {
		writeFileSync(join(repo, "x"), "hello\n");
		assert.equal(fileBlob(join(repo, "x")), git("hash-object", "x").trim());
		assert.equal(fileBlob(join(repo, "missing")), null);
	});
});

describe("the refusal", () => {
	test("names the command, each path and why, how to check and how to commit after checking", () => {
		own("a.ts", "a2\n");
		other("a.ts", "theirs\n");
		const text = refusal("git commit --only a.ts -m x")!;
		assert.match(text, /^Not run: this command commits changes your edit and write tools did not make:\n- `git commit --only a\.ts -m x`\nPaths:\n- `a\.ts`: changed since your last edit/);
		assert.match(text, /`git diff HEAD -- <path>`/);
		assert.match(text, /run the commit again as `PI_COMMIT_CHECKED=1 git commit …`\.$/);
	});

	test("lists at most 20 paths", () => {
		for (let i = 0; i < 25; i++) other(`f${i}.ts`, "theirs\n");
		const text = refusal("git add -A && git commit -m x")!;
		assert.equal(text.match(/^- `f\d+\.ts`/gm)?.length, 20);
		assert.match(text, /^- … and 5 more$/m);
	});
});
