// Thinking blocks the Anthropic API dropped from a request, read from the reply.
//
// Pi sends Opus/Sonnet 5.5 requests with `block_binding: { prefix_mismatch_behavior: "drop_block" }`:
// a replayed thinking block whose prefix binding no longer matches (an earlier message, the system
// prompt or the tools changed since it was generated) is dropped by the API instead of failing the
// request, and is not billed. The API reports each drop as an input transformation
// `{ type: "thinking_dropped", path: "messages.<i>.content.<j>", reason: "prefix_binding_mismatch" }`,
// and Pi records them on the reply as an `anthropic_input_transformations` diagnostic.
//
// The paths index the request body, not the session, so `thinkingPositions` replays how Pi lays the
// conversation out for Anthropic (vendor/pi/packages/ai/src/api/transform-messages.ts and
// anthropic-messages.ts `convertMessages` / `insertThinkingLevelMessages`): errored and aborted
// replies and assistant messages with nothing to send are left out, a run of tool results is one
// user message (with synthetic results for calls that got none), empty user messages are left out,
// later system messages are emitted before the next assistant message, and with effort markers a
// marker message precedes every earlier reply of the same provider that recorded its effort.
// Checked against every drop recorded on 2026-11-12: 2,417 paths in 54 requests, all on a signed
// thinking block. A request rewritten by an extension (pi-lens `context_with_system` injections in
// the middle of the transcript) shifts the paths; a path that does not land on a thinking block is
// still counted but its block keeps its price.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type Message, renderSystemMessageUpdate } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { replayedAsThinking, thinkingDigest } from "./blocks.ts";

const DIAGNOSTIC = "anthropic_input_transformations";
const DROPPED = "thinking_dropped";
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface DroppedThinking {
	/** Blocks the API reported dropping. */
	count: number;
	/** Digests (blocks.ts `thinkingDigest`) of the dropped blocks found in the context. */
	digests: Set<string>;
}

/** The `thinking_dropped` paths the API reported for the request that produced `reply`. */
export function droppedPaths(reply: AssistantMessage): string[] {
	return (reply.diagnostics ?? [])
		.filter((diagnostic) => diagnostic.type === DIAGNOSTIC)
		.flatMap((diagnostic) => {
			const transformations = diagnostic.details?.transformations;
			return Array.isArray(transformations) ? transformations : [];
		})
		.flatMap((t) => {
			const transformation = t as { type?: unknown; path?: unknown };
			return transformation.type === DROPPED && typeof transformation.path === "string" ? [transformation.path] : [];
		});
}

const sendsContent = (message: Extract<Message, { role: "user" }>): boolean =>
	typeof message.content === "string"
		? message.content.trim().length > 0
		: message.content.some((part) => part.type !== "text" || part.text.trim().length > 0);

/** What `convertMessages` sends of an assistant message: per block, the thinking part it carries, if any. */
function sentBlocks(message: AssistantMessage, sameModel: boolean): (Extract<AssistantMessage["content"][number], { type: "thinking" }> | undefined)[] {
	const blocks: ReturnType<typeof sentBlocks> = [];
	for (const part of message.content) {
		if (part.type === "text") {
			if (part.text.trim().length > 0) blocks.push(undefined);
		} else if (part.type === "thinking") {
			// Thinking from another model is not sent; an unsigned block goes as text.
			if (!sameModel) continue;
			if (replayedAsThinking(part)) blocks.push(part);
			else if (part.thinking.trim().length > 0) blocks.push(undefined);
		} else if (part.type === "toolCall") blocks.push(undefined);
	}
	return blocks;
}

/** Path `messages.<i>.content.<j>` of every thinking block in the Anthropic request body for `context`, to its digest. */
export function thinkingPositions(context: readonly AgentMessage[], reply: AssistantMessage): Map<string, string> {
	const positions = new Map<string, string>();
	const messages = convertToLlm([...context]);
	const conversation = messages[0]?.role === "system" ? messages.slice(1) : messages;
	const effortMarkers = reply.providerThinkingLevel !== undefined;
	let index = 0;
	let heldSystems = 0;
	let unanswered = new Set<string>();
	let inResults = false;
	// Synthetic results for calls that got none join the run of results, or form one.
	const closeCalls = () => {
		if (unanswered.size > 0 && !inResults) index += 1;
		unanswered = new Set();
		inResults = false;
	};
	for (const message of conversation) {
		if (message.role === "system") {
			// Always native here: every model the harness runs takes mid-conversation updates.
			if (renderSystemMessageUpdate(message) || message.toolsAdded?.length || message.toolsRemoved?.length) heldSystems += 1;
		} else if (message.role === "toolResult") {
			if (!inResults) index += 1;
			inResults = true;
			unanswered.delete(message.toolCallId);
		} else if (message.role === "user") {
			closeCalls();
			if (sendsContent(message)) index += 1;
		} else if (message.role === "assistant") {
			closeCalls();
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			unanswered = new Set(message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : [])));
			const sameModel = message.provider === reply.provider && message.api === reply.api && message.model === reply.model;
			const blocks = sentBlocks(message, sameModel);
			if (blocks.length === 0) continue;
			index += heldSystems;
			heldSystems = 0;
			if (effortMarkers && message.provider === reply.provider && message.api === "anthropic-messages" && EFFORTS.has(message.providerThinkingLevel ?? "")) index += 1;
			blocks.forEach((part, block) => {
				if (part) positions.set(`messages.${index}.content.${block}`, thinkingDigest(part));
			});
			index += 1;
		}
	}
	return positions;
}

/** The thinking blocks the API dropped from the request that answered with `reply`, given that request's context. */
export function droppedThinking(context: readonly AgentMessage[], reply: AssistantMessage): DroppedThinking {
	const paths = droppedPaths(reply);
	if (paths.length === 0) return { count: 0, digests: new Set() };
	const positions = thinkingPositions(context, reply);
	return { count: paths.length, digests: new Set(paths.flatMap((path) => positions.get(path) ?? [])) };
}
