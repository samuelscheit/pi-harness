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
	armUpdates,
	hashArm,
	listExperiments,
	recordedArms,
	runningExperiments,
	sectionName,
	stopExperiment,
} from "../extensions/lib/experiments.ts";
import { experimentCommand, renderComparison } from "../extensions/metrics/experiment.ts";
import { indexSessions } from "../extensions/metrics/indexer.ts";
import { type ArmSession, bootstrapDiff, compareArms, experiments, Scope } from "../extensions/metrics/queries/index.ts";
import { openStore } from "../extensions/metrics/store.ts";
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
	/** Run the extension's before_agent_start against an in-memory session; returns the custom sections. */
	function harness(sessionId: string, experimentsDir: string) {
		const entries: ReturnType<typeof armEntry>[] = [];
		let handler: ((event: unknown, ctx: unknown) => void) | undefined;
		const pi = {
			on: (name: string, h: typeof handler) => {
				if (name === "before_agent_start") handler = h;
			},
			appendEntry: (customType: string, data: ArmEntryData) => entries.push({ ...armEntry(data), customType }),
		};
		prompt(pi as never, experimentsDir);
		const ctx = { sessionManager: { getSessionId: () => sessionId, getEntries: () => entries } };
		const run = () => {
			const options = { customPrompt: undefined, contextFiles: [], sections: {} as Record<string, string> };
			handler!({ systemPromptOptions: options }, ctx);
			return options.sections;
		};
		return { entries, run };
	}

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

	/** Insert a session with arm rows and turns (minute, tool calls, cost, read cost), tool results and user messages. */
	function addSession(db: DatabaseSync, s: { id: string; cwd: string; arm: Arm; forced?: boolean; assigned?: number; ended?: number; turns: [number, number, number, number][]; errors?: [number, boolean][]; users?: [number, string][]; experiment?: string }) {
		db.prepare("INSERT INTO sessions (id, file, cwd, started_at, ended_at, requests, cost, aborted, errors, compactions, user_messages) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)").run(
			s.id, `/${s.id}.jsonl`, s.cwd, T, T + 100 * MIN);
		db.prepare("INSERT INTO experiment_arms VALUES (?, ?, ?, ?, ?, ?)").run(s.id, s.experiment ?? "x", s.arm, s.forced ? 1 : 0, T + (s.assigned ?? 0) * MIN, s.ended === undefined ? null : T + s.ended * MIN);
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

		const [x] = experiments(new Scope(db, {}), "x");
		assert.deepEqual({ ...x, metrics: undefined }, {
			experiment: "x",
			sessions: { A: 2, B: 2 },
			turns: { A: 4, B: 2 },
			forced: 1,
			unmatched: 1,
			projects: ["/p"],
			metrics: undefined,
		});
		const m = Object.fromEntries(x!.metrics.map((metric) => [metric.key, metric]));
		assert.equal(m.toolCallsPerTurn!.a, 3 / 4);
		assert.equal(m.toolCallsPerTurn!.b, 5 / 2);
		assert.equal(m.toolCallsPerTurn!.diff, 5 / 2 - 3 / 4);
		assert.equal(m.batchedTurns!.a, 0);
		assert.equal(m.batchedTurns!.b, 1);
		assert.equal(m.turnsPerPackage!.a, 4 / 2, "steers are no package");
		assert.equal(m.turnsPerPackage!.b, 2 / 2, "B1's first message came before its assignment");
		assert.equal(m.turnsPerSession!.a, 2);
		assert.equal(m.costPerSession!.a, 3);
		assert.equal(m.costPerSession!.b, 1);
		assert.equal(m.readCostPerSession!.b, 0.2);
		assert.equal(m.costPerTurn!.a, 6 / 4);
		assert.equal(m.readCostPerTurn!.a, 3 / 4);
		assert.equal(m.toolErrorRate!.a, 1 / 3);
		assert.equal(m.toolErrorRate!.b, 1 / 5);
		assert.ok(m.toolCallsPerTurn!.ci, "two sessions per arm give an interval");

		assert.deepEqual(experiments(new Scope(db, {})).map((e) => e.experiment), ["other", "x"]);
		// The time window applies on top: only minutes 0–5 leave A's sessions and none of B's.
		const early = experiments(new Scope(db, { end: T + 5 * MIN }), "x")[0]!;
		assert.deepEqual(early.sessions, { A: 0, B: 0 }, "B has no turns before 5, so /p has one arm only");
		assert.equal(early.unmatched, 3);
		// The project filter keeps /q only: one arm, nothing compared.
		assert.deepEqual(experiments(new Scope(db, { project: "/q" }), "x")[0]!.sessions, { A: 0, B: 0 });
		const text = renderComparison(x!);
		assert.match(text, /x: 2 sessions \/ 4 turns in A, 2 \/ 2 in B \(1 project with both arms\)/);
		assert.match(text, /left out: 1 forced, 1 in projects with one arm only/);
		assert.match(text, /tool calls per turn\s+0\.75\s+2\.50\s+\+1\.75/);
		db.close();
	});

	test("an experiment without sessions or with one arm only reports no metrics", () => {
		const empty = compareArms("x", []);
		assert.deepEqual(empty.sessions, { A: 0, B: 0 });
		assert.ok(empty.metrics.every((m) => m.a === null && m.b === null && m.diff === null && m.ci === null));
		assert.match(renderComparison(empty), /no comparable sessions yet/);
	});

	test("the bootstrap interval covers the difference, is deterministic and needs two sessions per arm", () => {
		const session = (calls: number, turns: number): [number, number] => [calls, turns];
		const a = Array.from({ length: 40 }, (_, i) => session(10 + (i % 5), 10));
		const b = Array.from({ length: 40 }, (_, i) => session(20 + (i % 5), 10));
		const ci = bootstrapDiff(a, b)!;
		assert.ok(ci[0] > 0.8 && ci[1] < 1.2 && ci[0] <= 1 && ci[1] >= 1, `ci ${ci}`);
		assert.deepEqual(bootstrapDiff(a, b), ci);
		assert.equal(bootstrapDiff(a.slice(0, 1), b), null);
		// No difference: the interval spans zero.
		const same = bootstrapDiff(a, a.map(([n, d]) => [n, d] as [number, number]))!;
		assert.ok(same[0] < 0 && same[1] > 0);
		// Zero denominators everywhere: no ratio, no interval.
		assert.equal(bootstrapDiff([[0, 0], [0, 0]], [[1, 0], [1, 0]]), null);
	});

	test("compareArms weighs sessions by their turns (ratio of sums)", () => {
		const s = (id: string, arm: Arm, turns: number, toolCalls: number): ArmSession => ({
			session: id, project: "/p", arm, forced: false, turns, toolCalls, batchedTurns: 0, packages: 1, cost: 0, readCost: 0, toolResults: 0, toolErrors: 0,
		});
		const c = compareArms("x", [s("a1", "A", 100, 100), s("a2", "A", 1, 5), s("b1", "B", 10, 20)]);
		assert.equal(c.metrics[0]!.a, 105 / 101);
		assert.equal(c.metrics[0]!.ci, null, "one session in B");
	});
});

describe("/harness experiment", () => {
	const result = compareArms("x", []);

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
		const status = experimentCommand([], { ...ctx, compare: () => [result, compareArms("gone", [])] });
		assert.equal(status.level, "info");
		assert.match(status.text, /## x \(running, started 2026-11-13\)\nthis session: B \(variant\) from its next run\nx: 0 sessions/);
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
		assert.match(log, /```\nx: 0 sessions/);
		assert.match(experimentCommand(["x", "stop"], ctx).text, /already stopped/);
		assert.match(experimentCommand(["x", "on"], ctx).text, /already stopped/);
	});

	test("rejects unknown experiments, ignored ones and bad arguments", () => {
		const at = experimentFile("x", "Variant.");
		experimentFile("empty", "", at);
		const { ctx, appended } = context(at);
		assert.match(experimentCommand(["nope", "on"], ctx).text, /No experiment nope/);
		assert.match(experimentCommand(["empty", "on"], ctx).text, /ignored: empty variant/);
		for (const args of [["x"], ["x", "maybe"], ["x", "on", "now"]]) {
			assert.deepEqual(experimentCommand(args, ctx), { text: "Usage: /harness experiment [<name> on|off|stop]", level: "warning" });
		}
		assert.equal(appended.length, 0);
	});
});
