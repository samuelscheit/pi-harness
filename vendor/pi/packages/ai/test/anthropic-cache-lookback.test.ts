import { describe, expect, it } from "vitest";
import { type AnthropicOptions, stream } from "../src/api/anthropic-messages.ts";
import type { AssistantMessage, Message, Model, SystemMessage, Tool, ToolCall, ToolResultMessage } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface WireBlock {
	type: string;
	cache_control?: unknown;
	tool_use_id?: string;
	text?: string;
}

interface WirePayload {
	system?: WireBlock[];
	tools?: Array<{ name: string; cache_control?: unknown }>;
	messages: Array<{ role: string; content: string | WireBlock[] }>;
}

const model: Model<"anthropic-messages"> = {
	id: "claude-opus-4-5",
	name: "Claude Opus 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:9",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 32000,
	compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
};

const tool = (name: string): Tool => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} } as Tool["parameters"] });

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function reply(calls: number, prefix: string): AssistantMessage {
	const content: ToolCall[] = Array.from({ length: calls }, (_, i) => ({ type: "toolCall", id: `${prefix}${i}`, name: "bash", arguments: {} }));
	return { role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: model.id, usage, stopReason: "toolUse", timestamp: 1 };
}

const result = (id: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "bash",
	content: [{ type: "text", text: `out ${id}` }],
	isError: false,
	timestamp: 2,
});

const results = (calls: number, prefix: string) => Array.from({ length: calls }, (_, i) => result(`${prefix}${i}`));

async function payloadFor(messages: Message[], options: Partial<AnthropicOptions> = {}): Promise<WirePayload> {
	let payload: WirePayload | undefined;
	const response = stream(model, normalizeContext({ systemPrompt: "You are a test.", tools: [tool("bash")], messages }), {
		apiKey: "test-key",
		...options,
		onPayload: (value) => {
			payload = value as WirePayload;
			throw new Error("payload captured");
		},
	});
	await response.result();
	if (!payload) throw new Error("Expected payload capture");
	return payload;
}

const blocks = (payload: WirePayload) =>
	payload.messages.flatMap((message) => (typeof message.content === "string" ? [] : message.content.map((block) => ({ role: message.role, block }))));

const markers = (payload: WirePayload) => blocks(payload).filter(({ block }) => block.cache_control);

const breakpoints = (payload: WirePayload) =>
	(payload.system ?? []).filter((b) => b.cache_control).length +
	(payload.tools ?? []).filter((t) => t.cache_control).length +
	markers(payload).length;

const toolSearch = (count: number): SystemMessage => ({
	role: "system",
	content: "",
	toolsAdded: Array.from({ length: count }, (_, i) => tool(`station_${i}`)),
	timestamp: 3,
});

describe("Anthropic cache lookback", () => {
	const user = { role: "user" as const, content: "start", timestamp: 0 };

	it("bridges a turn that adds more blocks than the lookback, right after the reply", async () => {
		const payload = await payloadFor([user, reply(1, "a"), ...results(1, "a"), toolSearch(25)]);
		const marked = markers(payload);
		expect(marked).toHaveLength(2);
		// The bridge: the first block after the reply, the tool result.
		expect(marked[0]!.block).toMatchObject({ type: "tool_result", tool_use_id: "a0" });
		// The newest block keeps its marker.
		expect(marked[1]!.block.type).toBe("tool_addition");
		expect(breakpoints(payload)).toBeLessThanOrEqual(4);
	});

	it("leaves a short turn alone", async () => {
		const payload = await payloadFor([user, reply(2, "a"), ...results(2, "a"), toolSearch(3)]);
		expect(markers(payload)).toHaveLength(1);
	});

	it("puts the bridge before a reply that is itself longer than the lookback", async () => {
		const payload = await payloadFor([user, reply(25, "a"), ...results(25, "a")]);
		const marked = markers(payload);
		expect(marked).toHaveLength(2);
		// The previous request ended with the user prompt, now sent as a text block with the marker.
		expect(marked[0]!).toMatchObject({ role: "user", block: { type: "text", text: "start" } });
		expect(marked[1]!.block).toMatchObject({ type: "tool_result", tool_use_id: "a24" });
	});

	it("bridges across earlier turns: only the newest reply counts", async () => {
		const payload = await payloadFor([user, reply(1, "a"), ...results(1, "a"), reply(1, "b"), ...results(1, "b"), toolSearch(30)]);
		expect(markers(payload)[0]!.block).toMatchObject({ type: "tool_result", tool_use_id: "b0" });
	});

	it("never exceeds the four breakpoints Anthropic allows", async () => {
		// OAuth requests already mark the identity block, the system prompt, the tools and the newest message.
		const payload = await payloadFor([user, reply(1, "a"), ...results(1, "a"), toolSearch(25)], { apiKey: "sk-ant-oat-test" });
		expect(breakpoints(payload)).toBe(4);
		expect(markers(payload)).toHaveLength(1);
	});

	it("adds nothing when caching is off", async () => {
		const payload = await payloadFor([user, reply(1, "a"), ...results(1, "a"), toolSearch(25)], { cacheRetention: "none" });
		expect(markers(payload)).toHaveLength(0);
	});
});
