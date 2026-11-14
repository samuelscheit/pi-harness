// The tool experiments in real Pi sessions (faux model, the harness extensions loaded through the
// SDK): codemode, workflow and fix_loop (a harness workflow) per arm; workflow scripts, saved
// workflows and the quoting of sh`…`
// are active in arm B only.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { type Arm, hashArm } from "../extensions/lib/experiments.ts";
import { runShell } from "../extensions/lib/process.ts";
import prompt, { toolGuidelinesSection } from "../extensions/prompt/index.ts";
import workflow from "../extensions/workflow/index.ts";
import { HARNESS_WORKFLOWS } from "../extensions/workflow/library.ts";
import { sh } from "../extensions/workflow/sh.ts";

let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
let dir: string;
let repo: string;
let experimentsDir: string;
let rulesDir: string;
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
	writeFileSync(join(experimentsDir, "codemode.md"), "---\ntools: codemode\n---\nUse codemode for batches.");
	writeFileSync(join(experimentsDir, "fix-loop.md"), "---\ntools: fix_loop\n---\n");
	writeFileSync(join(experimentsDir, "workflow.md"), "---\ntools: workflow\n---\n");
	rulesDir = join(dir, "rules");
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

/** A Pi session with the harness's prompt, workflow and the built-in codemode extensions. */
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
			(pi: ExtensionAPI) => prompt(pi, experimentsDir, rulesDir),
			(pi: ExtensionAPI) => workflow(pi, { experimentsDir, workflowDirs: () => [HARNESS_WORKFLOWS, join(repo, ".pi", "workflows")], modelRuntime: async () => runtime, agentDir: dir }),
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

describe("rules", () => {
	test("promoted tools are on in every session, and a saved workflow follows the workflow rule", async () => {
		rmSync(experimentsDir, { recursive: true });
		mkdirSync(rulesDir);
		writeFileSync(join(rulesDir, "codemode.md"), "---\ntools: codemode\n---\nUse codemode for batches.");
		writeFileSync(join(rulesDir, "workflow.md"), "---\ntools: workflow\n---\nWrite procedures as workflows.");
		for (const arm of ["A", "B"] as const) {
			const s = await newSession(idIn(arm, "codemode"));
			let system = "";
			respond((context) => {
				system = JSON.stringify(context.messages.filter((m) => m.role === "system"));
				return fauxAssistantMessage("ok");
			});
			await s.prompt("go");
			for (const tool of ["codemode", "workflow", "fix_loop"]) assert.equal(s.getActiveToolNames().includes(tool), true, `${tool} for a session the old experiments put in ${arm}`);
			assert.match(system, /Use codemode for batches\./);
			assert.match(system, /Write procedures as workflows\./);
		}
		rmSync(join(rulesDir, "workflow.md"));
		const without = await newSession(idIn("B", "codemode", "0190d000-0000-7000-8000-"));
		respond(fauxAssistantMessage("ok"));
		await without.prompt("go");
		assert.deepEqual(["codemode", "workflow", "fix_loop"].map((tool) => without.getActiveToolNames().includes(tool)), [true, false, false], "without the rule the workflows stay off");
	});
});

describe("tool guidelines", () => {
	test("the active tools' guidelines reach the prompt as their own section, also with the harness's base prompt", async () => {
		const s = await newSession(idIn("A", "codemode"));
		let system = "";
		respond((context) => {
			system = JSON.stringify(context.messages.filter((m) => m.role === "system"));
			return fauxAssistantMessage("ok");
		});
		await s.prompt("go");
		assert.match(system, /<tool-guidelines>/);
		assert.match(system, /Use read to examine files instead of cat or sed\./, "a built-in tool's guideline");
		assert.match(system, /Inside a bash command, `tool <name> \[arguments\]`|Use workflow when a task is a procedure/, "a harness tool's guideline");
	});

	test("toolGuidelinesSection keeps the tools' order, adds global guidelines, and drops duplicates and blanks", () => {
		assert.equal(
			toolGuidelinesSection({ selectedTools: ["bash", "read", "none"], toolGuidelines: { read: ["R1", "shared"], bash: ["B1", " shared "], edit: ["E1"] }, promptGuidelines: ["G1", ""] }),
			"- B1\n- shared\n- R1\n- G1",
		);
		assert.equal(toolGuidelinesSection({ selectedTools: [], toolGuidelines: {}, promptGuidelines: [] }), "");
	});
});

describe("tools per arm", () => {
	test("codemode, workflow and fix_loop are declared in arm B only", async () => {
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
		for (const [tool, experiment] of [["fix_loop", "fix-loop"], ["workflow", "workflow"]]) {
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

	test("codemode runs in arm B: a script calls a session tool", async () => {
		writeFileSync(join(repo, "notes.txt"), "from script\n");
		const s = await newSession(idIn("B", "codemode", "0190d000-0000-7000-8000-"));
		respond(call("codemode", { code: 'const r = await tools.read({ path: "notes.txt" }); return r;' }), fauxAssistantMessage("ok"));
		await s.prompt("go");
		const script = results(s)[0]!;
		assert.equal(script.error, false, script.text);
		assert.match(script.text, /Script completed/);
		assert.match(script.text, /from script/);
	});
});

describe("workflow in a session", () => {
	const double = 'export const meta = { description: "Double a number.", parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] }, budget: 0.5 };\nexport default async function ({ n }) { return `double: ${n * 2}`; }\n';

	test("scripts call the session's tools through its pipeline; failures reject; the calls are recorded on the result", async () => {
		writeFileSync(join(repo, "notes.txt"), "alpha\nbeta\n");
		const s = await newSession(idIn("B", "workflow"));
		const code = [
			"const text = await tools.read({ path: 'notes.txt' });",
			"const listed = await tools.bash({ command: 'echo from-bash' });",
			"const failed = await tools.bash({ command: 'echo partial; exit 4' });",
			"let missing = '';",
			"try { await tools.read({ path: 'nope.txt' }); } catch (e) { missing = 'read failed'; }",
			"let unknown = '';",
			"try { await tools.no_such_tool({}); } catch (e) { unknown = (e as Error).message; }",
			"return [text.split('\\n')[1], listed.output.trim(), `${failed.output.trim()} ${failed.exit_code}`, missing, unknown].join(' | ');",
		].join("\n");
		respond(call("workflow", { code, budget: 0.1 }), fauxAssistantMessage("done"));
		await s.prompt("go");
		const [result] = results(s);
		assert.equal(result!.error, false, result!.text);
		assert.match(result!.text, /\n\nbeta \| from-bash \| partial 4 \| read failed \| .*no_such_tool/);
		const message = s.messages.find((m) => m.role === "toolResult")!;
		assert.ok(message.role === "toolResult");
		assert.deepEqual(message.nestedCalls?.calls.map((c) => c.name), ["read", "bash", "bash", "read", "no_such_tool"]);
	});

	const workflowResults = (s: AgentSession) => results(s).filter((r) => r.tool === "workflow");

	test("a failing script is an error result", async () => {
		const s = await newSession(idIn("B", "workflow"));
		respond(call("workflow", { code: "throw new Error('nope');", budget: 0.1 }), fauxAssistantMessage("done"));
		await s.prompt("go");
		const [result] = workflowResults(s);
		assert.equal(result!.error, true);
		assert.match(result!.text, /^Workflow failed[^]*Error: nope\n {4}at .*workflow\.ts:1:/);
	});

	test("a workflow saved during a turn is a tool from the next turn, and withdrawn when deleted", async () => {
		const s = await newSession(idIn("B", "workflow"));
		const file = join(repo, ".pi", "workflows", "double.ts");
		respond(call("write", { path: ".pi/workflows/double.ts", content: double }), call("double", { n: "21" }), call("workflow", { code: "return await workflows.double({ n: 4 });", budget: 0.1 }), fauxAssistantMessage("done"));
		await s.prompt("go");
		const r = results(s);
		assert.equal(r[1]!.tool, "double");
		assert.equal(r[1]!.error, false, r[1]!.text);
		assert.match(r[1]!.text, /^Workflow double completed[^]*\n\ndouble: 42$/);
		assert.match(r[2]!.text, /\n\ndouble: 8$/);
		rmSync(file);
		respond(fauxAssistantMessage("ok"));
		await s.prompt("again");
		assert.equal(s.getActiveToolNames().includes("double"), false);
	});

	test("a saved workflow built with sh takes hostile arguments as literal text, also in a later session", async () => {
		const greet = 'export const meta = { description: "Print a greeting.", budget: 0.01, parameters: { type: "object", properties: { who: { type: "string" }, times: { type: "integer", default: 1 } }, required: ["who"] } };\nexport default async function ({ who, times = 1 }) {\n  const r = await shell(sh`for i in $(seq 1 ${times}); do printf \'hi <%s>\\n\' ${who}; done`);\n  return r.output.trimEnd();\n}\n';
		const hostile = "x'; touch pwned; echo '$(touch pwned2)`touch pwned3`\nnext line";
		const s = await newSession(idIn("B", "workflow"));
		respond(call("write", { path: ".pi/workflows/greet.ts", content: greet }), call("greet", { who: hostile, times: 2 }), fauxAssistantMessage("done"));
		await s.prompt("go");
		const greeted = results(s)[1]!;
		assert.equal(greeted.error, false, greeted.text);
		assert.equal(greeted.text.split("\n\n").at(-1), `hi <${hostile}>\nhi <${hostile}>`);
		for (const file of ["pwned", "pwned2", "pwned3"]) assert.equal(existsSync(join(repo, file)), false, file);
		const later = await newSession(idIn("B", "workflow", "0190b000-0000-7000-8000-"));
		respond(call("greet", { who: "again" }), fauxAssistantMessage("ok"));
		await later.prompt("go");
		assert.match(results(later)[0]!.text, /hi <again>$/);
	});

	test("arm A of workflow sees neither the tool nor saved project workflows; fix_loop follows its own experiment", async () => {
		mkdirSync(join(repo, ".pi", "workflows"), { recursive: true });
		writeFileSync(join(repo, ".pi", "workflows", "double.ts"), double);
		let id = "";
		for (let i = 0; ; i++) {
			id = `0190e000-0000-7000-8000-${String(i).padStart(12, "0")}`;
			if (hashArm(id, "workflow") === "A" && hashArm(id, "fix-loop") === "B") break;
		}
		const a = await newSession(id);
		respond(fauxAssistantMessage("ok"));
		await a.prompt("go");
		const active = a.getActiveToolNames();
		assert.equal(active.includes("workflow"), false);
		assert.equal(active.includes("double"), false);
		assert.equal(active.includes("fix_loop"), true);
		const b = await newSession(idIn("B", "workflow"));
		respond(fauxAssistantMessage("ok"));
		await b.prompt("go");
		assert.equal(b.getActiveToolNames().includes("double"), true);
	});
});

describe("sh", () => {
	const tag = (strings: TemplateStringsArray, ...values: unknown[]) => sh(strings, ...values);

	test("every hostile value arrives as one literal argument", async () => {
		const values = ["; rm -rf /tmp/never", "$(id)", "`id`", "a'b\"c", "line1\nline2", "--help", "*", "$HOME", "", " spaced  out ", "\\n"];
		for (const value of values) {
			const out = await runShell(tag`printf '[%s]' ${value}`, { cwd: dir });
			assert.equal(out.output, `[${value}]`, JSON.stringify(value));
		}
		assert.equal((await runShell(tag`printf '<%s>' ${["a b", 2, "c"]}`, { cwd: dir })).output, "<a b><2><c>", "arrays: one word per element");
		assert.equal((await runShell(tag`printf '%s\n' ${-1.5}`, { cwd: dir })).output, "-1.5\n", "the template is raw: backslashes stay shell escapes");
	});

	test("values inside quotes, NUL, other types and calls without a template are refused", () => {
		assert.throws(() => tag`echo '${"x"}'`, /value 1 stands inside single quotes/);
		assert.throws(() => tag`echo "it's ${"x"}"`, /value 1 stands inside double quotes/);
		assert.equal(tag`echo \'${"x"}`, "echo \\''x'", "an escaped quote opens nothing");
		assert.equal(tag`echo "a" ${"x"} 'b'`, "echo \"a\" 'x' 'b'");
		assert.throws(() => tag`echo ${"a\0b"}`, /NUL/);
		assert.throws(() => tag`echo ${Number.NaN}`, /finite number/);
		assert.throws(() => tag`echo ${{}}`, /must be a string, a number or an array/);
		assert.throws(() => tag`echo ${null}`, /got null/);
		assert.throws(() => (sh as unknown as (s: string) => string)("echo hi"), /template tag/);
	});
});
