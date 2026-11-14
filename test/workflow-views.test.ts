// What the thread shows of a workflow run (extensions/workflow/runs.ts), in real sessions with the
// background and workflow extensions, a faux model and fake t3 tools: the page through html_render
// at the start (in the calling run) and at the end (in the run the result wakes), on request with
// `show`, the live view in the preview panel, and the fallback when the call's context went stale.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { Context, JsonObject } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import background from "../extensions/background/index.ts";
import workflow from "../extensions/workflow/index.ts";
import { readJournal } from "../extensions/workflow/journal.ts";
import { renderWorkflow } from "../extensions/workflow/render.ts";

let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
/** The faux provider; again after a session reload, which resets Pi's API providers. */
function registerFaux() {
	faux?.unregister();
	faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "faux-1", name: "Faux", api: faux.api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8000 }],
	});
}
before(async () => {
	runtime = await ModelRuntime.create({ authPath: join(mkdtempSync(join(tmpdir(), "views-rt-")), "auth.json"), modelsPath: null });
	registerFaux();
});
after(() => faux.unregister());

let dir: string;
let repo: string;
let sessions: AgentSession[];
/** Each fake t3 call: tool, arguments, and whether a run of the session was active (t3 refuses otherwise). */
let calls: { name: string; args: Record<string, unknown>; active: boolean }[];
let errors: string[];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "views-"));
	repo = join(dir, "repo");
	mkdirSync(repo);
	writeFileSync(join(repo, "README.md"), "x\n");
	for (const args of [["init", "-q"], ["add", "."], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]]) execFileSync("git", args, { cwd: repo });
	sessions = [];
	calls = [];
	errors = [];
});
afterEach(() => {
	for (const session of sessions) session.dispose();
	assert.deepEqual(errors, [], "no extension errors");
	rmSync(dir, { recursive: true, force: true });
});

const textOf = (content: unknown) => (typeof content === "string" ? content : (content as { type: string; text?: string }[]).flatMap((b) => (b.type === "text" ? [b.text ?? ""] : [])).join("\n"));
const say = (text: string) => fauxAssistantMessage(text);
const call = (name: string, args: JsonObject) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
let debug: unknown;
const until = async (what: string, ok: () => boolean, ms = 10_000) => {
	const deadline = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(debug)}`);
		await new Promise((r) => setTimeout(r, 20));
	}
};

/** A session with fake t3 view tools; `t3: false` leaves them out (a session outside t3). */
async function newSession(options: { t3?: boolean; refuseRenders?: number } = {}) {
	let refusals = options.refuseRenders ?? 0;
	let session: AgentSession | undefined;
	const fakeT3 = (pi: ExtensionAPI) => {
		for (const name of ["html_render", "preview_open"]) {
			pi.registerTool({
				name: `mcp__t3-code__${name}`,
				label: name,
				description: name,
				parameters: Type.Object({}, { additionalProperties: true }),
				async execute(_id, params) {
					calls.push({ name, args: params as Record<string, unknown>, active: session?.isStreaming ?? false });
					// As t3 answers before it adopted a woken run.
					if (name === "html_render" && String((params as { title?: unknown }).title).endsWith("ended") && refusals-- > 0) {
						throw new Error('{"_tag":"OrchestratorMcpFailure","code":"parent_not_active","message":"The calling provider no longer owns an active thread run."}');
					}
					return { content: [{ type: "text" as const, text: '{"htmlRender":{"attachmentId":"a"}}' }], details: undefined };
				},
			});
		}
	};
	const settingsManager = SettingsManager.inMemory({});
	const agentDir = join(dir, "agent");
	const extensions = [
		(pi: ExtensionAPI) => background(pi, { logRoot: join(dir, "logs") }),
		(pi: ExtensionAPI) => workflow(pi, { experimentsDir: join(dir, "experiments"), workflowDirs: () => [], modelRuntime: async () => runtime, agentDir, dashboardUrl: "http://dash" }),
		...(options.t3 === false ? [] : [fakeT3]),
	];
	const resourceLoader = new DefaultResourceLoader({ cwd: repo, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, extensionFactories: extensions });
	await resourceLoader.reload();
	({ session } = await createAgentSession({ cwd: repo, agentDir, model: runtime.getModel("faux", "faux-1"), modelRuntime: runtime, resourceLoader, sessionManager: SessionManager.create(repo, join(dir, "sessions")), settingsManager }));
	await session.bindExtensions({ onError: (error) => errors.push(`${error.event}: ${error.error}`) });
	session.setActiveToolsByName([...session.getActiveToolNames(), "workflow", "mcp__t3-code__html_render", "mcp__t3-code__preview_open"]);
	sessions.push(session);
	return session;
}

/** The model calls workflow with `code`, then answers each message; returns what it was told. */
function model(code: string, extra: (text: string) => ReturnType<typeof say> | undefined = () => undefined) {
	const told: string[] = [];
	debug = told;
	faux.setResponses(
		Array.from({ length: 30 }, () => (context: Context) => {
			const last = context.messages.findLast((m) => m.role !== "system")!;
			const text = textOf(last.content);
			told.push(text);
			if (text === "go") return call("workflow", { code, budget: 1 });
			return extra(text) ?? say("ok");
		}),
	);
	return told;
}

const renders = () => calls.filter((c) => c.name === "html_render");

describe("the run's page in the thread", () => {
	test("at the start in the calling run, with the live view named and opened; at the end in the run its result wakes", async () => {
		const told = model("await new Promise((r) => setTimeout(r, 400));\nawait shell('echo hi');\nreturn 'finished';");
		const session = await newSession();
		await session.prompt("go");
		const immediate = told[1]!;
		const id = /Workflow run (\d{8}-\d{6}-[0-9a-f]{6}) · live view http:\/\/dash\/workflows\/\1/.exec(immediate)?.[1];
		assert.ok(id, `the immediate result names the run and its live view:\n${immediate}`);
		await until("the start page", () => renders().length === 1);
		const [start] = renders();
		assert.equal(start!.active, true, "rendered while the calling run was active");
		assert.match(String(start!.args.title), new RegExp(`^workflow ${id} · started$`));
		assert.match(String(start!.args.html), new RegExp(`data-run="${id}"`));
		assert.ok(Number(start!.args.height) >= 80);
		assert.deepEqual(calls.find((c) => c.name === "preview_open")?.args, { url: `http://dash/workflows/${id}` });

		await until("the result", () => told.some((t) => t.includes("Workflow completed")));
		await until("the end page", () => renders().length === 2);
		const end = renders()[1]!;
		assert.equal(end.active, true, "rendered in the run the result woke, not while idle");
		assert.match(String(end.args.title), /· ended$/);
		const journal = readJournal(join(dir, "agent", "workflows", id!, "journal.jsonl"));
		assert.equal(end.args.html, renderWorkflow(journal), "the final page: the journal's");
		assert.match(String(end.args.html), /completed/);
		assert.doesNotMatch(told.find((t) => t.includes("Workflow completed"))!, /Show this run's page/, "no fallback needed");
		const entries = session.sessionManager.getEntries().flatMap((e) => (e.type === "custom" && e.customType === "workflow-run" ? [e.data] : []));
		assert.deepEqual(entries, [{ id, state: "started" }, { id, state: "ended", status: "completed" }]);

		// On request: `show` answers at once in the foreground.
		faux.setResponses([call("workflow", { show: id! }), (context: Context) => (told.push(textOf(context.messages.findLast((m) => m.role !== "system")!.content)), say("shown"))]);
		await session.prompt("show it");
		assert.match(told.at(-1)!, new RegExp(`^Run ${id} is completed\\. Live view: http://dash/workflows/${id}\\. Page: .*page\\.html\\.\\nShown in the thread\\.$`));
		assert.equal(renders().length, 3);
		assert.equal(renders()[2]!.args.html, renderWorkflow(journal));
	});

	test("a call whose context went stale (a harness reload) is interrupted, and its result asks the agent to show the page", async () => {
		const told = model("await new Promise((r) => setTimeout(r, 500));\nawait tools.read({ path: 'README.md' });\nreturn 'never';");
		const session = await newSession();
		await session.prompt("go");
		await session.reload();
		registerFaux();
		// The model after a reload is a new faux provider; the result is read from the message the session got.
		const message = () =>
			session.sessionManager.getEntries().flatMap((e) => (e.type === "custom_message" && e.customType === "background-job" && typeof e.content === "string" ? [e.content] : []))[0];
		await until("the result", () => message() !== undefined);
		const result = message()!;
		assert.match(result, /Workflow interrupted/);
		assert.match(result, /It can continue from its journal: call workflow with resume: "\d{8}-\d{6}-[0-9a-f]{6}"/);
		assert.match(result, /interrupted: the harness reloaded/);
		assert.match(result, /Show this run's page in the thread before you reply: call mcp__t3-code__html_render with path ".*\/page\.html", height \d+ and title "workflow \S+ · ended"\./);
		assert.equal(renders().length, 1, "only the start page; the harness could not render the end");
	});

	test("an end page t3 refuses before it adopted the woken run is tried again at the next message", async () => {
		const told = model("return 'done';", (text) => (text.includes("Workflow completed") ? call("read", { path: "README.md" }) : undefined));
		const session = await newSession({ refuseRenders: 1 });
		await session.prompt("go");
		await until("the second try", () => renders().filter((c) => String(c.args.title).endsWith("ended")).length === 2);
		const ends = renders().filter((c) => String(c.args.title).endsWith("ended"));
		assert.equal(ends[1]!.args.html, ends[0]!.args.html);
		assert.ok(ends.every((c) => c.active));
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(renders().filter((c) => String(c.args.title).endsWith("ended")).length, 2, "not again once shown");
		assert.ok(told.length > 0);
	});

	test("outside t3 nothing is rendered or opened", async () => {
		const told = model("return 'plain';");
		const session = await newSession({ t3: false });
		await session.prompt("go");
		await until("the result", () => told.some((t) => t.includes("Workflow completed")));
		assert.deepEqual(calls, []);
		assert.doesNotMatch(told.find((t) => t.includes("Workflow completed"))!, /html_render/);
	});
});
