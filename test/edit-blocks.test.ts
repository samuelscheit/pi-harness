// `tool edit -` (extensions/bash/edit-blocks.ts): the SEARCH/REPLACE format, and applying it
// through Pi's real edit tool with the check of every file before any is written.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { createEditTool } from "@earendil-works/pi-coding-agent";
import { EditBlocksError, parseEditBlocks, pathOf, runEditBlocks } from "../extensions/bash/edit-blocks.ts";

const block = (search: string, replace: string) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

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

	test("a divider inside the REPLACE part is text; an empty REPLACE deletes", () => {
		assert.deepEqual(parseEditBlocks(["md.md", block("Title", "Title\n=======\nbody"), "x.ts", "<<<<<<< SEARCH\ngone\n=======\n>>>>>>> REPLACE"].join("\n")), [
			{ path: "md.md", edits: [{ oldText: "Title", newText: "Title\n=======\nbody" }] },
			{ path: "x.ts", edits: [{ oldText: "gone", newText: "" }] },
		]);
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

	test("one block not matching changes no file and names every failing one", async () => {
		const stdin = ["a.ts", block("const a = 1;", "const a = 10;"), "b.ts", block("nope", "y"), "missing.ts", block("a", "b")].join("\n");
		const response = await runEditBlocks(ctx(), stdin, dir, signal);
		assert.equal(response.code, 1);
		assert.match(response.stderr, /^tool edit: nothing changed, 2 of 3 files do not match:\n.*b\.ts: .*\n.*missing\.ts: Could not edit file/);
		assert.match(response.stderr, /missing\.ts: .*\(no such file: a path line holds only the file's path, relative to the shell's current directory\)\n$/);
		assert.doesNotMatch(response.stderr, /b\.ts: [^\n]*no such file/, "an existing file that does not match gets no path hint");
		assert.equal(readFileSync(file("a.ts"), "utf8"), "const a = 1;\nconst b = 2;\n");
		assert.deepEqual(calls, []);
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
