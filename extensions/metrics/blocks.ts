// Split the context of one model request into the blocks its prompt is made of, in the order
// the provider reads them: tool definitions, the system prompt sections, then the messages (with
// mid-conversation system updates in place).
//
// Ported from the gateway's usage_insights/blocks.py, but reading Pi's own messages instead of a
// provider payload, so one parser covers every API and every past session can be re-analysed.
// Prompt caching is a prefix, so this order decides which block was billed as a cache read, a
// cache write or plain input. Token counts are estimates; attribution scales them to the
// provider's real count.

import { createHash } from "node:crypto";
import { renderSystemMessageUpdate } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
// Loads the coding-agent message roles (bashExecution, custom, summaries) into AgentMessage.
import type {} from "@earendil-works/pi-coding-agent";

const CHARS_PER_TOKEN = 4;
// Anthropic downsizes images to fit 1568 px on the long edge and ~1.15 MP, then bills w*h/750.
const IMAGE_MAX_EDGE = 1568;
const IMAGE_MAX_PIXELS = 1_150_000;
const IMAGE_FALLBACK_TOKENS = 1_600;
const SUMMARY_KEYS = ["command", "path", "file_path", "pattern", "url", "query", "prompt", "task", "description", "name"];

export interface Block {
	category: string;
	tokens: number;
	digest: string;
	/** Set on tool results, to follow one result across the requests that carry it. */
	toolCallId?: string;
	/** After the conversation's last assistant message: what triggered this request. */
	isNew: boolean;
}

export interface ToolCallInfo {
	name: string;
	summary: string;
}

/** The prompt sections in effect and the tools the session started with, as content hashes. */
export interface HarnessState {
	sections: Record<string, string>;
	tools: Record<string, string>;
}

export interface Prompt {
	blocks: Block[];
	messageCount: number;
	/** Blocks before the messages: [tool definitions, + system prompt]. */
	sectionEnds: [number, number];
	toolCalls: Map<string, ToolCallInfo>;
	state: HarnessState;
	/** Text of every section and tool definition in `state`, by hash. */
	texts: Map<string, { kind: "section" | "tool"; name: string; text: string }>;
}

export const digest = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);

const textTokens = (text: string): number => text.length / CHARS_PER_TOKEN;

/** Width and height from a PNG, GIF, WebP or JPEG header. */
export function imageDimensions(data: Buffer): [number, number] | undefined {
	if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && data.length >= 24) {
		return [data.readUInt32BE(16), data.readUInt32BE(20)];
	}
	const head6 = data.subarray(0, 6).toString("latin1");
	if ((head6 === "GIF87a" || head6 === "GIF89a") && data.length >= 10) return [data.readUInt16LE(6), data.readUInt16LE(8)];
	if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") {
		const chunk = data.subarray(12, 16).toString("latin1");
		if (chunk === "VP8X" && data.length >= 30) return [1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3)];
		if (chunk === "VP8 " && data.length >= 30) return [data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff];
		if (chunk === "VP8L" && data.length >= 25) {
			const bits = data.readUInt32LE(21);
			return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
		}
	}
	if (data[0] === 0xff && data[1] === 0xd8) {
		let i = 2;
		while (i + 9 < data.length) {
			if (data[i] !== 0xff) {
				i += 1;
				continue;
			}
			const marker = data[i + 1]!;
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return [data.readUInt16BE(i + 7), data.readUInt16BE(i + 5)];
			}
			i += 2 + data.readUInt16BE(i + 2);
		}
	}
	return undefined;
}

/** Tokens Anthropic bills for an image, from its dimensions after downsizing. */
export function imageTokens(base64: string): number {
	const dims = imageDimensions(Buffer.from(base64.slice(0, 65536), "base64"));
	if (!dims || !dims[0] || !dims[1]) return IMAGE_FALLBACK_TOKENS;
	const [w, h] = dims;
	const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(w, h), Math.sqrt(IMAGE_MAX_PIXELS / (w * h)));
	return Math.max(1, (w * scale * (h * scale)) / 750);
}

export function summarizeToolInput(input: unknown): string {
	if (typeof input === "string") return input.slice(0, 200);
	if (input && typeof input === "object") {
		const record = input as Record<string, unknown>;
		for (const key of SUMMARY_KEYS) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
		}
		return Object.keys(record).slice(0, 6).join(", ").slice(0, 200);
	}
	return "";
}

type Part = { type: string; text?: string; data?: string };

function contentParts(content: unknown): Part[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as Part[]) : [];
}

interface ToolDeclaration {
	name: string;
	description?: string;
	parameters?: unknown;
}

const toolText = (tool: ToolDeclaration): string =>
	JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.parameters });

type RawBlock = Omit<Block, "isNew">;

/** Blocks of one message, without the "new" flag. Cached per message object across requests. */
const messageBlocks = new WeakMap<object, RawBlock[]>();

function contentBlocks(content: unknown, category: string, toolCallId?: string): RawBlock[] {
	const blocks: RawBlock[] = [];
	let text = "";
	let tokens = 0;
	for (const part of contentParts(content)) {
		if (part.type === "image") blocks.push({ category: "image", tokens: imageTokens(part.data ?? ""), digest: digest(part.data ?? "") });
		else if (typeof part.text === "string") {
			text += part.text;
			tokens += textTokens(part.text);
		}
	}
	// A tool result is one block (images included) so it can be followed as a whole.
	if (toolCallId !== undefined) {
		const imageTokensTotal = blocks.reduce((sum, b) => sum + b.tokens, 0);
		return [{ category, tokens: tokens + imageTokensTotal, digest: digest(`${toolCallId}\0${text}\0${blocks.map((b) => b.digest).join()}`), toolCallId }];
	}
	if (text) blocks.unshift({ category, tokens, digest: digest(`${category}\0${text}`) });
	return blocks;
}

function blocksOf(message: AgentMessage): RawBlock[] {
	const cached = messageBlocks.get(message);
	if (cached) return cached;
	let blocks: RawBlock[];
	switch (message.role) {
		case "system": {
			blocks = [];
			const update = renderSystemMessageUpdate(message);
			if (update) blocks.push({ category: "system update", tokens: textTokens(update), digest: digest(update) });
			const added = message.toolsAdded ?? [];
			if (added.length > 0) {
				const text = added.map(toolText).join("\n");
				blocks.push({ category: "system update", tokens: textTokens(text), digest: digest(text) });
			}
			break;
		}
		case "user":
			blocks = contentBlocks(message.content, "user prompt");
			break;
		case "assistant":
			blocks = [];
			for (const part of message.content) {
				if (part.type === "text") blocks.push({ category: "assistant text", tokens: textTokens(part.text), digest: digest(`a\0${part.text}`) });
				else if (part.type === "thinking") {
					const signature = part.thinkingSignature ?? "";
					blocks.push({
						category: "thinking",
						tokens: textTokens(part.thinking) + (signature.length * 0.75) / CHARS_PER_TOKEN,
						digest: digest(`t\0${part.thinking}\0${signature}`),
					});
				} else if (part.type === "toolCall") {
					const args = JSON.stringify(part.arguments ?? {});
					blocks.push({ category: `tool call: ${part.name}`, tokens: textTokens(args), digest: digest(`${part.id}\0${args}`) });
				}
			}
			break;
		case "toolResult":
			blocks = contentBlocks(message.content, `tool result: ${message.toolName}`, message.toolCallId);
			break;
		case "bashExecution":
			blocks = message.excludeFromContext
				? []
				: [{ category: "user bash", tokens: textTokens(message.command + message.output), digest: digest(`b\0${message.command}\0${message.output}`) }];
			break;
		case "custom":
			blocks = contentBlocks(message.content, `custom: ${message.customType}`);
			break;
		case "branchSummary":
			blocks = [{ category: "branch summary", tokens: textTokens(message.summary), digest: digest(`bs\0${message.summary}`) }];
			break;
		case "compactionSummary":
			blocks = [{ category: "compaction summary", tokens: textTokens(message.summary), digest: digest(`cs\0${message.summary}`) }];
			break;
		default: {
			const text = JSON.stringify(message);
			blocks = [{ category: `other: ${(message as { role: string }).role}`, tokens: textTokens(text), digest: digest(text) }];
		}
	}
	messageBlocks.set(message, blocks);
	return blocks;
}

/** Split the context of one request (Pi's messages, leading system message first). */
export function parsePrompt(messages: readonly AgentMessage[]): Prompt {
	const prompt: Prompt = {
		blocks: [],
		messageCount: 0,
		sectionEnds: [0, 0],
		toolCalls: new Map(),
		state: { sections: {}, tools: {} },
		texts: new Map(),
	};
	const head = messages[0]?.role === "system" ? messages[0] : undefined;
	const rest = head ? messages.slice(1) : messages;
	const raw: RawBlock[] = [];
	if (head) {
		for (const tool of head.toolsAdded ?? []) {
			const text = toolText(tool);
			raw.push({ category: `tool definition: ${tool.name}`, tokens: textTokens(text), digest: digest(text) });
		}
		prompt.sectionEnds[0] = raw.length;
		const base = contentParts(head.content).map((p) => p.text ?? "").join("");
		if (base) raw.push({ category: "system: base", tokens: textTokens(base), digest: digest(base) });
		for (const [name, text] of Object.entries(head.sections ?? {})) {
			if (text) raw.push({ category: `system: ${name}`, tokens: textTokens(text), digest: digest(text) });
		}
		prompt.sectionEnds[1] = raw.length;
	}

	// The harness version: prompt sections as patched by every later system message, and the
	// tools the session started with. Tools loaded later (tool search) are runtime state.
	const sections = new Map<string, string>();
	let appended = 0;
	for (const message of messages) {
		if (message.role !== "system") continue;
		const base = contentParts(message.content).map((p) => p.text ?? "").join("");
		if (base) sections.set(message === head ? "base" : `appended ${++appended}`, base);
		for (const [name, text] of Object.entries(message.sections ?? {})) {
			if (text === null) sections.delete(name);
			else sections.set(name, text);
		}
	}
	const tools = new Map((head?.toolsAdded ?? []).map((tool) => [tool.name, tool]));
	for (const [name, text] of sections) {
		const hash = digest(text);
		prompt.state.sections[name] = hash;
		prompt.texts.set(hash, { kind: "section", name, text });
	}
	for (const [name, tool] of tools) {
		const text = toolText(tool);
		const hash = digest(text);
		prompt.state.tools[name] = hash;
		prompt.texts.set(hash, { kind: "tool", name, text });
	}

	let lastAssistant = raw.length;
	for (const message of rest) {
		raw.push(...blocksOf(message));
		if (message.role !== "assistant") continue;
		lastAssistant = raw.length;
		for (const part of message.content) {
			if (part.type === "toolCall") prompt.toolCalls.set(part.id, { name: part.name, summary: summarizeToolInput(part.arguments) });
		}
	}
	prompt.messageCount = rest.length;
	prompt.blocks = raw.map((block, index) => ({ ...block, isNew: index >= lastAssistant }));
	return prompt;
}

/** One id for a harness state: the same prompt sections and tool definitions give the same id. */
export function versionId(state: HarnessState): string {
	const sorted = (record: Record<string, string>) =>
		Object.keys(record)
			.sort()
			.map((key) => `${key}=${record[key]}`)
			.join("\n");
	return digest(`sections\n${sorted(state.sections)}\ntools\n${sorted(state.tools)}`);
}
