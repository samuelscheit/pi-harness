// The `tool` command's argument parsing, help and result formatting (extensions/bash/bridge.ts).
// Real bash calls using it are in bash.test.ts.

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, test } from "node:test";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { clientCommand, describeTool, listTools, parseArguments, runToolCommand, toolEndedText, toolLabel } from "../extensions/bash/bridge.ts";

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

	test("`-` as the value of a string argument reads stdin, minus one final newline; other types and a missing stdin keep it literal", () => {
		assert.deepEqual(parse(["--path", "-"], "text with `ticks` and $(x)\n").args, { path: "text with `ticks` and $(x)" });
		assert.deepEqual(parse(["-"], "a.txt\n").args, { path: "a.txt" }, "a positional too");
		assert.deepEqual(parse(["--path=-"], "x\n\n").args, { path: "x\n" }, "only one newline is dropped");
		assert.deepEqual(parse(["--path", "-"], "line 1\nline 2").args, { path: "line 1\nline 2" });
		assert.deepEqual(parse(["--path", "-"], "").args, { path: "" });
		assert.deepEqual(parse(["--path", "-"]).args, { path: "-" }, "no stdin: literal");
		assert.deepEqual(parse(["--path", "a", "--tags", "-"], "x").args, { path: "a", tags: ["-"] }, "only string arguments");
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
	const none = () => assert.fail("no image");
	const ctx = (result: { content: unknown[]; structuredContent?: unknown }, isError = false, calls: unknown[] = []) => ({
		tools,
		cwd: "/repo",
		executeTool: async (name: string, args: unknown) => {
			calls.push({ name, args });
			return { toolCall: {} as never, result: result as never, isError };
		},
	});

	test("text to stdout, each image to attach in its place, --json prints the structured result", async () => {
		const images: ImageContent[] = [];
		const attach = (image: ImageContent) => `[image ${images.push(image)}]`;
		const calls: unknown[] = [];
		const result = { content: [{ type: "text", text: "note" }, { type: "image", data: "AAAA", mimeType: "image/png" }], structuredContent: { ok: true } };
		assert.deepEqual(await runToolCommand(ctx(result, false, calls), { argv: ["read", "a.png"] }, attach, signal), { stdout: "note\n[image 1]\n", stderr: "", code: 0 });
		assert.deepEqual(calls, [{ name: "read", args: { path: "/repo/a.png" } }]);
		assert.equal(images.length, 1);
		assert.equal((await runToolCommand(ctx(result), { argv: ["read", "a", "--json"] }, attach, signal)).stdout, '{\n  "ok": true\n}\n');
		assert.equal(images.length, 2, "--json still attaches the images");
	});

	test("a relative path resolves against the shell's directory; absolute and home paths stay", async () => {
		const calls: { args: unknown }[] = [];
		const c = ctx({ content: [] }, false, calls);
		await runToolCommand(c, { argv: ["read", "a.ts"], cwd: "/repo/sub" }, none, signal);
		await runToolCommand(c, { argv: ["read", "../b.ts"], cwd: "/repo/sub" }, none, signal);
		await runToolCommand(c, { argv: ["read", "/abs/c.ts"], cwd: "/repo/sub" }, none, signal);
		await runToolCommand(c, { argv: ["read", "~/d.ts"], cwd: "/repo/sub" }, none, signal);
		await runToolCommand(c, { argv: ["read", "e.ts"] }, none, signal);
		assert.deepEqual(
			calls.map((call) => (call.args as { path: string }).path),
			["/repo/sub/a.ts", "/repo/b.ts", "/abs/c.ts", "~/d.ts", "/repo/e.ts"],
		);
	});

	test("a failed call goes to stderr with exit code 1, also without text", async () => {
		assert.deepEqual(await runToolCommand(ctx({ content: [{ type: "text", text: "ENOENT" }] }, true), { argv: ["read", "a"] }, none, signal), { stdout: "", stderr: "ENOENT\n", code: 1 });
		assert.deepEqual(await runToolCommand(ctx({ content: [] }, true), { argv: ["read", "a"] }, none, signal), { stdout: "", stderr: "tool read failed\n", code: 1 });
	});

	test("no name, help, an unknown tool and a usage error answer without a call", async () => {
		const calls: unknown[] = [];
		const c = ctx({ content: [] }, false, calls);
		for (const argv of [[], ["--help"], ["help"]]) assert.match((await runToolCommand(c, { argv }, none, signal)).stdout, /^Usage: tool <name>/);
		assert.match((await runToolCommand(c, { argv: ["read", "--help"] }, none, signal)).stdout, /^read: Read\./);
		assert.deepEqual(await runToolCommand(c, { argv: ["nope"] }, none, signal), { stdout: "", stderr: 'tool: unknown tool "nope". Tools: read\n', code: 2 });
		assert.deepEqual(await runToolCommand(c, { argv: ["read", "--offset", "x"] }, none, signal), {
			stdout: "",
			stderr: 'tool read: --offset must be a number, got "x"\nRun `tool read --help` for its arguments.\n',
			code: 2,
		});
		assert.deepEqual(calls, []);
	});
});

describe("tool commands left running", () => {
	test("a client's label is its command as the shell ran it, quoted where needed", () => {
		assert.equal(toolLabel(["read", "a.txt"]), "tool read a.txt");
		assert.equal(toolLabel(["workflow", "--code", "return 'x'", "--budget", "1"]), "tool workflow --code 'return '\\''x'\\''' --budget 1");
		assert.equal(toolLabel([]), "tool");
	});

	test("a client is recognised in ps output before and after the wrapper's exec; other processes are not", () => {
		assert.equal(clientCommand(`${process.execPath} /tmp/bin/tool.mjs slow --ms 5`, "/tmp/bin"), "tool slow --ms 5");
		assert.equal(clientCommand(`${process.execPath} /tmp/bin/tool.mjs`, "/tmp/bin"), "tool");
		assert.equal(clientCommand("/bin/sh /tmp/bin/tool read x", "/tmp/bin"), "tool read x");
		assert.equal(clientCommand(`${process.execPath} /tmp/bin/tool.mjsx`, "/tmp/bin"), undefined);
		assert.equal(clientCommand(`${process.execPath} /tmp/other/tool.mjs read x`, "/tmp/bin"), undefined, "another process's client");
		assert.equal(clientCommand("sleep 30", "/tmp/bin"), undefined);
		assert.equal(clientCommand("/bin/sh /tmp/bin/tool read x", undefined), undefined, "no bridge in this process");
	});

	test("the tool command outlives the release that wrote it: pruning it during a call and before the next breaks nothing", async () => {
		// A release: a copy of the extensions, as deploy() extracts them, with the repository's packages.
		const repo = new URL("..", import.meta.url).pathname;
		const release = mkdtempSync(join(tmpdir(), "bridge-release-"));
		cpSync(join(repo, "extensions"), join(release, "extensions"), { recursive: true });
		copyFileSync(join(repo, "package.json"), join(release, "package.json"));
		symlinkSync(join(repo, "node_modules"), join(release, "node_modules"));
		// A Pi process loads it: its bash extension writes the process's `tool` command.
		const loader = `import { toolBinDir } from ${JSON.stringify(join(release, "extensions", "bash", "bridge.ts"))}; process.stdout.write(toolBinDir());`;
		const binDir = execFileSync(process.execPath, ["--input-type=module", "-e", loader], { encoding: "utf8" });
		const socket = join(binDir, "test.sock");
		const requests: string[][] = [];
		const server = createServer((connection) => {
			let line = "";
			connection.on("data", (chunk) => {
				line += chunk.toString("utf8");
				if (!line.includes("\n")) return;
				requests.push((JSON.parse(line) as { argv: string[] }).argv);
				// A deploy prunes the release while the call runs.
				rmSync(release, { recursive: true, force: true });
				connection.end(JSON.stringify({ stdout: `ran ${requests.length}\n`, stderr: "", code: 0 }));
			});
		});
		await new Promise<void>((listening) => server.listen(socket, listening));
		const run = (...argv: string[]) => promisify(execFile)(join(binDir, "tool"), argv, { env: { PATH: process.env.PATH, PI_TOOL_SOCKET: socket } });
		try {
			assert.equal((await run("edit", "--path", "a.txt")).stdout, "ran 1\n", "the call that was running when its release went away");
			assert.equal(existsSync(release), false);
			assert.equal((await run("read", "x")).stdout, "ran 2\n", "a call after the release went away");
			assert.deepEqual(requests, [["edit", "--path", "a.txt"], ["read", "x"]]);
			assert.equal(readFileSync(join(binDir, "tool.mjs"), "utf8"), readFileSync(join(repo, "extensions", "bash", "cli.mjs"), "utf8"), "the client is a copy");
			assert.doesNotMatch(readFileSync(join(binDir, "tool"), "utf8"), new RegExp(release), "the wrapper names no release file");
		} finally {
			server.close();
			rmSync(release, { recursive: true, force: true });
			rmSync(binDir, { recursive: true, force: true });
		}
	});

	test("the end message names the command, its pid and the bash command, then the exit code and output; or that it was killed", () => {
		const job = { pid: 7, startedBy: "tool slow > out &\necho started" };
		assert.equal(
			toolEndedText(job, "tool slow", { stdout: "done\n", stderr: "", code: 0 }, 61_000),
			"Your background `tool slow` (pid 7, left running by your command `tool slow > out & echo started`) exited with code 0 after 1 min 1 s:\n\ndone",
		);
		assert.match(toolEndedText(job, "tool slow", { stdout: "", stderr: "ENOENT\n", code: 1 }, 1000), /exited with code 1 after 1 s:\n\nENOENT$/);
		assert.match(toolEndedText(job, "tool slow", { stdout: "", stderr: "", code: 0 }, 1000), /:\n\n\(no output\)$/);
		assert.match(toolEndedText(job, "tool slow", "killed", 2000), /\) was killed after 2 s, so its call was aborted\.$/);
	});
});
