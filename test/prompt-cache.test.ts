// A prompt edit mid-session must not cost the prompt cache.
//
// Pi re-reads prompt/base.md, AGENTS.md and the skills list before every run and sends a changed
// section as a system message appended to the conversation. That only keeps the cache when the
// model accepts system messages mid-conversation (`compat.supportsMidConvoSystemMessages`);
// otherwise Pi folds every update into the leading system prompt and the provider rewrites the
// whole conversation. This test builds the real request payloads, for every model the installed
// ~/.pi/agent/models.json resolves the way sessions do, and requires each request to be an
// unchanged prefix of the request after the edit.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type Api, InMemoryCredentialStore, type Message, type Model, type SystemMessage, type Tool } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

const MODELS_JSON = join(getAgentDir(), "models.json");

const tool = (name: string): Tool => ({
	name,
	description: `${name} tool`,
	parameters: { type: "object", properties: { arg: { type: "string" } } } as unknown as Tool["parameters"],
});

/** Section texts long enough that a rewrite of any of them is a visible prompt change. */
const SECTIONS = {
	preamble: "You are a coding agent.\n\n# Autonomy\n\nDo the work.",
	project_context: "<project_instructions>Working rules.</project_instructions>",
	skills: "<available_skills><skill><name>tdd</name></skill></available_skills>",
	cwd: "/work/project",
};

const leading: SystemMessage = { role: "system", content: "", sections: SECTIONS, toolsAdded: [tool("bash"), tool("read")], timestamp: 0 };
const update = (sections: SystemMessage["sections"]): SystemMessage => ({ role: "system", content: "", sections, timestamp: 5 });

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });

function assistant(model: Model<Api>, callId?: string): Message {
	return {
		role: "assistant",
		content: callId ? [{ type: "toolCall", id: callId, name: "bash", arguments: { arg: "ls" } }] : [{ type: "text", text: "done" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: callId ? "toolUse" : "stop",
		timestamp: 2,
	} as Message;
}

const toolResult = (callId: string): Message => ({
	role: "toolResult",
	toolCallId: callId,
	toolName: "bash",
	content: [{ type: "text", text: `output of ${callId}` }],
	isError: false,
	timestamp: 3,
});

/** The request body Pi would send, captured before any network call. */
async function payload(registry: ModelRegistry, model: Model<Api>, messages: Message[]): Promise<Record<string, unknown>> {
	let captured: Record<string, unknown> | undefined;
	const response = registry.streamSimple(model, { messages: [leading, ...messages] } as never, {
		onPayload: (body) => {
			captured = body as Record<string, unknown>;
			throw new Error("payload captured");
		},
	});
	for await (const _ of response) {
		// Drain until the capture aborts the request.
	}
	if (!captured) throw new Error(`no payload for ${model.provider}/${model.id}`);
	return captured;
}

/** Cache markers move to the newest block each request and are not part of the cached content. */
function withoutCacheMarkers(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutCacheMarkers);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "cache_control")
			.map(([key, inner]) => [key, withoutCacheMarkers(inner)]),
	);
}

/**
 * The request content in the order a prefix cache hashes it: tools, then the system prompt, then
 * one entry per message block (Anthropic) or input item (OpenAI Responses). Blocks are flattened
 * so a block appended to the last message still extends the prefix.
 */
function cachedSequence(body: Record<string, unknown>): string[] {
	const clean = withoutCacheMarkers(body) as Record<string, unknown>;
	const head = [JSON.stringify(clean.tools ?? []), JSON.stringify(clean.system ?? clean.instructions ?? null)];
	if (Array.isArray(clean.messages)) {
		return [
			...head,
			...(clean.messages as Array<{ role: string; content: unknown }>).flatMap((message) =>
				typeof message.content === "string"
					? [JSON.stringify([message.role, message.content])]
					: (message.content as unknown[]).map((block) => JSON.stringify([message.role, block])),
			),
		];
	}
	return [...head, ...(clean.input as unknown[]).map((item) => JSON.stringify(item))];
}

/** Index of the first entry in `before` that `after` does not repeat, or -1 when `before` is a prefix. */
function divergence(before: string[], after: string[]): number {
	return before.findIndex((entry, i) => after[i] !== entry);
}

/** Conversations whose last request is followed by a prompt edit, as Pi records them. */
function scenarios(model: Model<Api>): Array<{ name: string; before: Message[]; after: Message[] }> {
	const turn = [user("fix the bug"), assistant(model, "call_1"), toolResult("call_1")];
	const edited = update({ preamble: `${SECTIONS.preamble}\n\nOne more rule.` });
	return [
		{
			// The common case: base.md or AGENTS.md changes between two user turns.
			name: "preamble edited before the next user turn",
			before: [...turn, assistant(model)],
			after: [...turn, assistant(model), edited, user("next task")],
		},
		{
			// An extension changes the prompt while tool calls are still running.
			name: "section edited between a tool result and the next request",
			before: turn,
			after: [...turn, edited],
		},
		{
			name: "several sections edited and one removed at once",
			before: [...turn, assistant(model)],
			after: [
				...turn,
				assistant(model),
				update({ project_context: `${SECTIONS.project_context} More rules.`, skills: `${SECTIONS.skills} `, cwd: null }),
				user("next task"),
			],
		},
		{
			name: "second edit after an earlier one",
			before: [...turn, assistant(model), edited, user("next task"), assistant(model)],
			after: [...turn, assistant(model), edited, user("next task"), assistant(model), update({ preamble: SECTIONS.preamble }), user("again")],
		},
	];
}

/** Whether Pi keeps system messages in place for this model instead of folding them into the prompt. */
const midConversationSystem = (model: Model<Api>) =>
	(model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages ?? false;

async function installedModels(): Promise<{ registry: ModelRegistry; models: Model<Api>[] }> {
	const credentials = new InMemoryCredentialStore();
	const runtime = await ModelRuntime.create({ credentials, modelsPath: MODELS_JSON, allowModelNetwork: false });
	const registry = new ModelRegistry(runtime);
	const configured = new Set(Object.keys((await import(MODELS_JSON, { with: { type: "json" } })).default.providers ?? {}));
	const models = registry.getAll().filter((model) => configured.has(model.provider));
	for (const provider of configured) await credentials.modify(provider, async () => ({ type: "api_key", key: "test-key" }));
	return { registry, models };
}

describe("prompt edits keep the prompt cache", { skip: !existsSync(MODELS_JSON) && `no ${MODELS_JSON}; run the installer` }, async () => {
	const { registry, models } = existsSync(MODELS_JSON) ? await installedModels() : { registry: undefined, models: [] };

	test("the harness configures models", () => {
		assert.ok(models.length > 0, `no models from ${MODELS_JSON}`);
	});

	for (const model of models) {
		// Anthropic's API takes system messages mid-conversation only from newer models (Pi's catalog
		// flags them); on older ones every prompt edit rewrites the cache, whatever the harness does.
		const unsupported = model.api === "anthropic-messages" && !midConversationSystem(model);
		test(`${model.provider}/${model.id}`, { skip: unsupported && "the API rejects mid-conversation system messages" }, async () => {
			for (const { name, before, after } of scenarios(model)) {
				const previous = cachedSequence(await payload(registry!, model, before));
				const next = cachedSequence(await payload(registry!, model, after));
				const at = divergence(previous, next);
				assert.equal(
					at,
					-1,
					`${name}: the edit rewrites cached content at ${["tools", "system prompt"][at] ?? `block ${at - 2}`}` +
						` (supportsMidConvoSystemMessages: ${midConversationSystem(model)})\n` +
						`before: ${previous[at]?.slice(0, 300)}\nafter:  ${next[at]?.slice(0, 300)}`,
				);
				assert.ok(next.length > previous.length, `${name}: the edit is not in the request`);
			}
		});
	}
});
