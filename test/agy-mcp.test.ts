// Tests for the pi-harness MCP server (agy/mcp/server.ts + protocol.ts) and standalone `tool` CLI
// (agy/bin/tool.ts): tool discovery, note_improvement, goal, edit_blocks, workflow, and stdio framing.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { handleJsonRpc } from "../agy/mcp/protocol.ts";
import { createHarnessMcpConfig } from "../agy/mcp/server.ts";
import { loadOwnWrites } from "../agy/state.ts";
import { HARNESS_ROOT } from "../extensions/lib/repository.ts";

let dir: string;
let dataDir: string;
let repoDir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agy-mcp-"));
	dataDir = join(dir, "data");
	repoDir = join(dir, "repo");
	mkdirSync(repoDir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pi-harness MCP server", () => {
	test("exposes note_improvement, goal, edit_blocks, workflow, and saved workflows like fix_loop", async () => {
		const config = createHarnessMcpConfig({ cwd: repoDir, dataDir, harnessRoot: HARNESS_ROOT, conversationId: "mcp-1" });
		const init = (await handleJsonRpc(config, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })) as {
			result: { serverInfo: { name: string } };
		};
		assert.equal(init.result.serverInfo.name, "pi-harness");

		const list = (await handleJsonRpc(config, { jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
			result: { tools: { name: string }[] };
		};
		const names = list.result.tools.map((t) => t.name);
		for (const expected of ["note_improvement", "goal", "edit_blocks", "workflow", "fix_loop"]) {
			assert.ok(names.includes(expected), `expected tool ${expected} in ${names.join(", ")}`);
		}
	});

	test("note_improvement appends to project backlog", async () => {
		const config = createHarnessMcpConfig({ cwd: repoDir, dataDir, harnessRoot: HARNESS_ROOT, conversationId: "mcp-note" });
		const res = (await handleJsonRpc(config, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: {
				name: "note_improvement",
				arguments: {
					scope: "project",
					observation: "Tests fail without fixture setup",
					proposal: "Document fixture setup in AGENTS.md",
					cwd: repoDir,
				},
			},
		})) as { result: { content: { text: string }[]; isError?: boolean } };
		assert.ok(!res.result.isError);
		const backlog = join(repoDir, ".agents", "improvements.md");
		assert.ok(existsSync(backlog));
		const text = readFileSync(backlog, "utf8");
		assert.match(text, /Tests fail without fixture setup/);
		assert.match(text, /Document fixture setup/);
	});

	test("edit_blocks applies atomic multi-file SEARCH/REPLACE and records own-writes", async () => {
		const f1 = join(repoDir, "one.txt");
		const f2 = join(repoDir, "two.txt");
		writeFileSync(f1, "hello world\n");
		writeFileSync(f2, "foo bar\n");

		const config = createHarnessMcpConfig({ cwd: repoDir, dataDir, harnessRoot: HARNESS_ROOT, conversationId: "mcp-edit" });
		const blocks = [
			"one.txt",
			"<<<<<<< SEARCH",
			"hello world",
			"=======",
			"hello agy",
			">>>>>>> REPLACE",
			"two.txt",
			"<<<<<<< SEARCH",
			"foo bar",
			"=======",
			"foo baz",
			">>>>>>> REPLACE",
		].join("\n");

		const res = (await handleJsonRpc(config, {
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: { name: "edit_blocks", arguments: { blocks, cwd: repoDir } },
		})) as { result: { content: { text: string }[]; isError?: boolean } };
		assert.ok(!res.result.isError, res.result.content[0]?.text);
		assert.equal(readFileSync(f1, "utf8"), "hello agy\n");
		assert.equal(readFileSync(f2, "utf8"), "foo baz\n");

		const own = loadOwnWrites("mcp-edit", dataDir);
		assert.ok(own.files.has(f1));
		assert.ok(own.files.has(f2));
	});

	test("stdio JSON-RPC transport responds cleanly without corrupting stdout", async () => {
		const serverPath = join(HARNESS_ROOT, "agy", "mcp", "server.ts");
		const child = spawn(process.execPath, [serverPath], {
			cwd: repoDir,
			env: { ...process.env, PLUGIN_DATA: dataDir },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const lines: string[] = [];
		let buffer = "";
		const waitLine = () =>
			new Promise<Record<string, unknown>>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("MCP stdio timeout")), 10_000);
				const onData = (chunk: Buffer) => {
					buffer += chunk.toString("utf8");
					const idx = buffer.indexOf("\n");
					if (idx >= 0) {
						clearTimeout(timer);
						child.stdout.off("data", onData);
						const line = buffer.slice(0, idx);
						buffer = buffer.slice(idx + 1);
						lines.push(line);
						resolve(JSON.parse(line) as Record<string, unknown>);
					}
				};
				child.stdout.on("data", onData);
			});

		try {
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
			const initResp = await waitLine();
			assert.equal(initResp.id, 1);

			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
			const pingResp = await waitLine();
			assert.equal(pingResp.id, 2);
		} finally {
			child.kill();
		}
	});
});

describe("standalone tool CLI", () => {
	test("tool edit - applies stdin SEARCH/REPLACE blocks and updates own-writes", () => {
		const target = join(repoDir, "sample.txt");
		writeFileSync(target, "alpha\nbeta\n");
		const toolScript = join(HARNESS_ROOT, "agy", "bin", "tool.ts");
		const input = [
			"sample.txt",
			"<<<<<<< SEARCH",
			"alpha",
			"=======",
			"ALPHA",
			">>>>>>> REPLACE",
		].join("\n");

		const out = execFileSync(process.execPath, [toolScript, "edit", "-"], {
			cwd: repoDir,
			input,
			encoding: "utf8",
			env: { ...process.env, PLUGIN_DATA: dataDir, ANTIGRAVITY_CONVERSATION_ID: "cli-edit-conv" },
		});
		assert.match(out, /sample\.txt/);
		assert.equal(readFileSync(target, "utf8"), "ALPHA\nbeta\n");
		assert.ok(loadOwnWrites("cli-edit-conv", dataDir).files.has(target));
	});
});
