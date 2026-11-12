// Pi messages and usage for the metrics tests (blocks, attribution, payload, indexer).

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "../extensions/metrics/attribution.ts";

// Opus-like prices per token.
export const PRICE = { input: 5e-6, read: 0.5e-6, write: 6.25e-6, output: 25e-6 };

export function usage(input: number, cacheRead: number, cacheWrite: number, output: number, reasoning?: number): Usage & { reasoning?: number } {
	const cost = {
		input: input * PRICE.input,
		cacheRead: cacheRead * PRICE.read,
		cacheWrite: cacheWrite * PRICE.write,
		output: output * PRICE.output,
		total: 0,
	};
	cost.total = cost.input + cost.cacheRead + cost.cacheWrite + cost.output;
	return { input, output, cacheRead, cacheWrite, cacheWrite1h: 0, cost, ...(reasoning === undefined ? {} : { reasoning }) };
}

export const tool = (name: string, description = `${name} tool`) => ({ name, description, parameters: { type: "object", properties: {} } });

export const system = (sections: Record<string, string | null>, toolsAdded = [tool("bash"), tool("read")]): AgentMessage =>
	({ role: "system", content: "", sections, toolsAdded, timestamp: 0 }) as AgentMessage;

export const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 0 });

export function assistant(content: unknown[], stopReason = "toolUse", u = usage(1, 0, 0, 10), extra: Record<string, unknown> = {}): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		thinkingLevel: "medium",
		usage: u,
		stopReason,
		timestamp: 0,
		...extra,
	} as AgentMessage;
}

export const toolResult = (id: string, name: string, text: string, extra: Record<string, unknown> = {}): AgentMessage =>
	({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 0, ...extra }) as AgentMessage;

/** A signed thinking block: summary `text` and a signature of `signatureChars` base64 characters. */
export const thinking = (text: string, signatureChars = 400) => ({ type: "thinking" as const, thinking: text, thinkingSignature: "s".repeat(signatureChars) });

export const toolCall = (id: string, name = "bash", args: Record<string, unknown> = { command: "ls" }) => ({ type: "toolCall", id, name, arguments: args });

/** Pi's diagnostic for Anthropic input transformations: one `thinking_dropped` per path. */
export const dropDiagnostic = (...paths: string[]) => ({
	diagnostics: [
		{
			type: "anthropic_input_transformations",
			timestamp: 0,
			details: { transformations: paths.map((path) => ({ type: "thinking_dropped", path, reason: "prefix_binding_mismatch" })) },
		},
	],
});
