// A lock between processes (several Pi processes share one agent dir): a directory that holds its
// holder's pid and that the holder touches every LOCK_HEARTBEAT_MS while it holds it. A lock whose
// holder's process ended is taken over at once; one not touched for STALE_LOCK_MS (a hung holder,
// or a reused pid) too. Taking over moves the abandoned lock aside with a rename first, so only one
// waiter wins it.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const LOCK_HEARTBEAT_MS = 2_000;
const STALE_LOCK_MS = 15_000;
const LOCK_OWNER = "pid";

/** Whether a process runs (a process of another user counts as running). */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Whether a lock was left by a holder that is gone: its process ended, or it stopped touching the lock. */
function abandoned(path: string): boolean {
	let touched: number;
	try {
		touched = statSync(path).mtimeMs;
	} catch {
		return false;
	}
	if (Date.now() - touched > STALE_LOCK_MS) return true;
	try {
		const pid = Number(readFileSync(join(path, LOCK_OWNER), "utf8"));
		return Number.isInteger(pid) && pid > 0 && !pidAlive(pid);
	} catch {
		// Just created, the pid not written yet.
		return false;
	}
}

/** Whether no live process holds the lock at `path` (looking only: it neither takes nor clears it). */
export function lockFree(path: string): boolean {
	return !existsSync(path) || abandoned(path);
}

/** Take the lock at `path`; returns its release, or undefined while another live process holds it. */
export function acquireLock(path: string): (() => void) | undefined {
	mkdirSync(dirname(path), { recursive: true });
	const take = () => {
		try {
			mkdirSync(path);
			return true;
		} catch {
			return false;
		}
	};
	if (!take()) {
		if (!abandoned(path)) return undefined;
		const aside = `${path}.abandoned.${process.pid}`;
		try {
			renameSync(path, aside);
		} catch {
			return undefined;
		}
		rmSync(aside, { recursive: true, force: true });
		if (!take()) return undefined;
	}
	writeFileSync(join(path, LOCK_OWNER), String(process.pid));
	const heartbeat = setInterval(() => {
		try {
			const now = new Date();
			utimesSync(path, now, now);
		} catch {
			// Taken over meanwhile; holders do idempotent work.
		}
	}, LOCK_HEARTBEAT_MS);
	heartbeat.unref();
	return () => {
		clearInterval(heartbeat);
		rmSync(path, { recursive: true, force: true });
	};
}
