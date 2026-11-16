// Leftovers (extensions/bash/leftovers.ts): reading ps, finding the jobs a command left, adopting
// and sweeping them, and the texts.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { sessionJobs } from "../extensions/background/jobs.ts";
import { adopt, adoptLeftovers, endedText, isHelperDaemon, type Leftovers, leftText, rootsOf, shownCommand, sweep, untrackedRoots, untrackedText } from "../extensions/bash/leftovers.ts";
import { commandArgs, commandsOf, defaultPs, parseCommands, parseTable, type Ps, TABLE_ARGS, treeOf } from "../extensions/lib/ps.ts";
import { withHugePs } from "./fixtures/huge-ps.ts";

// Group 100: the shell (100) has exited; it left `sleep 30` (101, reparented to 1) and a subshell
// (102) running `make` (103). Group 200 is another command's. 104 is a zombie.
const TABLE = ["  101     1   100 S", "  102     1   100 S", "  103   102   100 R", "  104   102   100 Z", "  201     1   200 Ss", "garbage line"].join("\n");
const COMMANDS = new Map([
	[101, "sleep 30"],
	[102, "bash -c make"],
	[103, "make"],
	[201, "node server.js --port 3000"],
]);

describe("reading ps", () => {
	test("parseTable keeps live processes with pid, parent and group", () => {
		const rows = parseTable(TABLE);
		assert.deepEqual(rows.map((r) => r.pid), [101, 102, 103, 201]);
		assert.deepEqual(rows[0], { pid: 101, ppid: 1, pgid: 100 });
	});

	test("parseCommands reads command lines by pid, spaces and all", () => {
		assert.deepEqual(parseCommands("  101 sleep 30\n 7 node  a.js --x 'y z'\n\n"), new Map([[101, "sleep 30"], [7, "node  a.js --x 'y z'"]]));
		assert.deepEqual(commandArgs([3, 5]), ["-o", "pid=,command=", "-p", "3,5"]);
	});

	test("rootsOf: the processes of a group whose parent is not in it; their children are part of them", () => {
		assert.deepEqual(rootsOf(parseTable(TABLE), 100).map((r) => r.pid), [101, 102]);
		assert.deepEqual(rootsOf(parseTable(TABLE), 999), []);
		// While the shell still runs, it is the only root: its jobs are its children.
		const running = parseTable(["  100    50   100 S", "  101   100   100 S", "  102   100   100 S", "  103   102   100 R"].join("\n"));
		assert.deepEqual(rootsOf(running, 100).map((r) => r.pid), [100]);
	});

	test("treeOf: a process and every process below it, parents first, whatever their group", () => {
		const rows = parseTable(["  10     1   10 S", "  11    10   10 S", "  12    11   12 S", "  13    12   10 S", "  14     1   10 S"].join("\n"));
		assert.deepEqual(treeOf(rows, 10), [10, 11, 12, 13]);
		assert.deepEqual(treeOf(rows, 14), [14]);
		assert.deepEqual(treeOf(rows, 99), [99], "an unknown pid is itself");
	});

	test("command lines are asked for only for the untracked roots", async () => {
		const asked: (readonly string[])[] = [];
		const ps: Ps = async (args) => {
			asked.push(args);
			return args === TABLE_ARGS ? TABLE : [...COMMANDS].filter(([pid]) => args[3]!.split(",").includes(String(pid))).map(([pid, c]) => `${pid} ${c}`).join("\n");
		};
		const jobs = sessionJobs(`asked-${process.pid}`);
		const adopted = await adoptLeftovers(jobs, 100, { startedBy: "cmd" }, ps, 60_000);
		clearInterval(jobs.poll);
		assert.deepEqual(adopted.left.map((l) => [l.pid, l.command]), [[101, "sleep 30"], [102, "bash -c make"]]);
		assert.deepEqual(asked, [TABLE_ARGS, commandArgs([101, 102])]);
		asked.length = 0;
		assert.deepEqual(await adoptLeftovers(jobs, 100, { startedBy: "again" }, ps, 60_000), { left: [], untracked: [] });
		assert.deepEqual(asked, [TABLE_ARGS], "nothing new: no command lines asked for");
		assert.deepEqual(await commandsOf(ps, []), new Map());
		assert.deepEqual(asked, [TABLE_ARGS], "no pids: ps does not run");
		clearInterval(jobs.poll);
	});

	test("with more than 1 MB of ps output, a real job left in a group is adopted and its end seen", async () => {
		// The group leader (bash) exits at once and leaves `sleep 30` in its group.
		const shell = spawn("bash", ["-c", "sleep 30 > /dev/null 2>&1 & echo $!"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		shell.stdout.on("data", (chunk) => (out += chunk));
		await new Promise((resolve) => shell.on("close", resolve));
		const sleep = Number(out.trim());
		const pgid = shell.pid!;
		try {
			await withHugePs(async () => {
				assert.ok((await defaultPs(TABLE_ARGS)).length > 1024 * 1024, "the fake ps lists more than 1 MB");
				const jobs = sessionJobs(`huge-${process.pid}`);
				const adopted = await adoptLeftovers(jobs, pgid, { startedBy: "sleep 30 &" }, defaultPs, 60_000);
				clearInterval(jobs.poll);
				assert.deepEqual(adopted.left.map((l) => [l.pid, l.pgid, l.command]), [[sleep, pgid, "sleep 30"]]);
				// A pid that exited meanwhile has no command line; ps's exit code 1 when none is left is not an error.
				const exited = spawnSync("true").pid!;
				assert.deepEqual(await commandsOf(defaultPs, [sleep, exited]), new Map([[sleep, "sleep 30"]]));
				assert.deepEqual(await commandsOf(defaultPs, [exited]), new Map());
				process.kill(sleep, "SIGKILL");
				await new Promise((resolve) => setTimeout(resolve, 100));
				const rows = parseTable(await defaultPs(TABLE_ARGS));
				assert.deepEqual(sweep(jobs.leftovers, rows, Date.now(), new Map()).map((e) => e.ended.pid), [sleep]);
			});
		} finally {
			try {
				process.kill(-pgid, "SIGKILL");
			} catch {
				// Gone.
			}
		}
	});
});

describe("adopting and sweeping", () => {
	const rows = parseTable(TABLE);

	test("adopt takes the group's roots once, with the command that left them", () => {
		const leftovers: Leftovers = new Map();
		assert.deepEqual(untrackedRoots(leftovers, rows, [100, 100]), [101, 102]);
		const adopted = adopt(leftovers, rows, 100, { startedBy: "sleep 30 & make &" }, 1000, COMMANDS);
		assert.deepEqual(adopted, [
			{ pid: 101, pgid: 100, command: "sleep 30", startedBy: "sleep 30 & make &", adoptedAt: 1000 },
			{ pid: 102, pgid: 100, command: "bash -c make", startedBy: "sleep 30 & make &", adoptedAt: 1000 },
		]);
		assert.deepEqual(untrackedRoots(leftovers, rows, [100]), []);
		assert.deepEqual(adopt(leftovers, rows, 100, { startedBy: "again" }, 2000, COMMANDS), [], "already tracked");
		assert.equal(leftovers.size, 2);
	});

	test("a leftover keeps the bash call that left it, and so do the processes it leaves in turn", () => {
		const leftovers: Leftovers = new Map();
		const [sleep] = adopt(leftovers, rows, 100, { startedBy: "cmd", callId: "toolu_1" }, 0, COMMANDS);
		assert.deepEqual(sleep, { pid: 101, pgid: 100, command: "sleep 30", startedBy: "cmd", callId: "toolu_1", adoptedAt: 0 });
		const [ended] = sweep(leftovers, parseTable(["  101     1   100 S", "  103     1   100 R"].join("\n")), 5, COMMANDS);
		assert.deepEqual(ended!.orphans.map((o) => [o.pid, o.callId]), [[103, "toolu_1"]]);
	});

	test("a helper daemon is never adopted, also not as the orphan of an ended job (2026-11-16: git's fsmonitor listed for hours)", () => {
		const leftovers: Leftovers = new Map();
		const commands = new Map([
			[101, "/bin/bash scratch/runH.sh"],
			[103, "/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core/git fsmonitor--daemon run --detach --ipc-threads=8"],
			[104, "make"],
		]);
		adopt(leftovers, parseTable("  101     1   100 S"), 100, { startedBy: "./runH.sh &" }, 0, commands);
		// runH.sh ends; it left git's fsmonitor and a make in the group.
		const [ended] = sweep(leftovers, parseTable(["  103     1   100 S", "  104     1   100 R"].join("\n")), 5, commands);
		assert.deepEqual(ended!.orphans.map((o) => o.command), ["make"]);
		assert.deepEqual([...leftovers.keys()], [104]);
		for (const daemon of ["git fsmonitor--daemon run", "/usr/local/bin/gpg-agent --daemon", "ssh: /Users/u/.ssh/cm-host [mux]", "ssh -o ControlMaster=auto -N host", "ssh -M -S sock host", "/opt/homebrew/bin/dirmngr --daemon"]) {
			assert.equal(isHelperDaemon(daemon), true, daemon);
		}
		for (const job of ["make", "git fetch origin", "ssh host ./run.sh", "node server.js --daemon-port 3", "pytest tests/test_gpg-agent.py"]) {
			assert.equal(isHelperDaemon(job), false, job);
		}
	});

	test("a subshell of the bash tool's wrapper is shown as the agent's command's", () => {
		const leftovers: Leftovers = new Map();
		const wrapper = "/bin/bash -c export PI_TOOL_SOCKET='/tmp/pi-tool-1.sock' PATH='/tmp/bin':\"$PATH\"\nprintf '%s' \"$$\" > /tmp/g";
		const [sub] = adopt(leftovers, parseTable("  101     1   100 S"), 100, { startedBy: "(for t in a b; do pytest $t; done) > log 2>&1 &" }, 0, new Map([[101, wrapper]]));
		assert.equal(sub!.command, "( … ) & in: (for t in a b; do pytest $t; done) > log 2>&1 &");
		assert.equal(shownCommand("sleep 30", "x"), "sleep 30");
	});

	test("a root without a command line exited after the listing: not adopted", () => {
		const leftovers: Leftovers = new Map();
		assert.deepEqual(adopt(leftovers, rows, 100, { startedBy: "cmd" }, 0, new Map([[102, "bash -c make"]])).map((l) => l.pid), [102]);
	});

	test("sweep reports each ended process once, and adopts what it left running", () => {
		const leftovers: Leftovers = new Map();
		adopt(leftovers, rows, 100, { startedBy: "cmd" }, 0, COMMANDS);
		assert.deepEqual(sweep(leftovers, rows, 10, COMMANDS), [], "nothing ended");
		// 102 ended; its make (103) is now an orphan in the group.
		const after = parseTable(["  101     1   100 S", "  103     1   100 R"].join("\n"));
		const [first, ...rest] = sweep(leftovers, after, 5000, COMMANDS);
		assert.equal(rest.length, 0);
		assert.equal(first!.ended.pid, 102);
		assert.deepEqual(first!.orphans.map((o) => [o.pid, o.command, o.startedBy, o.callId]), [[103, "make", "cmd", undefined]]);
		assert.deepEqual([...leftovers.keys()].sort(), [101, 103]);
		// Both end in the same check: two reports.
		assert.deepEqual(sweep(leftovers, [], 9000, new Map()).map((e) => e.ended.pid).sort(), [101, 103]);
		assert.equal(leftovers.size, 0);
	});

	test("processes that are not the call's jobs are named once, never adopted, and forgotten when they exit", async () => {
		let table = TABLE;
		const ps: Ps = async (args) =>
			args === TABLE_ARGS ? table : [...COMMANDS].filter(([pid]) => args[3]!.split(",").includes(String(pid))).map(([pid, c]) => `${pid} ${c}`).join("\n");
		const jobs = sessionJobs(`untracked-${process.pid}`);
		// 101 (`sleep 30`) is the shell's job; 102 (`bash -c make`) was started by a program.
		const first = await adoptLeftovers(jobs, 100, { startedBy: "sleep 30 & make", callId: "toolu_2" }, ps, 60_000, (pid) => pid === 101);
		clearInterval(jobs.poll);
		jobs.poll = undefined;
		assert.deepEqual(first.left.map((l) => l.pid), [101]);
		assert.deepEqual(first.untracked, [{ pid: 102, command: "bash -c make" }]);
		assert.deepEqual([...jobs.named.keys()], ["102:100"]);
		const named = jobs.named.get("102:100")!;
		assert.deepEqual({ ...named, namedAt: 0 }, { pid: 102, pgid: 100, command: "bash -c make", startedBy: "sleep 30 & make", callId: "toolu_2", namedAt: 0 }, "kept with what /jobs lists");
		assert.deepEqual(await adoptLeftovers(jobs, 100, { startedBy: "again" }, ps, 60_000, () => false), { left: [], untracked: [] }, "named once");
		// The job ends while 102 still runs: 102 is no orphan to adopt.
		const rows = parseTable(["  102     1   100 S", "  103   102   100 R"].join("\n"));
		assert.deepEqual(sweep(jobs.leftovers, rows, 1, COMMANDS, jobs.named).map((e) => [e.ended.pid, e.orphans.length]), [[101, 0]]);
		// Once 102 exits, its pid may be adopted again (reused by a job of a later call).
		table = "  102     1   100 S\n";
		await adoptLeftovers(jobs, 999, { startedBy: "other" }, ps, 60_000);
		assert.deepEqual([...jobs.named.keys()], ["102:100"], "still running");
		table = "";
		await adoptLeftovers(jobs, 999, { startedBy: "other" }, ps, 60_000);
		assert.deepEqual([...jobs.named.keys()], [], "exited: forgotten");
		clearInterval(jobs.poll);
	});

	test("a pid reused by a process in another group counts as ended", () => {
		const leftovers: Leftovers = new Map();
		adopt(leftovers, rows, 100, { startedBy: "cmd" }, 0, COMMANDS);
		const reused = parseTable(["  101     1   555 S", "  102     1   100 S", "  103   102   100 R"].join("\n"));
		assert.deepEqual(sweep(leftovers, reused, 1, COMMANDS).map((e) => e.ended.pid), [101]);
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

	test("the note on processes programs left names each one and how to stop it", () => {
		assert.equal(
			untrackedText([{ pid: 7, command: "git fsmonitor--daemon run --detach" }]),
			"Left running by programs this command ran, not by its own `&` jobs, so not tracked (their end is not reported, and they outlive the session):\n- pid 7: `git fsmonitor--daemon run --detach`\nStop one with `kill <pid>` if it is not wanted.",
		);
	});
});
