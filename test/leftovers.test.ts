// Leftovers (extensions/bash/leftovers.ts): reading ps, finding the jobs a command left, adopting
// and sweeping them, and the texts.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { adopt, endedText, type Leftovers, leftText, parsePs, rootsOf, sweep } from "../extensions/bash/leftovers.ts";

// Group 100: the shell (100) has exited; it left `sleep 30` (101, reparented to 1) and a subshell
// (102) running `make` (103). Group 200 is another command's. 104 is a zombie.
const PS = [
	"  101     1   100 S        01:00 sleep 30",
	"  102     1   100 S        00:59 bash -c make",
	"  103   102   100 R        00:59 make",
	"  104   102   100 Z        00:59 (defunct)",
	"  201     1   200 S     1-02:03:04 node server.js --port 3000",
	"garbage line",
].join("\n");

describe("reading ps", () => {
	test("parsePs keeps live processes with pid, parent, group, elapsed time and command", () => {
		const rows = parsePs(PS);
		assert.deepEqual(rows.map((r) => r.pid), [101, 102, 103, 201]);
		assert.deepEqual(rows[0], { pid: 101, ppid: 1, pgid: 100, elapsed: "01:00", command: "sleep 30" });
		assert.equal(rows[3]!.elapsed, "1-02:03:04");
	});

	test("rootsOf: the processes of a group whose parent is not in it; their children are part of them", () => {
		assert.deepEqual(rootsOf(parsePs(PS), 100).map((r) => r.pid), [101, 102]);
		assert.deepEqual(rootsOf(parsePs(PS), 999), []);
		// While the shell still runs, it is the only root: its jobs are its children.
		const running = parsePs(["  100    50   100 S 00:01 bash", "  101   100   100 S 00:01 sleep 30", "  102   100   100 S 00:01 bash -c make", "  103   102   100 R 00:01 make"].join("\n"));
		assert.deepEqual(rootsOf(running, 100).map((r) => r.pid), [100]);
	});
});

describe("adopting and sweeping", () => {
	test("adopt takes the group's roots once, with the command that left them", () => {
		const leftovers: Leftovers = new Map();
		const adopted = adopt(leftovers, parsePs(PS), 100, "sleep 30 & make &", 1000);
		assert.deepEqual(adopted, [
			{ pid: 101, pgid: 100, command: "sleep 30", startedBy: "sleep 30 & make &", adoptedAt: 1000 },
			{ pid: 102, pgid: 100, command: "bash -c make", startedBy: "sleep 30 & make &", adoptedAt: 1000 },
		]);
		assert.deepEqual(adopt(leftovers, parsePs(PS), 100, "again", 2000), [], "already tracked");
		assert.equal(leftovers.size, 2);
	});

	test("sweep reports each ended process once, and adopts what it left running", () => {
		const leftovers: Leftovers = new Map();
		adopt(leftovers, parsePs(PS), 100, "cmd", 0);
		assert.deepEqual(sweep(leftovers, parsePs(PS), 10), [], "nothing ended");
		// 102 ended; its make (103) is now an orphan in the group.
		const after = parsePs(["  101     1   100 S 01:10 sleep 30", "  103     1   100 R 01:09 make"].join("\n"));
		const [first, ...rest] = sweep(leftovers, after, 5000);
		assert.equal(rest.length, 0);
		assert.equal(first!.ended.pid, 102);
		assert.deepEqual(first!.orphans.map((o) => [o.pid, o.startedBy]), [[103, "cmd"]]);
		assert.deepEqual([...leftovers.keys()].sort(), [101, 103]);
		// Both end in the same check: two reports.
		assert.deepEqual(sweep(leftovers, [], 9000).map((e) => e.ended.pid).sort(), [101, 103]);
		assert.equal(leftovers.size, 0);
	});

	test("a pid reused by a process in another group counts as ended", () => {
		const leftovers: Leftovers = new Map();
		adopt(leftovers, parsePs(PS), 100, "cmd", 0);
		const reused = parsePs(["  101     1   555 S 00:01 other", "  102     1   100 S 01:00 bash -c make", "  103   102   100 R 01:00 make"].join("\n"));
		assert.deepEqual(sweep(leftovers, reused, 1).map((e) => e.ended.pid), [101]);
	});
});

describe("texts", () => {
	const leftover = { pid: 101, pgid: 100, command: "sleep 30", startedBy: "sleep 30 > /dev/null &\necho started", adoptedAt: 0 };

	test("the call's note lists each process and says its end wakes the agent", () => {
		const text = leftText([leftover, { ...leftover, pid: 102, command: "x".repeat(300) }]);
		assert.match(text, /^Still running in the background, left by this command \(2 processes\):\n- pid 101: `sleep 30`\n- pid 102: `x{159}…`\n/);
		assert.match(text, /Each one's end reaches you as a new message, also after your turn: do not wait or poll for them\. Stop one with `kill <pid>`\. They stop when the session ends\.$/);
		assert.match(leftText([leftover]), /\(1 process\)/);
		assert.match(leftText([leftover, { ...leftover, pid: 104, command: "tool workflow", tool: true }]), /- pid 104: `tool workflow`\nEach one's end reaches you as a new message \(a `tool` command's with its exit code and result\), also after/);
	});

	test("the end message names the process, the command that left it and what it left in turn", () => {
		const text = endedText(leftover, [], 125_000);
		assert.equal(
			text,
			"Background process pid 101 `sleep 30` ended (running at least 2 min 5 s since your command `sleep 30 > /dev/null & echo started` returned). Its exit code is not known; its output is wherever that command sent it.",
		);
		assert.match(endedText(leftover, [{ ...leftover, pid: 103, command: "make" }], 3000), /\nIt left running, now tracked as well:\n- pid 103: `make`$/);
	});
});
