// A delegated child's own writes (extensions/workflow/own-writes.ts): which files its tool calls
// changed, told apart from files other agents change in the same tree meanwhile.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { namesPath, ownWrites } from "../extensions/workflow/own-writes.ts";

let repo: string;
beforeEach(() => {
	repo = realpathSync(mkdtempSync(join(tmpdir(), "own-writes-")));
	mkdirSync(join(repo, "src", "lib"), { recursive: true });
	mkdirSync(join(repo, "other"));
	for (const file of ["src/a.ts", "src/lib/b.ts", "other/c.ts"]) writeFileSync(join(repo, file), "x\n");
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("namesPath", () => {
	const names = (command: string, file: string, cwd = repo) => namesPath(command, join(repo, file), cwd);

	test("a path as written, relative, with ./, quoted, absolute or after a redirect", () => {
		assert.ok(names("sed -i '' s/x/y/ src/a.ts", "src/a.ts"));
		assert.ok(names("printf y > ./src/a.ts", "src/a.ts"));
		assert.ok(names(`printf y >"src/a.ts"`, "src/a.ts"));
		assert.ok(names(`rm ${repo}/src/a.ts`, "src/a.ts"));
		assert.ok(names("echo y>>src/a.ts&&true", "src/a.ts"));
	});

	test("a directory names the files under it; a file's name names it after a cd", () => {
		assert.ok(names("rm -rf src/lib", "src/lib/b.ts"));
		assert.ok(names("rm -rf src/lib/", "src/lib/b.ts"));
		assert.ok(names(`rm -rf ${repo}/src`, "src/lib/b.ts"));
		assert.ok(names("cd src && sed -i '' s/x/y/ lib/b.ts", "src/lib/b.ts"));
		assert.ok(names("cd src/lib && sed -i '' s/x/y/ b.ts", "src/lib/b.ts"));
		assert.ok(names("printf y > b.ts", "src/lib/b.ts", join(repo, "src", "lib")), "relative to the call's cwd");
	});

	test("globs match the path or its tail", () => {
		assert.ok(names("sed -i '' s/x/y/ src/*.ts", "src/a.ts"));
		assert.ok(names("rm src/**/*.ts", "src/lib/b.ts"));
		assert.ok(names("cd src && rm lib/*.ts", "src/lib/b.ts"));
		assert.ok(!names("rm src/*.js", "src/a.ts"));
		assert.ok(!names("rm other/*.ts", "src/a.ts"));
	});

	test("where a command goes, the working directory and its parents name nothing (2026-11-16: a check run in bash took the parent's files)", () => {
		assert.ok(!names(`cd ${repo} && npm test`, "other/c.ts"));
		assert.ok(!names(`cd "${repo}/src" && npx tsc --noEmit`, "src/a.ts"));
		assert.ok(!names("pushd src && make; popd", "src/a.ts"));
		assert.ok(!names(`git -C ${repo} status`, "other/c.ts"));
		assert.ok(!names(`ls ${join(repo, "..")}`, "other/c.ts"));
		assert.ok(!names("ls / . .. ../..", "other/c.ts"));
		assert.ok(!names("npx tsc -p .", "src/a.ts"));
	});

	test("unrelated words and look-alike names do not match", () => {
		assert.ok(!names("npm test -- parse.test.ts", "src/a.ts"));
		assert.ok(!names("cat src/a.tsx", "src/a.ts"));
		assert.ok(!names("cat a", "src/a.ts"), "a word that only starts the name");
		assert.ok(!names("cat rc/a.ts", "src/a.ts"), "a tail that is no whole path segment");
		assert.ok(!names("rm -rf sr", "src/a.ts"));
	});
});

describe("ownWrites", () => {
	test("edit and write: the path they name when they succeed, resolved from the cwd; a failed call wrote nothing", async () => {
		const writes = ownWrites();
		await writes.started("1", "write", { path: "src/a.ts", content: "y" }, repo);
		await writes.started("2", "edit", { path: join(repo, "other", "c.ts"), edits: [] }, repo);
		await writes.started("3", "edit", { path: "lib/b.ts", edits: [] }, join(repo, "src"));
		await writes.started("4", "read", { path: "src/a.ts" }, repo);
		assert.deepEqual(await writes.ended("1", false), [join(repo, "src", "a.ts")]);
		assert.deepEqual(await writes.ended("2", true), []);
		assert.deepEqual(await writes.ended("3", false), [join(repo, "src", "lib", "b.ts")]);
		assert.deepEqual(await writes.ended("4", false), [], "a read writes nothing");
		assert.deepEqual(await writes.ended("unknown", false), []);
		assert.deepEqual(await writes.ended("1", false), [], "each call ends once");
	});

	test("bash: the files it changed and names, not those someone else changed during it, nor those it changed without naming", async () => {
		const writes = ownWrites();
		writeFileSync(join(repo, "gen.sh"), "printf gen > other/generated.ts\n");
		await writes.started("b", "bash", { command: "printf y > src/a.ts && sleep 0.4 && sh gen.sh" }, repo);
		const command = new Promise<void>((done) => spawn("bash", ["-c", "printf y > src/a.ts && sleep 0.4 && sh gen.sh"], { cwd: repo }).on("exit", () => done()));
		// The parent edits a file while the command runs.
		await new Promise((r) => setTimeout(r, 100));
		writeFileSync(join(repo, "other", "c.ts"), "parent\n");
		await command;
		assert.deepEqual(await writes.ended("b", false), [join(repo, "src", "a.ts")]);
	});

	test("bash: a failing command's writes count; deleting a file and undoing an earlier change count", async () => {
		writeFileSync(join(repo, "src", "a.ts"), "changed before\n");
		const writes = ownWrites();
		await writes.started("b", "bash", { command: "git checkout -- src/a.ts && rm src/lib/b.ts && false" }, repo);
		execFileSync("bash", ["-c", "git checkout -- src/a.ts && rm src/lib/b.ts; true"], { cwd: repo });
		assert.deepEqual(await writes.ended("b", true), [join(repo, "src", "a.ts"), join(repo, "src", "lib", "b.ts")]);
	});

	test("bash outside a git repository: nothing can be told, nothing is counted", async () => {
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "own-writes-nogit-")));
		try {
			const writes = ownWrites();
			await writes.started("b", "bash", { command: "printf y > f.txt" }, outside);
			writeFileSync(join(outside, "f.txt"), "y");
			assert.deepEqual(await writes.ended("b", false), []);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
