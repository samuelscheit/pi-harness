/**
 * A registry of prompt cache entries shared by every pi process of one agent directory.
 *
 * A forked session shares its source's conversation up to the fork point, and `forkFrom` copies
 * entry ids unchanged. So the provider's cache entry for a prefix can be named across sessions by
 * ids: the model, a hash of the leading system message (prompt and tools), and a hash chained over
 * the ids of the projected entries up to the prefix's end (plus the context edit applied to each).
 * The id chain, not only the last entry's id, is needed because a compaction keeps entries: the
 * same kept entry ends a different prefix before and after the compaction, and a context edit
 * changes a prefix without changing its last entry.
 *
 * After every provider request a session records which prefix it wrote or read and when it
 * expires. Coldness checks ask whether the next request of a branch would reach an entry that is
 * still alive, wherever it was written. One small JSON file per key, replaced atomically, keeps
 * concurrent writers safe; expired files are pruned unless they hold reads of the last day.
 *
 * The leading system message (prompt and tools) is named by the prompt hash, not by its entry id:
 * forks of a template record their own prompt entry, in front of the template's shared entries, so
 * the same prompt over the same template is the same prefix in every fork.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message, PROMPT_CACHE_LOOKBACK_BLOCKS, type SystemMessage, type Usage } from "@earendil-works/pi-ai";
import { convertToLlm } from "./messages.ts";
import type { SessionProjection } from "./session-manager.ts";

/** The model a cache entry belongs to. */
export interface ModelRef {
	provider: string;
	id: string;
}

/** One prefix of a branch's context: everything up to and including one projected entry. */
export interface PrefixPoint {
	/** Hash chained over the projected entry ids (and their context edits) up to this entry. */
	key: string;
	entryId: string;
	/** Lookback positions the provider counts up to and including this entry (see below). */
	end: number;
}

/** What the next request of a branch sends, as far as prompt caching is concerned. */
export interface BranchPrefix {
	/** Hash of the leading system message: the system prompt and the tool definitions. */
	promptHash: string;
	/** Prefixes ending at an entry boundary where a cache entry can exist, in context order. */
	points: PrefixPoint[];
	/** Lookback positions of the whole context. */
	positions: number;
	/** Blocks of the whole context, as Pi's lookback bridge counts them. */
	blocks: number;
	/** The last assistant reply: where it starts, in blocks and in positions, and how long it is. */
	lastReply?: { blockStart: number; blocks: number; positionStart: number; positions: number };
}

/** A prefix's last record: who touched its cache entry, how, and until when it lives. */
export interface PrefixCacheRecord {
	provider: string;
	model: string;
	promptHash: string;
	entryId: string;
	/** Prompt tokens up to the prefix's end, as the provider counted them. */
	tokens: number;
	cache: "read" | "write";
	at: number;
	ttlMs: number;
	expiresAt: number;
	/**
	 * Times sessions started from this prefix (a template fork's first request), within the last
	 * READS_KEPT_MS, oldest first: their rate decides whether keeping the entry warm pays.
	 */
	reads?: number[];
}

/** How long a record keeps the times of its reads. */
export const READS_KEPT_MS = 24 * 60 * 60_000;
/** At most this many read times per record. */
const MAX_READS = 500;

/** A provider request and the prefix it covered. */
export interface PrefixRequest {
	model: ModelRef;
	/** Anthropic places Pi's lookback bridge breakpoint (see `bridgeCacheLookback`). */
	bridge: boolean;
	ttlMs: number;
	prefix: BranchPrefix;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Hash of the system prompt and tools a transcript starts with. */
export function promptHashOf(messages: readonly { role: string }[]): string {
	const first = messages[0] as SystemMessage | undefined;
	if (first?.role !== "system") return sha256("");
	return sha256(JSON.stringify([first.content, first.sections ?? null, first.toolsAdded ?? null]));
}

/** Blocks and lookback positions one converted message adds; tool_use and tool_result runs count once. */
function measure(message: Message, previous: Message | undefined): { blocks: number; positions: number } {
	switch (message.role) {
		case "system": {
			const text =
				typeof message.content === "string" ? message.content : message.content.map((c) => c.text).join("");
			const blocks =
				(text.trim() || Object.keys(message.sections ?? {}).length > 0 ? 1 : 0) +
				(message.toolsAdded?.length ?? 0) +
				(message.toolsRemoved?.length ?? 0);
			return { blocks, positions: blocks };
		}
		case "user": {
			const blocks =
				typeof message.content === "string"
					? message.content.trim()
						? 1
						: 0
					: message.content.filter((c) => c.type !== "text" || c.text.trim()).length;
			return { blocks, positions: blocks };
		}
		case "toolResult":
			return { blocks: 1, positions: previous?.role === "toolResult" ? 0 : 1 };
		case "assistant": {
			let blocks = 0;
			let positions = 0;
			let inToolRun = false;
			for (const block of message.content) {
				if (block.type === "toolCall") {
					blocks++;
					if (!inToolRun) positions++;
					inToolRun = true;
					continue;
				}
				inToolRun = false;
				if (block.type === "text" && !block.text.trim()) continue;
				if (block.type === "thinking" && !block.thinking.trim() && !block.thinkingSignature?.trim()) continue;
				blocks++;
				positions++;
			}
			return { blocks, positions };
		}
	}
}

/**
 * The cacheable prefixes of a projected context. The leading system message travels outside the
 * message list (with the tools it declares) and counts no position. A tool result inside a run of
 * tool results ends no point: the run is one position, at its end.
 */
export function describeBranchPrefix(projection: Pick<SessionProjection, "entries" | "messages">): BranchPrefix {
	const edits = new Map<string, string>();
	for (const { sourceEntry } of projection.entries) {
		if (sourceEntry.type === "context_edit") edits.set(sourceEntry.targetId, sourceEntry.id);
	}
	const points: PrefixPoint[] = [];
	let chain = "";
	let blocks = 0;
	let positions = 0;
	let previous: Message | undefined;
	let leading = true;
	let lastReply: BranchPrefix["lastReply"];
	for (const { sourceEntry, messages } of projection.entries) {
		if (messages.length === 0) continue;
		// The leading prompt entry: its content is the prompt hash, its id differs per template fork.
		if (chain === "" && messages.every((message) => message.role === "system")) {
			leading = false;
			continue;
		}
		chain = sha256(`${chain}\n${sourceEntry.id}:${edits.get(sourceEntry.id) ?? ""}`);
		for (const message of convertToLlm(messages as AgentMessage[])) {
			if (leading && message.role === "system") {
				leading = false;
				continue;
			}
			leading = false;
			const size = measure(message, previous);
			if (message.role === "assistant" && size.blocks > 0) {
				lastReply = {
					blockStart: blocks,
					blocks: size.blocks,
					positionStart: positions,
					positions: size.positions,
				};
			}
			blocks += size.blocks;
			positions += size.positions;
			if (size.blocks > 0) previous = message;
		}
		const point = { key: chain, entryId: sourceEntry.id, end: positions };
		// A tool result followed by another one ends inside a run; the next entry replaces it.
		if (points.at(-1)?.end === positions && previous?.role === "toolResult") points.pop();
		if (positions > 0) points.push(point);
	}
	return { promptHash: promptHashOf(projection.messages), points, positions, blocks, lastReply };
}

/**
 * The prefixes whose cache entries a request reads if they are alive. `extraBlocks`: what the
 * request adds after the branch (0 for the request that sent exactly the branch, 1 for the next
 * prompt, which adds at least one block).
 *
 * Anthropic writes entries only at breakpoints and looks back {@link PROMPT_CACHE_LOOKBACK_BLOCKS}
 * positions from each breakpoint, the breakpoint itself first. Pi puts one on the last block, and,
 * when at least that many blocks follow the start of the last assistant reply, its lookback bridge
 * puts one on the first block after the reply (or, for a reply of 19 blocks or more, on the last
 * block before it). Both are reproduced here, so the entry ending right before the last reply is
 * always within reach on Anthropic, as Pi intends. Other providers get the final breakpoint's
 * lookback, a lower bound of what their automatic prefix caching reaches.
 */
export function reachablePrefixes(prefix: BranchPrefix, extraBlocks: number, bridge: boolean): PrefixPoint[] {
	const breakpoints = [prefix.positions + extraBlocks - 1];
	const reply = prefix.lastReply;
	if (bridge && reply && prefix.blocks + extraBlocks - reply.blockStart >= PROMPT_CACHE_LOOKBACK_BLOCKS) {
		breakpoints.push(
			reply.blocks + 1 < PROMPT_CACHE_LOOKBACK_BLOCKS
				? reply.positionStart + reply.positions
				: reply.positionStart - 1,
		);
	}
	return prefix.points.filter((point) =>
		breakpoints.some((breakpoint) => {
			const distance = breakpoint - (point.end - 1);
			return distance >= 0 && distance < PROMPT_CACHE_LOOKBACK_BLOCKS;
		}),
	);
}

/** Write `data` to `path` through a temporary file and a rename, so readers never see a partial file. */
export function writeFileAtomic(path: string, data: string): void {
	const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(temporary, data);
	renameSync(temporary, path);
}

/** Whether a process with this id runs (on this machine). */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Temporary files left by a writer that died between write and rename. */
const STALE_TEMPORARY_MS = 60_000;
/** How often one process sweeps expired records. */
const PRUNE_INTERVAL_MS = 10 * 60_000;

export class PrefixCacheRegistry {
	readonly dir: string;
	private lastPruneAt = 0;

	constructor(dir: string) {
		this.dir = dir;
	}

	private path(model: ModelRef, promptHash: string, point: PrefixPoint): string {
		return join(
			this.dir,
			`${sha256(`${model.provider}/${model.id}\n${promptHash}\n${point.key}`).slice(0, 40)}.json`,
		);
	}

	/** The prefix's last record, alive or not. */
	get(model: ModelRef, promptHash: string, point: PrefixPoint): PrefixCacheRecord | undefined {
		try {
			return JSON.parse(readFileSync(this.path(model, promptHash, point), "utf8")) as PrefixCacheRecord;
		} catch {
			return undefined;
		}
	}

	/** Record that a request touched the prefix's cache entry at `at`. Keeps the later expiry. */
	touch(
		model: ModelRef,
		promptHash: string,
		point: PrefixPoint,
		touch: { tokens?: number; cache: "read" | "write"; at: number; ttlMs: number },
	): void {
		const existing = this.get(model, promptHash, point);
		const expiresAt = Math.max(touch.at + touch.ttlMs, existing?.expiresAt ?? 0);
		this.write(model, promptHash, point, {
			provider: model.provider,
			model: model.id,
			promptHash,
			entryId: point.entryId,
			tokens: touch.tokens ?? existing?.tokens ?? 0,
			cache: touch.cache,
			at: Math.max(touch.at, existing?.at ?? 0),
			ttlMs: touch.ttlMs,
			expiresAt,
			...(existing?.reads ? { reads: existing.reads } : {}),
		});
		if (touch.at - this.lastPruneAt >= PRUNE_INTERVAL_MS) this.prune(touch.at);
	}

	/**
	 * Record that a session started from the prefix at `at` (a read it made or wanted to make),
	 * without changing its cache entry. `tokens`: the prefix's size, for a prefix without a record.
	 */
	noteRead(model: ModelRef, promptHash: string, point: PrefixPoint, at: number, tokens: number): void {
		const existing = this.get(model, promptHash, point);
		const reads = [...(existing?.reads ?? []).filter((time) => at - time < READS_KEPT_MS), at].slice(-MAX_READS);
		this.write(model, promptHash, point, {
			provider: model.provider,
			model: model.id,
			promptHash,
			entryId: point.entryId,
			tokens: existing?.tokens || tokens,
			cache: existing?.cache ?? "read",
			at: existing?.at ?? 0,
			ttlMs: existing?.ttlMs ?? 0,
			expiresAt: existing?.expiresAt ?? 0,
			reads,
		});
	}

	private write(model: ModelRef, promptHash: string, point: PrefixPoint, record: PrefixCacheRecord): void {
		mkdirSync(this.dir, { recursive: true });
		writeFileAtomic(this.path(model, promptHash, point), JSON.stringify(record));
	}

	/**
	 * Record what a finished request did to the cache, from its usage: its whole prompt was written
	 * or read at the final breakpoint, and a read of part of it refreshed the entry of the reachable
	 * prefix whose recorded size the read covers (the longest such prefix).
	 */
	recordRequest(request: PrefixRequest, usage: Usage, now: number): void {
		if (usage.cacheRead + usage.cacheWrite === 0) return;
		const { model, prefix, ttlMs } = request;
		const final = prefix.points.at(-1);
		if (!final) return;
		const tokens = usage.input + usage.cacheRead + usage.cacheWrite;
		this.touch(model, prefix.promptHash, final, {
			tokens,
			cache: usage.cacheWrite > 0 ? "write" : "read",
			at: now,
			ttlMs,
		});
		if (usage.cacheRead === 0 || usage.cacheRead >= tokens) return;
		let read: { point: PrefixPoint; tokens: number } | undefined;
		for (const point of reachablePrefixes(prefix, 0, request.bridge)) {
			if (point === final) continue;
			const record = this.get(model, prefix.promptHash, point);
			if (!record || record.tokens === 0 || record.tokens > usage.cacheRead) continue;
			if (!read || record.tokens > read.tokens) read = { point, tokens: record.tokens };
		}
		if (read) this.touch(model, prefix.promptHash, read.point, { cache: "read", at: now, ttlMs });
	}

	/** The live record a request adding `extraBlocks` after the branch would read, if any. */
	findWarm(
		model: ModelRef,
		prefix: BranchPrefix,
		bridge: boolean,
		now: number,
		extraBlocks = 1,
	): PrefixCacheRecord | undefined {
		for (const point of reachablePrefixes(prefix, extraBlocks, bridge).reverse()) {
			const record = this.get(model, prefix.promptHash, point);
			if (record && record.expiresAt > now) return record;
		}
		return undefined;
	}

	/** Remove expired records and abandoned temporary files. */
	prune(now: number): void {
		this.lastPruneAt = now;
		let names: string[];
		try {
			names = readdirSync(this.dir);
		} catch {
			return;
		}
		for (const name of names) {
			const path = join(this.dir, name);
			try {
				if (name.endsWith(".tmp")) {
					if (now - statSync(path).mtimeMs > STALE_TEMPORARY_MS) unlinkSync(path);
					continue;
				}
				if (!name.endsWith(".json")) continue;
				const text = readFileSync(path, "utf8");
				let record: Partial<PrefixCacheRecord> | undefined;
				try {
					record = JSON.parse(text) as Partial<PrefixCacheRecord>;
				} catch {
					// Not a record: nothing reads it.
				}
				const lastRead = record?.reads?.at(-1);
				if (lastRead !== undefined && now - lastRead < READS_KEPT_MS) continue;
				if (typeof record?.expiresAt !== "number" || record.expiresAt <= now) unlinkSync(path);
			} catch {
				// Another process removed or replaced it meanwhile.
			}
		}
	}
}
