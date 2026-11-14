/**
 * Named locks shared by every process of one machine, as files in one directory: `<key>.lock`,
 * opened with `wx`, holds the holder's pid and start time. Processes waiting for a lock register
 * `<key>.wait-<pid>-<random>` files, so the holder can see whether others wait for its result
 * (fork bases prime the cache for them, templates rebuild once for all). A lock whose holder died,
 * or that is older than ten minutes, is taken over.
 */
import { randomBytes } from "node:crypto";
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
import { isProcessAlive } from "./prefix-cache.ts";

/** A lock older than this is taken over even when its holder still runs (its task hung). */
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_POLL_MS = 100;

export class FileLocks {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	private file(name: string): string {
		return join(this.dir, name);
	}

	/** Whether someone holds the lock now. */
	held(key: string): boolean {
		try {
			statSync(this.file(`${key}.lock`));
			return true;
		} catch {
			return false;
		}
	}

	/** Processes other than the caller (`own`: its waiter name) waiting for the lock. */
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
	 * Run `task` holding the lock, waiting for other holders. While it waits, the caller is counted
	 * in `waiters`; `task` gets the caller's waiter name, to leave itself out of that count.
	 */
	async withLock<T>(key: string, task: (self: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
		mkdirSync(this.dir, { recursive: true });
		const lock = this.file(`${key}.lock`);
		const waiter = `${key}.wait-${process.pid}-${randomBytes(4).toString("hex")}`;
		writeFileSync(this.file(waiter), "");
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
			unlinkQuietly(this.file(waiter));
		}
		try {
			return await task(waiter);
		} finally {
			unlinkQuietly(lock);
		}
	}

	/** Remove wait files of processes that died. */
	pruneWaiters(): void {
		for (const name of this.list()) {
			if (!name.includes(".wait-")) continue;
			const pid = Number(name.split(".wait-")[1]?.split("-")[0]);
			if (!isProcessAlive(pid)) unlinkQuietly(this.file(name));
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
}

export function unlinkQuietly(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Already gone.
	}
}
