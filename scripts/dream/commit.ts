// Dreaming commits a rule without working in the checkout it changes. The commit is built from the
// branch's head with a temporary index (read-tree, hash-object, update-index, write-tree,
// commit-tree), then the branch is moved with `update-ref` against the head it was built on. So a
// commit that fails leaves the user's files and index exactly as they were, and a repository whose
// branch refuses direct moves (a reference-transaction hook that lets only its landing tool move
// `main`) is never edited: the commit stays on a branch of its own, `dream/<date>-<slug>`, for the
// user or a fixing pass to land the repository's own way. Only after the branch moved is the one
// changed file brought up to date in the checkout, and only while it still reads as before.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export const git = (repo: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}) =>
	execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", input: options.input, env: options.env, stdio: ["pipe", "pipe", "pipe"] }).trim();

const tryGit = (repo: string, args: string[]): string | undefined => {
	try {
		return git(repo, args);
	} catch {
		return undefined;
	}
};

/** The first line of what a failed command said: git's (or a hook's) stderr, else the error message. */
export function firstLine(error: unknown): string {
	const stderr = (error as { stderr?: unknown })?.stderr?.toString().trim();
	return (stderr || (error instanceof Error ? error.message : String(error))).split("\n")[0]!;
}

export const isRepository = (dir: string) => tryGit(dir, ["rev-parse", "--show-toplevel"]) !== undefined;

/** Uncommitted changes to `file` (staged or not, untracked, or deleted). */
export const dirty = (repo: string, file: string) => git(repo, ["status", "--porcelain", "--", file]) !== "";

export interface Committed {
	commit: string;
	/** Set when the checked-out branch did not move: the branch that holds the commit instead. */
	branch?: string;
	/** Why the checked-out branch did not move. */
	refused?: string;
}

/** `name`, or `name` with the first free numeric suffix, as a branch that does not exist yet. */
function freeBranch(root: string, name: string): string {
	for (let i = 1; ; i++) {
		const candidate = i === 1 ? name : `${name}-${i}`;
		if (tryGit(root, ["rev-parse", "-q", "--verify", `refs/heads/${candidate}`]) === undefined) return candidate;
	}
}

/**
 * Commit `content` as `file` (inside `repo`) on the checked-out branch, without touching the
 * checkout until the branch moved. The caller made sure `file` has no uncommitted changes.
 * `fallback` names the branch that keeps the commit when the checked-out branch refuses it.
 */
export function commitFile(repo: string, file: string, content: string, message: string, fallback: string): Committed {
	const root = git(repo, ["rev-parse", "--show-toplevel"]);
	const path = `${git(repo, ["rev-parse", "--show-prefix"])}${relative(repo, file)}`;
	const ref = tryGit(root, ["symbolic-ref", "-q", "HEAD"]);
	const old = tryGit(root, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
	const before = { content: existsSync(file) ? readFileSync(file, "utf8") : undefined, staged: git(root, ["ls-files", "-s", "--", path]) };

	const scratch = mkdtempSync(join(tmpdir(), "dream-index-"));
	let commit: string;
	try {
		const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
		git(root, old ? ["read-tree", old] : ["read-tree", "--empty"], { env });
		const blob = git(root, ["hash-object", "-w", "--stdin"], { input: content });
		const mode = (old && git(root, ["ls-tree", old, "--", path]).split(" ")[0]) || "100644";
		git(root, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`], { env });
		const tree = git(root, ["write-tree"], { env });
		commit = git(root, ["commit-tree", tree, ...(old ? ["-p", old] : []), "-F", "-"], { input: message });
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}

	const reflog = `dream: ${message.split("\n")[0]}`;
	let refused = "HEAD is detached";
	if (ref) {
		try {
			git(root, ["update-ref", "-m", reflog, ref, commit, old ?? ""]);
			refused = "";
		} catch (error) {
			refused = firstLine(error);
		}
	}
	if (!refused) {
		const unchanged = (existsSync(file) ? readFileSync(file, "utf8") : undefined) === before.content && git(root, ["ls-files", "-s", "--", path]) === before.staged;
		if (unchanged) git(root, ["checkout", commit, "--", path]);
		return { commit };
	}
	const branch = freeBranch(root, fallback);
	git(root, ["update-ref", "-m", reflog, `refs/heads/${branch}`, commit, ""]);
	return { commit, branch, refused };
}
