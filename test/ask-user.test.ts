// ask_user (extensions/ask-user) in real Pi sessions (faux model) with a fake UI whose questions
// dialogs the test answers: the call waits for the answers, a chat reply answers it, the time
// limit and `wait_minutes: 0` hand the answers on as a later message, an abort closes the dialog,
// and the background extension leaves a waiting call alone.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionUIContext,
	type ExtensionUIQuestion,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import askUser, { formatAnswers, invalidQuestions, pendingText } from "../extensions/ask-user/index.ts";
import background from "../extensions/background/index.ts";
import { sessionJobs } from "../extensions/background/jobs.ts";

type Answers = (string | undefined)[] | undefined;

/** One questions dialog the fake UI shows; `closed` is set when Pi closes it through its signal (RPC's `dismiss`). */
interface Dialog {
	questions: ExtensionUIQuestion[];
	answer: (answers: Answers) => void;
	closed: boolean;
}

describe("questions and answers", () => {
	test("refuses unusable questions", () => {
		assert.equal(invalidQuestions([]), "questions must not be empty");
		assert.match(invalidQuestions([{ title: "  " }])!, /titles must not be empty/);
		assert.match(invalidQuestions([{ title: "x", options: [] }])!, /at least one non-empty answer/);
		assert.match(invalidQuestions([{ title: "x", options: ["a", " "] }])!, /at least one non-empty answer/);
		assert.equal(invalidQuestions([{ title: "x", options: ["a"] }, { title: "y" }]), undefined);
	});

	test("formats answers: one question without a number, dismissed and empty answers distinct, chat replies noted", () => {
		assert.equal(formatAnswers([{ title: "Name?" }], [""]), "The user answered your ask_user questions:\n\nName?\nAnswer: (empty answer)");
		assert.equal(
			formatAnswers([{ title: "A?" }, { title: "B?" }], undefined),
			"The user answered your ask_user questions:\n\n1. A?\nAnswer: (dismissed without an answer)\n\n2. B?\nAnswer: (dismissed without an answer)",
		);
		assert.equal(formatAnswers([{ title: "A?" }], ["yes"], true), "The user answered your ask_user questions with a reply in the chat:\n\nA?\nAnswer: yes");
		assert.match(formatAnswers([{ title: "A?" }, { title: "B?" }], ["x", "x"], true), /^The user answered your ask_user questions with one reply in the chat, given here for each question:\n\n1\. A\?\nAnswer: x\n\n2\. B\?\nAnswer: x$/);
		assert.equal(pendingText(0), "The questions stay open. Continue with the work that does not depend on the answers, or end your turn: the answers arrive later as a message.");
		assert.match(pendingText(15), /^No answer after 15 min\. The questions stay open\./);
	});
});

const DETACH_MS = 300;
let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
let dir: string;
const open: AgentSession[] = [];
const extensionErrors: string[] = [];

before(async () => {
	faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	const scratch = mkdtempSync(join(tmpdir(), "ask-runtime-"));
	runtime = await ModelRuntime.create({ authPath: join(scratch, "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "faux-1", name: "Faux", api: faux.api, reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8000 }],
	});
});
after(() => faux.unregister());
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ask-"));
});
afterEach(async () => {
	assert.deepEqual(extensionErrors.splice(0), [], "no extension errors");
	for (const session of open.splice(0)) {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
	rmSync(dir, { recursive: true, force: true });
});

/** A UI whose questions dialogs the test answers; Pi closing a dialog (its signal) settles it without answers, as RPC mode does. */
function fakeUi() {
	const dialogs: Dialog[] = [];
	const methods = {
		questions: (questions: ExtensionUIQuestion[], opts?: { signal?: AbortSignal }) =>
			new Promise<Answers>((resolve) => {
				const dialog: Dialog = { questions, answer: resolve, closed: false };
				dialogs.push(dialog);
				opts?.signal?.addEventListener("abort", () => ((dialog.closed = true), resolve(undefined)), { once: true });
			}),
	};
	const context = new Proxy(methods, { get: (target, name) => (name in target ? target[name as keyof typeof target] : () => undefined) }) as unknown as ExtensionUIContext;
	return { dialogs, context };
}

/** `slow` sleeps `ms`, stopping on its signal. */
function slowTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "slow",
		label: "slow",
		description: "Sleeps.",
		parameters: Type.Object({ ms: Type.Number() }),
		execute: (_id, params, signal) =>
			new Promise<AgentToolResult<undefined>>((resolve, reject) => {
				const timer = setTimeout(() => resolve({ content: [{ type: "text", text: "slept" }], details: undefined }), params.ms);
				signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("aborted"))), { once: true });
			}),
	});
}

async function newSession() {
	const cwd = mkdtempSync(join(dir, "repo-"));
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: dir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		// The order of extensions/*/index.ts: ask-user's input handler runs before background's.
		extensionFactories: [askUser, (pi: ExtensionAPI) => background(pi, { detachAfterMs: DETACH_MS, logRoot: join(dir, "logs") }), slowTool],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: dir,
		model: runtime.getModel("faux", "faux-1"),
		modelRuntime: runtime,
		resourceLoader,
		sessionManager: SessionManager.create(cwd, join(dir, "sessions")),
		settingsManager,
	});
	const { dialogs, context } = fakeUi();
	await session.bindExtensions({ uiContext: context, onError: (error) => extensionErrors.push(`${error.event}: ${error.error}`) });
	open.push(session);
	return { s: session, dialogs };
}

type Args = Parameters<typeof fauxToolCall>[1];
const calls = (...list: [string, Args][]) => fauxAssistantMessage(list.map(([name, args]) => fauxToolCall(name, args)), { stopReason: "toolUse" });
const ask = (args: Args) => calls(["ask_user", args]);
const respond = (...steps: FauxResponseStep[]) => faux.setResponses(steps);
const textOf = (content: string | readonly { type: string; text?: string }[]) => (typeof content === "string" ? content : content.map((c) => c.text ?? "").join(""));
const results = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "toolResult" ? [{ tool: m.toolName, text: `${m.isError ? "error: " : ""}${textOf(m.content)}` }] : []));
const askResults = (s: AgentSession) => results(s).filter((r) => r.tool === "ask_user").map((r) => r.text);
const askMessages = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "custom" && m.customType === "ask_user" ? [textOf(m.content)] : []));
const userTexts = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "user" ? [textOf(m.content)] : []));
const settled = (s: AgentSession, reply: string) => () => !s.isStreaming && s.messages.at(-1)?.role === "assistant" && JSON.stringify(s.messages.at(-1)).includes(reply);
async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waits = (s: AgentSession) => (globalThis as { __harnessAskUserWaits?: Map<string, Set<unknown>> }).__harnessAskUserWaits?.get(s.sessionManager.getSessionId())?.size ?? 0;

describe("ask_user waits for the answers", () => {
	test("the dialog's answers are the call's result; it waits past the background limit", async () => {
		const { s, dialogs } = await newSession();
		const questions: { title: string; options?: string[] }[] = [{ title: "Area?", options: ["A", "B"] }, { title: "Why?" }];
		let seen = "";
		respond(ask({ questions: questions as Args[string] }), (context) => {
			seen = JSON.stringify(context.messages.at(-1));
			return fauxAssistantMessage("Going with B.");
		});
		const run = s.prompt("go");
		await until("the dialog", () => dialogs.length === 1);
		assert.deepEqual(dialogs[0]!.questions, questions);
		await pause(DETACH_MS * 2);
		assert.equal(askResults(s).length, 0, "still waiting after the background limit");
		assert.equal(sessionJobs(s.sessionManager.getSessionId()).jobs.size, 0, "not moved to the background");
		dialogs[0]!.answer(["B", undefined]);
		await run;
		const expected = "The user answered your ask_user questions:\n\n1. Area?\nAnswer: B\n\n2. Why?\nAnswer: (dismissed without an answer)";
		assert.deepEqual(askResults(s), [expected]);
		assert.match(seen, /Answer: B/, "the model reads the answers as the tool result");
		assert.deepEqual(askMessages(s), [], "no second delivery as a message");
		assert.equal(dialogs[0]!.closed, false);
		assert.equal(waits(s), 0);
	});

	test("a dismissed dialog answers every question as dismissed", async () => {
		const { s, dialogs } = await newSession();
		respond(ask({ questions: [{ title: "One?" }] }), fauxAssistantMessage("ok"));
		const run = s.prompt("go");
		await until("the dialog", () => dialogs.length === 1);
		dialogs[0]!.answer(undefined);
		await run;
		assert.deepEqual(askResults(s), ["The user answered your ask_user questions:\n\nOne?\nAnswer: (dismissed without an answer)"]);
	});

	test("without an answer in time it returns; the late answer arrives as a message that starts a run", async () => {
		const { s, dialogs } = await newSession();
		let woken = "";
		respond(ask({ questions: [{ title: "Deploy?", options: ["yes", "no"] }], wait_minutes: 0.005 }), fauxAssistantMessage("Doing other work."), (context) => {
			woken = JSON.stringify(context.messages.at(-1));
			return fauxAssistantMessage("Deploying.");
		});
		const t0 = Date.now();
		await s.prompt("go");
		assert.ok(Date.now() - t0 >= 300, "waited for wait_minutes");
		assert.deepEqual(askResults(s), [pendingText(0.005)]);
		assert.equal(dialogs[0]!.closed, false, "the dialog stays open");
		assert.equal(waits(s), 0, "a chat message no longer answers it");

		dialogs[0]!.answer(["yes"]);
		await until("the woken run", settled(s, "Deploying."));
		assert.deepEqual(askMessages(s), ["The user answered your ask_user questions:\n\nDeploy?\nAnswer: yes"]);
		assert.match(woken, /Deploy\?\\nAnswer: yes/);
	});

	test("wait_minutes 0 returns at once; the answer arrives as a message that steers the running turn", async () => {
		const { s, dialogs } = await newSession();
		let steered = "";
		respond(ask({ questions: [{ title: "Name?" }], wait_minutes: 0 }), calls(["slow", { ms: 150 }]), (context) => {
			steered = JSON.stringify(context.messages.slice(-2));
			return fauxAssistantMessage("Named.");
		});
		const run = s.prompt("go");
		await until("the dialog", () => dialogs.length === 1);
		await until("the result", () => askResults(s).length === 1);
		assert.deepEqual(askResults(s), [pendingText(0)]);
		dialogs[0]!.answer(["Ada"]);
		await run;
		assert.match(steered, /Name\?\\nAnswer: Ada/, "the answer steered the turn after the next tool call");
		assert.equal(askMessages(s).length, 1);
	});

	test("a chat reply answers one question, closes the dialog, and is delivered once", async () => {
		const { s, dialogs } = await newSession();
		let seen = "";
		respond(ask({ questions: [{ title: "Which database?", options: ["Postgres", "SQLite"] }] }), (context) => {
			seen = JSON.stringify(context.messages.map((m) => ("content" in m ? m.content : "")));
			return fauxAssistantMessage("Using SQLite.");
		});
		const run = s.prompt("go");
		await until("the dialog", () => dialogs.length === 1);
		assert.equal(await s.steer("SQLite, it is only a prototype", undefined, { source: "rpc" }), "handled");
		await run;
		assert.deepEqual(askResults(s), ["The user answered your ask_user questions with a reply in the chat:\n\nWhich database?\nAnswer: SQLite, it is only a prototype"]);
		assert.equal(dialogs[0]!.closed, true, "the dialog closed");
		assert.deepEqual(userTexts(s), ["go"], "not delivered as a user message");
		assert.equal(seen.split("SQLite, it is only a prototype").length - 1, 1, "the model reads it once");
		assert.equal(s.getSteeringMessages().length, 0);
		assert.deepEqual(askMessages(s), [], "the closed dialog sends no message");
		assert.equal(waits(s), 0);
	});

	test("a chat reply answers several questions with the same text, images included", async () => {
		const { s, dialogs } = await newSession();
		respond(ask({ questions: [{ title: "Color?" }, { title: "Size?" }] }), fauxAssistantMessage("ok"));
		const run = s.prompt("go");
		await until("the dialog", () => dialogs.length === 1);
		const image = { type: "image" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", mimeType: "image/png" };
		await s.prompt("blue and large, like this", { streamingBehavior: "steer", source: "rpc", images: [image] });
		await run;
		assert.deepEqual(askResults(s), [
			"The user answered your ask_user questions with one reply in the chat, given here for each question:\n\n1. Color?\nAnswer: blue and large, like this\n\n2. Size?\nAnswer: blue and large, like this",
		]);
		const result = s.messages.find((m) => m.role === "toolResult" && m.toolName === "ask_user");
		assert.ok(result?.role === "toolResult" && result.content.some((c) => c.type === "image"), "the image comes along");
		assert.equal(dialogs[0]!.closed, true);
		assert.deepEqual(userTexts(s), ["go"]);
	});

	test("a message from an extension is not a reply; a message after the answer is a normal message", async () => {
		const { s, dialogs } = await newSession();
		respond(ask({ questions: [{ title: "Go?" }] }), calls(["slow", { ms: 100 }]), fauxAssistantMessage("done"));
		const run = s.prompt("go");
		await until("the dialog", () => dialogs.length === 1);
		await s.steer("from an extension", undefined, { source: "extension" });
		assert.equal(askResults(s).length, 0, "still waiting");
		dialogs[0]!.answer(["yes"]);
		await until("the result", () => askResults(s).length === 1);
		assert.equal(await s.steer("unrelated", undefined, { source: "rpc" }), "queued");
		await run;
		assert.deepEqual(askResults(s), ["The user answered your ask_user questions:\n\nGo?\nAnswer: yes"]);
		assert.deepEqual(userTexts(s), ["go", "from an extension", "unrelated"]);
	});

	test("an abort ends the wait and closes the dialog", async () => {
		const { s, dialogs } = await newSession();
		respond(ask({ questions: [{ title: "Go?" }] }), fauxAssistantMessage("unused"));
		const run = s.prompt("go");
		await until("the dialog", () => dialogs.length === 1);
		await s.abort();
		await run;
		assert.equal(dialogs[0]!.closed, true);
		assert.deepEqual(askResults(s), ["error: Aborted: the questions were closed without an answer."]);
		assert.equal(waits(s), 0);
		await pause(20);
		assert.deepEqual(askMessages(s), [], "no late message");
	});

	test("the background limit moves a parallel slow call but not the waiting ask_user", async () => {
		const { s, dialogs } = await newSession();
		respond(calls(["ask_user", { questions: [{ title: "Go?" }] }], ["slow", { ms: 30_000 }]), fauxAssistantMessage("ok"));
		const run = s.prompt("go");
		await until("the dialog", () => dialogs.length === 1);
		const jobs = sessionJobs(s.sessionManager.getSessionId()).jobs;
		await until("slow in the background", () => jobs.size === 1);
		assert.deepEqual([...jobs.values()].map((j) => j.toolName), ["slow"]);
		await pause(DETACH_MS);
		assert.equal(askResults(s).length, 0, "ask_user still waits");
		await s.steer("yes", undefined, { source: "rpc" });
		await run;
		assert.deepEqual(askResults(s), ["The user answered your ask_user questions with a reply in the chat:\n\nGo?\nAnswer: yes"]);
		assert.match(results(s).find((r) => r.tool === "slow")!.text, /moved to the background/);
	});

	test("tools can call it (a workflow's tools.ask_user, `tool ask_user` in bash): it is a direct tool", async () => {
		const { s } = await newSession();
		assert.ok(s.getCallableToolNames().includes("ask_user"));
	});

	test("refuses a session without a user interface", async () => {
		const cwd = mkdtempSync(join(dir, "noui-"));
		const settingsManager = SettingsManager.inMemory({});
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, extensionFactories: [askUser] });
		await resourceLoader.reload();
		const { session } = await createAgentSession({ cwd, agentDir: dir, model: runtime.getModel("faux", "faux-1"), modelRuntime: runtime, resourceLoader, sessionManager: SessionManager.create(cwd, join(dir, "sessions")), settingsManager });
		await session.bindExtensions({ onError: (error) => extensionErrors.push(`${error.event}: ${error.error}`) });
		open.push(session);
		respond(ask({ questions: [{ title: "Go?" }] }), fauxAssistantMessage("ok"));
		await session.prompt("go");
		assert.match(askResults(session)[0]!, /^error: No user interface/);
	});
});
