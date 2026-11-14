/**
 * Fork bases: compacted states of a prefix, shared by every session that reaches the prefix cold.
 *
 * When a cold prefix is compacted with `compaction.economic`, the result is stored under the
 * prefix's key (model, prompt hash, id chain of the branch) and the compaction settings: a session
 * file holding the kept entries and the compaction entry, with the ids they have in every session
 * forked from the same point. A fork, or the source itself, that later reaches the same prefix cold
 * appends that compaction entry verbatim instead of summarising again, so its context is byte for
 * byte the base's and reads the base's prompt cache entry. Creating a base is serialised by a lock
 * file; parallel forks wait on it and then use the base.
 */
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { isProcessAlive, writeFileAtomic } from "./prefix-cache.ts";
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
/** A lock older than this is taken over even when its holder still runs (a compaction hung). */
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_POLL_MS = 100;
const PRUNE_INTERVAL_MS = 60 * 60_000;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function forkBaseKey(key: ForkBaseKey): string {
	return sha256(JSON.stringify(key)).slice(0, 40);
}

export class ForkBaseStore {
	readonly dir: string;
	private lastPruneAt = 0;

	constructor(dir: string) {
		this.dir = dir;
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
		let count = 0;
		for (const name of this.list()) {
			if (!name.startsWith(`${key}.wait-`) || name === own) continue;
			const pid = Number(name.slice(`${key}.wait-`.length).split("-")[0]);
			if (isProcessAlive(pid)) count++;
		}
		return count;
	}

	/**
	 * Run `task` holding the base's lock, waiting for other holders. While it waits, the caller is
	 * counted in `waiters`. A lock whose holder died, or that is older than ten minutes, is taken over.
	 */
	async withLock<T>(key: string, task: (self: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
		mkdirSync(this.dir, { recursive: true });
		const lock = this.file(key, ".lock");
		const waiter = `${key}.wait-${process.pid}-${randomBytes(4).toString("hex")}`;
		writeFileSync(this.file(waiter, ""), "");
		try {
			for (;;) {
				signal?.throwIfAborted();
				try {
					const fd = openSync(lock, "wx");
					writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
					closeSync(fd);
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
				if (this.isStale(lock)) {
					try {
						unlinkSync(lock);
					} catch {
						// Another waiter took it over first.
					}
					continue;
				}
				await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
			}
		} finally {
			unlinkQuietly(this.file(waiter, ""));
		}
		try {
			return await task(waiter);
		} finally {
			unlinkQuietly(lock);
			this.pruneIfDue(Date.now());
		}
	}

	private isStale(lock: string): boolean {
		try {
			const { pid, at } = JSON.parse(readFileSync(lock, "utf8")) as { pid: number; at: number };
			return !isProcessAlive(pid) || Date.now() - at > LOCK_STALE_MS;
		} catch {
			// Written between open and write: give the holder a moment, unless the file is old.
			try {
				return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
			} catch {
				return false;
			}
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
				if (existsLock(this.file(key, ".lock"))) continue;
				try {
					const meta = JSON.parse(readFileSync(this.file(key, ".json"), "utf8")) as ForkBaseMeta;
					if (now - meta.lastUsedAt <= FORK_BASE_MAX_IDLE_MS) continue;
				} catch {
					// Unreadable metadata: the base cannot be used.
				}
				unlinkQuietly(this.file(key, ".jsonl"));
				unlinkQuietly(this.file(key, ".json"));
				removed.push(key);
			} else if (name.includes(".wait-")) {
				const pid = Number(name.split(".wait-")[1]?.split("-")[0]);
				if (!isProcessAlive(pid)) unlinkQuietly(this.file(name, ""));
			} else if (name.endsWith(".tmp")) {
				try {
					if (now - statSync(this.file(name, "")).mtimeMs > 60_000) unlinkQuietly(this.file(name, ""));
				} catch {
					// Renamed meanwhile.
				}
			}
		}
		return removed;
	}
}

function existsLock(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function unlinkQuietly(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Already gone.
	}
}
