// Type declarations for knip-snapshot.mjs (untyped .mjs imported from .ts
// tests).

export interface SnapshotDeps {
	/** Injectable git runner for tests; defaults to a real `git` child process. */
	git?: (args: string[]) => string;
	/** Where the copy is made; defaults to the OS temp directory. */
	tmpRoot?: string;
}

export function createKnipSnapshot(
	repoRoot: string,
	deps?: SnapshotDeps,
): { dir: string; files: number };

export function removeKnipSnapshot(dir: string): void;
