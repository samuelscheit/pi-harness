/**
 * Fork bases: compacted states of a prefix, shared by every session that reaches the prefix cold.
 *
 * When a cold prefix is compacted with `compaction.economic`, the result is stored under the
 * prefix's key (model, prompt hash, id chain of the branch) and the compaction settings: a session
 * file holding the kept entries and the compaction entry, with the ids they have in every session
 * forked from the same point. A fork, or the source itself, that later reaches the same prefix cold
 * appends that compaction entry verbatim instead of summarising again, so its context is byte for
 * byte the base's and reads the base's prompt cache entry. Creating a base is serialised by a lock
 * file (file-lock.ts); parallel forks wait on it and then use the base.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { FileLocks, unlinkQuietly } from "./file-lock.ts";
import { writeFileAtomic } from "./prefix-cache.ts";
import {
	type CompactionEntry,
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
} from "./session-manager.ts";

/** What a base is stored under. */
export interface ForkBaseKey {
	provider: string;
	model: string;
	promptHash: string;
	/** Id chain key of the branch's last projected entry (see `PrefixPoint.key`). */
	point: string;
	/** The fork point's entry id, for people reading the metadata. */
	entryId: string;
	/** Everything that shapes the compaction: summary model and compaction settings. */
	settings: unknown;
}

export interface ForkBaseMeta extends ForkBaseKey {
	key: string;
	createdAt: number;
	createdBy?: string;
	compactionId: string;
	lastUsedAt: number;
	/** Sessions that took the base, the creator first. */
	forks: { at: number; session?: string }[];
	/** Cache writes of the base prefix sent so later forks read it. */
	primes: { at: number; session?: string; tokens: number; cost: number; usage: Usage }[];
	/** Size of the base session file in bytes. */
	bytes: number;
}

export interface ForkBase {
	meta: ForkBaseMeta;
	compaction: CompactionEntry;
	/** The base session file, a forkable session holding the kept entries and the compaction entry. */
	path: string;
}

/** Bases that no session took for this long are removed. */
export const FORK_BASE_MAX_IDLE_MS = 24 * 60 * 60_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function forkBaseKey(key: ForkBaseKey): string {
	return sha256(JSON.stringify(key)).slice(0, 40);
}

export class ForkBaseStore {
	readonly dir: string;
	/** Locks in the same directory, also for other prefixes' shared work (template-prefix.ts). */
	readonly locks: FileLocks;
	private lastPruneAt = 0;

	constructor(dir: string) {
		this.dir = dir;
		this.locks = new FileLocks(dir);
	}

	private file(key: string, suffix: string): string {
		return join(this.dir, `${key}${suffix}`);
	}

	load(key: string): ForkBase | undefined {
		try {
			const meta = JSON.parse(readFileSync(this.file(key, ".json"), "utf8")) as ForkBaseMeta;
			const path = this.file(key, ".jsonl");
			const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
			const compaction = JSON.parse(lines.at(-1) ?? "null") as CompactionEntry | null;
			if (compaction?.type !== "compaction" || compaction.id !== meta.compactionId) return undefined;
			return { meta, compaction, path };
		} catch {
			return undefined;
		}
	}

	/**
	 * Store a base: `kept` are the branch entries from the compaction's first kept entry to its
	 * parent, `compaction` the entry that summarises everything before them.
	 */
	save(
		key: ForkBaseKey,
		kept: SessionEntry[],
		compaction: CompactionEntry,
		now: number,
		session: { cwd: string; file?: string },
	): ForkBase {
		const id = forkBaseKey(key);
		mkdirSync(this.dir, { recursive: true });
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id,
			timestamp: new Date(now).toISOString(),
			cwd: session.cwd,
			...(session.file ? { parentSession: session.file } : {}),
		};
		// The first kept entry's parent is not in the file; the kept chain and the compaction keep their ids.
		const entries = [
			...kept.map((entry, index) => (index === 0 ? { ...entry, parentId: null } : entry)),
			{ ...compaction, parentId: kept.at(-1)?.id ?? null },
		];
		const text = `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		const path = this.file(id, ".jsonl");
		writeFileAtomic(path, text);
		const meta: ForkBaseMeta = {
			...key,
			key: id,
			createdAt: now,
			...(session.file ? { createdBy: session.file } : {}),
			compactionId: compaction.id,
			lastUsedAt: now,
			forks: [],
			primes: [],
			bytes: Buffer.byteLength(text),
		};
		writeFileAtomic(this.file(id, ".json"), JSON.stringify(meta, null, "\t"));
		return { meta, compaction, path };
	}

	/** Change a base's metadata. Call it while holding the base's lock. */
	update(key: string, change: (meta: ForkBaseMeta) => void): ForkBaseMeta | undefined {
		const base = this.load(key);
		if (!base) return undefined;
		change(base.meta);
		writeFileAtomic(this.file(key, ".json"), JSON.stringify(base.meta, null, "\t"));
		return base.meta;
	}

	/** Processes other than the caller waiting for the base's lock. */
	waiters(key: string, own?: string): number {
		return this.locks.waiters(key, own);
	}

	/** Run `task` holding the base's lock, waiting for other holders (see `FileLocks.withLock`). */
	async withLock<T>(key: string, task: (self: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
		try {
			return await this.locks.withLock(key, task, signal);
		} finally {
			this.pruneIfDue(Date.now());
		}
	}

	private list(): string[] {
		try {
			return readdirSync(this.dir);
		} catch {
			return [];
		}
	}

	pruneIfDue(now: number): void {
		if (now - this.lastPruneAt >= PRUNE_INTERVAL_MS) this.prune(now);
	}

	/** Remove bases no session took within a day, and wait files of processes that died. */
	prune(now: number): string[] {
		this.lastPruneAt = now;
		const removed: string[] = [];
		for (const name of this.list()) {
			if (name.endsWith(".json")) {
				const key = name.slice(0, -".json".length);
				if (this.locks.held(key)) continue;
				try {
					const meta = JSON.parse(readFileSync(this.file(key, ".json"), "utf8")) as ForkBaseMeta;
					if (now - meta.lastUsedAt <= FORK_BASE_MAX_IDLE_MS) continue;
				} catch {
					// Unreadable metadata: the base cannot be used.
				}
				unlinkQuietly(this.file(key, ".jsonl"));
				unlinkQuietly(this.file(key, ".json"));
				removed.push(key);
			} else if (name.endsWith(".tmp")) {
				try {
					if (now - statSync(this.file(name, "")).mtimeMs > 60_000) unlinkQuietly(this.file(name, ""));
				} catch {
					// Renamed meanwhile.
				}
			}
		}
		this.locks.pruneWaiters();
		return removed;
	}
}
