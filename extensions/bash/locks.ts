// The `index.lock` a killed bash call's git left behind is removed.
//
// Git holds `<git dir>/index.lock` while it changes the index and removes it when done. A git
// killed meanwhile leaves it, and every later git that writes the index then fails ("Unable to
// create '…/index.lock': File exists", "cannot rebase: You have unstaged changes"): 2026-11-21,
// law-formalization, two `git commit`s killed by the tool's timeout each left
// `.git/worktrees/<wt>/index.lock`, which then blocked landing until someone removed it by hand.
//
// So when a call ends killed (timeout or abort) while a git ran in its process group (a `ps`
// snapshot taken right before the kill: {@link groupRunsGit}), the lock of each git dir the call
// worked in (its working directory, every literal `cd <dir>` and `git -C <dir>` in the command) is
// removed when all of these hold:
// - it was made during the call (modified at or after the call's start): an older one is another git's;
// - no process has it open (`lsof`);
// - no other running git works in that repository ({@link gitWorksIn}): `git commit -a`/`--only`
//   closes its lock while its hooks run, and in a shared checkout those run tests for minutes, so
//   `lsof` alone would let a parallel agent's killed call delete a live commit's lock.
// Whatever cannot be told (no `lsof` or `ps`, an unknown work tree) keeps the lock. The result
// names each removal.

import { execFile, spawnSync } from "node:child_process";
import { readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { commandsIn, gitCommand } from "./commands.ts";
import { expandHome } from "./commit.ts";
import { withGitConfig } from "./git-env.ts";
import { isHelperDaemon } from "./leftovers.ts";

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

/** A command line that runs git (`git`, `/usr/bin/git`, `git-remote-https`, …), not one of its helper daemons. */
const GIT_PROGRAM = /^(?:\S*\/)?git(?:-\S+)?$/;
const isGit = (args: string) => GIT_PROGRAM.test(args.trimStart().split(/\s/, 1)[0]!) && !isHelperDaemon(args);

/** `ps` rows of `pid`/`pgid` (the first column) and the command line. */
const psRows = (stdout: string) => stdout.split("\n").flatMap((line) => {
	const match = /^\s*(\d+)\s+(.*)$/.exec(line);
	return match ? [{ id: Number(match[1]), args: match[2]! }] : [];
});

/**
 * Whether a git process runs in process group `pgid` now. Synchronous, so a timer or abort listener
 * registered before the bash tool's own runs it before the tool kills the group.
 */
export function groupRunsGit(pgid: number): boolean {
	const ps = spawnSync("ps", ["-A", "-o", "pgid=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return ps.status === 0 && psRows(ps.stdout).some((row) => row.id === pgid && isGit(row.args));
}

/** A repository a call worked in: its git dir (a worktree's own, `.git/worktrees/<name>`) and its work tree (undefined: unknown). */
export interface Repository {
	gitDir: string;
	root: string | undefined;
}

const real = (path: string) => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};

/** The repository `dir` is in, if any. */
async function repositoryOf(dir: string): Promise<Repository | undefined> {
	const [gitDir, top] = await Promise.all([run("git", ["-C", dir, "rev-parse", "--absolute-git-dir"]), run("git", ["-C", dir, "rev-parse", "--show-toplevel"])]);
	if (gitDir.code !== 0 || !gitDir.stdout.trim()) return undefined;
	const path = gitDir.stdout.trim();
	return { gitDir: real(path), root: top.code === 0 && top.stdout.trim() ? real(top.stdout.trim()) : workTreeOf(path) };
}

/** The work tree of a git dir when git does not say (`dir` was inside it): `<root>/.git`, or a worktree's `gitdir` file. */
function workTreeOf(gitDir: string): string | undefined {
	if (basename(gitDir) === ".git") return real(dirname(gitDir));
	try {
		return real(dirname(readFileSync(resolve(gitDir, "gitdir"), "utf8").trim()));
	} catch {
		return undefined;
	}
}

const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/**
 * Whether a running git (outside process group `ignore`, the killed call's) works in `repo`: its
 * working directory is in the work tree or the git dir (git changes to the work tree's top when it
 * starts). Helper daemons (fsmonitor) do not count. True when that cannot be told.
 */
export async function gitWorksIn(repo: Repository, ignore?: number): Promise<boolean> {
	if (repo.root === undefined) return true;
	const lsof = await run("lsof", ["-a", "-c", "/^git(-|$)/", "-d", "cwd", "-F", "pgn"]);
	// lsof exits 1 when no process matches.
	if (lsof.missing || (lsof.code !== 0 && lsof.code !== 1)) return true;
	const pids: number[] = [];
	let pid = 0;
	let pgid = 0;
	for (const line of lsof.stdout.split("\n")) {
		const value = line.slice(1);
		if (line[0] === "p") pid = Number(value);
		else if (line[0] === "g") pgid = Number(value);
		else if (line[0] === "n" && pgid !== ignore && (within(value, repo.root) || within(value, repo.gitDir))) pids.push(pid);
	}
	if (pids.length === 0) return false;
	const ps = await run("ps", ["-o", "pid=,args=", "-p", pids.join(",")]);
	// ps exits 1 when none of the processes runs any more.
	if (ps.missing || (ps.code !== 0 && ps.code !== 1)) return true;
	return psRows(ps.stdout).some((row) => pids.includes(row.id) && isGit(row.args));
}

/** Whether a process has `file` open; true when that cannot be told (no `lsof`, an error). */
export async function isHeld(file: string): Promise<boolean> {
	const { code, stdout, missing } = await run("lsof", ["-t", "--", file]);
	if (missing) return true;
	// lsof exits 1 when no process has the file open (also when the file is gone).
	return code === 0 ? stdout.trim() !== "" : code !== 1;
}

export interface StaleLockChecks {
	/** The killed call's process group: its own (dying) git does not count as another's. */
	ignoreGroup?: number;
	held?: (file: string) => Promise<boolean>;
	busy?: (repo: Repository) => Promise<boolean>;
}

/**
 * Remove the `index.lock` of each git dir of `dirs` that was made at or after `since` (ms), that no
 * process holds and whose repository no other git works in; returns the removed paths.
 */
export async function removeStaleLocks(dirs: readonly string[], since: number, { ignoreGroup, held = isHeld, busy = (repo) => gitWorksIn(repo, ignoreGroup) }: StaleLockChecks = {}): Promise<string[]> {
	const repos = new Map<string, Repository>();
	for (const repo of await Promise.all(dirs.map(repositoryOf))) if (repo) repos.set(repo.gitDir, repo);
	const removed: string[] = [];
	for (const repo of repos.values()) {
		const lock = resolve(repo.gitDir, "index.lock");
		let mtime: number;
		try {
			mtime = statSync(lock).mtimeMs;
		} catch {
			continue;
		}
		if (mtime < since || (await held(lock)) || (await busy(repo))) continue;
		rmSync(lock, { force: true });
		removed.push(lock);
	}
	return removed;
}

/** The note a killed call's result gets for the locks removed. */
export const locksText = (removed: readonly string[]) =>
	[
		`Removed the git index lock${removed.length === 1 ? "" : "s"} this killed command's git left behind (made during the command, held by no process, no other git running in the repository), so later git commands do not fail on it:`,
		...removed.map((lock) => `- \`${lock}\``),
	].join("\n");
