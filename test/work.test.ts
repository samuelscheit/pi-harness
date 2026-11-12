import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, test } from "node:test";
import { delegatedTaskDigest, delegation, mentions, taskDigest, toolFiles } from "../extensions/metrics/work.ts";

describe("toolFiles", () => {
	const cwd = "/repo";

	test("path arguments resolve against the session directory", () => {
		assert.deepEqual(toolFiles("read", { path: "src/a.ts" }, cwd), ["/repo/src/a.ts"]);
		assert.deepEqual(toolFiles("edit", { path: "/abs/b.ts", edits: [] }, cwd), ["/abs/b.ts"]);
		assert.deepEqual(toolFiles("read", { path: "~/notes.md" }, cwd), [`${homedir()}/notes.md`]);
	});

	test("shell commands yield their path-like words, after any cd", () => {
		assert.deepEqual(toolFiles("bash", { command: "sed -n 1,80p src/a.ts && rg -n foo extensions/" }, cwd).sort(), ["/repo/extensions", "/repo/src/a.ts"]);
		assert.deepEqual(toolFiles("bash", { command: "cd ~/gw && git diff routing_core.py" }, cwd), [`${homedir()}/gw/routing_core.py`]);
		assert.deepEqual(toolFiles("bash", { command: "cd /a; cd b && cat c.txt" }, cwd), ["/a/b/c.txt"]);
	});

	test("heredoc bodies, inline scripts and other non-paths are ignored", () => {
		const command = `python3 - <<'EOF'\nimport pathlib\np=pathlib.Path("x/y.ts")\nEOF\nsqlite3 m.db "select c.id from GPT/Gemini" && curl https://example.com/a.json && ls -la docs/ src`;
		assert.deepEqual(toolFiles("bash", { command }, cwd).sort(), ["/repo/docs", "/repo/m.db"]);
		assert.deepEqual(toolFiles("bash", { command: "npm test 2>&1 | tail -5; node -v 1.2.3" }, cwd), []);
	});

	test("calls without arguments or for other tools touch nothing", () => {
		assert.deepEqual(toolFiles("web_search", { query: "how to use src/a.ts" }, cwd), []);
		assert.deepEqual(toolFiles("bash", undefined, cwd), []);
	});
});

describe("mentions", () => {
	test("matches the file name as a word, not as part of another name", () => {
		assert.equal(mentions("I changed indexer.ts to …", "/r/extensions/metrics/indexer.ts"), true);
		assert.equal(mentions("see `indexer.ts:42`", "/r/indexer.ts"), true);
		assert.equal(mentions("my-indexer.ts and indexer.tsx", "/r/indexer.ts"), false);
		assert.equal(mentions("a b", "/r/a"), false);
	});
});

describe("delegations", () => {
	const task = "Fix the gateway.\n\nDetails follow.";

	test("a child's first message is a one-line preamble, a blank line and the task verbatim", () => {
		assert.equal(delegatedTaskDigest(`Act as the implementation sub-agent for this task.\n\n${task}`), taskDigest(task));
		assert.equal(delegatedTaskDigest("hello"), undefined);
		assert.equal(delegatedTaskDigest("two\nlines\n\nthen text"), undefined);
	});

	test("delegate_task records the task and the child thread; a failed start records nothing", () => {
		assert.deepEqual(delegation("mcp__t3-code__delegate_task", { task, title: "Gateway" }, JSON.stringify({ childThreadId: "thread:1" })), {
			kind: "delegate",
			taskDigest: taskDigest(task),
			threadId: "thread:1",
			title: "Gateway",
		});
		assert.equal(delegation("mcp__t3-code__delegate_task", { task }, "Error: provider disabled"), undefined);
	});

	test("t3_thread_send is a resume of that thread", () => {
		assert.deepEqual(delegation("mcp__t3-code__t3_thread_send", { threadId: "thread:1", text: "next" }, "{}"), { kind: "send", threadId: "thread:1" });
		assert.equal(delegation("bash", { command: "ls" }, ""), undefined);
	});
});
