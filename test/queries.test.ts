import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import {
	breakdown,
	coldResumes,
	compactionOpportunities,
	compactions,
	contentCosts,
	contextSizes,
	coverage,
	downsample,
	findings,
	GROUPS,
	largestRebuilds,
	largestResults,
	lineDiff,
	options,
	overview,
	pauses,
	rebuilds,
	Scope,
	sessionDetail,
	sessionList,
	series,
	sideCalls,
	subagents,
	titleOf,
	tools,
	totals,
	userMessages,
	versionDiff,
	versions,
	type Filters,
} from "../extensions/metrics/queries/index.ts";
import { report } from "../extensions/metrics/report.ts";
import { openStore } from "../extensions/metrics/store.ts";
import { MIN, RATES, seed, T0, TURN_SPLIT, turnCost } from "./seed.ts";

const close = (a: number, b: number, message?: string) => assert.ok(Math.abs(a - b) < 1e-9, `${message ?? ""} ${a} ≠ ${b}`);
const DAY = 1440 * MIN;
// Pi: A (4 turns, a warm, a compaction), C and D (2 turns each), B (1 turn of $1). Claude Code: X (3 turns), X/agent1 (1).
const A_COST = 4 * turnCost() + 0.02 + 0.04;
const PI_COST = A_COST + 4 * turnCost() + 1;
const CLAUDE_COST = 4 * 0.5;
// The window around T0: A, C and D, not B (two days earlier) nor the Claude Code sessions (an hour later).
const AROUND_T0: Filters = { start: T0 - 60 * MIN, end: T0 + 45 * MIN };

let dir: string;
let db: DatabaseSync;
const scope = (filters: Filters = {}) => new Scope(db, filters);

before(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-queries-"));
	db = openStore(join(dir, "metrics.db"));
	seed(db);
});
after(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("filters", () => {
	test("Pi sessions by default, Claude Code only when asked, all together", () => {
		const pi = totals(scope());
		assert.equal(pi.sessions, 4);
		assert.equal(pi.requests, 9);
		assert.equal(pi.sideRequests, 2);
		close(pi.cost, PI_COST);
		close(pi.sideCost, 0.06);
		close(pi.waste, 0.05);
		const claude = totals(scope({ source: "claude-code" }));
		assert.equal(claude.sessions, 2);
		close(claude.cost, CLAUDE_COST);
		close(totals(scope({ source: "all" })).cost, PI_COST + CLAUDE_COST);
	});

	test("the cost split by billing rate adds up to the cost", () => {
		for (const source of ["pi", "claude-code", "all"] as const) {
			const t = totals(scope({ source }));
			close(t.read + t.write + t.uncached + t.output, t.cost, source);
		}
	});

	test("the time window applies to each request's own time; start inclusive, end exclusive", () => {
		close(totals(scope(AROUND_T0)).cost, PI_COST - 1);
		assert.equal(totals(scope({ start: T0, end: T0 + MIN })).requests, 1, "only a1 at T0");
		assert.equal(totals(scope({ start: T0 + 31 * MIN })).requests, 1, "only D's last turn at 31 min");
		assert.equal(totals(scope({ end: T0 })).requests, 1, "only B, before T0");
	});

	test("project, model and session narrow everything; the model also selects sessions for tables without one", () => {
		close(totals(scope({ project: "/p2" })).cost, 1);
		const sonnet = totals(scope({ model: "claude-sonnet" }));
		assert.equal(sonnet.sessions, 2);
		close(sonnet.cost, 4 * turnCost());
		close(totals(scope({ session: "C" })).cost, 2 * turnCost());
		// Tool results have no model: the sonnet filter keeps those of sessions that used sonnet (C, not A).
		assert.deepEqual(tools(scope({ model: "claude-sonnet" })).map((t) => [t.tool, t.calls]), [["read", 1]]);
		assert.equal(totals(scope({ project: "'; DROP TABLE requests; --" })).sessions, 0, "values are parameters");
		assert.equal(totals(scope()).requests, 9, "and nothing was dropped");
	});

	test("the previous period has the same length, right before; an open window has none", () => {
		const previous = scope({ start: T0, end: T0 + 60 * MIN }).previous()!;
		assert.deepEqual([previous.filters.start, previous.filters.end], [T0 - 60 * MIN, T0]);
		const open = scope({ start: T0 }).previous(T0 + 10 * MIN)!;
		assert.deepEqual([open.filters.start, open.filters.end], [T0 - 10 * MIN, T0]);
		assert.equal(scope().previous(), undefined);
	});
});

describe("spend", () => {
	test("every request-based breakdown adds up to the total, for every source and window", () => {
		for (const filters of [{}, { source: "all" }, { source: "claude-code" }, AROUND_T0, { model: "claude-opus" }] as Filters[]) {
			const total = totals(scope(filters)).cost;
			for (const group of GROUPS.filter((g) => g !== "content" && g !== "tool")) {
				const rows = breakdown(scope(filters), group).rows;
				close(rows.reduce((sum, r) => sum + r.cost, 0), total, `${group} ${JSON.stringify(filters)}`);
				close(rows.reduce((sum, r) => sum + r.read + r.write + r.uncached + r.output, 0), total, `${group} split`);
				assert.equal(rows.reduce((sum, r) => sum + r.requests, 0), totals(scope(filters)).requests + totals(scope(filters)).sideRequests);
			}
		}
	});

	test("prompt content adds up to the analyzed requests, output counted as output, tool definitions grouped", () => {
		const content = breakdown(scope(), "content");
		const analyzed = 4 * turnCost() + 1;
		close(content.rows.reduce((sum, r) => sum + r.cost, 0), analyzed);
		close(content.coverage, analyzed / PI_COST);
		const output = content.rows.find((r) => r.key === "model output")!;
		close(output.output, 4 * TURN_SPLIT.output + 0.1);
		assert.equal(output.uncached, 0);
		assert.ok(content.rows.some((r) => r.key === "tool definitions"));
		assert.ok(!content.rows.some((r) => r.key.startsWith("tool definition: ")));
		assert.deepEqual(content.rows.map((r) => r.cost), [...content.rows.map((r) => r.cost)].sort((a, b) => b - a), "ranked by cost");
	});

	test("tools sum their definition, call and result parts", () => {
		const rows = breakdown(scope(), "tool").rows;
		assert.deepEqual(rows.map((r) => r.key), ["bash"]);
		close(rows[0]!.cost, 5 * 0.16);
		close(rows[0]!.parts!.result, 5 * 0.16);
		assert.equal(rows[0]!.parts!.definition, 0);
	});

	test("imported Claude Code sessions have no prompt content: coverage 0, no content rows", () => {
		assert.deepEqual(breakdown(scope({ source: "claude-code" }), "content").rows, []);
		assert.equal(coverage(scope({ source: "claude-code" })), 0);
		assert.equal(coverage(scope({ start: T0 + 1000 * DAY })), 1, "nothing spent: nothing missing");
	});

	test("side calls without a model are named by their kind; days and context bands keep their order", () => {
		const models = breakdown(scope(), "model").rows.map((r) => r.key);
		assert.ok(models.includes("compaction (model not recorded)"));
		const days = breakdown(scope(), "day").rows.map((r) => r.key);
		assert.deepEqual(days, [...days].sort());
		assert.deepEqual(breakdown(scope(), "context").rows.map((r) => r.key), ["under 50k", "100k–200k", "200k–400k"]);
	});

	test("the series covers every bucket of the window, by hour up to three days, and adds up", () => {
		const hourly = series(scope(AROUND_T0));
		assert.equal(hourly.unit, "hour");
		assert.deepEqual(hourly.points.map((p) => p.t.slice(11, 13)), ["09", "10"]);
		close(hourly.points.reduce((sum, p) => sum + p.cost, 0), PI_COST - 1);
		assert.equal(series(scope(), T0 + DAY - 2 * 3_600_000).unit, "hour", "up to three days");
		const daily = series(scope(), T0 + 2 * DAY);
		assert.equal(daily.unit, "day");
		assert.equal(daily.points.length, 5, "from B's day to two days after T0, empty days included");
		assert.equal(daily.points[1]!.cost, 0);
		close(daily.points.reduce((sum, p) => sum + p.cost, 0), PI_COST);
		assert.deepEqual(series(scope({ project: "/nowhere" })), { unit: "day", points: [] });
		const future = series(scope({ start: T0 - 30 * MIN }), T0);
		close(future.points.reduce((sum, p) => sum + p.cost, 0), PI_COST - 1, "requests after now still count");
	});

	test("side calls and user messages", () => {
		assert.deepEqual(sideCalls(scope()).map((s) => [s.kind, s.requests, s.model]), [["compaction", 1, "not recorded"], ["cache_warm", 1, "claude-opus"]]);
		assert.deepEqual(Object.fromEntries(userMessages(scope()).map((u) => [u.kind, u.count])), { first: 1, steer: 1, "after interrupt": 1 });
	});
});

describe("cache, tools and context", () => {
	test("rebuilds, pauses and compactions follow the window", () => {
		assert.deepEqual(rebuilds(scope()).map((r) => [r.cause, r.requests, r.lostTokens]), [["model switched", 1, 10_000]]);
		assert.equal(largestRebuilds(scope())[0]!.title, "Parent work");
		assert.deepEqual(pauses(scope()).map((p) => [p.outcome, p.pauses, p.resumeCost]), [["cold", 1, 0.2]]);
		assert.equal(coldResumes(scope())[0]!.session, "A");
		assert.deepEqual(compactions(scope()).map((c) => [c.reason, c.count, c.cost]), [["threshold", 1, 0.04]]);
		assert.deepEqual(rebuilds(scope({ start: T0 + 2 * MIN })), []);
		assert.deepEqual(pauses(scope({ start: T0 + 4 * MIN })), []);
		assert.deepEqual(compactions(scope({ end: T0 + 4 * MIN })), []);
	});

	test("tools: calls, errors, durations, carry cost and results never referenced again", () => {
		const byTool = Object.fromEntries(tools(scope()).map((t) => [t.tool, t]));
		assert.deepEqual(Object.keys(byTool), ["bash", "read"], "by carry cost");
		assert.equal(byTool.bash!.unreferenced, 1);
		close(byTool.bash!.unreferencedCost, 0.3);
		assert.equal(byTool.read!.calls, 2);
		assert.equal(byTool.read!.errors, 1);
		assert.equal(byTool.read!.withFiles, 2);
		assert.equal(byTool.read!.unreferenced, 0);
		assert.equal(byTool.bash!.p50Ms, 100);
	});

	test("largest results carry their files, session title and whether they were used", () => {
		const [first] = largestResults(scope(), 1);
		assert.deepEqual([first!.call, first!.files, first!.referencedLater, first!.title], ["c1", ["/p1/a.ts"], false, "Parent work"]);
		assert.equal(largestResults(scope(), 50).length, 3);
	});

	test("context sizes: percentiles and bands over the turns", () => {
		const sizes = contextSizes(scope());
		assert.deepEqual([sizes.requests, sizes.median, sizes.p90, sizes.max], [9, 100_000, 250_000, 250_000]);
		assert.deepEqual(sizes.bands.map((b) => b.requests), [4, 0, 3, 2, 0]);
		close(sizes.bands.reduce((sum, b) => sum + b.cost, 0), PI_COST - 0.06);
		assert.deepEqual(contextSizes(scope({ project: "/nowhere" })), { requests: 0, median: 0, p90: 0, max: 0, bands: sizes.bands.map((b) => ({ ...b, requests: 0, cost: 0 })) });
	});

	test("compaction opportunities are consistent and follow the scope", () => {
		const all = compactionOpportunities(scope());
		close(all.total, all.sessions.reduce((sum, s) => sum + s.saving, 0));
		assert.ok(all.sessions.every((s, i) => i === 0 || s.saving <= all.sessions[i - 1]!.saving));
		assert.ok(all.sessions.every((s) => s.saving > 0 && s.after >= 1 && s.after < s.requests));
		assert.deepEqual(compactionOpportunities(scope({ project: "/p2" })), { total: 0, sessions: [] }, "one turn: nothing to compact");
	});
});

describe("subagents", () => {
	test("each delegation finds its child, rediscovery, and the cheaper of new or resuming an idle sibling", () => {
		const s = subagents(scope());
		assert.equal(s.started, 2);
		close(s.cost, 4 * turnCost());
		assert.deepEqual(s.rows.map((r) => [r.child, r.title]), [["C", "Scout"], ["D", "Second"]]);
		const [c, d] = s.rows;
		assert.deepEqual(c!.rediscovered.calls, 1, "C read a.ts its parent had read");
		close(c!.rediscovered.cost, 0.02);
		assert.equal(c!.alternative, null, "no earlier sibling");
		// D could have resumed C: idle 26 min (cold), 10k more context on each of 2 requests, rewrite 30k.
		const alt = d!.alternative!;
		assert.deepEqual([alt.child, alt.warm, alt.contextTokens, alt.idleMs], ["C", false, 30_000, 26 * MIN]);
		const startup = 10_000 * RATES.write + 10 * RATES.input;
		close(alt.cost, 2 * turnCost() - startup + 2 * 10_000 * RATES.read + 30_000 * RATES.write);
		close(d!.difference, 2 * turnCost() - alt.cost);
		assert.ok(d!.difference < 0, "new was cheaper");
		assert.deepEqual([s.compared, s.resumeWins], [1, 0]);
		close(s.bestCost, s.cost);
	});

	test("the window selects delegations; no delegations is an empty result", () => {
		assert.deepEqual(subagents(scope({ start: T0 + 10 * MIN })).rows.map((r) => r.child), ["D"]);
		assert.deepEqual(subagents(scope({ project: "/p2" })), { started: 0, cost: 0, resumes: 0, rediscoveryCost: 0, compared: 0, resumeWins: 0, bestCost: 0, rows: [] });
	});
});

describe("sessions", () => {
	test("ranked by cost in scope, paged, with titles, sparklines and counts", () => {
		const page = sessionList(scope());
		assert.equal(page.total, 4);
		assert.deepEqual(page.rows.map((r) => r.id), ["A", "B", "C", "D"]);
		const a = page.rows[0]!;
		assert.deepEqual([a.title, a.requests, a.compactions, a.subagents, a.peakTokens], ["Parent work", 4, 1, 2, 250_000]);
		close(a.cost, A_COST);
		close(a.sideCost, 0.06);
		assert.deepEqual(a.spark, [100_000, 150_000, 200_000, 250_000]);
		assert.equal(page.rows[2]!.title, "Scout", "a subagent is named by its delegation");
		assert.deepEqual(sessionList(scope(), { page: 2, pageSize: 3 }).rows.map((r) => r.id), ["D"]);
		assert.deepEqual(sessionList(scope(), { sort: "recent" }).rows.map((r) => r.id), ["D", "A", "C", "B"]);
		assert.deepEqual(sessionList(scope(), { sort: "waste" }).rows[0]!.id, "A");
		assert.equal(sessionList(scope({ source: "claude-code" })).rows.find((r) => r.id === "X")!.title, "Claude Code task.", "first sentence of the first message");
		assert.deepEqual(sessionList(scope({ project: "/nowhere" })), { total: 0, page: 1, pageSize: 25, rows: [] });
	});

	test("a session in full: timeline, markers, subagent tree and parent links", () => {
		const a = sessionDetail(db, "A")!;
		assert.equal(a.session.parent, null);
		assert.deepEqual(a.session.models, ["claude-opus"]);
		assert.equal(a.timeline.length, 6);
		assert.deepEqual(a.compactions.map((c) => c.reason), ["threshold"]);
		assert.deepEqual(a.pauses.map((p) => p.outcome), ["cold"]);
		assert.deepEqual(a.delegations.map((d) => [d.title, d.child]), [["Scout", "C"], ["Second", "D"]]);
		assert.deepEqual(a.userMessages.map((u) => u.kind), ["first", "steer", "after interrupt"]);
		assert.deepEqual(a.children.map((c) => [c.id, c.title]), [["C", "Scout"], ["D", "Second"]]);
		assert.equal(a.peakTokens, 250_000);
		close(a.totals.cost, A_COST);
		assert.ok(a.composition.length > 0 && a.coverage < 1);
		assert.equal(sessionDetail(db, "C")!.session.parent!.title, "Parent work", "found through the delegation");
		const x = sessionDetail(db, "X")!;
		assert.deepEqual(x.children.map((c) => c.id), ["X/agent1"], "found through parent_session");
		assert.equal(sessionDetail(db, "X/agent1")!.session.parent!.id, "X");
		assert.deepEqual(x.composition, [], "imported: totals only");
		assert.equal(sessionDetail(db, "nope"), undefined);
	});

	test("downsample keeps the largest value of each slice", () => {
		assert.deepEqual(downsample([1, 2, 3]), [1, 2, 3]);
		const values = Array.from({ length: 96 }, (_, i) => i);
		assert.deepEqual(downsample(values), Array.from({ length: 48 }, (_, i) => 2 * i + 1));
		assert.deepEqual(downsample([]), []);
	});

	test("titles: first line, first sentence, cut long ones, fall back to the id", () => {
		assert.equal(titleOf("\n  Fix the build. Then test.", "s"), "Fix the build.");
		assert.equal(titleOf("ok. short", "s"), "ok. short", "a sentence needs some length");
		assert.equal(titleOf("x".repeat(200), "s").length, 90);
		assert.equal(titleOf(null, "abc/def123456789"), "Session def12345");
	});
});

describe("versions", () => {
	test("per version, Pi sessions only, compared with the previous version of the same project", () => {
		const rows = versions(scope({ source: "all" }));
		assert.deepEqual(rows.map((v) => [v.id, v.project, v.previous]), [["v1", "/p1", null], ["v2", "/p1", "v1"], ["v9", "/p2", null]]);
		const [v1, v2] = rows;
		assert.deepEqual([v1!.requests, v1!.sessions, v1!.toolCalls, v1!.toolErrors], [6, 3, 2, 0]);
		close(v1!.costPerRequest, turnCost());
		assert.deepEqual([v2!.requests, v2!.toolCalls, v2!.toolErrors, v2!.corrections], [2, 1, 1, 2]);
		assert.deepEqual(v2!.userMessages, { steer: 1, "after interrupt": 1 }, "each answered by a v2 turn");
		assert.deepEqual(v1!.userMessages, { first: 1 });
		assert.deepEqual(v2!.changes, [{ kind: "section", name: "base", change: "changed" }, { kind: "section", name: "skills", change: "added" }]);
		assert.ok(v2!.cacheShare > 0.9);
		assert.deepEqual(versions(scope({ source: "claude-code" })).map((v) => v.id), ["v1", "v2", "v9"], "Claude Code never has versions");
	});

	test("the window keeps versions with turns in it, still compared with their real predecessor", () => {
		assert.deepEqual(versions(scope({ start: T0 + 2.5 * MIN, end: T0 + 3.5 * MIN })).map((v) => [v.id, v.previous, v.requests]), [["v2", "v1", 1]]);
		assert.deepEqual(versions(scope({ start: T0 + 2 * MIN, end: T0 + 3.5 * MIN })).map((v) => [v.id, v.requests]), [["v1", 1], ["v2", 2]], "C's v1 turn at 2 min");
		assert.deepEqual(versions(scope({ project: "/p2" })).map((v) => v.id), ["v9"]);
	});

	test("a version diff has a line diff per changed section or tool", () => {
		const diff = versionDiff(db, "v1", "v2");
		assert.deepEqual(diff.items.map((i) => [i.name, i.change]), [["base", "changed"], ["skills", "added"]]);
		assert.deepEqual(diff.items[0]!.lines, [
			{ op: "same", text: "You are Pi." },
			{ op: "del", text: "Be brief." },
			{ op: "add", text: "Be thorough." },
			{ op: "same", text: "Use tools." },
		]);
		assert.deepEqual(diff.items[1]!.lines.map((l) => l.op), ["add", "add"]);
		assert.deepEqual(versionDiff(db, "v1", "v1").items, []);
	});

	test("a changed tool definition diffs by line of its indented JSON", () => {
		const tool = (description: string) => JSON.stringify({ name: "grep", description, parameters: { type: "object" } });
		db.prepare("INSERT INTO blobs (hash, kind, name, text) VALUES ('h-grep1', 'tool', 'grep', ?), ('h-grep2', 'tool', 'grep', ?)").run(tool("Search."), tool("Search files."));
		db.prepare("INSERT INTO versions (id, sections, tools, first_seen) VALUES ('t1', '{}', '{\"grep\":\"h-grep1\"}', 0), ('t2', '{}', '{\"grep\":\"h-grep2\"}', 0)").run();
		const lines = versionDiff(db, "t1", "t2").items[0]!.lines;
		assert.deepEqual(lines.filter((l) => l.op !== "same").map((l) => [l.op, l.text]), [["del", '  "description": "Search.",'], ["add", '  "description": "Search files.",']]);
		assert.ok(lines.some((l) => l.op === "same" && l.text === '  "name": "grep",'));
	});

	test("lineDiff edge cases", () => {
		assert.deepEqual(lineDiff("", ""), []);
		assert.deepEqual(lineDiff("a", ""), [{ op: "del", text: "a" }]);
		assert.deepEqual(lineDiff("a\nb", "a\nb"), [{ op: "same", text: "a" }, { op: "same", text: "b" }]);
		assert.deepEqual(lineDiff("a\nb\nc", "c\na").filter((l) => l.op === "same").length, 1);
	});
});

describe("overview", () => {
	test("findings are ranked by dollars, priced as a share of spend, and link to their view", () => {
		const list = findings(scope());
		assert.deepEqual(list.map((f) => f.cost), [...list.map((f) => f.cost)].sort((a, b) => b - a));
		for (const f of list) {
			close(f.share, f.cost / PI_COST, f.id);
			assert.equal(f.severity, f.share >= 0.1 ? "critical" : f.share >= 0.03 ? "warning" : "info", f.id);
		}
		const byId = Object.fromEntries(list.map((f) => [f.id, f]));
		for (const id of ["cache-rebuilds", "cold-resumes", "large-context", "tool-output", "never-referenced", "thinking", "side-calls"]) assert.ok(byId[id], id);
		close(byId["cache-rebuilds"]!.cost, 0.05);
		close(byId["cold-resumes"]!.cost, 0.2);
		close(byId["never-referenced"]!.cost, 0.3);
		close(byId["tool-output"]!.cost, 0.8);
		assert.deepEqual(byId["large-context"]!.params, { group: "context" });
		assert.equal(byId.subagents, undefined, "starting new was never more expensive");
		assert.deepEqual(findings(scope({ project: "/nowhere" })), []);
	});

	test("the overview compares with the previous period and lists top sessions", () => {
		const o = overview(scope({ start: T0, end: T0 + 45 * MIN }));
		close(o.kpis.cost, PI_COST - 1);
		assert.equal(o.previous!.requests, 0);
		assert.deepEqual(o.topSessions.map((s) => s.id), ["A", "C", "D"]);
		assert.equal(overview(scope()).previous, null);
	});

	test("options list the values in the window, each ignoring its own filter", () => {
		const o = options(scope({ project: "/p2", model: "claude-sonnet" }));
		assert.deepEqual(o.projects.map((p) => p.value), ["/p1"], "projects that used sonnet, whatever the project filter");
		assert.deepEqual(o.models.map((m) => m.value), ["claude-opus"], "models of /p2");
		const all = options(scope());
		assert.deepEqual(all.projects.map((p) => p.value), ["/p1", "/p2"]);
		assert.deepEqual(all.models.map((m) => m.value), ["claude-opus", "claude-sonnet"]);
		assert.deepEqual(options(scope({ model: "claude-sonnet" })).models.map((m) => m.value), ["claude-opus", "claude-sonnet"]);
		assert.deepEqual(Object.fromEntries(all.sources.map((s) => [s.value, s.sessions])), { pi: 4, "claude-code": 2 });
	});
});

describe("text report", () => {
	test("renders the query layer, per scope", () => {
		const text = report(db);
		assert.match(text, /^4 sessions, 9 model requests/);
		assert.match(text, /Where the cost goes/);
		assert.match(text, /model switched/);
		assert.match(text, /resumed, cache rebuilt/);
		assert.match(text, /Harness versions/);
		assert.match(text, /v2\s+p1/);
		assert.match(text, /base \+skills/);
		assert.match(text, /Subagents: 2 started/);
		assert.match(text, /new saved/);
		assert.match(text, /Context per request: median 100k/);
		assert.match(report(db, { source: "claude-code" }), /^2 sessions, 4 model requests/);
		assert.doesNotMatch(report(db, { source: "claude-code" }), /Where the cost goes/, "no prompt content for imported sessions");
		assert.equal(report(db, { project: "/nowhere" }), "No sessions recorded for this scope yet.");
	});

	test("an empty store answers every query without failing", () => {
		const empty = openStore(join(dir, "empty.db"));
		const s = new Scope(empty, { source: "all" });
		assert.equal(totals(s).cost, 0);
		assert.deepEqual(findings(s), []);
		assert.deepEqual(overview(s).topSessions, []);
		assert.deepEqual(contentCosts(s), []);
		for (const group of GROUPS) assert.deepEqual(breakdown(s, group).rows, []);
		assert.deepEqual(versions(s), []);
		assert.equal(subagents(s).started, 0);
		assert.equal(report(empty), "No sessions recorded for this scope yet.");
		empty.close();
	});
});
