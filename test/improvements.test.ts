import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { appendNote, backlogPath, formatNote } from "../extensions/improvements/index.ts";
import { repositoryRoot } from "../extensions/lib/repository.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "improvements-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("backlog location", () => {
	test("project notes go to the repository root, also from a subdirectory", () => {
		mkdirSync(join(dir, "repo/.git"), { recursive: true });
		mkdirSync(join(dir, "repo/packages/app/src"), { recursive: true });
		assert.equal(repositoryRoot(join(dir, "repo/packages/app/src")), join(dir, "repo"));
		assert.equal(backlogPath("project", join(dir, "repo/packages/app")), join(dir, "repo/.agents/improvements.md"));
	});

	test("the nearest repository wins when repositories nest", () => {
		mkdirSync(join(dir, "outer/.git"), { recursive: true });
		mkdirSync(join(dir, "outer/vendor/inner/.git"), { recursive: true });
		assert.equal(repositoryRoot(join(dir, "outer/vendor/inner")), join(dir, "outer/vendor/inner"));
	});

	test("outside a repository the working directory is the root", () => {
		mkdirSync(join(dir, "plain/sub"), { recursive: true });
		// tmpdir itself is not inside a repository on any sane machine.
		assert.equal(repositoryRoot(join(dir, "plain/sub")), join(dir, "plain/sub"));
	});

	test("harness notes ignore the working directory", () => {
		mkdirSync(join(dir, "repo/.git"), { recursive: true });
		assert.equal(backlogPath("harness", join(dir, "repo"), "/harness"), "/harness/.agents/improvements.md");
	});
});

describe("backlog entries", () => {
	const at = new Date("2026-11-12T15:41:30Z");

	test("the first note creates the file with a header, later notes append", () => {
		const file = join(dir, "repo/.agents/improvements.md");
		appendNote(file, formatNote({ scope: "project", observation: "first", proposal: "p1" }, at, "s1", "/repo"));
		appendNote(file, formatNote({ scope: "project", observation: "second", proposal: "p2" }, at, "s2", "/repo"));
		const text = readFileSync(file, "utf8");
		assert.equal(text.match(/^# Improvement backlog/gm)?.length, 1);
		assert.equal(text.match(/^## 2026-11-12 15:41 UTC$/gm)?.length, 2);
		assert.ok(text.indexOf("first") < text.indexOf("second"));
		assert.match(text, /- \*\*Session:\*\* s2 \(\/repo\)/);
	});

	test("multi-line text stays inside its entry", () => {
		const entry = formatNote({ scope: "harness", observation: "line one\n## not a heading\nline three", proposal: "  fix it  " }, at, "s", "/x");
		assert.doesNotMatch(entry, /^## not a heading/m);
		assert.match(entry, /^ {2}## not a heading$/m);
		assert.match(entry, /- \*\*Proposal:\*\* fix it\n/);
	});
});
