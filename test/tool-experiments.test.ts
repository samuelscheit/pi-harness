// The tool experiments in real Pi sessions (faux model, the harness extensions loaded through the
// SDK): define_tool defines, calls, quotes, persists, restores and refuses; codemode and fix_loop
// are active in arm B only.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { JsonObject } from "@earendil-works/pi-ai";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import defineTool, { DEFINED_ENTRY } from "../extensions/define-tool/index.ts";
import { placeholders, renderCommand, specProblem, type ToolSpec } from "../extensions/define-tool/template.ts";
import fixLoop from "../extensions/fix-loop/index.ts";
import { type Arm, hashArm } from "../extensions/lib/experiments.ts";
import { runShell } from "../extensions/lib/process.ts";
import { shellEffect } from "../extensions/metrics/shell.ts";
import prompt from "../extensions/prompt/index.ts";

let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
let dir: string;
let repo: string;
let experimentsDir: string;
const open: AgentSession[] = [];

before(async () => {
	faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	const scratch = mkdtempSync(join(tmpdir(), "tool-exp-runtime-"));
	runtime = await ModelRuntime.create({ authPath: join(scratch, "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "faux-1", name: "Faux", api: faux.api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8000 }],
	});
});
after(() => faux.unregister());

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tool-exp-"));
	repo = join(dir, "repo");
	mkdirSync(repo, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: repo });
	experimentsDir = join(dir, "experiments");
	mkdirSync(experimentsDir);
	writeFileSync(join(experimentsDir, "define-tool.md"), "---\ntools: define_tool\n---\n");
	writeFileSync(join(experimentsDir, "codemode.md"), "---\ntools: codemode\n---\nUse codemode for batches.");
	writeFileSync(join(experimentsDir, "fix-loop.md"), "---\ntools: fix_loop\n---\n");
});
afterEach(() => {
	for (const session of open.splice(0)) session.dispose();
	rmSync(dir, { recursive: true, force: true });
});

/** A session id whose hash puts it in `arm` of `experiment`. */
function idIn(arm: Arm, experiment: string, prefix = "0190a000-0000-7000-8000-"): string {
	for (let i = 0; ; i++) {
		const id = `${prefix}${String(i).padStart(12, "0")}`;
		if (hashArm(id, experiment) === arm) return id;
	}
}

/** A Pi session with the harness's prompt, define-tool, fix-loop and the built-in codemode extensions. */
async function session(sessionManager: SessionManager): Promise<AgentSession> {
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: repo,
		agentDir: dir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		extensionFactories: [
			createCodemodeExtension({ mode: "on" }),
			(pi: ExtensionAPI) => prompt(pi, experimentsDir),
			(pi: ExtensionAPI) => defineTool(pi, experimentsDir),
			fixLoop,
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: repo,
		agentDir: dir,
		model: runtime.getModel("faux", "faux-1"),
		modelRuntime: runtime,
		resourceLoader,
		sessionManager,
		settingsManager,
	});
	await session.bindExtensions({});
	open.push(session);
	return session;
}
const newSession = (id: string) => session(SessionManager.create(repo, join(dir, "sessions"), { id }));

const call = (name: string, args: JsonObject) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const respond = (...steps: FauxResponseStep[]) => faux.setResponses(steps);
/** The text of the tool results in the session, in order. */
const results = (s: AgentSession) =>
	s.messages.flatMap((m) => (m.role === "toolResult" ? [{ tool: m.toolName, error: m.isError, text: m.content.map((c) => (c.type === "text" ? c.text : "")).join("") }] : []));

const greet: JsonObject = {
	name: "greet",
	description: "Print a greeting.",
	parameters: [{ name: "who", type: "string", description: "Name" }, { name: "times", type: "number", description: "Count", default: 1 }],
	command: "for i in $(seq 1 {{times}}); do printf 'hi <%s>\\n' {{who}}; done",
};

describe("define_tool in a session", () => {
	test("defined in one turn, callable in the next; values arrive as literal text", async () => {
		const s = await newSession(idIn("B", "define-tool"));
		const hostile = "x'; touch pwned; echo '$(touch pwned2)`touch pwned3`\nnext line";
		respond(call("define_tool", greet), call("greet", { who: hostile, times: 2 }), fauxAssistantMessage("done"));
		await s.prompt("go");
		const [defined, greeted] = results(s);
		assert.equal(defined!.error, false, defined!.text);
		assert.match(defined!.text, /^Defined greet\(who: string, times\?: number\)/);
		assert.equal(greeted!.error, false, greeted!.text);
		assert.equal(greeted!.text.trim(), `hi <${hostile}>\nhi <${hostile}>`);
		for (const file of ["pwned", "pwned2", "pwned3"]) assert.equal(existsSync(join(repo, file)), false, file);
		assert.ok(s.getActiveToolNames().includes("greet"));
		// The definition is in the session file.
		const entries = s.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === DEFINED_ENTRY);
		assert.equal(entries.length, 1);
	});

	test("a resumed session gets its tools back; arm A never sees them", async () => {
		const id = idIn("B", "define-tool");
		const first = await newSession(id);
		respond(call("define_tool", { ...greet, scope: "project" }), fauxAssistantMessage("ok"));
		await first.prompt("define");
		const file = first.sessionFile!;
		first.dispose();
		open.splice(open.indexOf(first), 1);

		const resumed = await session(SessionManager.open(file));
		respond(call("greet", { who: "again" }), fauxAssistantMessage("ok"));
		await resumed.prompt("use it");
		assert.equal(results(resumed).at(-1)!.text.trim(), "hi <again>");

		// Saved for the project; another arm B session loads it, an arm A session does not.
		assert.ok(existsSync(join(repo, ".pi", "tools", "greet.json")));
		const other = await newSession(idIn("B", "define-tool", "0190b000-0000-7000-8000-"));
		respond(call("greet", { who: "project" }), fauxAssistantMessage("ok"));
		await other.prompt("go");
		assert.equal(results(other).at(-1)!.text.trim(), "hi <project>");

		const control = await newSession(idIn("A", "define-tool"));
		respond(fauxAssistantMessage("ok"));
		await control.prompt("go");
		assert.equal(control.getActiveToolNames().includes("greet"), false);
		assert.equal(control.getActiveToolNames().includes("define_tool"), false);
	});

	test("redefinition replaces; existing tool names and invalid definitions are refused", async () => {
		const s = await newSession(idIn("B", "define-tool"));
		respond(
			call("define_tool", greet),
			call("define_tool", { ...greet, command: "printf 'bye %s\\n' {{who}} # {{times}}" }),
			call("greet", { who: "x" }),
			call("define_tool", { ...greet, name: "read" }),
			call("define_tool", { ...greet, name: "fix_loop" }),
			call("define_tool", { ...greet, name: "quoted", command: "echo '{{who}}' {{times}}" }),
			call("define_tool", { ...greet, name: "bad", command: "echo {{who}} {{nope}} {{times}}" }),
			fauxAssistantMessage("ok"),
		);
		await s.prompt("go");
		const r = results(s);
		assert.match(r[1]!.text, /^Redefined greet/);
		assert.equal(r[2]!.text.trim(), "bye x");
		assert.equal(r[3]!.error, true);
		assert.match(r[3]!.text, /a tool named read exists already/);
		assert.match(r[4]!.text, /a tool named fix_loop exists already/, "inactive tools count too");
		assert.match(r[5]!.text, /stands inside quotes/);
		assert.match(r[6]!.text, /\{\{nope\}\} is not a declared parameter/);
	});

	test("output filter and line limit apply; the command's exit status decides the error", async () => {
		const s = await newSession(idIn("B", "define-tool"));
		respond(
			call("define_tool", { name: "count", description: "Count lines.", parameters: [{ name: "n", type: "number", description: "Lines" }], command: "seq 1 {{n}}; exit 3", outputFilter: "grep -v 5", maxLines: 2 }),
			call("count", { n: 6 }),
			fauxAssistantMessage("ok"),
		);
		await s.prompt("go");
		const counted = results(s)[1]!;
		assert.equal(counted.error, true, "exit 3 is an error");
		assert.match(counted.text, /^4\n6\n/);
		assert.doesNotMatch(counted.text, /\b5\b|^1$/m);
	});
});

describe("tools per arm", () => {
	test("codemode, fix_loop and define_tool are declared in arm B only", async () => {
		const b = await newSession(idIn("B", "codemode"));
		let system = "";
		respond((context) => {
			system = JSON.stringify(context.messages.filter((m) => m.role === "system"));
			return fauxAssistantMessage("ok");
		});
		await b.prompt("go");
		const a = await newSession(idIn("A", "codemode"));
		respond(fauxAssistantMessage("ok"));
		await a.prompt("go");
		assert.equal(b.getActiveToolNames().includes("codemode"), true);
		assert.equal(a.getActiveToolNames().includes("codemode"), false);
		assert.match(system, /Use codemode for batches\./, "arm B's prompt section");
		for (const [tool, experiment] of [["fix_loop", "fix-loop"], ["define_tool", "define-tool"]]) {
			const inB = await newSession(idIn("B", experiment!, "0190c000-0000-7000-8000-"));
			respond(fauxAssistantMessage("ok"));
			await inB.prompt("go");
			assert.equal(inB.getActiveToolNames().includes(tool!), true, `${tool} in B`);
			const inA = await newSession(idIn("A", experiment!, "0190c000-0000-7000-8000-"));
			respond(fauxAssistantMessage("ok"));
			await inA.prompt("go");
			assert.equal(inA.getActiveToolNames().includes(tool!), false, `${tool} in A`);
		}
	});

	test("the first request already declares arm B's tools (they are part of the session's harness version)", async () => {
		const s = await newSession(idIn("B", "fix-loop"));
		let system = "";
		respond((context) => {
			// The prompt and tool declarations travel in the transcript's system messages.
			system = JSON.stringify(context.messages.filter((m) => m.role === "system"));
			return fauxAssistantMessage("ok");
		});
		await s.prompt("go");
		assert.match(system, /"name":"fix_loop"/);
	});

	test("codemode runs in arm B: a script calls a defined tool", async () => {
		let id = "";
		for (let i = 0; ; i++) {
			id = `0190d000-0000-7000-8000-${String(i).padStart(12, "0")}`;
			if (hashArm(id, "codemode") === "B" && hashArm(id, "define-tool") === "B") break;
		}
		const s = await newSession(id);
		respond(
			call("define_tool", greet),
			call("codemode", { code: 'const r = await tools.greet({ who: "from script", times: 1 }); return r;' }),
			fauxAssistantMessage("ok"),
		);
		await s.prompt("go");
		const script = results(s)[1]!;
		assert.equal(script.error, false, script.text);
		assert.match(script.text, /Script completed/);
		assert.match(script.text, /hi <from script>/);
	});
});

describe("templates", () => {
	const spec = (extra: Partial<ToolSpec> = {}): ToolSpec => ({ name: "tool", description: "d", parameters: [{ name: "v", type: "string", description: "" }], command: "echo {{v}}", ...extra });

	test("placeholders: quoting context, escapes, spaces inside braces", () => {
		assert.deepEqual(placeholders(`a {{x}} '{{y}}' "{{z}}" \\'{{w}} "it's {{q}}" {{ s }}`), [
			{ name: "x", quoted: false },
			{ name: "y", quoted: true },
			{ name: "z", quoted: true },
			{ name: "w", quoted: false },
			{ name: "q", quoted: true },
			{ name: "s", quoted: false },
		]);
	});

	test("problems: names, types, defaults, unused and unknown placeholders, options", () => {
		assert.equal(specProblem(spec()), undefined);
		assert.match(specProblem(spec({ name: "Bad-Name" }))!, /name must match/);
		assert.match(specProblem(spec({ description: " " }))!, /description is empty/);
		assert.match(specProblem(spec({ parameters: [{ name: "v", type: "string", description: "" }, { name: "v", type: "number", description: "" }] }))!, /declared twice/);
		assert.match(specProblem(spec({ parameters: [{ name: "v", type: "boolean" as "string", description: "" }] }))!, /type must be/);
		assert.match(specProblem(spec({ parameters: [{ name: "v", type: "number", description: "", default: "1" }] }))!, /default must be a number/);
		assert.match(specProblem(spec({ parameters: [{ name: "1v", type: "string", description: "" }], command: "echo {{1v}}" }))!, /parameter name/);
		assert.match(specProblem(spec({ command: "echo hi" }))!, /v is not used/);
		assert.match(specProblem(spec({ maxLines: 0 }))!, /maxLines/);
		assert.match(specProblem(spec({ outputFilter: "" }))!, /outputFilter is empty/);
		assert.match(specProblem(spec({ scope: "global" as "project" }))!, /scope must be/);
	});

	test("rendered commands run every hostile value as one literal argument", async () => {
		const values = ["; rm -rf /tmp/never", "$(id)", "`id`", "a'b\"c", "line1\nline2", "--help", "*", "$HOME", "", " spaced  out "];
		for (const value of values) {
			const out = await runShell(renderCommand(spec({ command: "printf '[%s]' {{v}}" }), { v: value }), { cwd: dir });
			assert.equal(out.output, `[${value}]`, JSON.stringify(value));
		}
		assert.throws(() => renderCommand(spec(), { v: "a\0b" }), /NUL/);
		assert.throws(() => renderCommand(spec(), {}), /missing parameter v/);
		const number = spec({ parameters: [{ name: "v", type: "number", description: "" }] });
		assert.throws(() => renderCommand(number, { v: Number.NaN }), /finite number/);
		assert.equal((await runShell(renderCommand(number, { v: -1.5 }), { cwd: dir })).output, "-1.5\n");
	});

	test("cwd, filter and limit keep the command's status; a missing cwd fails", async () => {
		mkdirSync(join(dir, "sub dir"));
		writeFileSync(join(dir, "sub dir", "f.txt"), "x");
		const listed = await runShell(renderCommand(spec({ command: "ls {{v}}; exit 4", cwd: "sub dir", outputFilter: "tr a-z A-Z", maxLines: 1 }), { v: "." }), { cwd: dir });
		assert.deepEqual([listed.exitCode, listed.output], [4, "F.TXT\n"]);
		const missed = await runShell(renderCommand(spec({ command: "printf 'a\\nb\\n' {{v}}", outputFilter: "grep -E '^# pass'" }), { v: "" }), { cwd: dir });
		assert.deepEqual([missed.exitCode, missed.output], [0, "[the output filter printed nothing; the command printed 2 lines]\n"], "a filter that matches nothing says so");
		const silent = await runShell(renderCommand(spec({ command: "true {{v}}", outputFilter: "cat" }), { v: "" }), { cwd: dir });
		assert.deepEqual([silent.exitCode, silent.output], [0, "\n"], "no output at all stays empty");
		// The wrapper writes no file, so the metrics do not count a filtered read-only tool as a file change.
		assert.equal(shellEffect(renderCommand(spec({ command: "grep -rn -- {{v}} src", outputFilter: "head -3", maxLines: 2, cwd: "sub dir" }), { v: "x" }), dir).mutates, false);
		const missing = await runShell(renderCommand(spec({ cwd: "nope" }), { v: "x" }), { cwd: dir });
		assert.notEqual(missing.exitCode, 0);
		assert.doesNotMatch(missing.output, /^x$/m);
		assert.equal(readFileSync(join(dir, "sub dir", "f.txt"), "utf8"), "x");
	});
});
