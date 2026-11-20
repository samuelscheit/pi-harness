// Dreaming's spend loop (scripts/dream): the labels file in the metrics index and the quality
// metrics of the comparison, the spend facts, the blind session review, the judge's decisions and
// their commits, the economist's validated proposals as experiment commits, multi-file commits, and
// whole dream runs with all of it on a scripted model.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type Experiment, listExperiments } from "../extensions/lib/experiments.ts";
import { listRules } from "../extensions/lib/rules.ts";
import { appendLabels, indexLabels } from "../extensions/metrics/labels.ts";
import { type ArmSession, compareCells, experiments, Scope } from "../extensions/metrics/queries/index.ts";
import { openStore } from "../extensions/metrics/store.ts";
import { commitFiles } from "../scripts/dream/commit.ts";
import { economistInput, economize, experimentFile, parseEconomy } from "../scripts/dream/economize.ts";
import { decide, judge, LEVEL, MAX_DAYS, MIN_EARLY_SESSIONS, MIN_SESSIONS, MIN_STOP_REVIEWS, type ReviewStats, reviewStats, tQuantile } from "../scripts/dream/judge.ts";
import { appendEconomy, readEconomy } from "../scripts/dream/ledger.ts";
import { appendReviews, digest, parseReview, readReviews, REVIEWS_PER_ARM, type Review, sample } from "../scripts/dream/review.ts";
import { dream } from "../scripts/dream/run.ts";
import { spendFacts, windows } from "../scripts/dream/spend.ts";
import type { Ask } from "../scripts/lib/labels.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dream-economy-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
function repository(name: string, files: Record<string, string> = {}): string {
	const repo = join(dir, name);
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@t");
	git(repo, "config", "user.name", "t");
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), content);
	}
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "init", "--allow-empty");
	return repo;
}

const T = Date.parse("2026-11-01T10:00:00Z");
const MIN = 60_000;
const DAY = 86_400_000;

interface SessionSpec {
	id: string;
	cwd?: string;
	/** The arm in experiment `experiment` (none: not enrolled). */
	arm?: "A" | "B";
	experiment?: string;
	forced?: boolean;
	start?: number;
	/** Turns: cost each; the last `aborted` of them interrupted. */
	turns?: number[];
	aborted?: number;
	model?: string;
	thinking?: string;
	promptTokens?: number;
	/** User messages (kind follow-up) with their labels. */
	labels?: string[];
	toolErrors?: [ok: number, failed: number];
	delegated?: boolean;
	/** The session file's text, for reviews. */
	text?: string;
}

/** A session in the index with its arm, turns, user messages, labels and tool results, and its session file. */
function addSession(db: DatabaseSync, s: SessionSpec, labelsFile?: string): void {
	const start = s.start ?? T;
	const file = join(dir, `${s.id}.jsonl`);
	const at = (minute: number) => new Date(start + minute * MIN).toISOString();
	const first = s.delegated ? "Act as the review sub-agent for this task.\n\ndo the task" : "do the task";
	writeFileSync(
		file,
		[
			{ type: "message", timestamp: at(1), message: { role: "user", content: [{ type: "text", text: s.text ?? first }] } },
			{ type: "message", timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
		]
			.map((e) => JSON.stringify(e))
			.join("\n"),
	);
	db.prepare(
		`INSERT INTO sessions (id, file, cwd, prompt_digest, started_at, ended_at, requests, cost, aborted, errors, compactions, user_messages) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)`,
	).run(s.id, file, s.cwd ?? "/p", s.delegated ? "digest" : null, start, start + 60 * MIN);
	if (s.arm) db.prepare("INSERT INTO experiment_arms VALUES (?, ?, ?, ?, ?, NULL)").run(s.id, s.experiment ?? "x", s.arm, s.forced ? 1 : 0, start);
	const turns = s.turns ?? [1];
	turns.forEach((cost, i) => {
		db.prepare(
			`INSERT INTO requests (session_id, entry_id, ts, kind, provider, model, thinking, stop_reason, input, output, cache_read, cache_write, prompt_tokens, cost, message_count,
			cost_input, cost_output, cost_read, cost_write, trigger_tokens, cache_lost, cache_waste, tool_calls, input_rate, read_rate, write_rate)
			VALUES (?, ?, ?, 'turn', 'anthropic', ?, ?, ?, 0, 1000, ?, 0, ?, ?, 0, 0, ?, ?, 0, 0, 0, 0, 1, 0.000005, 0.0000005, 0.00000625)`,
		).run(s.id, `r${i}`, start + (3 + i) * MIN, s.model ?? "claude-opus-5-5", s.thinking ?? "medium", i >= turns.length - (s.aborted ?? 0) ? "aborted" : "toolUse", s.promptTokens ?? 100_000, s.promptTokens ?? 100_000, cost, cost / 4, (cost * 3) / 4);
	});
	db.prepare("INSERT INTO user_messages (session_id, entry_id, ts, kind, text) VALUES (?, 'u0', ?, 'first', ?)").run(s.id, start + MIN, first);
	(s.labels ?? []).forEach((_, i) => db.prepare("INSERT INTO user_messages (session_id, entry_id, ts, kind, text) VALUES (?, ?, ?, 'follow-up', '')").run(s.id, `u${i + 1}`, start + (10 + i) * MIN));
	if (labelsFile) appendLabels((s.labels ?? []).map((label, i) => ({ session: s.id, entry: `u${i + 1}`, ts: start + (10 + i) * MIN, label: label as never })), labelsFile);
	const [ok, failed] = s.toolErrors ?? [0, 0];
	for (let i = 0; i < ok + failed; i++) {
		db.prepare(`INSERT INTO tool_results (session_id, call_id, ts, tool, summary, is_error, tokens, requests_in_context, lifetime_cost, mutates) VALUES (?, ?, ?, 'bash', 'ls', ?, 500, 10, 0.5, 0)`).run(
			s.id,
			`t${i}`,
			start + 5 * MIN,
			i < failed ? 1 : 0,
		);
	}
}

describe("labels in the metrics index", () => {
	test("loaded when the file changed, a later label of a message wins, malformed lines are skipped, a missing file empties the table", () => {
		const db = openStore(join(dir, "metrics.db"));
		const file = join(dir, "labels.jsonl");
		indexLabels(db, file);
		assert.equal((db.prepare("SELECT COUNT(*) n FROM message_labels").get() as { n: number }).n, 0);
		appendLabels([{ session: "s", entry: "e1", ts: 1, label: "correction" }, { session: "s", entry: "e2", ts: 2, label: "new_task" }], file);
		appendFileSync(file, '{broken\n{"session":"s","entry":"e3","ts":3,"label":"bogus"}\n');
		indexLabels(db, file);
		const rows = () => db.prepare("SELECT entry_id, label FROM message_labels ORDER BY entry_id").all().map((r) => ({ ...r }));
		assert.deepEqual(rows(), [{ entry_id: "e1", label: "correction" }, { entry_id: "e2", label: "new_task" }]);
		appendLabels([{ session: "s", entry: "e1", ts: 1, label: "approval" }], file);
		indexLabels(db, file);
		assert.deepEqual(rows(), [{ entry_id: "e1", label: "approval" }, { entry_id: "e2", label: "new_task" }]);
		// Unchanged file: no reload (a row added by hand survives).
		db.prepare("INSERT INTO message_labels VALUES ('t', 'x', 0, 'other')").run();
		indexLabels(db, file);
		assert.equal(rows().length, 3);
		rmSync(file);
		indexLabels(db, file);
		assert.deepEqual(rows(), []);
		db.close();
	});

	test("the comparison's quality metrics: negative share of labelled messages, interrupts and cost per package", () => {
		const db = openStore(join(dir, "metrics.db"));
		const file = join(dir, "labels.jsonl");
		addSession(db, { id: "a1", arm: "A", turns: [2, 2], labels: ["correction", "new_task"] }, file);
		addSession(db, { id: "a2", arm: "A", turns: [4], aborted: 1, labels: ["approval", "failure_report"] }, file);
		addSession(db, { id: "b1", arm: "B", turns: [1], labels: ["new_task", "approval", "question", "quality"] }, file);
		addSession(db, { id: "b2", arm: "B", turns: [1], labels: [] }, file);
		indexLabels(db, file);
		const [c] = experiments(new Scope(db, {}), [["x"]]);
		const m = (key: string) => c!.metrics.find((x) => x.key === key)!;
		assert.deepEqual(m("negativeShare").values, { A: 2 / 4, B: 1 / 4 });
		assert.deepEqual(m("interruptsPerPackage").values, { A: 1 / 6, B: 0 });
		// Packages: the first message and each follow-up.
		assert.deepEqual(m("costPerPackage").values, { A: 8 / 6, B: 2 / 6 });
		db.close();
	});
});

describe("spend facts", () => {
	test("windows: since the last run against the week before; a first run looks at a day", () => {
		assert.deepEqual(windows(T, T + DAY), { window: { start: T, end: T + DAY }, baseline: { start: T - 7 * DAY, end: T } });
		assert.deepEqual(windows(0, T).window, { start: T - DAY, end: T });
	});

	test("cost, kinds, models, context sizes, tools and quality of the window next to the baseline", () => {
		const db = openStore(join(dir, "metrics.db"));
		const file = join(dir, "labels.jsonl");
		addSession(db, { id: "old", start: T - 2 * DAY, turns: [7], labels: ["new_task"] }, file);
		addSession(db, { id: "top", turns: [3, 3], labels: ["correction", "approval"], toolErrors: [3, 1], promptTokens: 450_000 }, file);
		addSession(db, { id: "child", turns: [10], delegated: true, model: "claude-sonnet-5-5", thinking: "high", promptTokens: 30_000 }, file);
		indexLabels(db, file);
		const empty = spendFacts(db, { start: T + 10 * DAY, end: T + 11 * DAY }, { start: T, end: T + 10 * DAY });
		assert.equal(empty.requests, 0);
		assert.match(empty.text, /^No model requests between/);
		const { text, requests } = spendFacts(db, { start: T, end: T + DAY }, { start: T - 7 * DAY, end: T });
		assert.equal(requests, 3);
		assert.match(text, /cost per day\s+\$16\.00\s+\$1\.00\s+\+1500%/);
		assert.match(text, /quality: user messages correcting or reporting failures\s+50% of 2\s+0% of 1/);
		assert.match(text, /quality: tool error rate\s+25%\s+–/);
		assert.match(text, /delegated\s+1\s+1\s+\$10\.00/);
		assert.match(text, /top-level\s+1\s+2\s+\$6\.00/);
		assert.match(text, /claude-sonnet-5-5\s+high\s+1\s+\$10\.00/);
		assert.match(text, /400k and more\s+2\s+\$6\.00\s+38%/);
		assert.match(text, /under 50k\s+1\s+\$10\.00\s+63%/);
		assert.match(text, /The costliest single tool results/);
		assert.match(text, /Costliest sessions/);
		db.close();
	});
});

describe("review", () => {
	const line = (ts: number, message: object) => JSON.stringify({ type: "message", timestamp: new Date(ts).toISOString(), message });

	test("the digest: user, agent text, tool calls and failures inside the window; never thinking, results that worked or other entries", () => {
		const content = [
			line(T - MIN, { role: "user", content: "before the experiment" }),
			line(T, { role: "user", content: [{ type: "text", text: "fix the login" }] }),
			JSON.stringify({ type: "custom", customType: "harness-experiment", timestamp: new Date(T).toISOString(), data: { experiment: "x", arm: "B" } }),
			line(T + 1, { role: "assistant", content: [{ type: "thinking", thinking: "secret plan" }, { type: "text", text: "Looking." }, { type: "toolCall", name: "bash", arguments: { command: "npm test" } }] }),
			line(T + 2, { role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "all green" }] }),
			line(T + 3, { role: "toolResult", toolName: "edit", isError: true, content: [{ type: "text", text: "no match" }] }),
			"{broken",
			line(T + 10, { role: "user", content: "after the end" }),
		].join("\n");
		assert.equal(digest(content, T, T + 10), "USER: fix the login\nAGENT: Looking.\nTOOL bash: npm test\nTOOL FAILED (edit): no match");
		assert.match(digest(content, T), /USER: after the end$/);
	});

	test("a long digest keeps its start and its end", () => {
		const content = Array.from({ length: 400 }, (_, i) => line(T + i, { role: "user", content: `message ${i} ${"x".repeat(400)}` })).join("\n");
		const text = digest(content, T);
		assert.ok(text.length < 61_000);
		assert.match(text, /^USER: message 0 /);
		assert.match(text, /characters of the middle left out/);
		assert.match(text, /USER: message 399 x+$/);
	});

	test("the sample: per arm, unreviewed sessions in a stable order, up to the target with the earlier reviews", () => {
		const candidates = Array.from({ length: 30 }, (_, i) => ({ session: `s${i}`, arm: i % 2 ? "B" : "A", file: "", from: 0 }));
		const first = sample("x", candidates, new Set(), 5);
		assert.deepEqual(first.filter((c) => c.arm === "A").length, 5);
		assert.deepEqual(first.filter((c) => c.arm === "B").length, 5);
		assert.deepEqual(sample("x", [...candidates].reverse(), new Set(), 5), first, "the order does not depend on the input");
		assert.notDeepEqual(sample("y", candidates, new Set(), 5), first, "each experiment samples on its own");
		const reviewed = new Set(first.filter((c) => c.arm === "A").slice(0, 3).map((c) => c.session));
		const next = sample("x", candidates, reviewed, 5);
		assert.equal(next.filter((c) => c.arm === "A").length, 2);
		assert.ok(next.every((c) => !reviewed.has(c.session)));
	});

	test("a review's answer: an integer 1-10 and a reason", () => {
		assert.deepEqual(parseReview({ score: 7, reason: "ok" }), { score: 7, reason: "ok" });
		assert.deepEqual(parseReview({ score: 1 }), { score: 1, reason: "" });
		for (const bad of [{ score: 0 }, { score: 11 }, { score: 7.5 }, { score: "7" }, null]) assert.throws(() => parseReview(bad), /score must be/);
	});

	test("review stats: means, B − A and a Welch t-interval, with a floor on the spread; none below two reviews per arm", () => {
		const r = (arm: string, score: number): Review => ({ experiment: "x", session: `${arm}${score}${Math.random()}`, arm, score, reason: "", model: "m", at: "" });
		assert.ok(Math.abs(tQuantile(0.975, 1e6) - 1.96) < 0.001);
		assert.ok(Math.abs(tQuantile(0.995, 30) - 2.75) < 0.01);
		assert.ok(Math.abs(tQuantile(0.975, 10) - 2.228) < 0.01);
		const stats = reviewStats([r("A", 6), r("A", 8), r("B", 8), r("B", 8), r("B", 8)]);
		assert.deepEqual(stats.n, { A: 2, B: 3 });
		assert.deepEqual(stats.mean, { A: 7, B: 8 });
		assert.equal(stats.effect, 1);
		assert.ok(stats.ci && stats.ci[0] < -1 && stats.ci[1] > 3, `two and three reviews prove nothing: ${stats.ci}`);
		// Identical scores: the spread floor (sd 1) keeps the interval open; 30 per arm at 99% is about ±0.69.
		const same = reviewStats(["A", "B"].flatMap((arm) => Array.from({ length: 30 }, () => r(arm, 8))));
		assert.ok(same.ci && Math.abs(same.ci[1] - 0.69) < 0.02 && Math.abs(same.ci[0] + 0.69) < 0.02, `${same.ci}`);
		assert.ok(reviewStats(["A", "B"].flatMap((arm) => Array.from({ length: 30 }, () => r(arm, 8))), 0.95).ci![1] < 0.55, "a lower level narrows it");
		assert.equal(reviewStats([r("A", 6), r("B", 6), r("B", 7)]).ci, null);
		assert.equal(reviewStats([]).effect, null);
	});

	test("ledgers survive a line a crash cut short: it is skipped, and the next append starts a new line", () => {
		const source = join(dir, "src");
		const r: Review = { experiment: "x", session: "s1", arm: "A", score: 7, reason: "", model: "m", at: "" };
		appendReviews(source, [r]);
		appendFileSync(join(source, ".agents/dreams/reviews.jsonl"), '{"experiment":"x","sess');
		appendFileSync(join(source, ".agents/dreams/reviews.jsonl"), "");
		appendReviews(source, [{ ...r, session: "s2" }]);
		appendFileSync(join(source, ".agents/dreams/reviews.jsonl"), '{"session":"s3"}\n');
		assert.deepEqual(readReviews(source).map((x) => x.session), ["s1", "s2"], "the cut line and the invalid record are skipped");
		appendEconomy(source, [{ run: "r", kind: "note", text: "n" }]);
		appendFileSync(join(source, ".agents/dreams/economy.jsonl"), "{broken");
		assert.deepEqual(readEconomy(source).map((x) => x.text), ["n"]);
	});
});

/** An arm session with defaults: one package, 10 turns, 20 tool results. */
const armSession = (id: string, cell: string, o: Partial<ArmSession> = {}): ArmSession => ({
	session: id, project: "/p", cell, forced: false, turns: 10, toolCalls: 10, batchedTurns: 0, packages: 1, cost: 10, readCost: 5, toolResults: 20, toolErrors: 1,
	mutatingCalls: 0, toolMutatingCalls: 0, editCalls: 0, editedFiles: 0, childCost: 0, labelled: 4, negatives: 1, interrupts: 0, delegated: 0, retried: 0, tools: {}, ...o,
});
/** The judge's comparison: 99% intervals. */
const compare = (sessions: ArmSession[]) => compareCells(["x"], sessions, [], LEVEL);
/** `n` sessions per arm; B's from `b`, with a little noise so intervals have width. */
const arms = (n: number, b: (i: number) => Partial<ArmSession>, a: (i: number) => Partial<ArmSession> = () => ({})) => [
	...Array.from({ length: n }, (_, i) => armSession(`a${i}`, "A", { cost: 10 + (i % 3) * 0.1, ...a(i) })),
	...Array.from({ length: n }, (_, i) => armSession(`b${i}`, "B", { cost: 10 + (i % 3) * 0.1, ...b(i) })),
];
const reviews = (n: number, a: number, b: number): ReviewStats =>
	reviewStats(["A", "B"].flatMap((arm) => Array.from({ length: n }, (_, i) => ({ experiment: "x", session: `${arm}${i}`, arm, score: (arm === "A" ? a : b) + (i % 2), reason: "", model: "m", at: "" }))));

describe("judge: decide", () => {
	const enough = MIN_SESSIONS;
	const held = () => reviews(REVIEWS_PER_ARM, 7, 7);

	test("promotes when cheaper with every guard that has data held, giving the reasons", () => {
		const v = decide(compare(arms(enough, () => ({ cost: 7 }))), held(), 3);
		assert.equal(v.decision, "promote", v.reasons.join("\n"));
		assert.match(v.reasons[0]!, /^cheaper: cost per package B − A -\$3\.\d+ \[-3\.\d+, -3\.\d+\]$/);
		for (const guard of ["review score", "user messages correcting", "tool error rate", "interrupted turns"]) assert.ok(v.reasons.some((r) => r.startsWith(`not worse: ${guard}`)), guard);
		assert.ok(!v.reasons.some((r) => r.includes("delegated again")), "no delegated sessions: no data, not counted");
		assert.ok(!v.reasons.some((r) => r.includes("follow-up")), "follow-ups count for delegated experiments only");
	});

	test("a guard resting on too little data neither vouches for quality nor stops", () => {
		// 10 labelled messages per arm, B's all corrections: below the guard's 30, so not "worse" and not "held".
		const few = arms(enough, (i) => ({ cost: 7, labelled: i < 10 ? 1 : 0, negatives: i < 10 ? 1 : 0 }), (i) => ({ labelled: i < 10 ? 1 : 0, negatives: 0 }));
		const v = decide(compare(few), held(), 3);
		assert.equal(v.decision, "promote");
		assert.ok(!v.reasons.some((r) => r.includes("user messages correcting")));
		// With 30 labelled messages per arm the same pattern stops it.
		const enoughLabels = arms(enough, () => ({ cost: 7, labelled: 1, negatives: 1 }), () => ({ labelled: 1, negatives: 0 }));
		assert.match(decide(compare(enoughLabels), held(), 3).reasons[0]!, /^quality worse: user messages correcting/);
	});

	test("stops early when a quality guard is worse, though cheaper", () => {
		const worse = decide(compare(arms(MIN_EARLY_SESSIONS, () => ({ cost: 5, negatives: 3 }))), reviews(0, 0, 0), 1);
		assert.equal(worse.decision, "stop");
		assert.match(worse.reasons[0]!, /^quality worse: user messages correcting or reporting failures B − A 0\.5000/);
		const errors = decide(compare(arms(MIN_EARLY_SESSIONS, () => ({ cost: 5, toolErrors: 6 }))), reviews(0, 0, 0), 1);
		assert.match(errors.reasons[0]!, /^quality worse: tool error rate/);
		const reviewed = decide(compare(arms(enough, () => ({ cost: 5 }))), reviews(REVIEWS_PER_ARM, 8, 5), 1);
		assert.equal(reviewed.decision, "stop");
		assert.match(reviewed.reasons[0]!, /^quality worse: review score \(1-10\) B − A -3\.00/);
	});

	test("the review stops nothing on a handful of reviews", () => {
		assert.equal(decide(compare(arms(enough, () => ({ cost: 5 }))), reviews(MIN_STOP_REVIEWS - 1, 9, 2), 1).decision, "continue");
		assert.equal(decide(compare(arms(enough, () => ({ cost: 5 }))), reviews(MIN_STOP_REVIEWS, 9, 2), 1).decision, "stop");
	});

	test("delegated experiments: the parent's rework guards quality", () => {
		const followUps = arms(enough, () => ({ cost: 5, delegated: 1, labelled: 0, negatives: 0, packages: 3 }), () => ({ delegated: 1, labelled: 0, negatives: 0 }));
		const v = decide(compare(followUps), held(), 1, "delegated");
		assert.equal(v.decision, "stop");
		assert.ok(v.reasons.some((r) => r.startsWith("quality worse: follow-up requests per session")), v.reasons.join("\n"));
		assert.notEqual(decide(compare(followUps), held(), 1, "top-level").reasons.some((r) => r.includes("follow-up")), true, "top-level follow-ups are new work, not rework");
		const retried = arms(enough, (i) => ({ cost: 5, delegated: 1, retried: i % 2, labelled: 0, negatives: 0 }), () => ({ delegated: 1, labelled: 0, negatives: 0 }));
		assert.match(decide(compare(retried), held(), 1, "delegated").reasons.join("\n"), /quality worse: subagent tasks delegated again/);
		const clean = arms(enough, () => ({ cost: 5, delegated: 1, labelled: 0, negatives: 0 }), () => ({ delegated: 1, labelled: 0, negatives: 0 }));
		const promoted = decide(compare(clean), held(), 1, "delegated");
		assert.equal(promoted.decision, "promote", promoted.reasons.join("\n"));
		assert.ok(promoted.reasons.some((r) => r.startsWith("not worse: subagent tasks delegated again")));
		assert.ok(promoted.reasons.some((r) => r.startsWith("not worse: follow-up requests per session")));
	});

	test("stops early when it costs more; never before enough sessions", () => {
		const v = decide(compare(arms(MIN_EARLY_SESSIONS, () => ({ cost: 14 }))), reviews(0, 0, 0), 1);
		assert.equal(v.decision, "stop");
		assert.match(v.reasons[0]!, /^costs more: cost per package B − A \$3\.9\d/);
		const few = decide(compare(arms(MIN_EARLY_SESSIONS - 1, () => ({ cost: 14, negatives: 4 }))), reviews(0, 0, 0), 1);
		assert.equal(few.decision, "continue");
	});

	test("continues while sessions, reviews or significance are missing, saying what is missing", () => {
		const v = decide(compare(arms(10, () => ({ cost: 7 }))), reviews(3, 7, 7), 2);
		assert.equal(v.decision, "continue");
		assert.ok(v.reasons.includes(`10 of ${MIN_SESSIONS} sessions in the smaller arm`));
		assert.ok(v.reasons.includes(`3 of ${REVIEWS_PER_ARM} reviews in the smaller arm`));
		const flat = decide(compare(arms(enough, () => ({}))), held(), 2);
		assert.equal(flat.decision, "continue");
		assert.match(flat.reasons.join("\n"), /no significant saving yet/);
	});

	test("an open guard (not shown not worse) blocks promotion", () => {
		// B's negative share is noisy: its interval reaches past the margin without being significantly worse.
		const v = decide(compare(arms(enough, (i) => ({ cost: 7, negatives: i % 2 ? 3 : 0 }))), held(), 2);
		assert.equal(v.decision, "continue");
		assert.match(v.reasons.join("\n"), /not shown not worse: user messages correcting/);
		// A review sample that is too noisy at 30 per arm stays open.
		const noisy = reviewStats(["A", "B"].flatMap((arm) => Array.from({ length: 30 }, (_, i) => ({ experiment: "x", session: `${arm}${i}`, arm, score: i % 2 ? 9 : 5, reason: "", model: "m", at: "" }))));
		assert.match(decide(compare(arms(enough, () => ({ cost: 7 }))), noisy, 2).reasons.join("\n"), /not shown not worse: review score/);
	});

	test("the review is always required", () => {
		const delegated = arms(enough, () => ({ cost: 7, labelled: 0, negatives: 0 }), () => ({ labelled: 0, negatives: 0 }));
		assert.equal(decide(compare(delegated), held(), 2).decision, "promote");
		const unreviewed = decide(compare(delegated), reviews(0, 0, 0), 2);
		assert.equal(unreviewed.decision, "continue");
		assert.match(unreviewed.reasons.join("\n"), /no review interval yet/);
	});

	test("judged at 99%: a saving significant at 95% only is not enough", () => {
		// B a little cheaper with noise: the 95% interval excludes 0, the 99% one does not.
		const s = arms(enough, (i) => ({ cost: 10 - 0.2 + ((i * 7) % 11) * 0.1 - 0.5 }), (i) => ({ cost: 10 + ((i * 5) % 11) * 0.1 - 0.5 }));
		const at95 = compareCells(["x"], s).metrics.find((m) => m.key === "costPerPackage")!.ci!;
		const at99 = compare(s).metrics.find((m) => m.key === "costPerPackage")!.ci!;
		assert.ok(at95[1] < 0 && at99[1] >= 0, `95% ${at95}, 99% ${at99}`);
		assert.match(decide(compare(s), held(), 2).reasons.join("\n"), /no significant saving yet/);
	});

	test("stops after MAX_DAYS without a promotion", () => {
		const v = decide(compare(arms(enough, () => ({}))), held(), MAX_DAYS);
		assert.equal(v.decision, "stop");
		assert.equal(v.reasons[0], `no promotion after ${MAX_DAYS} days`);
	});
});

/** A scripted model: reviews from the session text ("GOOD"/"BAD"), the economist from `economist`. */
function scripted(economist: unknown = { experiments: [], notes: [] }, calls: string[] = []): Ask {
	return async (model, system, prompt, validate) => {
		calls.push(system.startsWith("You grade") ? "review" : system.startsWith("You are the economist") ? "economist" : system.startsWith("You label") ? "label" : "curate");
		if (system.startsWith("You grade")) return validate({ score: prompt.includes("BAD") ? 3 : 8, reason: "scripted" });
		if (system.startsWith("You are the economist")) return validate(economist);
		if (system.startsWith("You label")) {
			const count = prompt.match(/<message i=/g)?.length ?? 0;
			return validate(Array.from({ length: count }, (_, i) => ({ i, label: "new_task", rule: null, scope: null })));
		}
		return validate({ deltas: [] });
	};
}

const DREAM_EXPERIMENT = (started: string, extra = "") => `---\nstatus: running\nstarted: ${started}\nsource: dream\nhypothesis: cheaper\nsettings:\n  thinking: low\n${extra}---\n\nWork lean.\n`;

describe("judge: runs", () => {
	function populate(db: DatabaseSync, n: number, b: Partial<SessionSpec>) {
		for (let i = 0; i < n; i++) {
			addSession(db, { id: `a${i}`, arm: "A", turns: [10 + (i % 3) * 0.1], start: T + i * MIN, text: "GOOD task" });
			addSession(db, { id: `b${i}`, arm: "B", turns: [7 + (i % 3) * 0.1], start: T + i * MIN, text: "GOOD task", ...b });
		}
	}

	test("reviews a sample, promotes a cheaper experiment whose quality held: one commit, changelog, reviews kept", async () => {
		const source = repository("harness", { ".gitignore": ".agents\n", "prompt/experiments/lean.md": DREAM_EXPERIMENT("2026-10-30T00:00:00.000Z"), "prompt/experiments/human.md": "---\nstatus: running\n---\nMine.\n" });
		const db = openStore(join(dir, "metrics.db"));
		populate(db, MIN_SESSIONS, {});
		db.prepare("UPDATE experiment_arms SET experiment = 'lean'").run();
		const calls: string[] = [];
		const now = new Date(T + 5 * DAY);
		const dry = await judge({ source, db, now, ask: scripted(undefined, calls), dryRun: true });
		assert.equal(dry[0]!.decision, "promote");
		assert.equal(calls.filter((c) => c === "review").length, 2 * REVIEWS_PER_ARM);
		assert.deepEqual(readReviews(source), [], "a dry run keeps no reviews");
		assert.equal(git(source, "rev-list", "--count", "HEAD"), "1");

		const [lean, ...others] = await judge({ source, db, now, ask: scripted(), dryRun: false });
		assert.equal(others.length, 0, "experiments people started are not judged");
		assert.equal(lean!.decision, "promote");
		assert.ok(lean!.commit);
		assert.equal(readReviews(source).length, 2 * REVIEWS_PER_ARM);
		assert.equal(git(source, "log", "-1", "--format=%s"), "feat(rules): promote dreamed experiment lean");
		assert.match(git(source, "log", "-1", "--format=%b"), /Settings of arm B: thinking: low \(all sessions\)\.[\s\S]*## Why\n\n- cheaper: [\s\S]*## Result \(99% intervals\)[\s\S]*review score: A 8\.00 \(30\), B 8\.00 \(30\)/);
		assert.equal(git(source, "status", "--porcelain"), "", "checkout matches the commit");
		assert.deepEqual(listExperiments(join(source, "prompt/experiments")).map((e) => e.name), ["human"]);
		const [rule] = listRules(join(source, "prompt/rules"));
		assert.deepEqual([rule!.name, rule!.body, rule!.settings, rule!.sessions], ["lean", "Work lean.", { thinking: "low" }, "all"]);
		assert.match(readFileSync(join(source, ".agents/changelog.md"), "utf8"), /experiment promoted: lean[\s\S]*\*\*Why:\*\* dreaming \(scripts\/dream\/judge\.ts\): cheaper/);

		// Reviews are not repeated.
		calls.length = 0;
		await judge({ source, db, now, ask: scripted(undefined, calls), dryRun: true });
		assert.deepEqual(calls, []);
		db.close();
	});

	test("stops an experiment whose reviews are worse, and leaves a file with uncommitted changes alone", async () => {
		const source = repository("harness", { ".gitignore": ".agents\n", "prompt/experiments/lean.md": DREAM_EXPERIMENT("2026-10-30T00:00:00.000Z") });
		const db = openStore(join(dir, "metrics.db"));
		populate(db, MIN_SESSIONS, { text: "BAD task" });
		db.prepare("UPDATE experiment_arms SET experiment = 'lean'").run();
		const now = new Date(T + 5 * DAY);
		const file = join(source, "prompt/experiments/lean.md");
		appendFileSync(file, "my edit\n");
		const [busy] = await judge({ source, db, now, ask: scripted(), dryRun: false });
		assert.equal(busy!.decision, "stop");
		assert.match(busy!.skipped!, /lean\.md has uncommitted changes/);
		assert.equal(git(source, "rev-list", "--count", "HEAD"), "1");

		git(source, "checkout", "--", "prompt/experiments/lean.md");
		const [stopped] = await judge({ source, db, now, ask: scripted(), dryRun: false });
		assert.equal(stopped!.decision, "stop");
		assert.match(stopped!.reasons[0]!, /^quality worse: review score/);
		assert.equal(git(source, "log", "-1", "--format=%s"), "chore(experiments): stop dreamed experiment lean");
		assert.equal(listExperiments(join(source, "prompt/experiments"))[0]!.status, "stopped");
		assert.equal(git(source, "status", "--porcelain"), "");
		db.close();
	});

	test("no review before each arm has enough settled sessions; then not the active, forced or unmatched ones", async () => {
		const source = repository("harness", { ".gitignore": ".agents\n", "prompt/experiments/lean.md": DREAM_EXPERIMENT("2026-10-30T00:00:00.000Z") });
		const db = openStore(join(dir, "metrics.db"));
		const now = new Date(T + 5 * DAY);
		populate(db, MIN_SESSIONS - 1, {});
		addSession(db, { id: "active", arm: "A", start: now.getTime() - 30 * MIN });
		addSession(db, { id: "activeB", arm: "B", start: now.getTime() - 30 * MIN });
		db.prepare("UPDATE experiment_arms SET experiment = 'lean'").run();
		const reviewed: string[] = [];
		const ask: Ask = async (_model, _system, prompt, validate) => {
			reviewed.push(prompt);
			return validate({ score: 7 });
		};
		await judge({ source, db, now, ask, dryRun: true });
		assert.equal(reviewed.length, 0, `${MIN_SESSIONS - 1} settled per arm: the sample waits`);
		addSession(db, { id: "a-last", arm: "A", experiment: "lean" });
		addSession(db, { id: "b-last", arm: "B", experiment: "lean" });
		addSession(db, { id: "forced", arm: "B", experiment: "lean", forced: true });
		addSession(db, { id: "lonely", arm: "B", experiment: "lean", cwd: "/other" });
		await judge({ source, db, now, ask, dryRun: true });
		assert.equal(reviewed.length, 2 * MIN_SESSIONS, "every settled, random, matched session; not the active, forced or unmatched ones");
		db.close();
	});

	test("a decision the branch refuses waits on its dream branch: no changelog, no second branch", async () => {
		const source = repository("harness", { ".gitignore": ".agents\n", "prompt/experiments/lean.md": DREAM_EXPERIMENT("2026-10-30T00:00:00.000Z") });
		mkdirSync(join(source, "hooks"));
		writeFileSync(join(source, "hooks/reference-transaction"), '#!/bin/sh\n[ "$1" = prepared ] || exit 0\nwhile read -r old new ref; do\n  [ "$ref" = refs/heads/main ] && { echo "refused" >&2; exit 1; }\ndone\nexit 0\n', { mode: 0o755 });
		git(source, "add", "hooks");
		git(source, "commit", "-qm", "hook");
		git(source, "config", "core.hooksPath", "hooks");
		const db = openStore(join(dir, "metrics.db"));
		populate(db, MIN_SESSIONS, { text: "BAD task" });
		db.prepare("UPDATE experiment_arms SET experiment = 'lean'").run();
		const now = new Date(T + 5 * DAY);
		const result = await dream({ source, db, now, since: now.getTime(), ask: scripted() });
		const [stopped] = result.verdicts;
		assert.equal(stopped!.decision, "stop");
		assert.equal(stopped!.branch, "dream/2026-11-06-stop-lean");
		assert.equal(existsSync(join(source, ".agents/changelog.md")), false, "not landed: not in the changelog");
		assert.equal(listExperiments(join(source, "prompt/experiments"))[0]!.status, "running", "the checkout keeps running it");
		const again = await dream({ source, db, now: new Date(now.getTime() + DAY), since: now.getTime(), ask: scripted() });
		assert.deepEqual([again.verdicts[0]!.decision, again.verdicts[0]!.reasons], ["continue", ["waiting for branch dream/2026-11-06-stop-lean to land"]]);
		assert.equal(git(source, "branch", "--list", "dream/*").split("\n").length, 1);
		db.close();
	});

	test("a dream experiment that no longer runs (a problem) is stopped", async () => {
		const source = repository("harness", { ".gitignore": ".agents\n", "prompt/experiments/broken.md": DREAM_EXPERIMENT("2026-10-30T00:00:00.000Z").replace("thinking: low", "thinking: lots") });
		const db = openStore(join(dir, "metrics.db"));
		const [v] = await judge({ source, db, now: new Date(T), ask: scripted(), dryRun: false });
		assert.equal(v!.decision, "stop");
		assert.match(v!.reasons[0]!, /^the experiment does not run: settings\.thinking must be one of/);
		assert.equal(git(source, "log", "-1", "--format=%s"), "chore(experiments): stop dreamed experiment broken");
		assert.match(readFileSync(join(source, ".agents/changelog.md"), "utf8"), /experiment stopped: broken/);
		db.close();
	});
});

/** An economist's proposal as the model writes it. */
const proposal = (o: Record<string, unknown> = {}) => ({ name: "lean-subagents", hypothesis: "Sonnet does delegated reviews as well.", body: "", settings: { model: "anthropic/claude-sonnet-5-5" }, sessions: "delegated", expectedWeeklySaving: 500, qualityRisk: "medium", evidence: "94% of spend is delegated.", ...o });

describe("economize", () => {
	const running = (name: string, settings: Experiment["settings"], sessions: Experiment["sessions"] = "all"): Experiment => ({
		name, file: "", status: "running", frontmatter: {}, body: "", interacts: [], tools: [], settings, sessions,
	});

	test("valid proposals pass; each invalid one is refused with its reason", () => {
		const existing = [running("thin", { thinking: "low" }, "delegated")];
		const economy = parseEconomy(
			{
				experiments: [
					proposal(),
					proposal({ name: "Bad Name" }),
					proposal({ name: "thin" }),
					proposal({ name: "unknown-setting", settings: { temperature: 1 } }),
					proposal({ name: "tiny-context", settings: { maxContextTokens: 1000 } }),
					proposal({ name: "nothing", settings: {}, body: "" }),
					proposal({ name: "risky", qualityRisk: "high" }),
					proposal({ name: "free", expectedWeeklySaving: 0 }),
					proposal({ name: "clash", settings: { thinking: "minimal" }, sessions: "all" }),
					proposal({ name: "top-thinking", settings: { thinking: "minimal" }, sessions: "top-level" }),
					proposal({ name: "own-clash", settings: { model: "anthropic/claude-haiku-5-5" }, sessions: "all" }),
					proposal({ name: "long", settings: {}, body: "x".repeat(1201) }),
					proposal({ name: "bad-sessions", sessions: "children" }),
					proposal({ name: "lean-subagents", settings: { maxContextTokens: 200000 } }),
				],
				notes: [{ title: "Truncate bash output", body: "36% of cost." }, { title: 3 }],
			},
			existing,
			new Set(["thin", "batch"]),
			2,
		);
		assert.deepEqual(economy.proposals.map((p) => p.name), ["lean-subagents", "top-thinking"]);
		assert.deepEqual(economy.proposals[0], { name: "lean-subagents", hypothesis: "Sonnet does delegated reviews as well.", body: "", settings: { model: "anthropic/claude-sonnet-5-5" }, sessions: "delegated", expectedWeeklySaving: 500, qualityRisk: "medium", evidence: "94% of spend is delegated." });
		assert.deepEqual(economy.refused, [
			{ name: "Bad Name", reason: "invalid name" },
			{ name: "thin", reason: "the name is taken by an experiment or rule" },
			{ name: "unknown-setting", reason: "unknown settings temperature (known: model, thinking, maxContextTokens)" },
			{ name: "tiny-context", reason: "settings.maxContextTokens must be an integer of at least 50000, got 1000" },
			{ name: "nothing", reason: "neither a body nor settings" },
			{ name: "risky", reason: 'quality risk "high": only low and medium risks are tested' },
			{ name: "free", reason: "no expected saving" },
			{ name: "clash", reason: "sets thinking like thin for the same sessions" },
			{ name: "own-clash", reason: "sets model like lean-subagents for the same sessions" },
			{ name: "long", reason: "body longer than 1200 characters" },
			{ name: "bad-sessions", reason: 'invalid sessions "children"' },
			{ name: "lean-subagents", reason: "the name is taken by an experiment or rule" },
		]);
		assert.deepEqual(economy.notes, [{ title: "Truncate bash output", body: "36% of cost." }]);
		assert.equal(parseEconomy({ experiments: [proposal(), proposal({ name: "second", settings: { maxContextTokens: 300000 } })] }, [], new Set(), 1).refused[0]!.reason, "only 1 new experiments this run");
		assert.throws(() => parseEconomy({}, [], new Set(), 2), /expected/);
	});

	test("the experiment file reads back as the proposal: a running dream experiment with its settings", () => {
		const source = join(dir, "x");
		mkdirSync(source);
		const now = new Date(T);
		const [p] = parseEconomy({ experiments: [proposal({ body: "Brief subagents tightly." })] }, [], new Set(), 2).proposals;
		writeFileSync(join(source, "lean-subagents.md"), experimentFile(p!, now));
		const [e] = listExperiments(source);
		assert.equal(e!.problem, undefined);
		assert.deepEqual([e!.status, e!.body, e!.settings, e!.sessions, e!.frontmatter.source, e!.frontmatter.started], ["running", "Brief subagents tightly.", { model: "anthropic/claude-sonnet-5-5" }, "delegated", "dream", now.toISOString()]);
	});

	test("the economist sees facts, settings, prices, rules and every experiment with how dreaming ended it", () => {
		const source = repository("harness", {
			"prompt/AGENTS.md": "Find the root cause.\n",
			"prompt/rules/lean.md": "---\nsettings:\n  thinking: low\nsessions: delegated\n---\n",
			"prompt/experiments/old.md": "---\nstatus: stopped\nsource: dream\n---\nOld idea.\n",
		});
		mkdirSync(join(source, ".agents/dreams"), { recursive: true });
		writeFileSync(join(source, ".agents/dreams/economy.jsonl"), `${JSON.stringify({ run: "r", kind: "verdict", experiment: "old", decision: "stop", reasons: ["quality worse: review"] })}\n`);
		const db = openStore(join(dir, "metrics.db"));
		addSession(db, { id: "s" });
		const input = economistInput({ source, db, now: new Date(T + DAY), facts: "FACTS" });
		assert.match(input, /<facts>\nFACTS\n<\/facts>/);
		assert.match(input, /Rule lean sets thinking: low for delegated sessions\./);
		assert.match(input, /anthropic\/claude-opus-5-5: input \$5\.00, cache read \$0\.50, cache write \$6\.25/);
		assert.match(input, /<user_rules>\nFind the root cause\.\n<\/user_rules>/);
		assert.match(input, /<experiment name="old" status="stopped" source="dream" sessions="all">\nbody: Old idea\.\nended by dreaming: stop: quality worse: review\n<\/experiment>/);
		db.close();
	});

	test("starts each valid proposal as its own commit; no free slot, no question", async () => {
		const source = repository("harness", { ".gitignore": ".agents\n" });
		const db = openStore(join(dir, "metrics.db"));
		const calls: string[] = [];
		const economist = { experiments: [proposal(), proposal({ name: "short-context", settings: { maxContextTokens: 300000 }, sessions: "all", qualityRisk: "low" })], notes: [] };
		const now = new Date(T);
		const dry = await economize({ source, db, now, facts: "F", ask: scripted(economist), dryRun: true });
		assert.equal(dry.started.length, 2);
		assert.equal(git(source, "rev-list", "--count", "HEAD"), "1");
		const { started } = await economize({ source, db, now, facts: "F", ask: scripted(economist, calls), dryRun: false });
		assert.deepEqual(started.map((s) => [s.proposal.name, Boolean(s.commit)]), [["lean-subagents", true], ["short-context", true]]);
		assert.deepEqual(git(source, "log", "--format=%s").split("\n"), ["feat(experiments): dreamed spend experiment short-context", "feat(experiments): dreamed spend experiment lean-subagents", "init"]);
		assert.match(git(source, "log", "-1", "--skip=1", "--format=%b"), /Hypothesis: Sonnet does delegated reviews as well\.\n\nArm B: settings model: anthropic\/claude-sonnet-5-5; enrolls delegated new sessions\.\nExpected saving: about \$500 a week\. Quality risk: medium\.\n\n## Evidence\n\n94% of spend is delegated\./);
		assert.deepEqual(listExperiments(join(source, "prompt/experiments")).map((e) => [e.name, e.problem]), [["lean-subagents", undefined], ["short-context", undefined]]);
		assert.equal(git(source, "status", "--porcelain"), "");

		// Two of three slots taken: only one new experiment may start.
		calls.length = 0;
		const third = await economize({ source, db, now, facts: "F", ask: scripted({ experiments: [proposal({ name: "a", settings: { thinking: "low" } }), proposal({ name: "b", settings: { thinking: "high" }, sessions: "top-level" })] }, calls), dryRun: false });
		assert.deepEqual(third.started.map((s) => s.proposal.name), ["a"]);
		assert.deepEqual(third.economy.refused, [{ name: "b", reason: "only 1 new experiments this run" }]);
		calls.length = 0;
		const full = await economize({ source, db, now, facts: "F", ask: scripted(economist, calls), dryRun: false });
		assert.deepEqual([full.started, calls], [[], []], "three dream experiments run: no economist call");
		db.close();
	});

	test("an experiment started on a branch that did not land takes a slot and keeps its name", async () => {
		const source = repository("harness", { ".gitignore": ".agents\n" });
		const db = openStore(join(dir, "metrics.db"));
		appendEconomy(source, [
			{ run: "r", kind: "started", experiment: "lean-subagents", branch: "dream/x" },
			{ run: "r", kind: "started", experiment: "other", branch: "dream/y" },
		]);
		const { economy, started } = await economize({ source, db, now: new Date(T), facts: "F", ask: scripted({ experiments: [proposal(), proposal({ name: "fresh", settings: { maxContextTokens: 300000 } })] }), dryRun: true });
		assert.deepEqual(started.map((s) => s.proposal.name), ["fresh"]);
		assert.deepEqual(economy.refused, [{ name: "lean-subagents", reason: "the name is taken by an experiment or rule" }]);
		db.close();
	});
});

describe("commitFiles", () => {
	test("writes and deletes several files in one commit and brings the checkout along", () => {
		const repo = repository("r", { "a.md": "a\n", "dir/b.md": "b\n", "keep.md": "k\n" });
		const result = commitFiles(repo, [{ path: join(repo, "a.md"), content: null }, { path: join(repo, "rules/c.md"), content: "c\n" }, { path: join(repo, "dir/b.md"), content: "B\n" }], "feat: move\n\nbody", "dream/x");
		assert.ok(result.commit && !result.branch);
		assert.deepEqual(git(repo, "show", "--name-status", "--format=", "HEAD").split("\n").sort(), ["A\trules/c.md", "D\ta.md", "M\tdir/b.md"]);
		assert.equal(existsSync(join(repo, "a.md")), false);
		assert.equal(readFileSync(join(repo, "rules/c.md"), "utf8"), "c\n");
		assert.equal(readFileSync(join(repo, "dir/b.md"), "utf8"), "B\n");
		assert.equal(git(repo, "status", "--porcelain"), "");
	});
});

describe("a dream run with spend", () => {
	test("labels kept for the comparison, judged and started experiments in the report and the economy ledger; a dry run writes nothing", async () => {
		const source = repository("harness", { ".gitignore": ".agents\n", "prompt/AGENTS.md": "Rule.\n" });
		const db = openStore(join(dir, "metrics.db"));
		const now = new Date(T + DAY);
		addSession(db, { id: "s1", start: T + 60 * MIN, turns: [5, 5] });
		db.prepare("UPDATE user_messages SET text = 'please fix' WHERE session_id = 's1'").run();
		writeFileSync(join(dir, "s1.jsonl"), "");
		const calls: string[] = [];
		const economist = { experiments: [proposal()], notes: [{ title: "Truncate bash output", body: "36% of cost." }] };
		const dry = await dream({ source, db, now, since: T, ask: scripted(economist, calls), dryRun: true });
		assert.deepEqual(calls, ["economist"], "no human follow-up to label; the economist is asked");
		assert.match(dry.text, /## Spend\n\nWindow 2026-11-01 10:00 to 2026-11-02 10:00 UTC/);
		assert.match(dry.text, /### Dream experiments started\n\n- lean-subagents: Sonnet does delegated reviews as well\. Arm B: model: anthropic\/claude-sonnet-5-5, delegated sessions; about \$500 a week, quality risk medium\./);
		assert.match(dry.text, /### Spend improvements that need code\n\n#### Truncate bash output\n\n36% of cost\./);
		assert.equal(existsSync(join(source, ".agents")), false);
		assert.equal(git(source, "rev-list", "--count", "HEAD"), "1");

		const result = await dream({ source, db, now, since: T, ask: scripted(economist) });
		assert.equal(result.started[0]!.proposal.name, "lean-subagents");
		assert.equal(git(source, "log", "-1", "--format=%s"), "feat(experiments): dreamed spend experiment lean-subagents");
		assert.deepEqual(readEconomy(source).map((r) => [r.kind, r.experiment ?? r.text]), [["started", "lean-subagents"], ["note", "Truncate bash output: 36% of cost."]]);
		assert.match(readFileSync(result.reportFile!, "utf8"), /### Dream experiments judged\n\nNone running\./);
		db.close();
	});

	test("a human follow-up is labelled and its label kept in the labels file and the index", async () => {
		const source = repository("harness", { ".gitignore": ".agents\n", "prompt/AGENTS.md": "Rule.\n" });
		const db = openStore(join(dir, "metrics.db"));
		addSession(db, { id: "s1", labels: ["x"] });
		db.prepare("UPDATE user_messages SET text = 'now also the footer' WHERE entry_id = 'u1'").run();
		writeFileSync(join(dir, "s1.jsonl"), "");
		await dream({ source, db, now: new Date(T + DAY), since: T, ask: scripted() });
		const kept = readFileSync(join(source, ".agents/dreams/labels.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.deepEqual(kept.map((l) => [l.session, l.entry, l.label]), [["s1", "u1", "new_task"]]);
		assert.deepEqual(db.prepare("SELECT session_id, entry_id, label FROM message_labels").all().map((r) => ({ ...r })), [{ session_id: "s1", entry_id: "u1", label: "new_task" }]);
		db.close();
	});
});
