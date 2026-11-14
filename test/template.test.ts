// Templates (extensions/template): recipe parsing, the deterministic build, staleness, the rebuild
// under a lock (in one process and across processes), capture, the `/template` command, and the
// prefix key across a prompt change. Then real Pi sessions with a faux model forked from a built
// template, with Anthropic's prompt cache simulated across sessions as in vendor/pi's fork-base
// tests: a fork carries the template's history, the next fork reads the template prefix the
// first one's use made worth caching, and a stale template rebuilds once for parallel uses.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Message, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	describeBranchPrefix,
	type ExtensionAPI,
	type ExtensionCommandContextActions,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	SharedPrefixCache,
} from "@earendil-works/pi-coding-agent";
import { buildTemplate, endMessage, expandReads } from "../extensions/template/build.ts";
import template, { modelFinder } from "../extensions/template/index.ts";
import { parseRecipe } from "../extensions/template/recipe.ts";
import { captureSession, describeTemplates, type FindModel, findTemplate, sessionPath, staleness, type TemplateMeta, useTemplate } from "../extensions/template/store.ts";

const exec = promisify(execFile);
const STORE = new URL("../extensions/template/store.ts", import.meta.url).pathname;
const MODEL = "faux/faux-1";
const COST = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
/** About 12k tokens in lines Pi's read tool returns whole (under its 50 KB limit): enough that caching the template pays. */
const BIG = "word word word word word word\n".repeat(1_600);

let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
let model: Model<Api>;
const findModel: FindModel = modelFinder((provider, id) => runtime.getModel(provider, id));

before(async () => {
	faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	const scratch = mkdtempSync(join(tmpdir(), "template-runtime-"));
	runtime = await ModelRuntime.create({ authPath: join(scratch, "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "faux-1", name: "Faux", api: faux.api, reasoning: true, input: ["text"], cost: { ...COST }, contextWindow: 400_000, maxTokens: 8000 }],
	});
	model = runtime.getModel("faux", "faux-1")!;
	// Anthropic's lifetimes, so Pi records and decides with them.
	(model as Model<Api> & { promptCache?: object }).promptCache = { short: 300, long: 3600 };
});
after(() => faux.unregister());

let dir: string;
let repo: string;
let agentDir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "template-"));
	repo = join(dir, "repo");
	agentDir = join(dir, "agent");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(join(repo, "docs"));
	writeFileSync(join(repo, "README.md"), "hello\n");
	writeFileSync(join(repo, "docs", "b.md"), "bee\n");
	writeFileSync(join(repo, "docs", "a.md"), "ay\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const RECIPE = `---
model: faux/faux-1
thinking: low
description: Reviews docs
read:
  - README.md
  - docs/*.md
---
You review the docs of this repository.

Work in small steps.

:::user
Review docs/a.md.
:::
:::assistant
docs/a.md is fine.
:::
`;
const writeRecipe = (text = RECIPE, name = "review") => {
	mkdirSync(join(repo, ".pi", "templates"), { recursive: true });
	writeFileSync(join(repo, ".pi", "templates", `${name}.md`), text);
};
const lines = (file: string) =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
const roleOf = (entry: { type: string; message?: { role: string } }) => (entry.type === "message" ? entry.message!.role : entry.type);

describe("recipes", () => {
	test("frontmatter and body: model, thinking, description, reads, instructions and verbatim examples", () => {
		const recipe = parseRecipe("review", RECIPE);
		assert.equal(recipe.model, MODEL);
		assert.equal(recipe.thinking, "low");
		assert.equal(recipe.description, "Reviews docs");
		assert.deepEqual(recipe.read, ["README.md", "docs/*.md"]);
		assert.equal(recipe.instructions, "You review the docs of this repository.\n\nWork in small steps.");
		assert.deepEqual(recipe.examples, [{ user: "Review docs/a.md.", assistant: "docs/a.md is fine." }]);
		assert.equal(recipe.hash, createHash("sha256").update(RECIPE).digest("hex"));
		// One path as a string; no examples; ::: lines inside a block's text are fine when not fences.
		const plain = parseRecipe("x", "---\nmodel: a/b\nread: README.md\n---\nDo it.\n");
		assert.deepEqual([plain.read, plain.examples, plain.thinking], [["README.md"], [], undefined]);
		const multi = parseRecipe("x", "---\nmodel: a/b\n---\nDo it.\n\n:::user\nq1\n\n:::note is text\n:::\n:::assistant\na1\n:::\n\n:::user\nq2\n:::\n:::assistant\na2\n:::\n");
		assert.deepEqual(multi.examples, [
			{ user: "q1\n\n:::note is text", assistant: "a1" },
			{ user: "q2", assistant: "a2" },
		]);
	});

	test("every mistake is named", () => {
		const cases: [string, string, RegExp][] = [
			["Bad", "---\nmodel: a/b\n---\nx", /the name must match/],
			["x", "Just text", /needs frontmatter/],
			["x", "---\nread: a\n---\nx", /model must be "provider\/id"/],
			["x", "---\nmodel: sonnet\n---\nx", /model must be "provider\/id"/],
			["x", "---\nmodel: a/b\nmodels: c\n---\nx", /unknown frontmatter key models/],
			["x", "---\nmodel: a/b\nthinking: huge\n---\nx", /thinking must be one of off, minimal/],
			["x", "---\nmodel: a/b\ndescription: ''\n---\nx", /description must be a non-empty string/],
			["x", "---\nmodel: a/b\nread: [1]\n---\nx", /read must be a path or glob/],
			["x", "---\nmodel: a/b\nread: /etc/passwd\n---\nx", /stay inside it/],
			["x", "---\nmodel: a/b\nread: ../other/x\n---\nx", /stay inside it/],
			["x", "---\nmodel: a/b\n---\n:::user\nq\n:::\n:::assistant\na\n:::\n", /the body \(role, instructions, process\) is empty/],
			["x", "---\nmodel: a/b\n---\nx\n:::assistant\na\n:::\n", /starting with :::user/],
			["x", "---\nmodel: a/b\n---\nx\n:::user\nq\n:::\n", /ending with :::assistant/],
			["x", "---\nmodel: a/b\n---\nx\n:::user\nq\n", /not closed/],
			["x", "---\nmodel: a/b\n---\nx\n:::user\n\n:::\n:::assistant\na\n:::\n", /an empty :::user block/],
			["x", "---\nmodel: a/b\n---\nx\n:::user\nq\n:::assistant\n", /a :::assistant block inside a :::user block/],
			["x", "---\nmodel: a/b\n---\nx\n:::user\nq\n:::\nstray text\n:::assistant\na\n:::\n", /line 5 of the body: after the first example only/],
		];
		for (const [name, text, problem] of cases) assert.throws(() => parseRecipe(name, text), problem, text);
	});
});

describe("the build", () => {
	test("is deterministic: two builds give the same bytes, ids and prefix key; a changed file keeps the ids before it", async () => {
		writeRecipe();
		const recipe = parseRecipe("review", RECIPE);
		const one = await buildTemplate(recipe, repo, model);
		const two = await buildTemplate(recipe, repo, model);
		assert.equal(one.text, two.text);
		assert.equal(one.prefixKey, two.prefixKey);
		const entries = one.text.trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(entries[0], { type: "session", version: 3, id: "template-review", timestamp: "1970-01-01T00:00:00.000Z", cwd: repo, template: { name: "review" } });
		assert.deepEqual(entries.slice(1).map(roleOf), ["user", "assistant", "toolResult", "toolResult", "toolResult", "assistant", "user", "assistant", "user"]);
		assert.ok(entries.slice(1).every((entry, index) => entry.parentId === (index === 0 ? null : entries[index]!.id) && /^[0-9a-f]{8}$/.test(entry.id) && entry.timestamp === "1970-01-01T00:00:00.000Z"));
		// One assistant message reads every file (glob matches sorted), each result is Pi's read tool's.
		const calls = entries[2].message.content;
		assert.deepEqual(calls.map((call: { name: string; arguments: object }) => [call.name, call.arguments]), [["read", { path: "README.md" }], ["read", { path: "docs/a.md" }], ["read", { path: "docs/b.md" }]]);
		assert.deepEqual(entries.slice(3, 6).map((entry) => [entry.message.toolCallId, entry.message.content[0].text]), calls.map((call: { id: string }, index: number) => [call.id, ["hello\n", "ay\n", "bee\n"][index]]));
		assert.equal(entries[2].message.model, "faux-1");
		assert.deepEqual(entries[2].message.usage.cost.total, 0);
		assert.equal(entries[6].message.content[0].text, "I have read README.md, docs/a.md, docs/b.md.");
		assert.deepEqual([entries[7].message.content, entries[8].message.content[0].text], ["Review docs/a.md.", "docs/a.md is fine."]);
		assert.equal(entries[9].message.content, endMessage("review"));
		assert.equal(one.leafId, entries[9].id);
		assert.deepEqual(one.reads.map((read) => read.path), ["README.md", "docs/a.md", "docs/b.md"]);

		writeFileSync(join(repo, "docs", "b.md"), "bee 2\n");
		const changed = (await buildTemplate(recipe, repo, model)).text.trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(changed.slice(0, 5).map((entry) => entry.id), entries.slice(0, 5).map((entry) => entry.id), "entries before the changed result keep their ids");
		assert.notEqual(changed[5].id, entries[5].id);
	});

	test("a recipe without reads or examples is its instructions alone; a read that matches nothing is an error", async () => {
		const bare = await buildTemplate(parseRecipe("bare", "---\nmodel: faux/faux-1\n---\nJust do it.\n"), repo, model);
		assert.deepEqual(bare.text.trim().split("\n").slice(1).map((line) => roleOf(JSON.parse(line))), ["user"]);
		assert.throws(() => expandReads(repo, ["nope/*.md"]), /read nope\/\*\.md: no file matches it/);
		assert.throws(() => expandReads(repo, ["docs"]), /read docs: no file matches it/, "a directory is no file");
		assert.deepEqual(expandReads(repo, ["docs/b.md", "docs/*.md"]), ["docs/b.md", "docs/a.md"], "a file named twice is read once");
	});
});

describe("the store", () => {
	test("builds on first use, then reuses; stale by recipe, file, glob and model", async () => {
		writeRecipe();
		const first = await useTemplate("review", repo, agentDir, findModel);
		assert.deepEqual(first.rebuilt, ["it was not built yet"]);
		assert.ok(first.file.startsWith(join(agentDir, "templates", "review", "repo-")));
		const meta = JSON.parse(readFileSync(join(first.file, "..", "meta.json"), "utf8")) as TemplateMeta;
		assert.equal(meta.recipe!.hash, parseRecipe("review", RECIPE).hash);
		assert.deepEqual([meta.model, meta.thinking, meta.kind, meta.description], [MODEL, "low", "recipe", "Reviews docs"]);
		assert.deepEqual(meta.reads.map((read) => read.path), ["README.md", "docs/a.md", "docs/b.md"]);
		assert.match(meta.builtAt, /^\d{4}-\d\d-\d\dT/);
		assert.equal(meta.prefixKey, describeBranchPrefix(SessionManager.open(first.file).buildSessionProjection()).points.at(-1)!.key);
		const again = await useTemplate("review", repo, agentDir, findModel);
		assert.equal(again.rebuilt, undefined);
		assert.equal(again.meta.builtAt, meta.builtAt);

		const recipe = parseRecipe("review", RECIPE);
		assert.deepEqual(await staleness(meta, findModel, recipe), []);
		writeFileSync(join(repo, "docs", "a.md"), "ay 2\n");
		assert.deepEqual(await staleness(meta, findModel, recipe), ["docs/a.md changed"]);
		writeFileSync(join(repo, "docs", "a.md"), "ay\n");
		writeFileSync(join(repo, "docs", "c.md"), "see\n");
		assert.deepEqual(await staleness(meta, findModel, recipe), ["its globs match other files now"]);
		rmSync(join(repo, "docs", "c.md"));
		rmSync(join(repo, "README.md"));
		assert.deepEqual(await staleness(meta, findModel, recipe), [`read README.md: no file matches it in ${repo}`]);
		writeFileSync(join(repo, "README.md"), "hello\n");
		assert.deepEqual(await staleness(meta, findModel, parseRecipe("review", `${RECIPE}\n`)), ["its recipe changed"]);
		assert.deepEqual(await staleness(meta, () => undefined, recipe), ["its model faux/faux-1 is gone"]);

		writeRecipe(RECIPE.replace("Work in small steps.", "Work carefully."));
		const rebuilt = await useTemplate("review", repo, agentDir, findModel);
		assert.deepEqual(rebuilt.rebuilt, ["its recipe changed"]);
		assert.match(readFileSync(rebuilt.file, "utf8"), /Work carefully\./);
		await assert.rejects(useTemplate("review", repo, agentDir, () => undefined), /its model faux\/faux-1 is gone|unknown model faux\/faux-1/);
		await assert.rejects(useTemplate("nope", repo, agentDir, findModel), /no template nope \(templates: review\)/);
	});

	test("parallel uses of a stale template rebuild it once and share the build", async () => {
		writeRecipe();
		await useTemplate("review", repo, agentDir, findModel);
		writeFileSync(join(repo, "README.md"), "hello again\n");
		const uses = await Promise.all(Array.from({ length: 6 }, () => useTemplate("review", repo, agentDir, findModel)));
		assert.equal(uses.filter((use) => use.rebuilt).length, 1);
		assert.deepEqual(uses.find((use) => use.rebuilt)!.rebuilt, ["README.md changed"]);
		assert.equal(new Set(uses.map((use) => use.meta.builtAt)).size, 1);
		assert.match(readFileSync(uses[0]!.file, "utf8"), /hello again/);
		assert.deepEqual(readdirSync(join(agentDir, "templates", "review")).filter((name) => name.includes(".lock") || name.includes(".wait-")), [], "no lock left");
	});

	test("across processes too: one rebuild, every process waits for it", async () => {
		writeRecipe();
		const script = `
			import { useTemplate } from ${JSON.stringify(STORE)};
			const model = { provider: "faux", id: "faux-1", api: "faux" };
			const use = await useTemplate("review", ${JSON.stringify(repo)}, ${JSON.stringify(agentDir)}, (spec) => (spec === "faux/faux-1" ? model : undefined));
			console.log(JSON.stringify({ rebuilt: use.rebuilt ?? null, builtAt: use.meta.builtAt }));`;
		const results = await Promise.all(Array.from({ length: 4 }, () => exec(process.execPath, ["--input-type=module", "-e", script], { cwd: repo })));
		const uses = results.map(({ stdout }) => JSON.parse(stdout.trim()) as { rebuilt: string[] | null; builtAt: string });
		assert.equal(uses.filter((use) => use.rebuilt).length, 1, JSON.stringify(uses));
		assert.equal(new Set(uses.map((use) => use.builtAt)).size, 1);
	});

	test("a project recipe replaces a global one of the same name; list shows each with its state", async () => {
		writeRecipe();
		writeRecipe("---\nmodel: faux/gone\n---\nOther.\n", "other");
		assert.equal(findTemplate("review", join(repo, "docs"), agentDir)?.kind, "recipe", "found from a subdirectory");
		assert.equal(findTemplate("nope", repo, agentDir), undefined);
		const listed = await describeTemplates(repo, agentDir, findModel);
		assert.deepEqual(listed, ["other (project, faux/gone): stale: not built yet", "review (project, faux/faux-1): stale: not built yet — Reviews docs"]);
		await useTemplate("review", repo, agentDir, findModel);
		assert.match((await describeTemplates(repo, agentDir, findModel))[1]!, /^review \(project, faux\/faux-1\): built \d{4}-/);
	});
});

/** A session with a prompt, a read of README.md and an answer, as a user's session would be. */
function workedSession(): SessionManager {
	const manager = SessionManager.create(repo, join(dir, "sessions"));
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({ role: "assistant", content, api: faux.api, provider: "faux", model: "faux-1", usage, stopReason, timestamp: 1 });
	manager.appendMessage({ role: "system", content: "", sections: { preamble: "you are pi" }, timestamp: 1 });
	manager.appendMessage({ role: "user", content: "Learn the README.", timestamp: 1 });
	manager.appendMessage(assistant([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "README.md" } }], "toolUse"));
	manager.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "hello" }], isError: false, timestamp: 1 });
	manager.appendMessage(assistant([{ type: "text", text: "It says hello." }], "stop"));
	return manager;
}

describe("capture", () => {
	test("a session's context without its prompt, ids kept, ending in the closing message; its reads are tracked and a change warns", async () => {
		const source = workedSession();
		const meta = await captureSession("learned", agentDir, { cwd: repo, file: source.getSessionFile(), model: MODEL, thinking: "high", projection: source.buildSessionProjection() });
		assert.deepEqual([meta.kind, meta.model, meta.thinking, meta.capturedFrom], ["captured", MODEL, "high", source.getSessionFile()]);
		assert.deepEqual(meta.reads.map((read) => read.path), ["README.md"]);
		const file = sessionPath(join(agentDir, "templates", "learned", "captured"));
		const entries = lines(file);
		assert.deepEqual(entries[0].template, { name: "learned" });
		assert.deepEqual(entries.slice(1).map(roleOf), ["user", "assistant", "toolResult", "assistant", "user"]);
		const sourceIds = source.getBranch().filter((entry) => entry.type === "message" && entry.message.role !== "system").map((entry) => entry.id);
		assert.deepEqual(entries.slice(1, 5).map((entry) => entry.id), sourceIds);
		assert.equal(entries[1].parentId, null, "the prompt entry is gone, its child is the root");
		assert.equal(entries[5].message.content, endMessage("learned"));

		const fresh = await useTemplate("learned", repo, agentDir, findModel);
		assert.equal(fresh.warning, undefined);
		assert.equal(fresh.file, file);
		writeFileSync(join(repo, "README.md"), "changed\n");
		const stale = await useTemplate("learned", repo, agentDir, findModel);
		assert.match(stale.warning!, /captured template learned is stale \(README\.md changed\); it cannot be rebuilt, so it is used as captured/);
		assert.equal(stale.meta.builtAt, meta.builtAt, "not rebuilt");
		await assert.rejects(useTemplate("learned", repo, agentDir, () => undefined), /its model faux\/faux-1 is gone, and a captured template cannot be rebuilt/);
		await assert.rejects(captureSession("learned", agentDir, { cwd: repo, model: MODEL, projection: { entries: [] } }), /no conversation to capture/);
	});
});

describe("prefix keys", () => {
	test("forks with different prompts share the template's id chain (the meta's prefix key) under different prompt hashes", async () => {
		writeRecipe();
		const { file, meta } = await useTemplate("review", repo, agentDir, findModel);
		const forkWith = (prompt: string) => {
			const fork = SessionManager.forkFrom(file, repo, join(dir, "sessions"));
			fork.appendMessage({ role: "system", content: "", sections: { preamble: prompt }, timestamp: 2 });
			fork.appendMessage({ role: "user", content: "task", timestamp: 2 });
			return describeBranchPrefix(fork.buildSessionProjection());
		};
		const [release1, release1Again, release2] = [forkWith("prompt of release 1"), forkWith("prompt of release 1"), forkWith("prompt of release 2")];
		const at = (prefix: typeof release1) => prefix.points.find((point) => point.entryId === meta.leafId)!.key;
		assert.equal(at(release1), meta.prefixKey);
		assert.equal(at(release1Again), meta.prefixKey);
		assert.equal(at(release2), meta.prefixKey);
		assert.equal(release1Again.promptHash, release1.promptHash);
		assert.notEqual(release2.promptHash, release1.promptHash, "a release's prompt names another cache entry: its first use writes it");
	});
});

describe("/template", () => {
	test("list, save and starting a session from a template on its model", async () => {
		writeRecipe();
		const notes: string[] = [];
		const switched: string[] = [];
		const ui = { notify: (text: string) => void notes.push(text) } as unknown as ExtensionUIContext;
		const manager = workedSession();
		const settingsManager = SettingsManager.inMemory({});
		const resourceLoader = new DefaultResourceLoader({ cwd: repo, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, extensionFactories: [(pi: ExtensionAPI) => template(pi, { agentDir })] });
		await resourceLoader.reload();
		const { session } = await createAgentSession({ cwd: repo, agentDir, model, modelRuntime: runtime, resourceLoader, sessionManager: manager, settingsManager });
		// SAFETY: the command only calls switchSession; the other actions are not reached.
		const commandContextActions = {
			waitForIdle: async () => undefined,
			switchSession: async (path: string, options?: { withSession?: (ctx: { ui: ExtensionUIContext }) => Promise<void> }) => {
				switched.push(path);
				await options?.withSession?.({ ui });
				return { cancelled: false };
			},
		} as unknown as ExtensionCommandContextActions;
		await session.bindExtensions({ uiContext: ui, commandContextActions });
		try {
			await session.prompt("/template list");
			assert.match(notes.at(-1)!, /^review \(project, faux\/faux-1\): stale: not built yet — Reviews docs$/);
			await session.prompt("/template save learned");
			assert.match(notes.at(-1)!, /^Saved template learned \(1 read calls tracked\)/);
			await session.prompt("/template review");
			assert.equal(switched.length, 1);
			const fork = SessionManager.open(switched[0]!);
			assert.equal(fork.getHeader()?.fork?.template?.name, "review");
			assert.equal(fork.getHeader()?.parentSession, sessionPath(findTemplate("review", repo, agentDir)!.dir));
			assert.deepEqual(fork.getBranch().slice(-2).map((entry) => entry.type), ["model_change", "thinking_level_change"]);
			assert.match(notes.at(-1)!, /^Session from template review \(built [^,]+, rebuilt: it was not built yet\) on faux\/faux-1\.$/);
			await session.prompt("/template");
			assert.match(notes.at(-1)!, /^\/template <name> starts a session/);
			await session.prompt("/template nope");
			assert.match(notes.at(-1)!, /^no template nope \(templates: learned, review\)$/);
		} finally {
			session.dispose();
		}
	});
});

/**
 * Anthropic's prompt cache across sessions: a request writes an entry at its last message and reads
 * the longest live entry among the 20 positions ending there (one position per message), as in
 * vendor/pi's shared-prefix tests.
 */
class SimulatedCache {
	private readonly entries = new Map<string, number>();
	readonly requests: { label: string; cacheRead: number; cacheWrite: number; maxTokens?: number; roles: string[] }[] = [];

	attach(session: AgentSession, label: string): void {
		const inner = session.agent.streamFunction;
		const stream: StreamFn = async (streamModel, context, options) => {
			const source = await inner(streamModel, context, options);
			const out = createAssistantMessageEventStream();
			void (async () => {
				for await (const event of source) {
					if (event.type === "done") this.apply(event.message, context.messages, label, options?.maxTokens);
					out.push(event);
				}
			})();
			return out;
		};
		session.agent.streamFunction = stream;
	}

	private apply(message: AssistantMessage, messages: Message[], label: string, maxTokens?: number): void {
		const now = Date.now();
		const wire = messages.map((m) => ({ role: m.role, content: m.content, ...(m.role === "system" ? { sections: m.sections } : {}) }));
		const start = wire[0]?.role === "system" ? 1 : 0;
		const prefixes = wire.slice(start).map((_, index) => {
			const text = JSON.stringify(wire.slice(0, start + index + 1));
			return { key: createHash("sha256").update(text).digest("hex"), tokens: Math.ceil(text.length / 4) };
		});
		const last = prefixes.at(-1)!;
		let read: (typeof prefixes)[number] | undefined;
		for (let index = prefixes.length - 1; index >= Math.max(0, prefixes.length - 20); index--) {
			if ((this.entries.get(prefixes[index]!.key) ?? 0) > now) {
				read = prefixes[index];
				break;
			}
		}
		if (read) this.entries.set(read.key, now + 3_600_000);
		this.entries.set(last.key, now + 3_600_000);
		const cacheRead = read?.tokens ?? 0;
		message.usage = { input: 0, output: 1, cacheRead, cacheWrite: last.tokens - cacheRead, totalTokens: last.tokens + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		this.requests.push({ label, cacheRead, cacheWrite: last.tokens - cacheRead, ...(maxTokens !== undefined ? { maxTokens } : {}), roles: messages.map((m) => m.role) });
	}
}

describe("real Pi sessions forked from a template", () => {
	const sessions: AgentSession[] = [];
	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
	});

	/** A fork of the template `use` returns, as t3 or delegate() makes it, answering `ok`. */
	async function forkAndRun(sim: SimulatedCache, shared: SharedPrefixCache, label: string, task: string) {
		const use = await useTemplate("review", repo, agentDir, findModel);
		const settingsManager = SettingsManager.inMemory({ cacheRetention: "long" });
		const resourceLoader = new DefaultResourceLoader({ cwd: repo, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true });
		await resourceLoader.reload();
		const sessionManager = SessionManager.forkFrom(use.file, repo, join(dir, "sessions"));
		const { session } = await createAgentSession({ cwd: repo, agentDir, model, modelRuntime: runtime, resourceLoader, sessionManager, settingsManager, sharedPrefixCache: shared });
		sessions.push(session);
		sim.attach(session, label);
		await session.prompt(task);
		return { session, use };
	}

	test("a fork carries the template's history; the next fork primes the template prefix and reads it; a later one reads it without a prime", async () => {
		writeFileSync(join(repo, "README.md"), BIG);
		writeRecipe();
		faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage("ok")));
		const sim = new SimulatedCache();
		const shared = SharedPrefixCache.forAgentDir(agentDir);

		const first = await forkAndRun(sim, shared, "first", "Review README.md");
		const context = first.session.sessionManager.buildSessionProjection().messages;
		assert.deepEqual(context.map((m) => m.role), ["system", "user", "assistant", "toolResult", "toolResult", "toolResult", "assistant", "user", "assistant", "user", "user", "assistant"], "the prompt leads, then the template, the task and the answer");
		assert.equal((context[3] as { content: { text: string }[] }).content[0]!.text, BIG);
		// Nobody used the template before: no prime, the fork's own request writes everything.
		assert.deepEqual(sim.requests.map((r) => [r.label, r.maxTokens ?? null, r.cacheRead]), [["first", null, 0]]);

		const second = await forkAndRun(sim, shared, "second", "Review docs/a.md");
		const prime = sim.requests.find((r) => r.label === "second" && r.maxTokens === 1)!;
		assert.ok(prime, "the second use primes: the first made another use likely within the hour");
		assert.deepEqual(prime.roles, ["system", "user", "assistant", "toolResult", "toolResult", "toolResult", "assistant", "user", "assistant", "user"], "the prompt and the whole template, ending in its closing user message");
		assert.equal(prime.cacheRead, 0);
		const secondAnswer = sim.requests.find((r) => r.label === "second" && r.maxTokens === undefined)!;
		assert.equal(secondAnswer.cacheRead, prime.cacheWrite, "the second fork reads the primed template prefix");
		assert.equal(second.session.sessionManager.getBranch().filter((entry) => entry.type === "usage" && entry.kind === "cache_prime").length, 1);

		await forkAndRun(sim, shared, "third", "Review docs/b.md");
		const third = sim.requests.filter((r) => r.label === "third");
		assert.deepEqual(third.map((r) => r.maxTokens ?? null), [null], "alive: no prime");
		assert.equal(third[0]!.cacheRead, prime.cacheWrite);

		// The registry names the template prefix like any other and holds its reads.
		const point = describeBranchPrefix(second.session.sessionManager.buildSessionProjection()).points.find((p) => p.entryId === first.use.meta.leafId)!;
		assert.equal(point.key, first.use.meta.prefixKey);
		const promptHash = describeBranchPrefix(second.session.sessionManager.buildSessionProjection()).promptHash;
		const record = shared.registry.get({ provider: "faux", id: "faux-1" }, promptHash, point)!;
		assert.equal(record.reads!.length, 3);
		assert.ok(record.expiresAt > Date.now() + 3_000_000, "alive for the hour");
	});

	test("a stale template rebuilds once for parallel uses; the forks see the new files", async () => {
		writeFileSync(join(repo, "README.md"), "version 1\n");
		writeRecipe();
		faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage("ok")));
		const sim = new SimulatedCache();
		const shared = SharedPrefixCache.forAgentDir(agentDir);
		const before = await forkAndRun(sim, shared, "before", "task");
		writeFileSync(join(repo, "README.md"), "version 2\n");
		const forks = await Promise.all(["a", "b", "c"].map((label) => forkAndRun(sim, shared, label, `task ${label}`)));
		assert.equal(forks.filter((fork) => fork.use.rebuilt).length, 1);
		assert.deepEqual(forks.find((fork) => fork.use.rebuilt)!.use.rebuilt, ["README.md changed"]);
		assert.notEqual(forks[0]!.use.meta.prefixKey, before.use.meta.prefixKey);
		for (const fork of forks) {
			const texts = fork.session.sessionManager.buildSessionProjection().messages.flatMap((m) => (m.role === "toolResult" ? [(m.content[0] as { text: string }).text] : []));
			assert.equal(texts[0], "version 2\n");
		}
		assert.ok(existsSync(sessionPath(findTemplate("review", repo, agentDir)!.dir)));
	});
});
