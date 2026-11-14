// scripts/lib/knip-snapshot.mjs
//
// The tree knip analyses: a temporary copy of the checkout's tracked files
// plus its untracked, non-ignored files (the working tree as git would commit
// it), with `node_modules` linked in. Gitignored build output never enters it.
//
// Why a copy. `npm run build` (tsc, no `outDir`) writes `clients/x.js` beside
// every `clients/x.ts`. Every source imports its siblings with a `.js`
// specifier, and knip's resolver tries the literal `.js` file before the
// `.ts` source and does not gitignore-filter a resolved target, so on a built
// tree its graph walks into the compiled copies and reports the sources as
// unused (491 files, #2698). The first fix deleted those compiled siblings in
// the checkout before knip ran. In a checkout shared by several agents that
// broke their running vitest suites (the stale-build guard rejects a missing
// twin) until someone rebuilt: 558 files purged on 2026-11-14. It also only
// purged a `.js` beside a TRACKED `.ts`, so a new, untracked source kept its
// compiled twin and was reported unused although imported. A copy that holds
// no ignored file has neither problem and never touches the checkout.
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const GIT_MAX_BUFFER = 16 * 1024 * 1024;
// Far above any real listing; fires only on a wedged git (#2698 r3).
const GIT_TIMEOUT_MS = 60_000;

/**
 * @typedef {{
 *   git?: (args: string[]) => string,
 *   tmpRoot?: string,
 * }} SnapshotDeps `git` is an injectable git runner (tests); `tmpRoot` is
 *   where the copy is made (default: the OS temp directory).
 */

/**
 * @param {string} repoRoot
 * @param {SnapshotDeps} [deps]
 * @returns {{ dir: string, files: number }} the copy and how many files it holds.
 *   Throws when git cannot list the tree; a partial copy is removed first.
 */
export function createKnipSnapshot(repoRoot, deps = {}) {
	const git =
		deps.git ??
		((args) =>
			execFileSync("git", args, {
				cwd: repoRoot,
				encoding: "utf-8",
				shell: false,
				maxBuffer: GIT_MAX_BUFFER,
				timeout: GIT_TIMEOUT_MS,
				killSignal: "SIGKILL",
			}));
	const listed = git([
		"ls-files",
		"-z",
		"--cached",
		"--others",
		"--exclude-standard",
	]);
	const dir = mkdtempSync(
		path.join(deps.tmpRoot ?? os.tmpdir(), "pi-lens-knip-"),
	);
	try {
		let files = 0;
		for (const relPath of new Set(listed.split("\0").filter(Boolean))) {
			const source = path.join(repoRoot, relPath);
			// A tracked file deleted in the working tree is not part of it.
			if (!existsSync(source)) continue;
			const target = path.join(dir, relPath);
			mkdirSync(path.dirname(target), { recursive: true });
			copyFileSync(source, target);
			files += 1;
		}
		const modules = path.join(repoRoot, "node_modules");
		if (existsSync(modules))
			symlinkSync(modules, path.join(dir, "node_modules"), "junction");
		return { dir, files };
	} catch (err) {
		removeKnipSnapshot(dir);
		throw err;
	}
}

/** Remove a copy made by {@link createKnipSnapshot} (the link, not its target). */
export function removeKnipSnapshot(dir) {
	rmSync(dir, { recursive: true, force: true });
}
