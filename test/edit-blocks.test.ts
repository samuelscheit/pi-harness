// `tool edit -` (extensions/bash/edit-blocks.ts): the SEARCH/REPLACE format, and applying it
// through Pi's real edit tool with the check of every file before any is written.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { createEditTool } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { conflictLines, EditBlocksError, editOf, parseEditBlocks, pathOf, runEditBlocks } from "../extensions/bash/edit-blocks.ts";

const block = (search: string, replace: string) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
const hunk = (ours: string, theirs: string, sha = "1a2b3c4 (fix land)") => `<<<<<<< HEAD\n${ours}\n=======\n${theirs}\n>>>>>>> ${sha}`;

describe("parseEditBlocks", () => {
	test("several files, several blocks per file, blank lines and fences between them", () => {
		const text = ["a.ts", block("one", "1"), "", block("two\n  indented", "2"), "```", "dir/b.rs", "```rust", block("x", ""), "```", ""].join("\n");
		assert.deepEqual(parseEditBlocks(text), [
			{ path: "a.ts", edits: [{ oldText: "one", newText: "1" }, { oldText: "two\n  indented", newText: "2" }] },
			{ path: "dir/b.rs", edits: [{ oldText: "x", newText: "" }] },
		]);
	});

	test("a repeated path joins the first; CRLF input; text keeps its own blank lines and trailing spaces", () => {
		const text = ["a.ts", block("one", "1"), "b.ts", block("b", "B"), "a.ts", block("three\n\n  ", "3")].join("\r\n");
		assert.deepEqual(parseEditBlocks(text), [
			{ path: "a.ts", edits: [{ oldText: "one", newText: "1" }, { oldText: "three\n\n  ", newText: "3" }] },
			{ path: "b.ts", edits: [{ oldText: "b", newText: "B" }] },
		]);
	});

	test("an empty REPLACE deletes lines, one empty line replaces them by a blank line; marker-like lines that are not exactly markers are text", () => {
		const text = [
			"md.md",
			block("Title\n========\n  =======\n<<<<<<<<x\n>>>>>>>>y", "Title\n-------\n= ======"),
			"x.ts",
			"<<<<<<< SEARCH\ngone\n=======\n>>>>>>> REPLACE",
			block("blank", ""),
		].join("\n");
		assert.deepEqual(parseEditBlocks(text), [
			{ path: "md.md", edits: [{ oldText: "Title\n========\n  =======\n<<<<<<<<x\n>>>>>>>>y", newText: "Title\n-------\n= ======" }] },
			{ path: "x.ts", edits: [{ oldText: "gone", newText: "", deleteLines: true }, { oldText: "blank", newText: "" }] },
		]);
	});

	test("editOf: a deletion of whole lines takes a line break, anything else stays as written", () => {
		const del = (oldText: string) => ({ oldText, newText: "", deleteLines: true as const });
		const content = "a\n  b = 1,  \nc\nab\n";
		assert.deepEqual(editOf(content, del("  b = 1,")), { oldText: "  b = 1,  \n", newText: "" }, "the file's own text, trailing spaces included");
		assert.deepEqual(editOf(content, del("a\n  b = 1,")), { oldText: "a\n  b = 1,  \n", newText: "" }, "several lines");
		assert.deepEqual(editOf("a\nlast", del("last")), { oldText: "\nlast", newText: "" }, "last line without a line break: the one before goes");
		assert.deepEqual(editOf("only", del("only")), { oldText: "only", newText: "" }, "the whole file");
		assert.deepEqual(editOf("\uFEFFx\r\ny\r\n", del("x")), { oldText: "x\n", newText: "" }, "BOM and CRLF: matched in LF text");
		assert.deepEqual(editOf(content, del("b = 1")), { oldText: "b = 1", newText: "" }, "part of a line");
		assert.deepEqual(editOf(content, del("c\na")), { oldText: "c\na", newText: "" }, "starts a line but ends inside one");
		assert.deepEqual(editOf("x\nx\n", del("x")), { oldText: "x", newText: "" }, "twice as whole lines: left for edit to refuse");
		assert.deepEqual(editOf(content, del("a")), { oldText: "a", newText: "" }, "once a whole line, again inside `ab`: left for edit to refuse");
		assert.deepEqual(editOf(content, { oldText: "c", newText: "" }), { oldText: "c", newText: "" }, "REPLACE of one empty line");
		assert.deepEqual(editOf(content, { oldText: "c", newText: "d" }), { oldText: "c", newText: "d" });
		assert.deepEqual(editOf("", del("x")), { oldText: "x", newText: "" }, "missing file");
	});

	test("a conflict marker inside a block is ambiguous and refuses the whole input", () => {
		const ambiguous = (text: string, line: number, marker: string) =>
			fails(text, new RegExp(`line ${line} \`${marker.replace(/[()]/g, "\\$&")}\` inside the block at line \\d+ looks like a conflict marker.*nothing changed.*--edits`));
		// The reported case: SEARCH holds a whole conflict hunk; its `=======` used to end SEARCH early.
		ambiguous(["land.py", block(hunk("ours", "theirs"), "resolved")].join("\n"), 3, "<<<<<<< HEAD");
		// SEARCH starting inside the hunk: git's `=======` is taken as the divider, its end marker then refuses.
		ambiguous(["land.py", "<<<<<<< SEARCH\nours\n=======\ntheirs\n>>>>>>> 1a2b3c4 (fix land)\n=======\nresolved\n>>>>>>> REPLACE"].join("\n"), 6, ">>>>>>> 1a2b3c4 (fix land)");
		ambiguous(["land.py", block(`x\n${hunk("ours", "theirs")}`, "x\nresolved")].join("\n"), 4, "<<<<<<< HEAD");
		// REPLACE that would write markers back.
		ambiguous(["a.ts", block("one", hunk("1", "2"))].join("\n"), 5, "<<<<<<< HEAD");
		ambiguous(["a.ts", block("one", "1\n>>>>>>> 1a2b3c4")].join("\n"), 6, ">>>>>>> 1a2b3c4");
		ambiguous(["a.ts", block("one", "1\n<<<<<<<")].join("\n"), 6, "<<<<<<<");
		// A Markdown setext underline of exactly seven `=` is indistinguishable from the divider.
		ambiguous(["README.md", block("Title", "New title\n=======")].join("\n"), 6, "=======");
		// A forgotten `>>>>>>> REPLACE`: the next block's start is not taken as text.
		ambiguous(["a.ts", "<<<<<<< SEARCH\none\n=======\n1", block("two", "2")].join("\n"), 6, "<<<<<<< SEARCH");
		ambiguous(["a.ts", "<<<<<<< SEARCH\none\n>>>>>>> REPLACE\n=======\n1\n>>>>>>> REPLACE"].join("\n"), 4, ">>>>>>> REPLACE");
	});

	test("conflict markers outside a block are refused, not taken as paths", () => {
		fails(["a.ts", block("a", "b"), "<<<<<<< HEAD", block("c", "d")].join("\n"), /line 7: `<<<<<<< HEAD` outside a block/);
		fails([">>>>>>> 1a2b3c4", "a.ts", block("a", "b")].join("\n"), /line 1: `>>>>>>> 1a2b3c4` outside a block/);
	});

	test("path lines written as in diffs or Markdown name the file", () => {
		for (const [line, path] of [
			["tools/kernel/mutation.py", "tools/kernel/mutation.py"],
			["--- tools/kernel/mutation.py", "tools/kernel/mutation.py"],
			["--- a/src/x.ts", "src/x.ts"],
			["+++ b/src/x.ts", "src/x.ts"],
			["*** src/x.ts", "src/x.ts"],
			["## src/x.ts", "src/x.ts"],
			["File: src/x.ts", "src/x.ts"],
			["path: src/x.ts", "src/x.ts"],
			["`src/x.ts`", "src/x.ts"],
			["\"src/my file.ts\"", "src/my file.ts"],
			["src/x.ts:", "src/x.ts"],
			["  /abs/x.ts  ", "/abs/x.ts"],
			["a/b.ts", "a/b.ts"],
			["---a.ts", "---a.ts"],
		] as const) {
			assert.equal(pathOf(line), path, line);
		}
		assert.deepEqual(parseEditBlocks(["--- tools/kernel/mutation.py", block("old", "new"), "", block("two", "2")].join("\n")), [
			{ path: "tools/kernel/mutation.py", edits: [{ oldText: "old", newText: "new" }, { oldText: "two", newText: "2" }] },
		]);
	});

	const fails = (text: string, message: RegExp) => assert.throws(() => parseEditBlocks(text), (error: unknown) => error instanceof EditBlocksError && message.test(error.message));

	test("malformed input names what is wrong and where", () => {
		fails("", /no blocks on stdin/);
		fails(block("a", "b"), /line 1: a block before any path/);
		fails(["a.ts", "b.ts", block("a", "b")].join("\n"), /^a\.ts: no SEARCH\/REPLACE block follows the path$/);
		fails(["a.ts", block("a", "b"), "c.ts"].join("\n"), /^c\.ts: no SEARCH\/REPLACE block/);
		fails("a.ts\n<<<<<<< SEARCH\nold", /^a\.ts: the block at line 2 has no `=======` line$/);
		fails("a.ts\n<<<<<<< SEARCH\nold\n=======\nnew", /^a\.ts: the block at line 2 has no `>>>>>>> REPLACE` line$/);
		fails("a.ts\n<<<<<<< SEARCH\n=======\nnew\n>>>>>>> REPLACE", /empty SEARCH part; create files with `tool write`/);
		fails("a.ts\n<<<<<<< SEARCH\n  \n=======\nnew\n>>>>>>> REPLACE", /empty SEARCH part/);
		fails(["a.ts", block("a", "b"), ">>>>>>> REPLACE"].join("\n"), /line 7: `>>>>>>> REPLACE` outside a block/);
	});
});

describe("runEditBlocks", () => {
	let dir: string;
	const signal = new AbortController().signal;
	let calls: string[];
	const ctx = () => {
		const edit = createEditTool(dir);
		return {
			executeTool: async (name: string, args: unknown) => {
				calls.push(`${name} ${(args as { path: string }).path}`);
				try {
					const result = await edit.execute("id", args as never, signal);
					return { toolCall: {} as never, result: result as never, isError: false };
				} catch (error) {
					return { toolCall: {} as never, result: { content: [{ type: "text", text: (error as Error).message }] } as never, isError: true };
				}
			},
		};
	};
	const file = (name: string) => join(dir, name);
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "edit-blocks-"));
		calls = [];
		writeFileSync(file("a.ts"), "const a = 1;\nconst b = 2;\n");
		writeFileSync(file("b.ts"), "export const x = 'x';\r\n");
	});

	test("applies every file as one edit call each, relative paths against the shell's directory", async () => {
		const stdin = ["a.ts", block("const a = 1;", "const a = 10;"), block("const b = 2;", "const b = 20;"), `${file("b.ts")}`, block("'x'", "'y'")].join("\n");
		const response = await runEditBlocks(ctx(), stdin, dir, signal);
		assert.equal(response.code, 0, response.stderr);
		assert.match(response.stdout, /Successfully replaced 2 block\(s\) in .*a\.ts\.\nSuccessfully replaced 1 block\(s\) in .*b\.ts\.\n$/);
		assert.equal(readFileSync(file("a.ts"), "utf8"), "const a = 10;\nconst b = 20;\n");
		assert.equal(readFileSync(file("b.ts"), "utf8"), "export const x = 'y';\r\n", "CRLF kept");
		assert.deepEqual(calls, [`edit ${file("a.ts")}`, `edit ${file("b.ts")}`]);
	});

	test("a repo-relative path from a subdirectory edits the repository's file; the shell's directory wins when it holds the path", async () => {
		const sub = join(dir, "tools", "kernel");
		mkdirSync(join(sub, "tools", "kernel"), { recursive: true });
		writeFileSync(join(sub, "dead_refs.py"), "import paths\n");
		writeFileSync(join(dir, "top.py"), "x = 1\n");
		execFileSync("git", ["init", "-q"], { cwd: dir });
		// The incident: `cd repo/tools/kernel && tool edit -` with the path as git shows it.
		const fromSub = await runEditBlocks(ctx(), ["tools/kernel/dead_refs.py", block("import paths", "import paths  # noqa")].join("\n"), sub, signal);
		assert.equal(fromSub.code, 0, fromSub.stderr);
		assert.equal(readFileSync(join(sub, "dead_refs.py"), "utf8"), "import paths  # noqa\n");
		// A file of the root, named from the subdirectory.
		const top = await runEditBlocks(ctx(), ["top.py", block("x = 1", "x = 2")].join("\n"), sub, signal);
		assert.equal(top.code, 0, top.stderr);
		assert.equal(readFileSync(join(dir, "top.py"), "utf8"), "x = 2\n");
		// Both exist: the shell's directory wins.
		writeFileSync(join(sub, "tools", "kernel", "dead_refs.py"), "import paths\n");
		const both = await runEditBlocks(ctx(), ["tools/kernel/dead_refs.py", block("import paths", "import nested")].join("\n"), sub, signal);
		assert.equal(both.code, 0, both.stderr);
		assert.equal(readFileSync(join(sub, "tools", "kernel", "dead_refs.py"), "utf8"), "import nested\n");
		assert.equal(readFileSync(join(sub, "dead_refs.py"), "utf8"), "import paths  # noqa\n");
		// Under neither: refused, named against the shell's directory, nothing written.
		const none = await runEditBlocks(ctx(), ["nope/x.py", block("a", "b")].join("\n"), sub, signal);
		assert.equal(none.code, 1);
		assert.match(none.stderr, new RegExp(`${join(sub, "nope", "x.py").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: .*no such file.*repository root`));
	});

	test("outside a repository a missing relative path is refused against the shell's directory", async () => {
		const sub = join(dir, "sub");
		mkdirSync(sub);
		const response = await runEditBlocks(ctx(), ["a.ts", block("const a = 1;", "const a = 2;")].join("\n"), sub, signal);
		assert.equal(response.code, 1);
		assert.match(response.stderr, /sub\/a\.ts: .*no such file/);
		assert.equal(readFileSync(file("a.ts"), "utf8"), "const a = 1;\nconst b = 2;\n");
	});

	test("one block not matching changes no file and names every failing one", async () => {
		const stdin = ["a.ts", block("const a = 1;", "const a = 10;"), "b.ts", block("nope", "y"), "missing.ts", block("a", "b")].join("\n");
		const response = await runEditBlocks(ctx(), stdin, dir, signal);
		assert.equal(response.code, 1);
		assert.match(response.stderr, /^tool edit: nothing changed, 2 of 3 files do not match:\n.*b\.ts: .*\n.*missing\.ts: Could not edit file/);
		assert.match(response.stderr, /missing\.ts: .*\(no such file: a path line holds only the file's path, relative to the shell's current directory or the repository root\)\n$/);
		assert.doesNotMatch(response.stderr, /b\.ts: [^\n]*no such file/, "an existing file that does not match gets no path hint");
		assert.equal(readFileSync(file("a.ts"), "utf8"), "const a = 1;\nconst b = 2;\n");
		assert.deepEqual(calls, []);
	});

	test("an empty REPLACE deletes whole lines with their line breaks; one empty line leaves a blank line", async () => {
		const run = async (name: string, content: string, ...blocks: string[]) => {
			writeFileSync(file(name), content);
			const response = await runEditBlocks(ctx(), [name, ...blocks].join("\n"), dir, signal);
			assert.equal(response.code, 0, response.stderr);
			return readFileSync(file(name), "utf8");
		};
		const empty = (search: string) => `<<<<<<< SEARCH\n${search}\n=======\n>>>>>>> REPLACE`;
		// The incident: one entry of a Python dict.
		const dict = 'COUNTS = {\n    "test_a.py": 3,\n    "test_copied_conditions.py": 19,\n    "test_z.py": 1,\n}\n';
		assert.equal(await run("d.py", dict, empty('    "test_copied_conditions.py": 19,')), 'COUNTS = {\n    "test_a.py": 3,\n    "test_z.py": 1,\n}\n');
		assert.equal(await run("d.py", dict, empty('"test_copied_conditions.py": 19,')), 'COUNTS = {\n    "test_a.py": 3,\n    \n    "test_z.py": 1,\n}\n', "part of a line keeps the rest");
		assert.equal(await run("d.py", dict, block('    "test_copied_conditions.py": 19,', "")), 'COUNTS = {\n    "test_a.py": 3,\n\n    "test_z.py": 1,\n}\n', "one empty line in REPLACE");
		assert.equal(await run("m.txt", "1\n2\n3\n4\n", empty("2\n3")), "1\n4\n", "several lines");
		assert.equal(await run("m.txt", "1\n2\n3\n4\n", empty("1"), empty("3"), block("4", "four")), "2\nfour\n", "several blocks of one file, the first line");
		assert.equal(await run("e.txt", "1\n2\n3", empty("3")), "1\n2", "last line without a line break");
		assert.equal(await run("e.txt", "1\n2\n3", block("2", "two"), empty("3")), "1\ntwo", "next to another block");
		assert.equal(await run("e.txt", "1\n2\n3\n", empty("3")), "1\n2\n", "last line with a line break");
		assert.equal(await run("c.txt", "a\r\nb\r\nc\r\n", empty("b")), "a\r\nc\r\n", "CRLF");
		assert.equal(await run("c.txt", "a\r\nb\r\nc", empty("c")), "a\r\nb", "CRLF, last line");
		assert.equal(await run("t.txt", "a\nb  \nc\n", empty("b")), "a\nc\n", "trailing whitespace in the file");
		assert.equal(await run("o.txt", "only\n", empty("only")), "", "the whole file");
	});

	test("an empty REPLACE of a SEARCH found twice is refused, nothing changes", async () => {
		writeFileSync(file("a.ts"), "x\nax\n");
		const response = await runEditBlocks(ctx(), ["a.ts", "<<<<<<< SEARCH\nx\n=======\n>>>>>>> REPLACE"].join("\n"), dir, signal);
		assert.equal(response.code, 1);
		assert.match(response.stderr, /a\.ts: Found 2 occurrences/);
		assert.equal(readFileSync(file("a.ts"), "utf8"), "x\nax\n");
	});

	test("a diff-style path line edits the file it names", async () => {
		const response = await runEditBlocks(ctx(), ["--- a/a.ts", block("const a = 1;", "const a = 10;")].join("\n"), dir, signal);
		assert.equal(response.code, 0, response.stderr);
		assert.equal(readFileSync(file("a.ts"), "utf8"), "const a = 10;\nconst b = 2;\n");
	});

	test("an old text occurring twice is refused like the edit tool refuses it", async () => {
		writeFileSync(file("a.ts"), "x\nx\n");
		const response = await runEditBlocks(ctx(), ["a.ts", block("x", "y")].join("\n"), dir, signal);
		assert.equal(response.code, 1);
		assert.match(response.stderr, /a\.ts: .*(unique|occurrences)/i);
		assert.equal(readFileSync(file("a.ts"), "utf8"), "x\nx\n");
	});

	test("one ambiguous block among several files changes no file", async () => {
		const stdin = ["a.ts", block("const a = 1;", "const a = 10;"), "b.ts", block("'x'", hunk("'y'", "'z'"))].join("\n");
		const response = await runEditBlocks(ctx(), stdin, dir, signal);
		assert.equal(response.code, 2);
		assert.match(response.stderr, /^tool edit: b\.ts: line 11 `<<<<<<< HEAD` inside the block at line 8 looks like a conflict marker/);
		assert.equal(readFileSync(file("a.ts"), "utf8"), "const a = 1;\nconst b = 2;\n");
		assert.equal(readFileSync(file("b.ts"), "utf8"), "export const x = 'x';\r\n");
		assert.deepEqual(calls, []);
	});

	test("a conflict hunk is resolved through JSON edits; markers left behind in an unmerged file exit 1", async () => {
		const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "pipe" });
		git("init", "-q", "-b", "main");
		writeFileSync(file("land.py"), "a = 0\nb = 0\n");
		git("add", "land.py");
		git("commit", "-qm", "base");
		git("checkout", "-qb", "other");
		writeFileSync(file("land.py"), "a = 2\nb = 2\n");
		git("commit", "-qam", "other");
		git("checkout", "-q", "main");
		writeFileSync(file("land.py"), "a = 1\nb = 1\n");
		git("commit", "-qam", "main");
		assert.throws(() => git("merge", "-q", "other"));
		const conflicted = readFileSync(file("land.py"), "utf8");
		assert.equal(conflictLines(conflicted).length, 1, conflicted);
		// Resolving only a line inside the hunk leaves the markers: the edit is made, the exit says so.
		const response = await runEditBlocks(ctx(), ["land.py", block("a = 2", "a = 3")].join("\n"), dir, signal);
		assert.equal(response.code, 1);
		assert.match(response.stdout, /Successfully replaced 1 block/);
		assert.match(response.stderr, /^tool edit: .*land\.py: changed, but it still holds git conflict markers \(conflicts starting at line 1\); resolve them/);
		// The same edit after `git add` (merged, the markers were there before): no warning.
		git("add", "land.py");
		const again = await runEditBlocks(ctx(), ["land.py", block("a = 3", "a = 4")].join("\n"), dir, signal);
		assert.deepEqual([again.code, again.stderr], [0, ""]);
	});

	test("an edit adding a full conflict warns; a Markdown setext underline or an unchanged count of conflicts does not", async () => {
		writeFileSync(file("doc.md"), `Title\n=====\n\n\`\`\`\n${hunk("ours", "theirs")}\n\`\`\`\n`);
		const unchanged = await runEditBlocks(ctx(), ["doc.md", block("Title\n=====", "Heading\n========")].join("\n"), dir, signal);
		assert.deepEqual([unchanged.code, unchanged.stderr], [0, ""], "a documented conflict that was already there is not warned about");
		// Blocks cannot hold markers, but a text edit inside a line can complete one: `======X` becomes `=======`.
		writeFileSync(file("a.ts"), "<<<<<<< HEAD\nconst a = 1;\n======X\nconst a = 2;\n>>>>>>> 1a2b3c4\n");
		const added = await runEditBlocks(ctx(), ["a.ts", block("X", "=")].join("\n"), dir, signal);
		assert.equal(added.code, 1);
		assert.match(added.stderr, /a\.ts: changed, but it still holds git conflict markers \(conflicts starting at line 1\)/);
		assert.equal(readFileSync(file("a.ts"), "utf8"), "<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> 1a2b3c4\n");
	});

	test("conflictLines needs the full triple, in order, at line start", () => {
		assert.deepEqual(conflictLines(`x\n${hunk("a", "b")}\ny\r\n${hunk("c", "d")}\n`), [2, 8]);
		assert.deepEqual(conflictLines("Title\n=======\nbody\n"), []);
		assert.deepEqual(conflictLines("<<<<<<< HEAD\na\n>>>>>>> x\n=======\n"), []);
		assert.deepEqual(conflictLines(" <<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n"), []);
		assert.deepEqual(conflictLines("<<<<<<< HEAD\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n"), [2]);
	});

	test("a format error exits 2 without touching files", async () => {
		const response = await runEditBlocks(ctx(), "a.ts\n", dir, signal);
		assert.deepEqual(response, { stdout: "", stderr: "tool edit: a.ts: no SEARCH/REPLACE block follows the path\n", code: 2 });
	});

	test("a file changed between the check and its write: earlier files stay changed, the answer says which", async () => {
		const edit = ctx();
		const racing = {
			executeTool: async (name: string, args: unknown) => {
				if ((args as { path: string }).path === file("b.ts")) writeFileSync(file("b.ts"), "changed meanwhile\n");
				return edit.executeTool(name, args);
			},
		};
		const stdin = ["a.ts", block("const a = 1;", "const a = 10;"), "b.ts", block("'x'", "'y'")].join("\n");
		const response = await runEditBlocks(racing, stdin, dir, signal);
		assert.equal(response.code, 1);
		assert.match(response.stdout, /a\.ts/);
		assert.match(response.stderr, new RegExp(`b\\.ts: .*\\nchanged: ${file("a.ts").replace(/[.]/g, "\\.")}; not attempted: none\\n$`));
		assert.equal(readFileSync(file("a.ts"), "utf8"), "const a = 10;\nconst b = 2;\n");
	});
});
