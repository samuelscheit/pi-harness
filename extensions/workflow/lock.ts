// Who may change a working tree at once while agents run in it, process-wide per tree.
//
// An agent with `files` takes a shared lease: guarded agents run in parallel, and each one, after
// its run, reverts changes outside the files of every guarded agent that ran at the same time
// (`allowed()`), so parallel agents never revert each other's work. An agent that may write
// without `files` takes the tree exclusively: nothing else could tell its changes apart. Waiters
// are served in arrival order, so a waiting exclusive lease is not starved by shared ones.

export type LeaseMode = "shared" | "exclusive";

export interface Lease {
	/** The allowed paths of this lease and of every shared lease that overlapped it so far. */
	allowed(): string[];
	release(): void;
}

interface Holder {
	mode: LeaseMode;
	overlap: Set<string>;
	own: readonly string[];
}

export class WorkspaceLock {
	private readonly holders = new Set<Holder>();
	private readonly queue: { holder: Holder; grant: () => void }[] = [];

	acquire(mode: LeaseMode, own: readonly string[], signal?: AbortSignal): Promise<Lease> {
		const holder: Holder = { mode, overlap: new Set(own), own };
		return new Promise((resolve, reject) => {
			if (signal?.aborted) return reject(signal.reason);
			const onAbort = () => {
				const index = this.queue.findIndex((waiter) => waiter.holder === holder);
				if (index >= 0) this.queue.splice(index, 1);
				reject(signal!.reason);
				this.admit();
			};
			const grant = () => {
				signal?.removeEventListener("abort", onAbort);
				for (const other of this.holders) {
					for (const path of other.own) holder.overlap.add(path);
					for (const path of own) other.overlap.add(path);
				}
				this.holders.add(holder);
				let released = false;
				resolve({
					allowed: () => [...holder.overlap],
					release: () => {
						if (released) return;
						released = true;
						this.holders.delete(holder);
						this.admit();
					},
				});
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.queue.push({ holder, grant });
			this.admit();
		});
	}

	private admit(): void {
		while (this.queue.length) {
			const next = this.queue[0]!;
			const exclusiveHeld = [...this.holders].some((h) => h.mode === "exclusive");
			const free = next.holder.mode === "shared" ? !exclusiveHeld : this.holders.size === 0;
			if (!free) return;
			this.queue.shift();
			next.grant();
		}
	}
}

const locks = new Map<string, WorkspaceLock>();
/** The lock of a working tree (its repository root, or the directory outside one). */
export const workspaceLock = (root: string) => locks.get(root) ?? locks.set(root, new WorkspaceLock()).get(root)!;
