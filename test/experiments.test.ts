import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	type Arm,
	ARM_ENTRY,
	type ArmEntryData,
	applyToolSwitches,
	armUpdates,
	hashArm,
	listExperiments,
	recordedArms,
	runningExperiments,
	sectionName,
	stopExperiment,
	toolSwitches,
} from "../extensions/lib/experiments.ts";
import { crossedGroups, experimentCommand, renderComparison } from "../extensions/metrics/experiment.ts";
import { indexSessions } from "../extensions/metrics/indexer.ts";
import { type ArmSession, bootstrapContrast, cellsOf, compareCells, contrastWeight, experiments, Scope } from "../extensions/metrics/queries/index.ts";
import { openStore } from "../extensions/metrics/store.ts";
import { applyRules, listRules, promoteExperiment } from "../extensions/lib/rules.ts";
import prompt from "../extensions/prompt/index.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "experiments-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const experimentFile = (name: string, content: string, at = join(dir, "experiments")) => {
	mkdirSync(at, { recursive: true });
	writeFileSync(join(at, `${name}.md`), content);
	return at;
};

/** A session id whose hash puts it in `arm` of `experiment`. */
function sessionIn(arm: Arm, experiment: string, prefix = "s"): string {
	for (let i = 0; ; i++) if (hashArm(`${prefix}${i}`, experiment) === arm) return `${prefix}${i}`;
}

let clock = Date.parse("2026-11-13T10:00:00Z");
const armEntry = (data: ArmEntryData, ts = (clock += 1000)) => ({ type: "custom", customType: ARM_ENTRY, data, timestamp: new Date(ts).toISOString() });

describe("assignment", () => {
	test("is stable for a session and splits about 50/50", () => {
		const n = 20_000;
		let b = 0;
		for (let i = 0; i < n; i++) {
			const arm = hashArm(`session-${i}`, "parallel-tools");
			assert.equal(hashArm(`session-${i}`, "parallel-tools"), arm);
			if (arm === "B") b += 1;
		}
		// 4 standard deviations of a fair coin: fails by chance with p < 1e-4.
		assert.ok(Math.abs(b / n - 0.5) < 4 * Math.sqrt(0.25 / n), `share in B ${b / n}`);
	});

	test("arms of two experiments are independent", () => {
		const n = 20_000;
		const cells = { AA: 0, AB: 0, BA: 0, BB: 0 };
		for (let i = 0; i < n; i++) cells[`${hashArm(`id${i}`, "one")}${hashArm(`id${i}`, "two")}` as keyof typeof cells] += 1;
		for (const [cell, count] of Object.entries(cells)) {
			assert.ok(Math.abs(count / n - 0.25) < 4 * Math.sqrt((0.25 * 0.75) / n), `${cell}: ${count / n}`);
		}
	});

	test("a new session gets the hash arm for each running experiment, a resumed one nothing", () => {
		const running = [{ name: "one" }, { name: "two" }];
		const updates = armUpdates("sess", new Map(), running);
		assert.deepEqual(updates, [
			{ experiment: "one", arm: hashArm("sess", "one"), forced: false },
			{ experiment: "two", arm: hashArm("sess", "two"), forced: false },
		]);
		const recorded = recordedArms(updates.map((u) => armEntry(u)));
		assert.deepEqual(armUpdates("sess", recorded, running), []);
	});

	test("a forced arm wins over the hash, stays forced and keeps the first assignment time", () => {
		const first = armEntry({ experiment: "x", arm: "A", forced: false });
		const forced = armEntry({ experiment: "x", arm: "B", forced: true });
		const back = armEntry({ experiment: "x", arm: "A", forced: true });
		assert.deepEqual(recordedArms([first, forced]).get("x"), { arm: "B", forced: true, assignedAt: Date.parse(first.timestamp) });
		assert.deepEqual(recordedArms([first, forced, back]).get("x"), { arm: "A", forced: true, assignedAt: Date.parse(first.timestamp) });
		// A forced arm is an assignment: the next run adds nothing.
		assert.deepEqual(armUpdates("sess", recordedArms([forced]), [{ name: "x" }]), []);
	});

	test("an experiment that no longer runs ends once; running again reassigns the same arm", () => {
		const assigned = armEntry({ experiment: "x", arm: "B", forced: false });
		const ended = armUpdates("sess", recordedArms([assigned]), []);
		assert.deepEqual(ended, [{ experiment: "x", ended: true }]);
		const endEntry = armEntry(ended[0]!);
		const afterEnd = recordedArms([assigned, endEntry]);
		assert.equal(afterEnd.get("x")!.endedAt, Date.parse(endEntry.timestamp));
		assert.deepEqual(armUpdates("sess", afterEnd, []), [], "ended only once");
		assert.deepEqual(armUpdates("sess", afterEnd, [{ name: "x" }]), [{ experiment: "x", arm: "B", forced: false }]);
		const again = recordedArms([assigned, endEntry, armEntry({ experiment: "x", arm: "B", forced: false })]).get("x")!;
		assert.equal(again.endedAt, undefined);
		assert.equal(again.assignedAt, Date.parse(assigned.timestamp));
	});

	test("ignores other entries and malformed arm data", () => {
		const arms = recordedArms([
			{ type: "custom", customType: "other", data: { experiment: "x", arm: "B" }, timestamp: new Date().toISOString() },
			{ type: "custom", customType: ARM_ENTRY, data: { experiment: "x", arm: "C" }, timestamp: new Date().toISOString() },
			{ type: "custom", customType: ARM_ENTRY, timestamp: new Date().toISOString() },
			{ type: "message", timestamp: new Date().toISOString() },
			// An end without an assignment is nothing.
			armEntry({ experiment: "y", ended: true }),
		]);
		assert.equal(arms.size, 0);
	});
});

describe("experiment files", () => {
	test("reads frontmatter and body; empty, invalid and stopped experiments do not run", () => {
		const at = experimentFile("good", "---\nstatus: running\nstarted: 2026-11-13\n---\n\n- Do the thing.\n");
		experimentFile("plain", "- No frontmatter.");
		experimentFile("empty", "---\nstatus: running\n---\n\n");
		experimentFile("Bad Name", "text");
		experimentFile("stopped", "---\nstatus: stopped\n---\ntext");
		experimentFile("weird", "---\nstatus: paused\n---\ntext");
		experimentFile("broken", "---\nstatus: [\n---\ntext");
		writeFileSync(join(at, "notes.txt"), "not an experiment");
		const byName = new Map(listExperiments(at).map((e) => [e.name, e]));
		assert.deepEqual([...byName.keys()], ["Bad Name", "broken", "empty", "good", "plain", "stopped", "weird"]);
		assert.equal(byName.get("good")!.body, "- Do the thing.");
		assert.equal(byName.get("good")!.frontmatter.started, "2026-11-13");
		assert.equal(byName.get("plain")!.status, "running");
		assert.equal(byName.get("empty")!.problem, "empty variant");
		assert.match(byName.get("Bad Name")!.problem!, /invalid name/);
		assert.match(byName.get("weird")!.problem!, /unknown status/);
		assert.match(byName.get("broken")!.problem!, /unreadable frontmatter/);
		assert.equal(byName.get("stopped")!.status, "stopped");
		assert.deepEqual(runningExperiments(at).map((e) => e.name), ["good", "plain"]);
	});

	test("interacts names other experiments, as a name or a list", () => {
		const at = experimentFile("one", "---\ninteracts: two\n---\ntext");
		experimentFile("many", "---\ninteracts: [one, two]\n---\ntext", at);
		experimentFile("none", "text", at);
		experimentFile("self", "---\ninteracts: self\n---\ntext", at);
		experimentFile("number", "---\ninteracts: [3]\n---\ntext", at);
		experimentFile("invalid", "---\ninteracts: Not A Name\n---\ntext", at);
		experimentFile("object", "---\ninteracts: {a: b}\n---\ntext", at);
		const byName = new Map(listExperiments(at).map((e) => [e.name, e]));
		assert.deepEqual(byName.get("one")!.interacts, ["two"]);
		assert.deepEqual(byName.get("many")!.interacts, ["one", "two"]);
		assert.deepEqual(byName.get("none")!.interacts, []);
		for (const name of ["self", "number", "invalid", "object"]) assert.match(byName.get(name)!.problem!, /interacts must name other experiments/, name);
		assert.deepEqual(runningExperiments(at).map((e) => e.name), ["many", "none", "one"]);
		// Each pair once, the declaring experiment first; experiments with a problem declare nothing.
		assert.deepEqual(crossedGroups(listExperiments(at)), [["many", "one"], ["many", "two"], ["one", "two"]]);
	});

	test("tools name the tools of arm B; a tools-only experiment is valid", () => {
		const at = experimentFile("one", "---\ntools: fix_loop\n---\n");
		experimentFile("list", "---\ntools: [define_tool, codemode, codemode]\n---\nText.", at);
		experimentFile("bad", "---\ntools: [\"no spaces\"]\n---\nText.", at);
		experimentFile("number", "---\ntools: 3\n---\nText.", at);
		experimentFile("empty", "---\ntools: []\n---\n", at);
		const byName = new Map(listExperiments(at).map((e) => [e.name, e]));
		assert.deepEqual(byName.get("one")!.tools, ["fix_loop"]);
		assert.equal(byName.get("one")!.problem, undefined);
		assert.deepEqual(byName.get("list")!.tools, ["define_tool", "codemode"], "duplicates once");
		assert.match(byName.get("bad")!.problem!, /tools must name tools/);
		assert.match(byName.get("number")!.problem!, /tools must name tools/);
		assert.equal(byName.get("empty")!.problem, "empty variant");
	});

	test("tool switches: on in arm B of a running experiment, off otherwise; problems switch nothing", () => {
		const at = experimentFile("a", "---\ntools: [shared, only_a]\n---\n");
		experimentFile("b", "---\ntools: shared\n---\n", at);
		experimentFile("off", "---\nstatus: stopped\ntools: stopped_tool\n---\n", at);
		experimentFile("broken", "---\nstatus: paused\ntools: broken_tool\n---\n", at);
		const all = listExperiments(at);
		let id = "";
		for (let i = 0; ; i++) if (hashArm(`u${i}`, "a") === "A" && hashArm(`u${i}`, "b") === "B") { id = `u${i}`; break; }
		assert.deepEqual(Object.fromEntries(toolSwitches(all, id, new Map())), { shared: true, only_a: false, stopped_tool: false }, "on in any B wins");
		const forced = recordedArms([armEntry({ experiment: "a", arm: "B", forced: true }), armEntry({ experiment: "b", arm: "A", forced: true })]);
		assert.deepEqual(Object.fromEntries(toolSwitches(all, id, forced)), { shared: true, only_a: true, stopped_tool: false });
		assert.deepEqual(applyToolSwitches(["x", "only_a", "y"], new Map([["only_a", false], ["shared", true], ["z", false]])), ["x", "y", "shared"]);
		assert.deepEqual(applyToolSwitches([], new Map()), []);
	});

	test("a missing directory has no experiments", () => {
		assert.deepEqual(listExperiments(join(dir, "nope")), []);
	});

	test("stopping keeps the body and other keys and can be undone by status: running", () => {
		const at = experimentFile("x", "---\nstarted: 2026-11-13\nhypothesis: fewer turns\n---\n\nBody line.\n");
		stopExperiment(listExperiments(at)[0]!, new Date("2026-11-20T08:00:00Z"));
		const [stopped] = listExperiments(at);
		assert.equal(stopped!.status, "stopped");
		assert.equal(stopped!.body, "Body line.");
		assert.deepEqual(stopped!.frontmatter, { started: "2026-11-13", hypothesis: "fewer turns", status: "stopped", stopped: "2026-11-20T08:00:00.000Z" });
		writeFileSync(stopped!.file, readFileSync(stopped!.file, "utf8").replace("status: stopped", "status: running"));
		assert.deepEqual(runningExperiments(at).map((e) => e.name), ["x"]);
	});
});

describe("prompt extension", () => {
	/**
	 * Run the extension's before_agent_start against an in-memory session; returns the custom
	 * sections. The tool selection carries over between runs, as Pi's active tools do.
	 */
	function harness(sessionId: string, experimentsDir: string, initialTools = ["read", "bash", "edit", "write"], rulesDir = join(dir, "rules")) {
		const entries: ReturnType<typeof armEntry>[] = [];
		const notices: string[] = [];
		let handler: ((event: unknown, ctx: unknown) => void) | undefined;
		const pi = {
			on: (name: string, h: typeof handler) => {
				if (name === "before_agent_start") handler = h;
			},
			appendEntry: (customType: string, data: ArmEntryData) => entries.push({ ...armEntry(data), customType }),
		};
		prompt(pi as never, experimentsDir, rulesDir);
		const ctx = { hasUI: true, ui: { notify: (text: string) => notices.push(text) }, sessionManager: { getSessionId: () => sessionId, getEntries: () => entries } };
		let tools = initialTools;
		const run = () => {
			const options = { customPrompt: undefined, contextFiles: [], sections: { cwd: "Current working directory: /x" } as Record<string, string>, selectedTools: [...tools], toolGuidelines: {}, promptGuidelines: [] };
			handler!({ systemPromptOptions: options }, ctx);
			tools = options.selectedTools;
			const { cwd: _, ...added } = options.sections;
			return added;
		};
		return { entries, notices, run, tools: () => tools };
	}

	test("rules are sections and tools for every session, before the experiments", () => {
		const rules = experimentFile("batch", "---\npromoted: 2026-11-12\n---\nBatch calls.\n", join(dir, "rules"));
		experimentFile("loop", "---\ntools: [workflow, fix_loop]\n---\n", rules);
		const at = experimentFile("x", "---\ntools: fix_loop\n---\nVariant.");
		for (const arm of ["A", "B"] as const) {
			const session = harness(sessionIn(arm, "x"), at);
			const sections = session.run();
			assert.deepEqual(Object.keys(sections), arm === "B" ? ["batch", "experiment-x"] : ["batch"], `arm ${arm}: the rule's section first`);
			assert.equal(sections.batch, "Batch calls.");
			assert.deepEqual(session.tools(), ["read", "bash", "edit", "write", "fix_loop", "workflow"], `arm ${arm}: a rule's tool stays on although the experiment switches it off in arm A`);
			assert.deepEqual(session.notices, []);
		}
		rmSync(join(rules, "loop.md"));
		const later = harness("later", join(dir, "none"), ["read", "workflow"]);
		later.run();
		assert.deepEqual(later.tools(), ["read", "workflow"], "a removed rule no longer switches anything; the tool's own registration decides");
	});

	test("rules with a problem or a taken section name are left out and reported once", () => {
		const rules = experimentFile("cwd", "Shadows Pi's section.", join(dir, "rules"));
		experimentFile("empty", "---\npromoted: 2026-11-12\n---\n", rules);
		experimentFile("Bad", "text", rules);
		experimentFile("tools", "---\ntools: [\"no spaces\"]\n---\nX", rules);
		experimentFile("ok", "Fine.", rules);
		const session = harness("s", join(dir, "none"));
		assert.deepEqual(session.run(), { ok: "Fine." });
		assert.equal(session.notices.length, 1);
		const lines = session.notices[0]!.split("\n");
		assert.equal(lines[0], "Ignored prompt rules:");
		assert.deepEqual(
			lines.slice(1).map((line) => line.slice(rules.length + 1)),
			["Bad.md: invalid name (use ^[a-z0-9][a-z0-9_-]*$)", "cwd.md: the prompt has a section cwd already", "empty.md: empty rule", 'tools.md: tools must name tools, got ["no spaces"]'],
		);
		session.run();
		assert.equal(session.notices.length, 1, "the same problems are not reported again");
	});

	test("applyRules adds sections in file order and collects tools, a tools-only rule adds no section", () => {
		const rules = experimentFile("b", "---\ntools: [codemode, workflow]\n---\n", join(dir, "rules"));
		experimentFile("a", "---\ntools: workflow\n---\nA.", rules);
		const sections: Record<string, string> = {};
		const { tools, problems } = applyRules(listRules(rules), sections);
		assert.deepEqual(sections, { a: "A." });
		assert.deepEqual([...tools], ["workflow", "codemode"]);
		assert.equal(problems, "");
		assert.deepEqual(listRules(join(dir, "none")), []);
	});

	test("only arm B gets the variant as its own section, and the arm is recorded once", () => {
		const at = experimentFile("parallel-tools", "---\nstatus: running\n---\n- Batch calls.\n");
		const b = harness(sessionIn("B", "parallel-tools"), at);
		assert.deepEqual(b.run(), { [sectionName("parallel-tools")]: "- Batch calls." });
		assert.deepEqual(b.run(), { "experiment-parallel-tools": "- Batch calls." }, "resumed: same section");
		assert.deepEqual(b.entries.map((e) => e.data), [{ experiment: "parallel-tools", arm: "B", forced: false }]);

		const a = harness(sessionIn("A", "parallel-tools"), at);
		assert.deepEqual(a.run(), {});
		assert.deepEqual(a.entries.map((e) => e.data), [{ experiment: "parallel-tools", arm: "A", forced: false }]);
	});

	test("a forced arm changes the section from the next run; a stopped or removed experiment drops it and ends the arm", () => {
		const at = experimentFile("x", "Variant.");
		const session = harness(sessionIn("A", "x"), at);
		assert.deepEqual(session.run(), {});
		session.entries.push(armEntry({ experiment: "x", arm: "B", forced: true }));
		assert.deepEqual(session.run(), { "experiment-x": "Variant." });
		stopExperiment(listExperiments(at)[0]!);
		assert.deepEqual(session.run(), {});
		assert.deepEqual(session.entries.at(-1)!.data, { experiment: "x", ended: true });
		rmSync(join(at, "x.md"));
		assert.deepEqual(session.run(), {});
		assert.equal(session.entries.length, 3, "ended once");
	});

	test("arm B gets the experiment's tools, arm A not; other tools keep their order", () => {
		const at = experimentFile("fix-loop", "---\ntools: fix_loop\n---\n");
		experimentFile("both", "---\ntools: [define_tool, codemode]\n---\nUse them.", at);
		const id = (arms: string) => {
			for (let i = 0; ; i++) if (hashArm(`t${i}`, "fix-loop") + hashArm(`t${i}`, "both") === arms) return `t${i}`;
		};
		const bb = harness(id("BB"), at);
		assert.deepEqual(bb.run(), { "experiment-both": "Use them." }, "a tools-only experiment adds no section");
		assert.deepEqual(bb.tools(), ["read", "bash", "edit", "write", "define_tool", "codemode", "fix_loop"]);
		assert.deepEqual(bb.run(), { "experiment-both": "Use them." });
		assert.deepEqual(bb.tools(), ["read", "bash", "edit", "write", "define_tool", "codemode", "fix_loop"], "resumed: same tools, no duplicates");

		const ab = harness(id("AB"), at, ["read", "fix_loop", "bash"]);
		ab.run();
		assert.deepEqual(ab.tools(), ["read", "bash", "define_tool", "codemode"], "arm A removes a tool even if something activated it");
		const aa = harness(id("AA"), at);
		aa.run();
		assert.deepEqual(aa.tools(), ["read", "bash", "edit", "write"]);
	});

	test("forcing an arm switches the tools from the next run; stopping turns them off for everyone", () => {
		const at = experimentFile("x", "---\ntools: [x_tool]\n---\nVariant.");
		const session = harness(sessionIn("A", "x"), at);
		session.run();
		assert.deepEqual(session.tools(), ["read", "bash", "edit", "write"]);
		session.entries.push(armEntry({ experiment: "x", arm: "B", forced: true }));
		session.run();
		assert.deepEqual(session.tools(), ["read", "bash", "edit", "write", "x_tool"]);
		session.entries.push(armEntry({ experiment: "x", arm: "A", forced: true }));
		session.run();
		assert.deepEqual(session.tools(), ["read", "bash", "edit", "write"]);

		const b = harness(sessionIn("B", "x"), at);
		b.run();
		assert.deepEqual(b.tools().at(-1), "x_tool");
		stopExperiment(listExperiments(at)[0]!);
		b.run();
		assert.deepEqual(b.tools(), ["read", "bash", "edit", "write"], "stopped: off");
		rmSync(join(at, "x.md"));
		const later = harness(sessionIn("B", "x"), at, ["read", "x_tool"]);
		later.run();
		assert.deepEqual(later.tools(), ["read", "x_tool"], "no file: the experiments no longer switch the tool");
	});

	test("empty or invalid experiments assign nothing", () => {
		const at = experimentFile("empty", "---\nstatus: running\n---\n");
		experimentFile("Bad", "text", at);
		const session = harness("any", at);
		assert.deepEqual(session.run(), {});
		assert.equal(session.entries.length, 0);
	});
});

describe("index", () => {
	const time = (minute: number) => new Date(Date.parse("2026-11-13T10:00:00Z") + minute * 60_000).toISOString();
	const usage = { input: 1, output: 10, cacheRead: 0, cacheWrite: 100, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0.01, total: 0.013 } };
	const assistant = (calls: number) => ({
		role: "assistant",
		content: Array.from({ length: calls }, (_, i) => ({ type: "toolCall", id: `c${Math.random()}${i}`, name: "bash", arguments: { command: "ls" } })),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		usage,
		stopReason: calls ? "toolUse" : "stop",
		timestamp: 0,
	});

	test("records arms per session and tool calls per turn", () => {
		const sessions = join(dir, "sessions");
		mkdirSync(sessions, { recursive: true });
		let id = 0;
		const line = (minute: number, body: object) => ({ id: `e${++id}`, parentId: id > 1 ? `e${id - 1}` : null, timestamp: time(minute), ...body });
		const lines = [
			{ type: "session", version: 3, id: "sess-1", timestamp: time(0), cwd: "/p" },
			line(0, { type: "message", message: { role: "user", content: "go", timestamp: 0 } }),
			line(1, { type: "message", message: assistant(3) }),
			line(2, { type: "custom", customType: ARM_ENTRY, data: { experiment: "x", arm: "A", forced: false } }),
			line(3, { type: "message", message: assistant(0) }),
			line(4, { type: "custom", customType: ARM_ENTRY, data: { experiment: "y", arm: "B", forced: false } }),
			line(5, { type: "custom", customType: ARM_ENTRY, data: { experiment: "y", arm: "A", forced: true } }),
			line(6, { type: "custom", customType: ARM_ENTRY, data: { experiment: "x", ended: true } }),
		];
		writeFileSync(join(sessions, "s.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		const db = openStore(join(dir, "metrics.db"));
		assert.deepEqual(indexSessions(db, sessions).failed, []);
		const arms = db.prepare("SELECT experiment, arm, forced, assigned_at, ended_at FROM experiment_arms ORDER BY experiment").all().map((r) => ({ ...r }));
		assert.deepEqual(arms, [
			{ experiment: "x", arm: "A", forced: 0, assigned_at: Date.parse(time(2)), ended_at: Date.parse(time(6)) },
			{ experiment: "y", arm: "A", forced: 1, assigned_at: Date.parse(time(4)), ended_at: null },
		]);
		const calls = db.prepare("SELECT tool_calls FROM requests WHERE kind = 'turn' ORDER BY ts").all().map((r) => r.tool_calls);
		assert.deepEqual(calls, [3, 0]);
		// A session without arm entries has no rows; re-indexing replaces the rows.
		writeFileSync(join(sessions, "s.jsonl"), `${lines.slice(0, 3).map((l) => JSON.stringify(l)).join("\n")}\n`);
		indexSessions(db, sessions);
		assert.equal((db.prepare("SELECT COUNT(*) n FROM experiment_arms").get() as { n: number }).n, 0);
		db.close();
	});
});

describe("comparison", () => {
	const T = Date.parse("2026-11-13T10:00:00Z");
	const MIN = 60_000;

	interface ArmRow {
		experiment?: string;
		arm: Arm;
		forced?: boolean;
		assigned?: number;
		ended?: number;
	}

	/**
	 * Insert a session with arm rows (its own in experiment x, plus `arms`), turns (minute, tool
	 * calls, cost, read cost), tool results, file-changing tool calls (minute, tool, files written;
	 * none for a shell write whose files are unknown) and user messages.
	 */
	function addSession(db: DatabaseSync, s: ArmRow & { id: string; cwd: string; arms?: ArmRow[]; turns: [number, number, number, number][]; errors?: [number, boolean][]; changes?: [number, string, string[]][]; users?: [number, string][] }) {
		db.prepare("INSERT INTO sessions (id, file, cwd, started_at, ended_at, requests, cost, aborted, errors, compactions, user_messages) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)").run(
			s.id, `/${s.id}.jsonl`, s.cwd, T, T + 100 * MIN);
		for (const a of [s, ...(s.arms ?? [])]) {
			db.prepare("INSERT INTO experiment_arms VALUES (?, ?, ?, ?, ?, ?)").run(s.id, a.experiment ?? "x", a.arm, a.forced ? 1 : 0, T + (a.assigned ?? 0) * MIN, a.ended === undefined ? null : T + a.ended * MIN);
		}
		(s.changes ?? []).forEach(([minute, tool, files], i) => {
			db.prepare(`INSERT INTO tool_results (session_id, call_id, ts, tool, summary, is_error, tokens, requests_in_context, lifetime_cost, mutates)
				VALUES (?, ?, ?, ?, '', 0, 0, 0, 0, 1)`).run(s.id, `c${i}`, T + minute * MIN, tool);
			for (const file of files) db.prepare("INSERT INTO tool_files VALUES (?, ?, ?, ?, 1)").run(s.id, `c${i}`, T + minute * MIN, file);
		});
		s.turns.forEach(([minute, calls, cost, read], i) => {
			db.prepare(`INSERT INTO requests (session_id, entry_id, ts, kind, provider, model, input, output, cache_read, cache_write, prompt_tokens, cost, message_count,
				cost_input, cost_output, cost_read, cost_write, trigger_tokens, cache_lost, cache_waste, tool_calls)
				VALUES (?, ?, ?, 'turn', 'anthropic', 'opus', 0, 0, 0, 0, 0, ?, 0, 0, 0, ?, 0, 0, 0, 0, ?)`).run(s.id, `r${i}`, T + minute * MIN, cost, read, calls);
		});
		(s.errors ?? []).forEach(([minute, error], i) => {
			db.prepare(`INSERT INTO tool_results (session_id, call_id, ts, tool, summary, is_error, tokens, requests_in_context, lifetime_cost, mutates)
				VALUES (?, ?, ?, 'bash', '', ?, 0, 0, 0, 0)`).run(s.id, `t${i}`, T + minute * MIN, error ? 1 : 0);
		});
		(s.users ?? []).forEach(([minute, kind], i) => {
			db.prepare("INSERT INTO user_messages (session_id, entry_id, ts, kind, text) VALUES (?, ?, ?, ?, '')").run(s.id, `u${i}`, T + minute * MIN, kind);
		});
	}

	test("compares random sessions in shared projects over their time in the experiment", () => {
		const db = openStore(join(dir, "metrics.db"));
		// Project /p: A1, A2 (control) and B1, B2 (variant).
		addSession(db, { id: "A1", cwd: "/p", arm: "A", turns: [[1, 1, 1, 0.5], [2, 1, 1, 0.5]], errors: [[1, false], [2, false]], users: [[0.5, "first"], [1.5, "steer"]] });
		addSession(db, { id: "A2", cwd: "/p", arm: "A", turns: [[3, 1, 2, 1], [4, 0, 2, 1]], errors: [[3, true]], users: [[2.5, "first"]] });
		// B1 ran two turns before it was assigned (minute 5): they do not count.
		addSession(db, { id: "B1", cwd: "/p", arm: "B", assigned: 5, turns: [[1, 9, 9, 9], [2, 9, 9, 9], [6, 3, 1, 0.2]], errors: [[1, true], [6, false], [6, false], [6, false]], users: [[0.5, "first"], [5.5, "follow-up"]] });
		// B2's experiment ended at minute 10: later turns do not count.
		addSession(db, { id: "B2", cwd: "/p", arm: "B", ended: 10, turns: [[7, 2, 1, 0.2], [11, 9, 9, 9]], errors: [[7, false], [7, true]], users: [[6.5, "first"]] });
		// Left out: a forced session, a project with only one arm, a session with no turns, another experiment.
		addSession(db, { id: "F", cwd: "/p", arm: "B", forced: true, turns: [[1, 5, 5, 5]] });
		addSession(db, { id: "Q", cwd: "/q", arm: "A", turns: [[1, 5, 5, 5]] });
		addSession(db, { id: "E", cwd: "/p", arm: "A", turns: [] });
		addSession(db, { id: "O", cwd: "/p", arm: "B", experiment: "other", turns: [[1, 1, 1, 1]] });

		const [x] = experiments(new Scope(db, {}), [["x"]]);
		assert.deepEqual({ ...x, metrics: undefined }, {
			experiments: ["x"],
			cells: ["A", "B"],
			sessions: { A: 2, B: 2 },
			turns: { A: 4, B: 2 },
			forced: 1,
			unmatched: 1,
			projects: ["/p"],
			metrics: undefined,
		});
		const m = Object.fromEntries(x!.metrics.map((metric) => [metric.key, metric]));
		assert.equal(m.toolCallsPerTurn!.values.A, 3 / 4);
		assert.equal(m.toolCallsPerTurn!.values.B, 5 / 2);
		assert.equal(m.toolCallsPerTurn!.effect, 5 / 2 - 3 / 4);
		assert.equal(m.batchedTurns!.values.A, 0);
		assert.equal(m.batchedTurns!.values.B, 1);
		assert.equal(m.turnsPerPackage!.values.A, 4 / 2, "steers are no package");
		assert.equal(m.turnsPerPackage!.values.B, 2 / 2, "B1's first message came before its assignment");
		assert.equal(m.turnsPerSession!.values.A, 2);
		assert.equal(m.costPerSession!.values.A, 3);
		assert.equal(m.costPerSession!.values.B, 1);
		assert.equal(m.readCostPerSession!.values.B, 0.2);
		assert.equal(m.costPerTurn!.values.A, 6 / 4);
		assert.equal(m.readCostPerTurn!.values.A, 3 / 4);
		assert.equal(m.toolErrorRate!.values.A, 1 / 3);
		assert.equal(m.toolErrorRate!.values.B, 1 / 5);
		assert.ok(m.toolCallsPerTurn!.ci, "two sessions per arm give an interval");

		assert.deepEqual(experiments(new Scope(db, {})).map((e) => e.experiments), [["other"], ["x"]]);
		// The time window applies on top: only minutes 0–5 leave A's sessions and none of B's.
		const early = experiments(new Scope(db, { end: T + 5 * MIN }), [["x"]])[0]!;
		assert.deepEqual(early.sessions, { A: 0, B: 0 }, "B has no turns before 5, so /p has one arm only");
		assert.equal(early.unmatched, 3);
		// The project filter keeps /q only: one arm, nothing compared.
		assert.deepEqual(experiments(new Scope(db, { project: "/q" }), [["x"]])[0]!.sessions, { A: 0, B: 0 });
		const text = renderComparison(x!);
		assert.match(text, /^x: A 2 sessions \/ 4 turns, B 2 \/ 2 \(1 project with every arm\)$/m);
		assert.match(text, /left out: 1 forced, 1 in projects missing an arm/);
		assert.match(text, /tool calls per turn\s+0\.75\s+2\.50\s+\+1\.75/);
		db.close();
	});

	test("crosses two experiments over the time a session was in both, with the edit metrics", () => {
		const db = openStore(join(dir, "metrics.db"));
		const y = (arm: Arm, row: Omit<ArmRow, "arm" | "experiment"> = {}): ArmRow[] => [{ experiment: "y", arm, ...row }];
		const turn = (minute: number): [number, number, number, number] => [minute, 1, 1, 0];
		// AA: shell writes only (one with unknown files).
		addSession(db, { id: "aa", cwd: "/p", arm: "A", arms: y("A"), turns: [turn(1), turn(2)], changes: [[1, "bash", ["/p/a.ts"]], [2, "bash", []]] });
		// AB: half the changes via edit, three edits on one file.
		addSession(db, { id: "ab", cwd: "/p", arm: "A", arms: y("B"), turns: [turn(1)], changes: [[1, "edit", ["/p/a.ts"]], [1, "edit", ["/p/a.ts"]], [1, "edit", ["/p/a.ts"]], [1, "bash", []], [1, "bash", []], [1, "bash", []]] });
		// BA: y started at minute 5, so x-only turns and changes before it do not count; edits on two files.
		addSession(db, { id: "ba", cwd: "/p", arm: "B", arms: y("A", { assigned: 5 }), turns: [turn(1), turn(6)], changes: [[1, "bash", []], [6, "edit", ["/p/a.ts"]], [6, "edit", ["/p/b.ts"]], [6, "write", ["/p/c.ts"]]] });
		// BB: x ended at minute 10, y never; later turns do not count.
		addSession(db, { id: "bb", cwd: "/p", arm: "B", ended: 10, arms: y("B"), turns: [turn(1), turn(11)], changes: [[1, "edit", ["/p/a.ts"]], [1, "edit", ["/p/b.ts"]], [11, "bash", []]] });
		// y ended (minute 3) before x started (minute 4): no time in both, no turns.
		addSession(db, { id: "gap", cwd: "/p", arm: "B", assigned: 4, arms: y("B", { ended: 3 }), turns: [turn(1), turn(5)] });
		// Only in x: not part of the crossed comparison. Forced in y: left out.
		addSession(db, { id: "xonly", cwd: "/p", arm: "A", turns: [turn(1)] });
		addSession(db, { id: "forced", cwd: "/p", arm: "A", arms: y("B", { forced: true }), turns: [turn(1)] });

		const [crossed] = experiments(new Scope(db, {}), [["x", "y"]]);
		assert.deepEqual(crossed!.sessions, { AA: 1, AB: 1, BA: 1, BB: 1 });
		assert.deepEqual(crossed!.turns, { AA: 2, AB: 1, BA: 1, BB: 1 });
		assert.equal(crossed!.forced, 1);
		assert.equal(crossed!.unmatched, 0);
		const m = Object.fromEntries(crossed!.metrics.map((metric) => [metric.key, metric]));
		assert.deepEqual(m.toolMutationShare!.values, { AA: 0, AB: 0.5, BA: 1, BB: 1 });
		assert.equal(m.toolMutationShare!.effect, (1 - 1) - (0.5 - 0));
		assert.deepEqual(m.editCallsPerFile!.values, { AA: null, AB: 3, BA: 1, BB: 1 }, "write calls are no edits");
		assert.equal(m.editCallsPerFile!.effect, null);
		// The crossed order is the caller's: the cells swap their letters.
		const [swapped] = experiments(new Scope(db, {}), [["y", "x"]]);
		assert.deepEqual(swapped!.metrics.find((x) => x.key === "toolMutationShare")!.values, { AA: 0, AB: 1, BA: 0.5, BB: 1 });
		// x alone sees every session in it over its own time: xonly, forced (forced in y only) and gap
		// count, and ba's minute-1 change does.
		const [alone] = experiments(new Scope(db, {}), [["x"]]);
		assert.deepEqual(alone!.sessions, { A: 4, B: 3 });
		assert.equal(alone!.metrics.find((x) => x.key === "toolMutationShare")!.values.B, (3 + 2) / (4 + 2));
		db.close();
	});

	test("an experiment without sessions or with one arm only reports no metrics", () => {
		const empty = compareCells(["x"], []);
		assert.deepEqual(empty.sessions, { A: 0, B: 0 });
		assert.ok(empty.metrics.every((m) => m.values.A === null && m.values.B === null && m.effect === null && m.ci === null));
		assert.match(renderComparison(empty), /no comparable sessions yet/);
	});

	test("cells and contrast weights: B − A for one experiment, the interaction for two", () => {
		assert.deepEqual(cellsOf(1), ["A", "B"]);
		assert.deepEqual(cellsOf(2), ["AA", "AB", "BA", "BB"]);
		assert.equal(cellsOf(3).length, 8);
		assert.deepEqual(cellsOf(1).map(contrastWeight), [-1, 1]);
		assert.deepEqual(cellsOf(2).map(contrastWeight), [1, -1, -1, 1]);
		// Every contrast sums to zero: a constant metric has no effect.
		assert.equal(cellsOf(3).map(contrastWeight).reduce((x, y) => x + y), 0);
	});

	test("the bootstrap interval covers the contrast, is deterministic and needs two sessions per group", () => {
		const group = (base: number, weight: number) => ({ pairs: Array.from({ length: 40 }, (_, i): [number, number] => [base + (i % 5), 10]), weight });
		const [a, b] = [group(10, -1), group(20, 1)];
		const ci = bootstrapContrast([a, b])!;
		assert.ok(ci[0] > 0.8 && ci[1] < 1.2 && ci[0] <= 1 && ci[1] >= 1, `ci ${ci}`);
		assert.deepEqual(bootstrapContrast([a, b]), ci);
		assert.equal(bootstrapContrast([{ ...a, pairs: a.pairs.slice(0, 1) }, b]), null);
		// No difference: the interval spans zero.
		const same = bootstrapContrast([a, { ...a, weight: 1 }])!;
		assert.ok(same[0] < 0 && same[1] > 0);
		// Zero denominators everywhere: no ratio, no interval.
		assert.equal(bootstrapContrast([{ pairs: [[0, 0], [0, 0]], weight: -1 }, { pairs: [[1, 0], [1, 0]], weight: 1 }]), null);
		// Interaction: B adds 1 under A of the first experiment and 3 under its B, so the interaction is 2.
		const cells = [group(10, 1), group(20, -1), group(10, -1), group(40, 1)];
		const interaction = bootstrapContrast(cells)!;
		assert.ok(interaction[0] > 1.6 && interaction[1] < 2.4 && interaction[0] <= 2 && interaction[1] >= 2, `interaction ${interaction}`);
		// Same effect of B under both arms: the interval spans zero.
		const additive = bootstrapContrast([group(10, 1), group(20, -1), group(30, -1), group(40, 1)])!;
		assert.ok(additive[0] < 0 && additive[1] > 0, `additive ${additive}`);
	});

	const armSession = (id: string, cell: string, turns: number, toolCalls: number): ArmSession => ({
		session: id, project: "/p", cell, forced: false, turns, toolCalls, batchedTurns: 0, packages: 1, cost: 0, readCost: 0, toolResults: 0, toolErrors: 0,
		mutatingCalls: 0, toolMutatingCalls: 0, editCalls: 0, editedFiles: 0, childCost: 0, tools: {},
	});

	test("compareCells weighs sessions by their turns (ratio of sums)", () => {
		const c = compareCells(["x"], [armSession("a1", "A", 100, 100), armSession("a2", "A", 1, 5), armSession("b1", "B", 10, 20)]);
		assert.equal(c.metrics[0]!.values.A, 105 / 101);
		assert.equal(c.metrics[0]!.ci, null, "one session in B");
	});

	test("compareCells for two experiments: the interaction of the cells, projects need every cell", () => {
		const sessions = [
			armSession("aa", "AA", 10, 10), armSession("ab", "AB", 10, 20),
			armSession("ba", "BA", 10, 10), armSession("bb", "BB", 10, 40),
			// /q has three cells only: left out.
			{ ...armSession("q", "AA", 10, 90), project: "/q" }, { ...armSession("q2", "AB", 10, 90), project: "/q" }, { ...armSession("q3", "BB", 10, 90), project: "/q" },
		];
		const c = compareCells(["one", "two"], sessions);
		assert.deepEqual(c.cells, ["AA", "AB", "BA", "BB"]);
		assert.deepEqual(c.sessions, { AA: 1, AB: 1, BA: 1, BB: 1 });
		assert.deepEqual(c.projects, ["/p"]);
		assert.equal(c.unmatched, 3);
		const calls = c.metrics.find((m) => m.key === "toolCallsPerTurn")!;
		assert.deepEqual(calls.values, { AA: 1, AB: 2, BA: 1, BB: 4 });
		assert.equal(calls.effect, (4 - 1) - (2 - 1));
		assert.equal(calls.ci, null, "one session per cell");
		// A metric undefined in one cell has no effect.
		assert.equal(c.metrics.find((m) => m.key === "editCallsPerFile")!.effect, null);
		const text = renderComparison(c);
		assert.match(text, /^one × two: AA 1 session \/ 10 turns, AB 1 \/ 10, BA 1 \/ 10, BB 1 \/ 10 \(1 project with every cell\)$/m);
		assert.match(text, /^cells: arm in one, then two; interaction = how much two's B − A differs between the arms of one$/m);
		assert.match(text, /left out: 0 forced, 3 in projects missing a cell/);
		assert.match(text, /metric\s+AA\s+AB\s+BA\s+BB\s+interaction\s+95% CI/);
		assert.match(text, /tool calls per turn\s+1\.00\s+2\.00\s+1\.00\s+4\.00\s+\+2\.00\s+–/);
	});
});

describe("/harness experiment", () => {
	const result = compareCells(["x"], []);

	function context(at: string, recorded = new Map()) {
		const appended: ArmEntryData[] = [];
		const changelog = join(dir, "changelog.md");
		writeFileSync(changelog, "# Harness changelog\n");
		return { appended, changelog, ctx: { sessionId: sessionIn("B", "x"), recorded, appendEntry: (d: ArmEntryData) => appended.push(d), dir: at, changelog, compare: () => [result], now: new Date("2026-11-20T08:00:00Z") } };
	}

	test("without arguments lists experiments, this session's arm and the interim result", () => {
		const at = experimentFile("x", "---\nstarted: 2026-11-13\n---\nVariant.");
		experimentFile("empty", "", at);
		const { ctx } = context(at);
		const status = experimentCommand([], { ...ctx, compare: () => [result, compareCells(["gone"], [])] });
		assert.equal(status.level, "info");
		assert.match(status.text, /## x \(running, started 2026-11-13\)\nthis session: B \(variant\) from its next run\nx: A 0 sessions/);
		assert.match(status.text, /## empty \(ignored: empty variant\)/);
		assert.match(status.text, /## gone \(file removed\)/);
		const forced = experimentCommand([], { ...ctx, recorded: recordedArms([armEntry({ experiment: "x", arm: "A", forced: true })]) });
		assert.match(forced.text, /this session: A \(control\), forced/);
		assert.match(experimentCommand([], { ...ctx, dir: join(dir, "none"), compare: () => [] }).text, /No experiments/);
	});

	test("on and off force this session's arm", () => {
		const at = experimentFile("x", "Variant.");
		const { ctx, appended } = context(at);
		assert.match(experimentCommand(["x", "off"], ctx).text, /A \(control\) of x from its next run/);
		experimentCommand(["x", "on"], ctx);
		assert.deepEqual(appended, [{ experiment: "x", arm: "A", forced: true }, { experiment: "x", arm: "B", forced: true }]);
	});

	test("stop marks the file stopped and logs the result in the changelog", () => {
		const at = experimentFile("x", "Variant.");
		const { ctx, changelog } = context(at);
		const stopped = experimentCommand(["x", "stop"], ctx);
		assert.match(stopped.text, /^Stopped x/);
		assert.equal(listExperiments(at)[0]!.status, "stopped");
		const log = readFileSync(changelog, "utf8");
		assert.match(log, /^## 2026-11-20 — experiment stopped: x$/m);
		assert.match(log, /```\nx: A 0 sessions/);
		assert.match(experimentCommand(["x", "stop"], ctx).text, /already stopped/);
		// Running a release, the written files are committed to the harness repository to take effect.
		experimentFile("y", "Variant.", at);
		const published: [string[], string][] = [];
		const text = experimentCommand(["y", "stop"], { ...ctx, publish: (paths, message) => (published.push([paths, message]), "Committed abc.") }).text;
		assert.deepEqual(published, [[[join(at, "y.md")], "chore(experiments): stop y"]], "the changelog is local state, not committed");
		assert.match(text, /^Stopped y; result logged in the changelog\.\nCommitted abc\./);
		assert.match(experimentCommand(["x", "on"], ctx).text, /already stopped/);
	});

	test("declared interactions add the crossed comparison to the status and the stop entry", () => {
		const at = experimentFile("x", "---\ninteracts: y\n---\nVariant.");
		experimentFile("y", "---\ninteracts: x\n---\nOther.", at);
		experimentFile("z", "Unrelated.", at);
		const { ctx, changelog } = context(at);
		const asked: (string[][] | undefined)[] = [];
		const compare = (groups?: string[][]) => {
			asked.push(groups);
			return (groups ?? [["x"], ["y"], ["z"]]).map((group) => compareCells(group, []));
		};
		const status = experimentCommand([], { ...ctx, compare });
		assert.deepEqual(asked, [undefined, [["x", "y"]]], "the pair once, though both declare it");
		assert.match(status.text, /## x \(running\)\n.*\nx: A 0 sessions.*\nno comparable sessions yet\n\nx × y: AA 0 sessions/);
		assert.equal(status.text.match(/x × y/g)!.length, 1, "only under the experiment that comes first");
		assert.doesNotMatch(status.text.slice(status.text.indexOf("## z")), /×/);

		asked.length = 0;
		experimentCommand(["y", "stop"], { ...ctx, compare });
		assert.deepEqual(asked, [[["y"], ["x", "y"]]]);
		assert.match(readFileSync(changelog, "utf8"), /```\ny: A 0 sessions[^`]*\n\nx × y: AA 0 sessions[^`]*```/);
		// Stopped experiments keep their declared pairs: the data stays comparable.
		assert.deepEqual(crossedGroups(listExperiments(at)), [["x", "y"]]);
	});

	test("promote moves the experiment to a rule with its tools and logs the result", () => {
		const at = experimentFile("x", "---\nstatus: running\nstarted: 2026-11-13\ninteracts: y\ntools: [x_tool, y_tool]\n---\nVariant.\n");
		experimentFile("y", "---\ntools: y_tool\n---\n", at);
		const rules = join(dir, "rules");
		const { ctx, changelog } = context(at);
		const published: [string[], string][] = [];
		const promoted = experimentCommand(["x", "promote"], { ...ctx, rulesDir: rules, publish: (paths, message) => (published.push([paths, message]), "Committed abc.") });
		assert.match(promoted.text, /^Promoted x to a rule for every session; result logged in the changelog\.\nCommitted abc\./);
		assert.deepEqual(published, [[[join(rules, "x.md"), join(at, "x.md")], "chore(experiments): promote x"]]);
		assert.match(readFileSync(changelog, "utf8"), /promote/i, "the result is still logged locally");
		assert.deepEqual(listExperiments(at).map((e) => e.name), ["y"], "the experiment file is gone");
		assert.equal(readFileSync(join(rules, "x.md"), "utf8"), "---\ntools:\n  - x_tool\n  - y_tool\npromoted: 2026-11-20\n---\n\nVariant.\n");
		assert.deepEqual(listRules(rules), [{ name: "x", file: join(rules, "x.md"), body: "Variant.", tools: ["x_tool", "y_tool"] }]);
		const log = readFileSync(changelog, "utf8");
		assert.match(log, /^## 2026-11-20 — experiment promoted: x$/m);
		assert.match(log, /became the rule `prompt\/rules\/x\.md`/);
		assert.match(log, /\*\*Result at promote/);

		experimentCommand(["y", "promote"], { ...ctx, rulesDir: rules });
		assert.equal(readFileSync(join(rules, "y.md"), "utf8"), "---\ntools: y_tool\npromoted: 2026-11-20\n---\n\n\n", "a tools-only experiment keeps its single tool");
		experimentFile("y", "Again.", at);
		assert.throws(() => promoteExperiment(listExperiments(at)[0]!, rules), /y\.md exists already/);
		assert.equal(readFileSync(join(at, "y.md"), "utf8"), "Again.", "a refused promotion keeps the experiment");
	});

	test("rejects unknown experiments, ignored ones and bad arguments", () => {
		const at = experimentFile("x", "Variant.");
		experimentFile("empty", "", at);
		const { ctx, appended } = context(at);
		assert.match(experimentCommand(["nope", "on"], ctx).text, /No experiment nope/);
		assert.match(experimentCommand(["empty", "on"], ctx).text, /ignored: empty variant/);
		for (const args of [["x"], ["x", "maybe"], ["x", "on", "now"]]) {
			assert.deepEqual(experimentCommand(args, ctx), { text: "Usage: /harness experiment [<name> on|off|stop|promote]", level: "warning" });
		}
		assert.equal(appended.length, 0);
	});
});
