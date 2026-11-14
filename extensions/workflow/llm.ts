// llm(): one model request without the session's tools, for the judgments inside a workflow
// (classify, extract, decide, summarize).
//
// With a schema the answer is structured: the request offers one tool, `respond`, whose parameters
// are the schema, and the arguments of its call are the answer, validated (and coerced) like any
// tool call. An answer without that call or with invalid arguments is sent back with the problem,
// up to MAX_ATTEMPTS requests. Pi's providers have no portable forced tool choice, so the system
// prompt asks for the call.
//
// Results are cached for the session by their exact input (model, system, prompt, schema,
// thinking): rerunning an edited script repeats only the calls that changed.
//
// The model is checked against its endpoint's listing before the first request (models.ts). A
// failed request (an error stop reason: a 404 for an unknown model, an auth error) fails the call
// at once; only invalid structured answers are asked again.

import { createHash } from "node:crypto";
import { type AssistantMessage, type Message, type Tool, type Usage, validateToolArguments } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CACHE_RETENTION, checkServed, resolveModel, type Thinking, thinkingOption } from "./models.ts";

export const DEFAULT_LLM_MODEL = "anthropic/claude-haiku-5-5";
const MAX_ATTEMPTS = 3;
const RESPOND = "respond";

export interface LlmOptions {
	model?: string;
	system?: string;
	schema?: Record<string, unknown>;
	thinking?: Thinking;
	cache?: boolean;
}

export interface LlmEnv {
	runtime: ModelRuntime;
	/** The session's results by input digest. */
	cache: Map<string, unknown>;
	signal: AbortSignal;
	/** Every response's usage, as it arrives. */
	spend: (usage: Usage) => void;
	/** Each call, and whether the cache answered it. */
	counted: (cached: boolean) => void;
}

/** The options a script passed, checked; throws with what is wrong. */
export function llmOptions(prompt: unknown, raw: unknown): LlmOptions & { prompt: string } {
	if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("llm(prompt, options?): prompt must be a non-empty string");
	if (raw === undefined || raw === null) return { prompt };
	if (typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("llm(prompt, options?): options must be an object");
	const options = raw as Record<string, unknown>;
	const known = new Set(["model", "system", "schema", "thinking", "cache"]);
	const unknown = Object.keys(options).find((key) => !known.has(key));
	if (unknown) throw new TypeError(`llm(): unknown option ${unknown} (use ${[...known].join(", ")})`);
	for (const key of ["model", "system"] as const) {
		if (options[key] !== undefined && typeof options[key] !== "string") throw new TypeError(`llm(): ${key} must be a string`);
	}
	const schema = options.schema;
	if (schema !== undefined && (typeof schema !== "object" || schema === null || (schema as { type?: unknown }).type !== "object")) {
		throw new TypeError('llm(): schema must be a JSON Schema of an object ({ type: "object", properties: … })');
	}
	if (options.cache !== undefined && typeof options.cache !== "boolean") throw new TypeError("llm(): cache must be a boolean");
	return {
		prompt,
		model: options.model as string | undefined,
		system: options.system as string | undefined,
		schema: schema as Record<string, unknown> | undefined,
		thinking: options.thinking === undefined ? undefined : thinkingOption(options.thinking, "llm()"),
		cache: options.cache as boolean | undefined,
	};
}

const textOf = (message: AssistantMessage) =>
	message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");

/** Run one llm() call. */
export async function llm(promptArg: unknown, optionsArg: unknown, env: LlmEnv): Promise<unknown> {
	const { prompt, model: spec = DEFAULT_LLM_MODEL, system, schema, thinking, cache = true } = llmOptions(promptArg, optionsArg);
	const model = resolveModel(env.runtime, spec);
	const key = createHash("sha256")
		.update(JSON.stringify([model.provider, model.id, system ?? "", prompt, schema ?? null, thinking ?? "off"]))
		.digest("hex");
	if (cache && env.cache.has(key)) {
		env.counted(true);
		return structuredClone(env.cache.get(key));
	}
	env.counted(false);
	// A model its endpoint does not serve fails here, without a request; one that fails anyway (a 404) is not retried below.
	await checkServed(env.runtime, model, env.signal);

	const tool: Tool | undefined = schema && { name: RESPOND, description: "Give your answer as this tool's arguments.", parameters: schema };
	const instruction = tool ? `Answer only by calling the ${RESPOND} tool once; its arguments are your answer.` : undefined;
	const systemPrompt = [system?.trim(), instruction].filter(Boolean).join("\n\n") || undefined;
	const messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
	let problem = "";
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const message = await env.runtime.completeSimple(
			model,
			{ systemPrompt, messages, tools: tool ? [tool] : undefined },
			{ signal: env.signal, cacheRetention: CACHE_RETENTION, ...(thinking && thinking !== "off" ? { reasoning: thinking } : {}) },
		);
		env.spend(message.usage);
		if (message.stopReason === "aborted" || env.signal.aborted) throw env.signal.reason ?? new Error("llm(): aborted");
		if (message.stopReason === "error") throw new Error(`llm(): ${message.errorMessage ?? "the request failed"}`);
		let value: unknown;
		if (!tool) {
			if (message.stopReason === "length") throw new Error(`llm(): the answer was cut off at the model's output limit`);
			value = textOf(message);
		} else {
			const calls = message.content.filter((block) => block.type === "toolCall");
			const call = calls.find((block) => block.name === RESPOND);
			messages.push(message);
			try {
				if (!call) throw new Error(`no ${RESPOND} tool call`);
				value = validateToolArguments(tool, call);
			} catch (error) {
				problem = error instanceof Error ? error.message : String(error);
				// Every tool call needs its result before the next user turn.
				for (const block of calls) {
					messages.push({
						role: "toolResult",
						toolCallId: block.id,
						toolName: block.name,
						content: [{ type: "text", text: block === call ? `${problem}\nCall ${RESPOND} again with valid arguments.` : `Unknown tool; call ${RESPOND}.` }],
						isError: true,
						timestamp: Date.now(),
					});
				}
				if (!call) messages.push({ role: "user", content: `Answer by calling the ${RESPOND} tool; its arguments must match its schema.`, timestamp: Date.now() });
				continue;
			}
		}
		env.cache.set(key, structuredClone(value));
		return value;
	}
	throw new Error(`llm(): no valid ${RESPOND} call after ${MAX_ATTEMPTS} attempts; last problem: ${problem}`);
}
