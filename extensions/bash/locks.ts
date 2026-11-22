// The `index.lock` a killed bash call's git left behind is removed.
//
// Git holds `<git dir>/index.lock` while it changes the index and removes it when done. A git
// killed meanwhile leaves it, and every later git that writes the index then fails ("Unable to
// create '…/index.lock': File exists", "cannot rebase: You have unstaged changes"): 2026-11-21,
// law-formalization, two `git commit`s killed by the tool's timeout each left
// `.git/worktrees/<wt>/index.lock`, which then blocked landing until someone removed it by hand.
//
// So when a call ends killed (timeout or abort), the lock of each git dir the call worked in (its
// working directory, every literal `cd <dir>` and `git -C <dir>` in the command) is removed when
// it was made during the call (modified at or after the call's start) and no process has it open
// (`lsof`). The result names each removal. A lock from before the call, or one a live git holds,
// is another git's and stays.

import { execFile } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { commandsIn, gitCommand } from "./commands.ts";
import { expandHome } from "./commit.ts";
import { withGitConfig } from "./git-env.ts";

/** The status line the bash tool ends a killed call's error with (timeout or abort). */
const KILLED = /(?:^|\n\n)(?:Command aborted|Command timed out after \d[^\n]*)$/;

/** Whether a bash call ended killed: its signal aborted, or its error says it timed out or was aborted. */
export const wasKilled = (error: unknown, signal: AbortSignal | undefined) => signal?.aborted === true || (error instanceof Error && KILLED.test(error.message));

/** The directories `source`, run in `cwd`, works in: `cwd`, and the literal targets of `cd <dir>` and `git -C <dir>` (relative to the `cd`s before). */
export function workDirs(source: string, cwd: string): string[] {
	const dirs = new Set([cwd]);
	let dir: string | undefined = cwd;
	for (const command of commandsIn(source)) {
		if (command.name === "cd") {
			const target = command.args.length === 1 && !command.args[0]!.includes("$") ? expandHome(command.args[0]!) : undefined;
			dir = target !== undefined && (dir !== undefined || isAbsolute(target)) ? resolve(dir ?? "/", target) : undefined;
			if (dir !== undefined) dirs.add(dir);
			continue;
		}
		const git = gitCommand(command);
		if (!git || git.dirs.length === 0 || git.dirs.some((d) => d.includes("$"))) continue;
		const targets = git.dirs.map(expandHome);
		if (dir !== undefined || targets.some(isAbsolute)) dirs.add(resolve(dir ?? "/", ...targets));
	}
	return [...dirs];
}

const run = (file: string, args: string[]) =>
	new Promise<{ code: number | null; stdout: string; missing: boolean }>((done) => {
		execFile(file, args, { encoding: "utf8", env: withGitConfig(process.env), timeout: 10_000 }, (error, stdout) => {
			const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
			done({ code, stdout, missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT" });
		});
	});

/** The git dir of `dir` (a worktree's own, `.git/worktrees/<name>`), if it is in a repository. */
async function gitDirOf(dir: string): Promise<string | undefined> {
	const { code, stdout } = await run("git", ["-C", dir, "rev-parse", "--absolute-git-dir"]);
	return code === 0 && stdout.trim() ? stdout.trim() : undefined;
}

/** Whether a process has `file` open; true when that cannot be told (no `lsof`, an error). */
export async function isHeld(file: string): Promise<boolean> {
	const { code, stdout, missing } = await run("lsof", ["-t", "--", file]);
	if (missing) return true;
	// lsof exits 1 when no process has the file open (also when the file is gone).
	return code === 0 ? stdout.trim() !== "" : code !== 1;
}

/** Remove the `index.lock` of each git dir of `dirs` that was made at or after `since` (ms) and that no process holds; returns the removed paths. */
export async function removeStaleLocks(dirs: readonly string[], since: number, held: (file: string) => Promise<boolean> = isHeld): Promise<string[]> {
	const gitDirs = new Set((await Promise.all(dirs.map(gitDirOf))).filter((d) => d !== undefined));
	const removed: string[] = [];
	for (const gitDir of gitDirs) {
		const lock = resolve(gitDir, "index.lock");
		let mtime: number;
		try {
			mtime = statSync(lock).mtimeMs;
		} catch {
			continue;
		}
		if (mtime < since || (await held(lock))) continue;
		rmSync(lock, { force: true });
		removed.push(lock);
	}
	return removed;
}

/** The note a killed call's result gets for the locks removed. */
export const locksText = (removed: readonly string[]) =>
	[
		`Removed the git index lock${removed.length === 1 ? "" : "s"} this killed command's git left behind (made during the command, held by no process), so later git commands do not fail on it:`,
		...removed.map((lock) => `- \`${lock}\``),
	].join("\n");
