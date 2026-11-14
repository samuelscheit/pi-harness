import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { appendNote, backlogPath, formatNote, readNotes, takeNotes } from "../extensions/improvements/index.ts";
import { repositoryRoot } from "../extensions/lib/repository.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "improvements-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("reading and taking notes", () => {
	const note = (observation: string, at: string) => formatNote({ scope: "project", observation, proposal: "p" }, new Date(at), "s", "/w");

	test("readNotes parses every note of every backlog with its full body; missing and empty backlogs have none", () => {
		const a = join(dir, "a.md");
		const b = join(dir, "b.md");
		appendNote(a, note("one\nsecond line", "2026-11-12T16:47:00Z"));
		appendNote(a, note("two ## not a heading", "2026-11-12T21:57:00Z"));
		appendNote(b, note("three", "2026-11-13T01:00:00Z"));
		writeFileSync(join(dir, "empty.md"), "# Improvement backlog\n");
		const notes = readNotes([a, join(dir, "missing.md"), join(dir, "empty.md"), b]);
		assert.deepEqual(notes.map((n) => [n.backlog, n.at]), [[a, "2026-11-12 16:47"], [a, "2026-11-12 21:57"], [b, "2026-11-13 01:00"]]);
		assert.equal(notes[0]!.body, "- **Session:** s (/w)\n- **Observation:** one\n  second line\n- **Proposal:** p");
		assert.match(readFileSync(a, "utf8"), /one/, "reading changes nothing");
	});

	test("takeNotes empties the backlogs to their header; a note appended afterwards is the only one left", () => {
		const a = join(dir, "a.md");
		appendNote(a, note("one", "2026-11-12T16:47:00Z"));
		assert.deepEqual(takeNotes([a, join(dir, "missing.md")]).map((n) => n.at), ["2026-11-12 16:47"]);
		assert.deepEqual(readNotes([a]), []);
		assert.match(readFileSync(a, "utf8"), /^# Improvement backlog\n/);
		appendNote(a, note("later", "2026-11-14T08:00:00Z"));
		assert.deepEqual(readNotes([a]).map((n) => n.at), ["2026-11-14 08:00"]);
		assert.deepEqual(takeNotes([a]).map((n) => n.at), ["2026-11-14 08:00"]);
		assert.deepEqual(takeNotes([a]), [], "nothing left: the file stays as it is");
	});
});

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
