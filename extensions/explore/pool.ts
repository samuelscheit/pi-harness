// Explorer pools: per calling session and working directory, up to POOL_SIZE explorers. An idle
// explorer is reused (it remembers earlier questions and its prompt cache stays warm); parallel
// calls get one explorer each, and a call beyond the pool's size waits for one. Shared by the
// in-process explorers (explorer.ts) and the t3 ones (t3-explorer.ts). The pools live in process
// state, so a harness reload (which evaluates extensions anew) keeps them.

export const POOL_SIZE = 4;

export interface Member {
	busy: boolean;
}

export interface Pool<T extends Member> {
	members: T[];
	/** Calls waiting for a member to become idle. */
	waiting: (() => void)[];
}

export const poolKey = (sessionId: string, cwd: string) => `${sessionId}\0${cwd}`;

/** The pool of `key` in `pools`, created empty. */
export const poolOf = <T extends Member>(pools: Map<string, Pool<T>>, key: string): Pool<T> => pools.get(key) ?? pools.set(key, { members: [], waiting: [] }).get(key)!;

/**
 * Claims an idle member, a new one (`create`) while the pool has room, else the next one to become
 * idle. The claim (busy) is set here, before the caller's `await` of this function resumes: set
 * after it, a parallel call ran in between, found the same member idle, and its prompt failed with
 * "Agent is already processing a prompt" (2026-11-22, two parallel explore calls).
 */
export async function acquire<T extends Member>(pool: Pool<T>, create: () => T, signal?: AbortSignal): Promise<T> {
	for (;;) {
		signal?.throwIfAborted();
		const idle = pool.members.find((m) => !m.busy);
		if (idle) {
			idle.busy = true;
			return idle;
		}
		if (pool.members.length < POOL_SIZE) {
			const member = create();
			member.busy = true;
			pool.members.push(member);
			return member;
		}
		await new Promise<void>((resolve, reject) => {
			pool.waiting.push(resolve);
			signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	}
}

/** Free a member: the next waiting call gets it. */
export function release<T extends Member>(pool: Pool<T>, member: T): void {
	member.busy = false;
	pool.waiting.shift()?.();
}

/** Drop a member that cannot serve again; a waiting call may create a new one. */
export function remove<T extends Member>(pool: Pool<T>, member: T): void {
	const i = pool.members.indexOf(member);
	if (i >= 0) pool.members.splice(i, 1);
	pool.waiting.shift()?.();
}

/** Take the pools of a calling session (it ended): removed from `pools`, returned for disposal. */
export function takePools<T extends Member>(pools: Map<string, Pool<T>>, sessionId: string): Pool<T>[] {
	const taken: Pool<T>[] = [];
	for (const [key, pool] of pools) {
		if (!key.startsWith(`${sessionId}\0`)) continue;
		pools.delete(key);
		taken.push(pool);
	}
	return taken;
}
