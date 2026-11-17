// Dreaming (scripts/dream): labelling, collecting the user's messages, the known rules, curator
// validation, applying deltas as commits (temporary git repositories), the ledger and report, and
// whole runs against a temporary metrics index with a scripted model.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { openStore } from "../extensions/metrics/store.ts";
import { applyDelta, type ApplyContext, withLearnedLine } from "../scripts/dream/apply.ts";
import { collect, precedingAgentText } from "../scripts/dream/collect.ts";
import { type Candidate, parseDeltas } from "../scripts/dream/curate.ts";
import { type LedgerRecord, readLedger, readSince, recurrences, report } from "../scripts/dream/ledger.ts";
import { globalRules, instructionFile, type KnownRule, projectRules } from "../scripts/dream/rules.ts";
import { dream } from "../scripts/dream/run.ts";
import { type Ask, isHuman, labelMessages, parseLabels } from "../scripts/lib/labels.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dream-"));
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
const head = (repo: string) => git(repo, "log", "-1", "--format=%s%n%b");

describe("labels", () => {
	test("isHuman leaves out what tools, t3 and the harness wrote", () => {
		for (const text of ["<task-notification>x", "Delegated task y", "[Request interrupted by user]", "The user answered your ask_user questions:\n…", "   ", ""]) assert.equal(isHuman(text), false, text);
		assert.equal(isHuman("no, use bun"), true);
	});

	test("parseLabels needs every message, keeps valid labels, defaults a rule's scope to global", () => {
		const labels = parseLabels(
			[
				{ i: 0, label: "correction", rule: " Use bun. ", scope: "project" },
				{ i: 1, label: "process", rule: "Do not wait.", scope: "weird" },
				{ i: 2, label: "approval", rule: "", scope: "global" },
			],
			3,
		);
		assert.deepEqual([...labels.values()], [
			{ label: "correction", rule: "Use bun.", scope: "project" },
			{ label: "process", rule: "Do not wait.", scope: "global" },
			{ label: "approval", rule: null, scope: null },
		]);
		assert.throws(() => parseLabels([{ i: 0, label: "correction" }], 2), /got 1 of 2/);
		assert.throws(() => parseLabels([{ i: 0, label: "bogus" }], 1), /got 0 of 1/);
		assert.throws(() => parseLabels({}, 1), /array/);
	});

	test("labelMessages batches, sends the agent's message before, and keeps the order", async () => {
		const bodies: string[] = [];
		const ask: Ask = async (_model, _system, user, validate) => {
			bodies.push(user);
			const count = user.match(/<message i=/g)!.length;
			return validate(Array.from({ length: count }, (_, i) => ({ i, label: "new_task", rule: user.includes(`M${i}`) ? null : null })));
		};
		const messages = Array.from({ length: 7 }, (_, i) => ({ text: `message ${i}`, ...(i === 0 ? { before: "x".repeat(900) + "TAIL" } : {}) }));
		const done: number[] = [];
		const labels = await labelMessages(messages, "m", { ask, batch: 3, concurrency: 2, onBatch: (b) => done.push(...b.keys()) });
		assert.equal(labels.length, 7);
		assert.equal(bodies.length, 3);
		assert.deepEqual(done.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
		assert.match(bodies[0]!, /<agent_before>\nx+TAIL\n<\/agent_before>/);
		assert.equal(bodies[0]!.match(/x+TAIL/)![0].length, 500, "the end of a long agent message");
	});
});

/** A metrics index with sessions and user messages written the way the indexer writes them. */
function index(): DatabaseSync {
	return openStore(join(dir, "metrics.db"));
}
function addSession(db: DatabaseSync, s: { id: string; cwd: string; file?: string; source?: string; parent?: string; digest?: string; messages: [entry: string, ts: number, kind: string, text: string][] }) {
	db.prepare(
		`INSERT INTO sessions (id, file, cwd, parent_session, name, source, prompt_digest, started_at, ended_at, requests, cost, aborted, errors, compactions, user_messages)
		VALUES (?, ?, ?, ?, NULL, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0)`,
	).run(s.id, s.file ?? join(dir, `${s.id}.jsonl`), s.cwd, s.parent ?? null, s.source ?? "pi", s.digest ?? null);
	for (const [entry, ts, kind, text] of s.messages) db.prepare("INSERT INTO user_messages (session_id, entry_id, ts, kind, text) VALUES (?, ?, ?, ?, ?)").run(s.id, entry, ts, kind, text);
}
function sessionFile(name: string, entries: object[]): string {
	const file = join(dir, `${name}.jsonl`);
	writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n{broken`);
	return file;
}
const assistant = (id: string, content: unknown) => ({ type: "message", id, message: { role: "assistant", content } });
const user = (id: string, text: string) => ({ type: "message", id, message: { role: "user", content: text } });

describe("collect", () => {
	test("the agent's last text before each entry, skipping thinking, tool calls and broken lines", () => {
		const file = sessionFile("s", [
			user("u1", "start"),
			assistant("a1", [{ type: "thinking", thinking: "hm" }, { type: "text", text: "Done: built it." }]),
			assistant("a2", [{ type: "toolCall", name: "bash" }]),
			user("u2", "no, the other one"),
			assistant("a3", "plain string answer"),
			user("u3", "ok"),
		]);
		const before = precedingAgentText(file);
		assert.equal(before.get("u1"), "");
		assert.equal(before.get("u2"), "Done: built it.");
		assert.equal(before.get("u3"), "plain string answer");
		assert.equal(precedingAgentText(join(dir, "missing.jsonl")).size, 0);
	});

	test("only messages the user typed in Pi sessions they drove, after the position", () => {
		const repo = repository("project");
		const db = index();
		const file = sessionFile("main", [assistant("a0", "I changed X."), user("e1", "no, Y"), user("e2", "<task-notification>"), user("e3", "old")]);
		addSession(db, { id: "main", cwd: join(repo, "sub"), file, messages: [["e1", 200, "follow-up", "no, Y"], ["e2", 210, "follow-up", "<task-notification> done"], ["e3", 50, "steer", "old"], ["e0", 190, "first", "the task"]] });
		addSession(db, { id: "delegated", cwd: repo, digest: "abc", messages: [["d1", 300, "follow-up", "parent agent text"]] });
		addSession(db, { id: "child", cwd: repo, parent: "main", messages: [["k1", 300, "follow-up", "tool agent text"]] });
		addSession(db, { id: "cc", cwd: repo, source: "claude-code", messages: [["c1", 300, "follow-up", "claude code text"]] });
		addSession(db, { id: "other", cwd: dir, messages: [["o1", 250, "after interrupt", "stop that"]] });
		const found = collect(db, 100);
		assert.deepEqual(
			found.map((o) => [o.key, o.text, o.repo, o.before ?? null]),
			[
				["main e1", "no, Y", repo, "I changed X."],
				["other o1", "stop that", dir, null],
			],
		);
		db.close();
	});
});

describe("known rules", () => {
	test("global: the user's AGENTS.md lines (read-only) and every prompt rule (editable)", () => {
		const prompt = join(dir, "prompt");
		mkdirSync(join(prompt, "rules"), { recursive: true });
		writeFileSync(join(prompt, "AGENTS.md"), "# Working rules\n\nFind the root cause.\n\n---\n- Be bold.\n-\n");
		writeFileSync(join(prompt, "rules", "batch.md"), "---\npromoted: 2026-11-12\n---\nBatch calls.\n");
		writeFileSync(join(prompt, "rules", "tools-only.md"), "---\ntools: x\n---\n");
		assert.deepEqual(globalRules(prompt), [
			{ id: "AGENTS.md:3", text: "Find the root cause.", editable: false },
			{ id: "AGENTS.md:6", text: "- Be bold.", editable: false },
			{ id: "rules/batch", text: "Batch calls.", editable: true },
		]);
	});

	test("project: AGENTS.md, else CLAUDE.md; only learned lines are editable", () => {
		const repo = join(dir, "r");
		mkdirSync(repo);
		assert.equal(instructionFile(repo), join(repo, "AGENTS.md"));
		assert.deepEqual(projectRules(repo), []);
		writeFileSync(join(repo, "CLAUDE.md"), "Use bun.\n\n## Learned rules\n\n- Run make check.\n\n## Other\nKeep it.\n");
		assert.equal(instructionFile(repo), join(repo, "CLAUDE.md"));
		assert.deepEqual(projectRules(repo), [
			{ id: `${repo}:1`, text: "Use bun.", editable: false },
			{ id: `${repo}:5`, text: "- Run make check.", editable: true },
			{ id: `${repo}:8`, text: "Keep it.", editable: false },
		]);
		writeFileSync(join(repo, "AGENTS.md"), "x\n");
		assert.equal(instructionFile(repo), join(repo, "AGENTS.md"), "AGENTS.md wins");
	});
});

describe("curator validation", () => {
	const candidates: Candidate[] = [
		{ ref: "c1", label: "correction", text: "a", rule: "A", scope: "global", repo: "/r" },
		{ ref: "c2", label: "process", text: "b", rule: "B", scope: "project", repo: "/r" },
	];
	const rules: KnownRule[] = [
		{ id: "AGENTS.md:3", text: "x", editable: false },
		{ id: "rules/batch", text: "y", editable: true },
	];
	const parse = (deltas: unknown[]) => parseDeltas({ deltas }, candidates, rules);

	test("accepts each kind of delta", () => {
		assert.deepEqual(
			parse([
				{ op: "recur", rule: "AGENTS.md:3", evidence: ["c1"] },
				{ op: "add", scope: "project", repo: "/r", text: " Use bun. ", evidence: ["c2"] },
			]),
			[
				{ op: "recur", rule: "AGENTS.md:3", evidence: ["c1"] },
				{ op: "add", scope: "project", repo: "/r", text: "Use bun.", evidence: ["c2"] },
			],
		);
		assert.equal(parse([{ op: "update", rule: "rules/batch", text: "z", reason: "wider", evidence: ["c1", "c2"] }])[0]!.op, "update");
		assert.equal(parse([{ op: "add", scope: "global", name: "no-idle-waits", text: "t", evidence: ["c1"] }, { op: "skip", reason: "one-off", evidence: ["c2"] }]).length, 2);
	});

	test("rule text loses the list markers the model starts it with; a project rule is one line", () => {
		const projectText = (text: string) => (parse([{ op: "add", scope: "project", repo: "/r", text, evidence: ["c1", "c2"] }])[0] as { text: string }).text;
		assert.equal(projectText("- A decision briefing is complete."), "A decision briefing is complete.");
		assert.equal(projectText("  * Use bun."), "Use bun.");
		assert.equal(projectText("- - Twice."), "Twice.");
		assert.equal(projectText("1. Numbered.\n   Second line."), "Numbered. Second line.");
		assert.equal(projectText("**Bold** stays."), "**Bold** stays.");
		assert.equal(projectText("-5 degrees is cold."), "-5 degrees is cold.", "a minus sign is no list marker");
		const global = parse([{ op: "add", scope: "global", name: "x", text: "+ First.\n\nSecond paragraph.", evidence: ["c1", "c2"] }])[0] as { text: string };
		assert.equal(global.text, "First.\n\nSecond paragraph.", "a global rule file keeps its lines");
		const update = parse([{ op: "update", rule: "rules/batch", text: "- Batch.", reason: "", evidence: ["c1", "c2"] }])[0] as { text: string };
		assert.equal(update.text, "Batch.");
		for (const text of ["", "   ", "-", "- ", "* -", "1.", "- …"]) assert.throws(() => projectText(text), /invalid delta/, JSON.stringify(text));
	});

	test("refuses what would break the rules or lose a candidate", () => {
		const bad: [unknown[], RegExp][] = [
			[[{ op: "update", rule: "AGENTS.md:3", text: "z", evidence: ["c1", "c2"] }], /invalid delta/],
			[[{ op: "recur", rule: "rules/nope", evidence: ["c1", "c2"] }], /invalid delta/],
			[[{ op: "add", scope: "global", name: "Bad Name", text: "t", evidence: ["c1", "c2"] }], /invalid delta/],
			[[{ op: "add", scope: "project", repo: "/elsewhere", text: "t", evidence: ["c1", "c2"] }], /invalid delta/],
			[[{ op: "add", scope: "global", name: "long", text: "x".repeat(601), evidence: ["c1", "c2"] }], /invalid delta/],
			[[{ op: "skip", evidence: ["c1"] }], /no delta for c2/],
			[[{ op: "skip", evidence: ["c1"] }, { op: "skip", evidence: ["c1", "c2"] }], /c1 is in two deltas/],
			[[{ op: "skip", evidence: ["c9", "c1", "c2"] }], /bad evidence/],
			[[{ op: "skip", evidence: [] }], /bad evidence/],
		];
		for (const [deltas, error] of bad) assert.throws(() => parse(deltas), error, JSON.stringify(deltas));
		assert.throws(() => parseDeltas([], candidates, rules), /expected \{deltas/);
	});
});

describe("applying deltas", () => {
	const at = new Date("2026-11-13T03:00:00Z");
	const evidence = () => ({ ts: Date.parse("2026-11-12T10:00:00Z"), sessionId: "0190abcd-session", text: "no!   do not   wait idly" });
	const context = (source: string, rules: KnownRule[] = []): ApplyContext => ({ source, now: at, rules: new Map(rules.map((r) => [r.id, r])), evidence });

	test("withLearnedLine adds the section at the end, or appends inside it before the next heading", () => {
		assert.equal(withLearnedLine("", "- a"), "## Learned rules\n\n- a\n");
		assert.equal(withLearnedLine("# P\nUse bun.\n\n", "- a"), "# P\nUse bun.\n\n## Learned rules\n\n- a\n");
		assert.equal(withLearnedLine("## Learned rules\n\n- a\n\n## Other\nx\n", "- b"), "## Learned rules\n\n- a\n- b\n\n## Other\nx\n");
		assert.equal(withLearnedLine("## Learned rules\n## Other\n", "- b"), "## Learned rules\n\n- b\n## Other\n");
	});

	test("a global rule becomes its own file and commit; a taken name gets a suffix; other staged work stays", () => {
		const source = repository("harness", { "prompt/rules/no-idle-waits.md": "---\npromoted: x\n---\nOld.\n" });
		writeFileSync(join(source, "staged.txt"), "the user's work\n");
		git(source, "add", "staged.txt");
		const applied = applyDelta({ op: "add", scope: "global", name: "no-idle-waits", text: "Never wait idly.", evidence: ["c1"] }, context(source));
		assert.equal(applied.target, "rules/no-idle-waits-2");
		assert.equal(readFileSync(join(source, "prompt/rules/no-idle-waits-2.md"), "utf8"), "---\nsource: dream\nadded: 2026-11-13\n---\n\nNever wait idly.\n");
		assert.equal(applied.commit, git(source, "rev-parse", "HEAD"));
		const message = head(source);
		assert.match(message, /^feat\(rules\): learned rule no-idle-waits-2\n/);
		assert.match(message, /## Rule\n\nNever wait idly\./);
		assert.match(message, /- 2026-11-12, session 0190abcd: "no! do not wait idly"/);
		assert.deepEqual(git(source, "show", "--name-only", "--format=", "HEAD").split("\n"), ["prompt/rules/no-idle-waits-2.md"]);
		assert.match(git(source, "status", "--short"), /^A {2}staged\.txt$/m);
	});

	test("a global update keeps the frontmatter; a rule with uncommitted edits is left alone", () => {
		const source = repository("harness", { "prompt/rules/batch.md": "---\ntools: codemode\npromoted: 2026-11-12\n---\n\nBatch calls.\n" });
		const applied = applyDelta({ op: "update", rule: "rules/batch", text: "Batch independent calls.", reason: "wider", evidence: ["c1"] }, context(source));
		assert.ok(applied.commit);
		assert.equal(readFileSync(join(source, "prompt/rules/batch.md"), "utf8"), "---\ntools: codemode\npromoted: 2026-11-12\nupdated: 2026-11-13\n---\n\nBatch independent calls.\n");
		assert.match(head(source), /^fix\(rules\): sharpen rule batch\n[\s\S]*## Why changed\n\nwider/);
		writeFileSync(join(source, "prompt/rules/batch.md"), "user edit\n");
		const skipped = applyDelta({ op: "update", rule: "rules/batch", text: "Other.", reason: "", evidence: ["c1"] }, context(source));
		assert.match(skipped.skipped!, /uncommitted changes/);
		assert.equal(readFileSync(join(source, "prompt/rules/batch.md"), "utf8"), "user edit\n");
	});

	test("a project rule goes under Learned rules in the repository's instruction file, as its own commit", () => {
		const repo = repository("project", { "CLAUDE.md": "Use bun.\n" });
		const added = applyDelta({ op: "add", scope: "project", repo, text: "Run make check before committing.", evidence: ["c1"] }, context(dir));
		assert.equal(readFileSync(join(repo, "CLAUDE.md"), "utf8"), "Use bun.\n\n## Learned rules\n\n- Run make check before committing.\n");
		assert.equal(added.target, `${repo}:5`);
		assert.match(head(repo), /^docs\(agents\): learned rule\n/);
		const fresh = repository("fresh");
		applyDelta({ op: "add", scope: "project", repo: fresh, text: "Rule.", evidence: ["c1"] }, context(dir));
		assert.equal(readFileSync(join(fresh, "AGENTS.md"), "utf8"), "## Learned rules\n\n- Rule.\n", "created when missing");
		assert.match(applyDelta({ op: "add", scope: "project", repo: join(dir, "plain"), text: "x", evidence: ["c1"] }, context(dir)).skipped!, /not a git repository/);
	});

	test("a project update replaces its line only while it still reads as the curator saw it", () => {
		const repo = repository("project", { "AGENTS.md": "## Learned rules\n\n- Run make check.\n" });
		const known: KnownRule = { id: `${repo}:3`, text: "- Run make check.", editable: true };
		const applied = applyDelta({ op: "update", rule: known.id, text: "Run make check and make lint.", reason: "lint too", evidence: ["c1"] }, context(dir, [known]));
		assert.ok(applied.commit);
		assert.equal(readFileSync(join(repo, "AGENTS.md"), "utf8"), "## Learned rules\n\n- Run make check and make lint.\n");
		const stale = applyDelta({ op: "update", rule: known.id, text: "x", reason: "", evidence: ["c1"] }, context(dir, [known]));
		assert.match(stale.skipped!, /changed since the rules were read/);
		writeFileSync(join(repo, "AGENTS.md"), "dirty\n");
		assert.match(applyDelta({ op: "add", scope: "project", repo, text: "x", evidence: ["c1"] }, context(dir)).skipped!, /uncommitted changes/);
	});

	/** A hook like law-formalization's: only its landing tool may move `main`. */
	function guardMain(repo: string): void {
		mkdirSync(join(repo, "hooks"));
		writeFileSync(
			join(repo, "hooks/reference-transaction"),
			'#!/bin/sh\n[ "$1" = prepared ] || exit 0\nwhile read -r old new ref; do\n  [ "$ref" = refs/heads/main ] || continue\n  echo "refused: \\`main\\` moves only by a landing (tools/kernel/land.py)" >&2\n  echo "more detail" >&2\n  exit 1\ndone\n',
			{ mode: 0o755 },
		);
		git(repo, "add", "hooks");
		git(repo, "commit", "-qm", "hook");
		git(repo, "config", "core.hooksPath", "hooks");
	}
	const snapshot = (repo: string, file: string) => ({ head: git(repo, "rev-parse", "HEAD"), status: git(repo, "status", "--porcelain"), index: git(repo, "ls-files", "-s"), file: existsSync(file) ? readFileSync(file, "utf8") : null });

	test("a branch that refuses the move: checkout and index untouched, the commit kept on a dream branch", () => {
		const repo = repository("guarded", { "AGENTS.md": "# Rules\n\nUse the kernel.\n" });
		guardMain(repo);
		writeFileSync(join(repo, "work.txt"), "staged by another agent\n");
		git(repo, "add", "work.txt");
		const before = snapshot(repo, join(repo, "AGENTS.md"));
		const applied = applyDelta({ op: "add", scope: "project", repo, text: "A decision briefing is complete.", evidence: ["c1"] }, context(dir));
		assert.deepEqual(snapshot(repo, join(repo, "AGENTS.md")), before, "files, index and main as before");
		assert.equal(applied.skipped, undefined);
		assert.equal(applied.branch, "dream/2026-11-13-a-decision-briefing-is-complete");
		assert.equal(applied.refused, "refused: `main` moves only by a landing (tools/kernel/land.py)");
		assert.equal(git(repo, "rev-parse", `refs/heads/${applied.branch}`), applied.commit);
		assert.equal(git(repo, "rev-parse", `${applied.commit}^`), before.head, "built on main");
		assert.equal(git(repo, "show", `${applied.commit}:AGENTS.md`), "# Rules\n\nUse the kernel.\n\n## Learned rules\n\n- A decision briefing is complete.");
		assert.deepEqual(git(repo, "show", "--name-only", "--format=", applied.commit!).split("\n"), ["AGENTS.md"], "the staged work is not in it");

		// The same rule again the same day gets a free branch name; a new global rule file is not created.
		assert.equal(applyDelta({ op: "add", scope: "project", repo, text: "A decision briefing is complete.", evidence: ["c1"] }, context(dir)).branch, "dream/2026-11-13-a-decision-briefing-is-complete-2");
		const global = applyDelta({ op: "add", scope: "global", name: "no-idle-waits", text: "Never wait idly.", evidence: ["c1"] }, context(repo));
		assert.equal(global.branch, "dream/2026-11-13-no-idle-waits");
		assert.equal(existsSync(join(repo, "prompt/rules/no-idle-waits.md")), false);
		assert.deepEqual(snapshot(repo, join(repo, "AGENTS.md")), before);
	});

	test("a detached HEAD moves nothing; the commit goes to a dream branch", () => {
		const repo = repository("detached", { "AGENTS.md": "x\n" });
		git(repo, "checkout", "-q", "--detach");
		const applied = applyDelta({ op: "add", scope: "project", repo, text: "Rule.", evidence: ["c1"] }, context(dir));
		assert.equal(applied.refused, "HEAD is detached");
		assert.equal(applied.branch, "dream/2026-11-13-rule");
		assert.equal(readFileSync(join(repo, "AGENTS.md"), "utf8"), "x\n");
	});

	test("a normal branch advances and the checkout's file follows; a staged or untracked file is skipped", () => {
		const repo = repository("normal", { "AGENTS.md": "x\n" });
		const old = git(repo, "rev-parse", "HEAD");
		const applied = applyDelta({ op: "add", scope: "project", repo, text: "Rule.", evidence: ["c1"] }, context(dir));
		assert.equal(applied.branch, undefined);
		assert.equal(git(repo, "rev-parse", "HEAD"), applied.commit);
		assert.equal(git(repo, "rev-parse", "HEAD^"), old);
		assert.equal(readFileSync(join(repo, "AGENTS.md"), "utf8"), "x\n\n## Learned rules\n\n- Rule.\n");
		assert.equal(git(repo, "status", "--porcelain"), "");
		assert.match(git(repo, "reflog", "-1", "--format=%gs", "main"), /^dream: docs\(agents\): learned rule$/);

		writeFileSync(join(repo, "AGENTS.md"), "staged\n");
		git(repo, "add", "AGENTS.md");
		writeFileSync(join(repo, "AGENTS.md"), "x\n\n## Learned rules\n\n- Rule.\n");
		const head = git(repo, "rev-parse", "HEAD");
		assert.match(applyDelta({ op: "add", scope: "project", repo, text: "Other.", evidence: ["c1"] }, context(dir)).skipped!, /AGENTS\.md in .* has uncommitted changes/);
		assert.equal(git(repo, "rev-parse", "HEAD"), head);
		assert.equal(git(repo, "show", ":AGENTS.md"), "staged", "the staged version stays");

		const fresh = repository("untracked");
		writeFileSync(join(fresh, "AGENTS.md"), "the user's draft\n");
		assert.match(applyDelta({ op: "add", scope: "project", repo: fresh, text: "Rule.", evidence: ["c1"] }, context(dir)).skipped!, /uncommitted changes/);
		assert.equal(readFileSync(join(fresh, "AGENTS.md"), "utf8"), "the user's draft\n");
	});

	test("a failure is reported with its target and git's own first line", () => {
		const repo = repository("read-only", { "AGENTS.md": "x\n" });
		const objects = join(repo, ".git/objects");
		const directories = [objects, ...readdirSync(objects, { recursive: true, withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(e.parentPath, e.name))];
		for (const d of directories) chmodSync(d, 0o555);
		try {
			const before = snapshot(repo, join(repo, "AGENTS.md"));
			const applied = applyDelta({ op: "add", scope: "project", repo, text: "Rule.", evidence: ["c1"] }, context(dir));
			assert.equal(applied.target, join(repo, "AGENTS.md"));
			assert.match(applied.skipped!, /^failed: (fatal|error): /);
			assert.deepEqual(snapshot(repo, join(repo, "AGENTS.md")), before);
		} finally {
			for (const d of directories) chmodSync(d, 0o755);
		}
	});

	test("recurrences and skips change nothing", () => {
		assert.deepEqual(applyDelta({ op: "recur", rule: "AGENTS.md:3", evidence: ["c1"] }, context(dir)), { delta: { op: "recur", rule: "AGENTS.md:3", evidence: ["c1"] }, target: "AGENTS.md:3" });
		assert.deepEqual(applyDelta({ op: "skip", reason: "one-off", evidence: ["c1"] }, context(dir)).target, undefined);
	});
});

describe("ledger and report", () => {
	const record = (r: Partial<LedgerRecord>): LedgerRecord => ({ run: "2026-11-13T03:00:00.000Z", ts: 1, session: "s1", entry: "e", repo: "/r", label: "process", derived: "d", op: "recur", ...r });

	test("recurrences group by rule text across moved ids, count sessions and know what dreaming wrote", () => {
		const ledger = [
			record({ op: "add", targetText: "Never wait idly.", target: "rules/x", commit: "abc", ts: 5 }),
			record({ op: "recur", targetText: "Never  wait idly.", target: "rules/x", session: "s2", ts: 10 }),
			record({ op: "recur", targetText: "never wait idly.", target: "rules/x-old", session: "s3", ts: 20 }),
			record({ op: "recur", targetText: "Use bun.", target: "/r:1", session: "s2", ts: 15 }),
			record({ op: "skip", reason: "one-off" }),
		];
		assert.deepEqual(recurrences(ledger), [
			{ text: "Never  wait idly.", ids: ["rules/x", "rules/x-old"], count: 2, sessions: 2, last: 20, written: 5 },
			{ text: "Use bun.", ids: ["/r:1"], count: 1, sessions: 1, last: 15 },
		]);
	});

	test("the report lists changes, recurrences, stubborn rules, the rate per run and the notes per backlog in full", () => {
		const records = [
			record({ op: "add", target: "rules/x", targetText: "Never wait idly.", commit: "abcdef1234567" }),
			record({ op: "recur", target: "AGENTS.md:3", targetText: "Find the root cause.", session: "s2" }),
			record({ op: "update", target: "/r:4", targetText: "Run make check.", skipped: "AGENTS.md in /r has uncommitted changes" }),
			record({ op: "skip", reason: "one-off" }),
		];
		const earlier = [record({ run: "2026-11-12T03:00:00.000Z", op: "recur", targetText: "Find the root cause.", session: "s0" })];
		const text = report({ run: new Date("2026-11-13T03:00:00Z"), since: 0, until: 1, messages: 9, labelled: { correction: 3, new_task: 6 }, records, notes: [
					{ backlog: "/h/.agents/improvements.md", at: "2026-11-11 08:00", body: "- **Observation:** old friction\n- **Proposal:** fix it" },
					{ backlog: "/h/.agents/improvements.md", at: "2026-11-12 21:57", body: "- **Observation:** pi-lens noise" },
					{ backlog: "/p/.agents/improvements.md", at: "2026-11-12 22:00", body: "- **Observation:** project friction" },
				] }, [...earlier, ...records]);
		assert.match(text, /^# Dream 2026-11-13/);
		assert.match(text, /Labels: new_task 6, correction 3\./);
		assert.match(text, /Corrections with a rule: 4: 1 recurring an existing rule, 1 making 1 new rules, 1 making 1 updates, 1 skipped\./);
		assert.match(text, /- add rules\/x: Never wait idly\. \(abcdef123\)/);
		assert.match(text, /- update \/r:4: Run make check\. — not applied: AGENTS\.md in \/r has uncommitted changes/);
		assert.match(text, /Fix a note of a project repository the way its AGENTS\.md or CLAUDE\.md prescribes: .*own landing tool\. Never edit or commit in its main checkout/);
		assert.match(text, /\| Find the root cause\. \| 2 \| 2 \| 1970-01-01 \| – \|/);
		assert.match(text, /\| 2026-11-12 03:00 \| 1 \| 100% \|\n\| 2026-11-13 03:00 \| 4 \| 33% \|/);
		assert.match(
			text,
			/### \/h\/\.agents\/improvements\.md\n\n#### 2026-11-11 08:00 UTC\n\n- \*\*Observation:\*\* old friction\n- \*\*Proposal:\*\* fix it\n\n#### 2026-11-12 21:57 UTC\n\n- \*\*Observation:\*\* pi-lens noise\n\n### \/p\/\.agents\/improvements\.md\n\n#### 2026-11-12 22:00 UTC\n\n- \*\*Observation:\*\* project friction\n/,
		);
		assert.doesNotMatch(text, /\n\n\n/);
	});

	test("the report names a refused commit's branch and why, and a failed project add by its file; neither counts as written", () => {
		const records = [
			record({ op: "add", target: "/p:7", targetText: "Brief completely.", commit: "abcdef1234567", branch: "dream/2026-11-13-brief-completely", refused: "refused: `main` moves only by a landing" }),
			record({ op: "add", repo: "/q", targetText: "Other.", skipped: "failed: fatal: x" }),
			record({ op: "recur", target: "/p:7", targetText: "Brief completely.", session: "s2" }),
		];
		const text = report({ run: new Date("2026-11-13T03:00:00Z"), since: 0, until: 1, messages: 3, labelled: {}, records, notes: [] }, records);
		assert.match(text, /- add \/p:7: Brief completely\. \(abcdef123\) — committed on branch dream\/2026-11-13-brief-completely, not landed: refused: `main` moves only by a landing\n/);
		assert.match(text, /- add \/q: Other\. — not applied: failed: fatal: x/);
		assert.equal(recurrences(records)[0]!.written, undefined);
	});


});

describe("a dream run", () => {
	/** A scripted model: labels from markers in the messages, deltas from the derived rules. */
	const ask: Ask = async (model, _system, prompt, validate) => {
		if (model.includes("sonnet")) {
			const messages = [...prompt.matchAll(/<message i="(\d+)">\n(?:<agent_before>[\s\S]*?<\/agent_before>\n)?([\s\S]*?)\n<\/message>/g)];
			return validate(
				messages.map(([, i, text]) => {
					const marker = /(GLOBAL|PROJECT|RECUR): (.*)/.exec(text!);
					return marker ? { i: Number(i), label: "correction", rule: marker[2], scope: marker[1] === "PROJECT" ? "project" : "global" } : { i: Number(i), label: "new_task", rule: null, scope: null };
				}),
			);
		}
		const candidates = [...prompt.matchAll(/<candidate ref="(c\d+)" label="\w+" scope="(\w+)" repo="([^"]+)">[\s\S]*?<derived_rule>(.*)<\/derived_rule>/g)];
		return validate({
			deltas: candidates.map(([, ref, scope, repo, rule]) =>
				rule!.startsWith("root")
					? { op: "recur", rule: "AGENTS.md:1", evidence: [ref] }
					: scope === "project"
						? { op: "add", scope: "project", repo, text: rule, evidence: [ref] }
						: { op: "add", scope: "global", name: "no-idle-waits", text: rule, evidence: [ref] },
			),
		});
	};

	test("commits each new rule, records the ledger, moves the position and writes the report; a dry run changes nothing", async () => {
		const source = repository("harness", { ".gitignore": ".agents\n", "prompt/AGENTS.md": "Find the root cause.\n", "prompt/rules/batch.md": "Batch calls.\n" });
		const project = repository("project");
		const db = index();
		const t = Date.parse("2026-11-12T10:00:00Z");
		addSession(db, {
			id: "s1",
			cwd: project,
			messages: [
				["e1", t, "follow-up", "GLOBAL: Never end a turn waiting on background work."],
				["e2", t + 1, "follow-up", "PROJECT: Run make check before committing."],
				["e3", t + 2, "steer", "RECUR: root causes, I said"],
				["e4", t + 3, "follow-up", "now add a button"],
			],
		});
		const now = new Date("2026-11-13T03:00:00Z");
		const backlog = join(project, ".agents/improvements.md");
		mkdirSync(join(project, ".agents"));
		writeFileSync(backlog, "# Improvement backlog\n\nheader\n\n## 2026-11-12 09:00 UTC\n- **Observation:** the build is slow\n- **Proposal:** cache it\n");

		const dry = await dream({ source, db, now, ask, dryRun: true });
		assert.match(dry.text, /#### 2026-11-12 09:00 UTC\n\n- \*\*Observation:\*\* the build is slow/);
		assert.match(readFileSync(backlog, "utf8"), /the build is slow/, "a dry run leaves the notes in the backlog");
		assert.deepEqual(dry.deltas.map((d) => d.op), ["add", "add", "recur"]);
		assert.equal(dry.reportFile, undefined);
		assert.equal(existsSync(join(source, ".agents")), false, "a dry run writes nothing");
		assert.equal(git(source, "rev-list", "--count", "HEAD"), "1");

		const result = await dream({ source, db, now, ask });
		assert.equal(readFileSync(join(source, "prompt/rules/no-idle-waits.md"), "utf8"), "---\nsource: dream\nadded: 2026-11-13\n---\n\nNever end a turn waiting on background work.\n");
		assert.match(readFileSync(join(project, "AGENTS.md"), "utf8"), /## Learned rules\n\n- Run make check before committing\.\n/);
		assert.deepEqual(git(source, "log", "--format=%s").split("\n"), ["feat(rules): learned rule no-idle-waits", "init"], "only the rule is committed");
		assert.equal(git(project, "log", "-1", "--format=%s"), "docs(agents): learned rule");
		const ledger = readLedger(source);
		assert.deepEqual(ledger.map((r) => [r.entry, r.op, r.target]), [
			["e1", "add", "rules/no-idle-waits"],
			["e2", "add", `${project}:3`],
			["e3", "recur", "AGENTS.md:1"],
		]);
		assert.equal(ledger[2]!.targetText, "Find the root cause.");
		assert.equal(readSince(source), now.getTime());
		assert.equal(result.reportFile, join(source, ".agents/dreams/2026-11-13.md"));
		assert.match(readFileSync(result.reportFile!, "utf8"), /Messages the user typed .*: 4\./);
		assert.match(readFileSync(result.reportFile!, "utf8"), new RegExp(`### ${project}/\\.agents/improvements\\.md\\n\\n#### 2026-11-12 09:00 UTC\\n\\n- \\*\\*Observation:\\*\\* the build is slow\\n- \\*\\*Proposal:\\*\\* cache it`));
		assert.doesNotMatch(readFileSync(backlog, "utf8"), /## 2026/, "the notes moved into the report");
		assert.equal(git(source, "status", "--porcelain"), "", "rules committed; the ledger, position and report stay local");

		// The next run reads only newer messages; a second report the same day gets the time in its name.
		addSession(db, { id: "s2", cwd: project, messages: [["f1", now.getTime() + 1000, "follow-up", "RECUR: root cause again"]] });
		const next = await dream({ source, db, now: new Date(now.getTime() + 3600_000), ask });
		assert.deepEqual(next.records.map((r) => [r.entry, r.op]), [["f1", "recur"]]);
		assert.ok(readdirSync(join(source, ".agents/dreams")).includes("2026-11-13T0400.md"));
		assert.match(readFileSync(next.reportFile!, "utf8"), /\| Find the root cause\. \| 2 \| 2 \|/);
		db.close();
	});

	test("nothing new: no model call, no commit, the position still moves and the report is written", async () => {
		const source = repository("harness", { ".gitignore": ".agents\n", "prompt/AGENTS.md": "Rule.\n" });
		const db = index();
		const now = new Date("2026-11-13T03:00:00Z");
		const result = await dream({ source, db, now, ask: () => assert.fail("no model call") });
		assert.deepEqual(result.records, []);
		assert.equal(git(source, "rev-list", "--count", "HEAD"), "1");
		assert.equal(readSince(source), now.getTime());
		assert.ok(existsSync(result.reportFile!));
		db.close();
	});
});
