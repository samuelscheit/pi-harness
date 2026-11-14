// A template's session file, built without a model call, and the checks that tell when it is stale.
//
// Built from a recipe (recipe.ts), deterministically, so the same recipe, files and model give the same
// bytes and the same entry ids, and with them the same prompt cache keys (Pi names a prefix by its
// entry ids):
//   1. the recipe's instructions as the first user message;
//   2. one assistant message calling Pi's `read` tool for every file, and each call's real result
//      (Pi's own read tool runs here), so the history is that of a session that read them;
//   3. a fixed assistant reply listing the files read, which closes the tool loop;
//   4. the recipe's examples, verbatim;
//   5. a fixed user message saying the template ends and the task follows.
// The last one makes the template end in a plain user message: the prefix every fork shares can
// then be written to the prompt cache on its own (Pi's template-prefix.ts primes everything before
// the last reply), with extended thinking too, which a prefix ending in tool results would refuse
// without the thinking blocks a built template cannot have. Every timestamp is the epoch; entry and
// tool call ids are hashes chained over the content before them.
//
// There is no system message: a template is the conversation. Every fork runs it with its own current
// prompt and tools, which Pi puts in front (see `SessionTemplate`).
//
// Captured from a session (`/template save`): its context at that point without its system messages,
// plus the same closing user message. Its read calls are re-run at capture time to record what they
// return now, which later checks compare with.

import { existsSync, globSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { type CompactionEntry, CURRENT_SESSION_VERSION, createReadTool, describeBranchPrefix, type SessionEntry, type SessionHeader, type SessionProjection } from "@earendil-works/pi-coding-agent";
import { type Recipe, sha256 } from "./recipe.ts";

/** One read call of a template and a hash of what it returned. */
export interface ReadRecord {
	path: string;
	offset?: number;
	limit?: number;
	hash: string;
}

export interface BuiltTemplate {
	/** The session file's text. */
	text: string;
	reads: ReadRecord[];
	/** The id chain key of the template's last entry: its prefix without the prompt, which forks put in front. */
	prefixKey: string;
	/** The template's last entry. */
	leafId: string;
}

const EPOCH = new Date(0).toISOString();
const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const GLOB = /[*?[{]/;

/** The message that ends every template: the fork's task comes next. */
export const endMessage = (name: string) => `This is where the template "${name}" ends. The task follows.`;

/** The files a recipe reads, relative to `root`, in recipe order (each glob's matches sorted); throws for a path or glob that matches no file. */
export function expandReads(root: string, patterns: readonly string[]): string[] {
	const paths: string[] = [];
	for (const pattern of patterns) {
		const matches = GLOB.test(pattern)
			? globSync(pattern, { cwd: root })
					.filter((path) => statSync(join(root, path)).isFile())
					.sort()
			: existsSync(join(root, pattern)) && statSync(join(root, pattern)).isFile()
				? [pattern]
				: [];
		if (matches.length === 0) throw new Error(`read ${pattern}: no file matches it in ${root}`);
		for (const path of matches) if (!paths.includes(path)) paths.push(path);
	}
	return paths;
}

/** Run Pi's read tool as the template's history shows it; the hash covers what the model sees. */
export async function readCall(root: string, call: Omit<ReadRecord, "hash">): Promise<{ content: ToolResultMessage["content"]; details: unknown; hash: string }> {
	const result = await createReadTool(root).execute("template", { path: call.path, ...(call.offset !== undefined ? { offset: call.offset } : {}), ...(call.limit !== undefined ? { limit: call.limit } : {}) });
	const content = result.content as ToolResultMessage["content"];
	return { content, details: result.details ?? undefined, hash: sha256(JSON.stringify(content)) };
}

/** Appends message entries with ids chained over their content, as one branch. */
class Chain {
	readonly entries: SessionEntry[] = [];
	private parent: string | null = null;

	/** Continue after `entries`, which form one branch already. */
	constructor(entries: SessionEntry[] = []) {
		this.entries.push(...entries);
		this.parent = entries.at(-1)?.id ?? null;
	}

	message(message: AgentMessage): void {
		const entry = { type: "message" as const, timestamp: EPOCH, message };
		const id = sha256(`${this.parent ?? ""}\n${JSON.stringify(entry)}`).slice(0, 8);
		this.entries.push({ ...entry, id, parentId: this.parent });
		this.parent = id;
	}

	get leafId(): string {
		return this.parent ?? "";
	}
}

const assistant = (model: Model<Api>, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: ZERO_USAGE,
	stopReason,
	timestamp: 0,
});

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: 0 });

/** The session file text of a template's entries, and its prefix key. */
function sessionFile(name: string, cwd: string, chain: Chain): { text: string; prefixKey: string; leafId: string } {
	const header: SessionHeader = { type: "session", version: CURRENT_SESSION_VERSION, id: `template-${name}`, timestamp: EPOCH, cwd, template: { name } };
	const text = `${[header, ...chain.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	const projected = chain.entries.map((sourceEntry) => ({ sourceEntry, messages: sourceEntry.type === "message" ? [sourceEntry.message] : [] }));
	const prefix = describeBranchPrefix({ entries: projected, messages: projected.flatMap((entry) => entry.messages) } as Pick<SessionProjection, "entries" | "messages">);
	return { text, prefixKey: prefix.points.at(-1)?.key ?? "", leafId: chain.leafId };
}

/** Build a recipe's template session in `root` (the repository its paths are relative to), for `model`. */
export async function buildTemplate(recipe: Recipe, root: string, model: Model<Api>): Promise<BuiltTemplate> {
	const chain = new Chain();
	chain.message(user(recipe.instructions));
	const paths = expandReads(root, recipe.read);
	const reads: ReadRecord[] = [];
	if (paths.length) {
		const calls = paths.map((path, index) => ({ type: "toolCall" as const, id: `call_${sha256(`${recipe.name}\n${index}\n${path}`).slice(0, 24)}`, name: "read", arguments: { path } }));
		chain.message(assistant(model, calls, "toolUse"));
		for (const call of calls) {
			const { content, details, hash } = await readCall(root, { path: call.arguments.path });
			reads.push({ path: call.arguments.path, hash });
			// SAFETY: the read tool's details are plain JSON (ReadToolDetails), as Pi persists them.
			const result = { role: "toolResult", toolCallId: call.id, toolName: "read", content, ...(details !== undefined ? { details } : {}), isError: false, timestamp: 0 } as ToolResultMessage;
			chain.message(result);
		}
		chain.message(assistant(model, [{ type: "text", text: `I have read ${paths.join(", ")}.` }], "stop"));
	}
	for (const example of recipe.examples) {
		chain.message(user(example.user));
		chain.message(assistant(model, [{ type: "text", text: example.assistant }], "stop"));
	}
	if (chain.entries.length > 1) chain.message(user(endMessage(recipe.name)));
	return { ...sessionFile(recipe.name, root, chain), reads };
}

/**
 * A template from a session's context at its current point (`projection`), working in `cwd`: its
 * entries keep their ids, without the session's system messages (a template carries no prompt), and
 * end with the closing user message. Read calls are run again to record what they return now.
 */
export async function captureTemplate(name: string, cwd: string, projection: Pick<SessionProjection, "entries">): Promise<BuiltTemplate> {
	const kept: SessionEntry[] = [];
	for (const { sourceEntry, messages } of projection.entries) {
		if (messages.length > 0 && messages.every((message) => message.role === "system")) continue;
		if (messages.length === 0 && sourceEntry.type !== "context_edit") continue;
		if (sourceEntry.type === "compaction") {
			const { systemMessage: _prompt, ...compaction } = sourceEntry as CompactionEntry & { systemMessage?: unknown };
			kept.push(compaction as SessionEntry);
		} else kept.push(sourceEntry);
	}
	if (!kept.some((entry) => entry.type === "message" || entry.type === "compaction")) throw new Error("the session has no conversation to capture yet");
	// The kept entries form one branch: each one's parent is the one before it.
	const entries = kept.map((entry, index) => ({ ...entry, parentId: index === 0 ? null : kept[index - 1]!.id }) as SessionEntry);
	const chain = new Chain(entries);
	chain.message(user(endMessage(name)));
	const reads: ReadRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall" || block.name !== "read") continue;
			const { path, offset, limit } = block.arguments as { path?: unknown; offset?: unknown; limit?: unknown };
			if (typeof path !== "string") continue;
			const call = { path, ...(typeof offset === "number" ? { offset } : {}), ...(typeof limit === "number" ? { limit } : {}) };
			try {
				reads.push({ ...call, hash: (await readCall(cwd, call)).hash });
			} catch {
				// The file is gone: nothing to compare later.
			}
		}
	}
	return { ...sessionFile(name, cwd, chain), reads };
}

/** Read calls whose result changed since the template recorded it, as reasons. */
export async function changedReads(root: string, reads: readonly ReadRecord[]): Promise<string[]> {
	const changed: string[] = [];
	for (const { hash, ...call } of reads) {
		let now: string | undefined;
		try {
			now = (await readCall(root, call)).hash;
		} catch {
			now = undefined;
		}
		if (now !== hash) changed.push(now === undefined ? `${call.path} is gone` : `${call.path} changed`);
	}
	return changed;
}
