// The `tool` command's argument parsing, help and result formatting (extensions/bash/bridge.ts).
// Real bash calls using it are in bash.test.ts.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describeTool, listTools, parseArguments, runToolCommand } from "../extensions/bash/bridge.ts";

const schema = Type.Object({
	path: Type.String({ description: "File to read." }),
	offset: Type.Optional(Type.Integer()),
	ratio: Type.Optional(Type.Number()),
	follow_links: Type.Optional(Type.Boolean()),
	tags: Type.Optional(Type.Array(Type.String())),
	sizes: Type.Optional(Type.Array(Type.Integer())),
	options: Type.Optional(Type.Object({ deep: Type.Boolean() })),
	mode: Type.Optional(Type.Union([Type.Literal("a"), Type.Literal("b")])),
	any: Type.Optional(Type.Unknown()),
}) as never;
const parse = (argv: string[], stdin?: string) => parseArguments(schema, argv, stdin);
const fails = (argv: string[], message: RegExp, stdin?: string) => assert.throws(() => parse(argv, stdin), message);

describe("parseArguments", () => {
	test("positional values fill the required properties; options take --name value or --name=value", () => {
		assert.deepEqual(parse(["a.txt", "--offset", "3", "--ratio=0.5"]).args, { path: "a.txt", offset: 3, ratio: 0.5 });
		assert.deepEqual(parse(["--path", "a.txt"]).args, { path: "a.txt" });
		assert.deepEqual(parse(["--path=x=y"]).args, { path: "x=y" }, "only the first = splits");
		assert.deepEqual(parse(["-5"]).args, { path: "-5" }, "a single dash is a value");
		assert.deepEqual(parse(["--", "--path"]).args, { path: "--path" }, "after -- everything is positional");
	});

	test("option names match ignoring case, - and _", () => {
		assert.deepEqual(parse(["a", "--follow-links"]).args, { path: "a", follow_links: true });
		assert.deepEqual(parse(["a", "--followLinks"]).args, { path: "a", follow_links: true });
		assert.deepEqual(parse(["a", "--OFFSET", "1"]).args, { path: "a", offset: 1 });
	});

	test("booleans: a bare flag, --no-flag, an explicit true/false; a following positional is not taken", () => {
		assert.deepEqual(parse(["a", "--follow-links", "false"]).args, { path: "a", follow_links: false });
		assert.deepEqual(parse(["a", "--no-follow-links"]).args, { path: "a", follow_links: false });
		assert.deepEqual(parse(["--follow-links", "a"]).args, { path: "a", follow_links: true });
		assert.deepEqual(parse(["a", "--follow-links=true"]).args, { path: "a", follow_links: true });
		fails(["a", "--follow-links=yes"], /--follow_links must be true or false, got "yes"/);
	});

	test("numbers are checked", () => {
		fails(["a", "--offset", "1.5"], /--offset must be an integer, got 1\.5/);
		fails(["a", "--offset", "ten"], /--offset must be a number, got "ten"/);
		fails(["a", "--offset", ""], /--offset must be a number/);
		fails(["a", "--offset"], /--offset needs a value/);
	});

	test("arrays: repeated options, or one JSON array; items are coerced", () => {
		assert.deepEqual(parse(["a", "--tags", "x", "--tags", "y"]).args.tags, ["x", "y"]);
		assert.deepEqual(parse(["a", "--tags", '["x","y"]']).args.tags, ["x", "y"]);
		assert.deepEqual(parse(["a", "--sizes", "1", "--sizes", "2"]).args.sizes, [1, 2]);
		fails(["a", "--sizes", "x"], /--sizes must be a number/);
	});

	test("objects and untyped values take JSON; unions of literals are strings", () => {
		assert.deepEqual(parse(["a", "--options", '{"deep":true}']).args.options, { deep: true });
		fails(["a", "--options", "[1]"], /--options must be a JSON object/);
		fails(["a", "--options", "{deep}"], /--options is not valid JSON/);
		assert.deepEqual(parse(["a", "--mode", "b"]).args.mode, "b");
		assert.deepEqual(parse(["a", "--any", "[1,2]"]).args.any, [1, 2]);
		assert.deepEqual(parse(["a", "--any", "plain"]).args.any, "plain");
	});

	test("--args gives the base, from the command line or stdin; options override it and it fills required properties", () => {
		assert.deepEqual(parse(["--args", '{"path":"a","offset":1}', "--offset", "2"]).args, { path: "a", offset: 2 });
		assert.deepEqual(parse(["--args", "-"], '{"path":"from stdin"}\n').args, { path: "from stdin" });
		fails(["--args", "[]"], /--args must be a JSON object/);
		fails(["--args", "-"], /--args is not valid JSON/, "");
		fails(["--args", '{"path":"a"}', "extra"], /unexpected argument "extra"/);
	});

	test("unknown options and extra positionals are explained", () => {
		fails(["a", "--bogus", "1"], /unknown option --bogus; options: --path, --offset, --ratio, --follow_links, --tags, --sizes, --options, --mode, --any/);
		fails(["a", "b"], /unexpected argument "b": positional values fill the required arguments \(path\) only; pass others as --name value/);
		assert.throws(() => parseArguments(Type.Object({}) as never, ["--x"]), /unknown option --x; this tool takes no arguments/);
		assert.throws(() => parseArguments(Type.Object({ q: Type.Optional(Type.String()) }) as never, ["v"]), /unexpected argument "v": pass options as --name value/);
	});

	test("--json and --help are the command's own, unless the tool has such a property", () => {
		assert.deepEqual(parse(["a", "--json"]), { args: { path: "a" }, json: true, help: false });
		assert.equal(parse(["--help"]).help, true);
		assert.equal(parse(["-h"]).help, true);
		const own = Type.Object({ json: Type.Optional(Type.Boolean()), help: Type.Optional(Type.String()) }) as never;
		assert.deepEqual(parseArguments(own, ["--json", "--help", "me"]), { args: { json: true, help: "me" }, json: false, help: false });
	});
});

describe("help", () => {
	test("a tool's usage lists required arguments first, then options with types and descriptions", () => {
		const text = describeTool({ name: "read", description: "Read a file.\n\nMore.", parameters: schema });
		assert.match(text, /^read: Read a file\.\n\nMore\.\n\nUsage: tool read <path> \[--offset <integer>\] \[--ratio <number>\] \[--follow_links <boolean>\] \[--tags <string…>\] \[--sizes <integer…>\] \[--options <object>\] \[--mode <string>\] \[--any <json>\]\n/);
		assert.match(text, /\n {2}--path <string> \(required\) File to read\.\n/);
		assert.match(text, /--args -/);
	});

	test("the list shows each tool's first paragraph on one line", () => {
		assert.equal(
			listTools([
				{ name: "read", description: "Read a\nfile.\n\nDetails." },
				{ name: "web_fetch", description: "Fetch." },
			]),
			"Usage: tool <name> [arguments]   (tool <name> --help shows a tool's arguments)\n\nTools:\n  read       Read a file.\n  web_fetch  Fetch.",
		);
	});
});

describe("runToolCommand", () => {
	const tools = [{ name: "read", label: "read", description: "Read.", parameters: schema, execute: async () => assert.fail("not run directly") }] as never;
	const signal = new AbortController().signal;
	const ctx = (result: { content: unknown[]; structuredContent?: unknown }, isError = false, calls: unknown[] = []) => ({
		tools,
		executeTool: async (name: string, args: unknown) => {
			calls.push({ name, args });
			return { toolCall: {} as never, result: result as never, isError };
		},
	});

	test("text to stdout, images collected and named, --json prints the structured result", async () => {
		const images: ImageContent[] = [];
		const calls: unknown[] = [];
		const result = { content: [{ type: "text", text: "note" }, { type: "image", data: "AAAA", mimeType: "image/png" }], structuredContent: { ok: true } };
		assert.deepEqual(await runToolCommand(ctx(result, false, calls), { argv: ["read", "a.png"] }, images, signal), {
			stdout: "note\n[image 1 (image/png) is attached to this bash call's result]\n",
			stderr: "",
			code: 0,
		});
		assert.deepEqual(calls, [{ name: "read", args: { path: "a.png" } }]);
		assert.equal(images.length, 1);
		assert.equal((await runToolCommand(ctx(result), { argv: ["read", "a", "--json"] }, images, signal)).stdout, '{\n  "ok": true\n}\n');
		assert.equal(images.length, 2, "numbered across the bash call");
	});

	test("a failed call goes to stderr with exit code 1, also without text", async () => {
		assert.deepEqual(await runToolCommand(ctx({ content: [{ type: "text", text: "ENOENT" }] }, true), { argv: ["read", "a"] }, [], signal), { stdout: "", stderr: "ENOENT\n", code: 1 });
		assert.deepEqual(await runToolCommand(ctx({ content: [] }, true), { argv: ["read", "a"] }, [], signal), { stdout: "", stderr: "tool read failed\n", code: 1 });
	});

	test("no name, help, an unknown tool and a usage error answer without a call", async () => {
		const calls: unknown[] = [];
		const c = ctx({ content: [] }, false, calls);
		for (const argv of [[], ["--help"], ["help"]]) assert.match((await runToolCommand(c, { argv }, [], signal)).stdout, /^Usage: tool <name>/);
		assert.match((await runToolCommand(c, { argv: ["read", "--help"] }, [], signal)).stdout, /^read: Read\./);
		assert.deepEqual(await runToolCommand(c, { argv: ["nope"] }, [], signal), { stdout: "", stderr: 'tool: unknown tool "nope". Tools: read\n', code: 2 });
		assert.deepEqual(await runToolCommand(c, { argv: ["read", "--offset", "x"] }, [], signal), {
			stdout: "",
			stderr: 'tool read: --offset must be a number, got "x"\nRun `tool read --help` for its arguments.\n',
			code: 2,
		});
		assert.deepEqual(calls, []);
	});
});
