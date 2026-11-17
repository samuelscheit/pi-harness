// fix_loop (workflows/fix_loop.ts): green is the exit code of the whole check, never the exit code
// of a filter at the end of a pipeline; only the child's own changes outside `files` go back to it,
// never files someone else changes in the same tree meanwhile.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { JsonObject } from "@earendil-works/pi-ai";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import { compile, evaluate } from "../extensions/workflow/compile.ts";
import { HARNESS_WORKFLOWS } from "../extensions/workflow/library.ts";
import { runWorkflow } from "../extensions/workflow/run.ts";

// Loaded as the runtime loads a saved workflow: its types need the workflow globals, which this project leaves out.
const file = join(HARNESS_WORKFLOWS, "fix_loop.ts");
const checkCommand = evaluate(compile(readFileSync(file, "utf8"), file), file, {}).exports.checkCommand as (check: string) => string;

/** The exit code of a check as fix_loop runs it (shell() runs `bash -c`). */
const exitOf = (check: string) => spawnSync("bash", ["-c", checkCommand(check)]).status;

describe("fix_loop's check", () => {
	test("a failing command piped into a filter fails (2026-11-16: `pytest … | tail -1` read as green before any round)", () => {
		assert.equal(exitOf("false | tail -1"), 1);
		assert.equal(exitOf("(echo '1 failed'; exit 1) 2>&1 | tail -1 | cat"), 1);
		assert.equal(exitOf("true | tail -1"), 0);
	});

	test("lists, && chains, a cd and multi-line checks keep their own exit codes", () => {
		assert.equal(exitOf("cd / && true"), 0);
		assert.equal(exitOf("true && false"), 1);
		assert.equal(exitOf("false || true"), 0);
		assert.equal(exitOf("echo a\nexit 3"), 3);
		assert.equal(exitOf("set +o pipefail; false | true"), 0, "a check that opts out explicitly still can");
	});
});

// ---- whole runs: a real in-process child on a scripted model, its tool calls real --------------

let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
before(async () => {
	faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	runtime = await ModelRuntime.create({ authPath: join(mkdtempSync(join(tmpdir(), "fix-loop-runtime-")), "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "faux-1", name: "Faux", api: faux.api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8000 }],
	});
});
after(() => faux.unregister());

let dir: string;
let repo: string;
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "fix-loop-")));
	repo = join(dir, "repo");
	mkdirSync(join(repo, "src"), { recursive: true });
	mkdirSync(join(repo, "other"));
	writeFileSync(join(repo, "src", "value.txt"), "bad\n");
	writeFileSync(join(repo, "other", "child.txt"), "committed\n");
	writeFileSync(join(repo, "other", "parent.txt"), "committed\n");
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const call = (name: string, args: JsonObject) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(text);
const textOf = (content: unknown) => (typeof content === "string" ? content : (content as { type: string; text?: string }[]).flatMap((b) => (b.type === "text" ? [b.text ?? ""] : [])).join("\n"));
/** Another agent (the parent) editing a file of the same tree. */
const parentEdits = (file: string, content = "the parent's edit\n") => writeFileSync(join(repo, file), content);

interface Outcome {
	ok: boolean;
	rounds: number;
	outside?: string[];
	changedByOthers?: string[];
	diff: string;
	lastCheckOutput?: string;
	summary: string;
}

/**
 * Run fix_loop with the child's model answering `steps` in order (a step may act as the parent
 * meanwhile); returns its result and the messages the child got from the workflow, one per round.
 */
async function fixLoop(steps: FauxResponseStep[], input: Record<string, unknown> = {}) {
	const told: string[] = [];
	const calls = faux.state.callCount;
	faux.setResponses(
		steps.map(
			(step): FauxResponseStep =>
				(...args) => {
					const last = args[0].messages.at(-1)!;
					if (last.role === "user") told.push(textOf(last.content));
					return typeof step === "function" ? step(...args) : step;
				},
		),
	);
	const file = join(HARNESS_WORKFLOWS, "fix_loop.ts");
	const { details, text } = await runWorkflow(
		{ source: readFileSync(file, "utf8"), filename: file, inline: false, name: "fix_loop", input: { goal: "make value.txt good", files: ["src"], check: "grep -q good src/value.txt", model: "faux/faux-1", ...input } },
		1,
		{ cwd: repo, runtime, agentDir: join(dir, "agent"), llmCache: new Map(), library: () => new Map() },
	);
	assert.equal(faux.state.callCount - calls, steps.length, "the child used every scripted step");
	const outcome = parseYaml(text.slice(text.indexOf("\n\n") + 2)) as Outcome;
	return { outcome, told, status: details.status };
}

describe("fix_loop: whose changes outside `files`", () => {
	test("the parent's edits during the child's run, also while the child's bash runs, are reported, not sent to the child, and do not block green (2026-11-16)", async () => {
		const { outcome, told } = await fixLoop([
			() => {
				parentEdits("other/parent.txt");
				return call("write", { path: "src/value.txt", content: "good\n" });
			},
			() => {
				setTimeout(() => parentEdits("other/during-bash.txt"), 150);
				return call("bash", { command: `cd ${repo} && sleep 0.6 && grep -q good src/value.txt` });
			},
			say("Wrote good into src/value.txt."),
		]);
		assert.equal(outcome.ok, true);
		assert.equal(outcome.rounds, 1);
		assert.equal(outcome.outside, undefined);
		assert.deepEqual(outcome.changedByOthers, ["other/during-bash.txt", "other/parent.txt"]);
		assert.match(outcome.diff, /src\/value\.txt[\s\S]*\+good/);
		assert.doesNotMatch(outcome.diff, /parent|during-bash/, "the diff is the child's work only");
		assert.equal(told.length, 1, "one round: the failing check only");
		assert.doesNotMatch(told[0]!, /other\//);
	});

	test("the child's own out-of-scope edit goes back to it, the parent's beside it does not; once it undid its edit, it is green", async () => {
		const { outcome, told } = await fixLoop([
			call("write", { path: "src/value.txt", content: "good\n" }),
			() => {
				parentEdits("other/parent.txt");
				return call("edit", { path: "other/child.txt", edits: [{ oldText: "committed", newText: "the child's edit" }] });
			},
			say("Fixed it, and tidied other/child.txt."),
			call("bash", { command: "git checkout -- other/child.txt" }),
			say("Put other/child.txt back."),
		]);
		assert.equal(outcome.ok, true);
		assert.equal(outcome.rounds, 2);
		assert.equal(outcome.outside, undefined, "undone");
		assert.deepEqual(outcome.changedByOthers, ["other/parent.txt"]);
		assert.equal(told.length, 2);
		assert.match(told[1]!, /\n\nThe check passes \(round 1 of 6\), but not with only the allowed files changed\.\nYou changed files outside src: other\/child\.txt\. Undo those changes/);
		assert.doesNotMatch(told[1]!, /parent\.txt/);
		assert.doesNotMatch(outcome.diff, /other\//);
	});

	test("an out-of-scope file a child's bash command changed and names, never undone: not green, returned as `outside` with its diff", async () => {
		const { outcome, told } = await fixLoop(
			[
				() => {
					parentEdits("other/parent.txt");
					return call("bash", { command: "printf 'good\\n' > src/value.txt && printf 'hack\\n' > other/child.txt" });
				},
				say("Done."),
				say("I keep other/child.txt as it is."),
			],
			{ maxRounds: 2 },
		);
		assert.equal(outcome.ok, false);
		assert.equal(outcome.rounds, 2);
		assert.deepEqual(outcome.outside, ["other/child.txt"]);
		assert.deepEqual(outcome.changedByOthers, ["other/parent.txt"]);
		assert.match(outcome.diff, /other\/child\.txt[\s\S]*\+hack/);
		assert.doesNotMatch(outcome.diff, /parent\.txt/);
		assert.equal(outcome.lastCheckOutput, undefined, "the check itself passes");
		assert.match(told[1]!, /You changed files outside src: other\/child\.txt\./);
	});

	test("a file the child changed in an earlier round and left changed stays its own in later rounds", async () => {
		const { outcome, told } = await fixLoop(
			[
				call("write", { path: "other/child.txt", content: "child\n" }),
				say("Started."),
				call("write", { path: "src/value.txt", content: "good\n" }),
				say("Fixed."),
			],
			{ maxRounds: 2 },
		);
		assert.equal(outcome.ok, false);
		assert.deepEqual(outcome.outside, ["other/child.txt"], "changed in round 1, not undone in round 2");
		assert.equal(outcome.changedByOthers, undefined);
		assert.match(told[1]!, /\n\nThe check still fails \(exit 1, round 1 of 2\)[\s\S]*You changed files outside src: other\/child\.txt\./);
	});
});
