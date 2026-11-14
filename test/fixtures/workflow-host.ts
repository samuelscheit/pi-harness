// A Pi process for test/workflow-kill.test.ts: one session with the background and workflow
// extensions and a faux model, which the test kills mid-run and starts again on the same session.
//
// node test/fixtures/workflow-host.ts '<json>'  with { mode: "start" | "resume", repo, agentDir,
// sessionsDir, out, code?, sessionFile? }
// - start: the model calls `workflow` with `code`; the session file's path goes to `out`; the
//   process then runs until it is killed.
// - resume: opens `sessionFile` (its session starts again), lets the harness offer the interrupted
//   run and the model resume it, and writes what the model said and the session's messages to
//   `out` once the model got the final result.
//
// The faux model answers by the request: llm() calls ("count me") count themselves in llm-count,
// a child agent runs a slow bash command on its first run and finishes when asked to continue, and
// the parent calls the workflow tool, resumes what it is offered (with inFlight "rerun" when a
// resume names in-flight calls), and says "all done: <result>" for the final result.

import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import background from "../../extensions/background/index.ts";
import workflow from "../../extensions/workflow/index.ts";

const options = JSON.parse(process.argv[2]!) as { mode: "start" | "resume"; repo: string; agentDir: string; sessionsDir: string; out: string; code?: string; sessionFile?: string };

const faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
const runtime = await ModelRuntime.create({ authPath: join(mkdtempSync(join(tmpdir(), "host-rt-")), "auth.json"), modelsPath: null });
runtime.registerProvider("faux", {
	baseUrl: "http://localhost:0",
	apiKey: "faux",
	api: faux.api,
	models: [{ id: "faux-1", name: "Faux", api: faux.api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8000 }],
});

const textOf = (content: unknown) => (typeof content === "string" ? content : (content as { type: string; text?: string }[]).flatMap((b) => (b.type === "text" ? [b.text ?? ""] : [])).join("\n"));
const firstUser = (context: Context) => textOf(context.messages.find((m) => m.role === "user")?.content ?? "");
const say = (text: string) => fauxAssistantMessage(text);
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
const said: string[] = [];
const reply = (text: string) => (said.push(text), say(text));

faux.setResponses(
	Array.from({ length: 200 }, () => (context: Context) => {
		const last = context.messages.findLast((m) => m.role !== "system")!;
		const text = textOf(last.content);
		if (firstUser(context).includes("count me")) {
			appendFileSync(join(options.repo, "llm-count"), "x\n");
			return say("counted");
		}
		if (firstUser(context).includes("harness-delegation:")) {
			if (last.role === "user" && text.includes("Continue the task")) return say("agent finished after the restart");
			if (last.role === "user") return call("bash", { command: "echo a >> agent-count; touch agent-ready; sleep 20" });
			return say("agent finished");
		}
		const offered = /stopped when its Pi process ended:\n- (\d{8}-\d{6}-[0-9a-f]{6})/.exec(text);
		if (offered) return call("workflow", { resume: offered[1] });
		const refused = /workflow run (\d{8}-\d{6}-[0-9a-f]{6}) was not resumed/.exec(text);
		if (refused) return call("workflow", { resume: refused[1], inFlight: "rerun" });
		if (/Workflow \S* ?completed/.test(text)) return reply(`all done: ${text.split("\n\n").at(-1)}`);
		if (last.role === "toolResult" || text.includes("Workflow")) return reply(`noted: ${text.slice(0, 200)}`);
		return call("workflow", { code: options.code, budget: 1 });
	}),
);

const extensions = [
	(pi: ExtensionAPI) => background(pi, { logRoot: join(options.agentDir, "job-logs") }),
	(pi: ExtensionAPI) => workflow(pi, { experimentsDir: join(options.agentDir, "experiments"), workflowDirs: () => [], modelRuntime: async () => runtime, agentDir: options.agentDir }),
];
const settingsManager = SettingsManager.inMemory({});
const resourceLoader = new DefaultResourceLoader({ cwd: options.repo, agentDir: options.agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, extensionFactories: extensions });
await resourceLoader.reload();
const sessionManager = options.mode === "start" ? SessionManager.create(options.repo, options.sessionsDir) : SessionManager.open(options.sessionFile!);
const { session } = await createAgentSession({ cwd: options.repo, agentDir: options.agentDir, model: runtime.getModel("faux", "faux-1"), modelRuntime: runtime, resourceLoader, sessionManager, settingsManager });
const errors: string[] = [];
session.setActiveToolsByName([...session.getActiveToolNames(), "workflow"]);
await session.bindExtensions({ onError: (error) => errors.push(`${error.event}: ${error.error}`) });

if (options.mode === "start") {
	writeFileSync(options.out, JSON.stringify({ sessionFile: session.sessionFile }));
	await session.prompt("go");
	// Runs until killed: the workflow keeps the process busy.
	setInterval(() => undefined, 1000);
} else {
	const deadline = Date.now() + 60_000;
	while (!said.some((line) => line.startsWith("all done")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
	// Let anything that would arrive twice arrive.
	await new Promise((r) => setTimeout(r, 500));
	const messages = session.messages.map((m) => ({ role: m.role, text: "content" in m ? textOf(m.content).slice(0, 2000) : "" }));
	writeFileSync(options.out, JSON.stringify({ said, messages, errors }));
	process.exit(0);
}
