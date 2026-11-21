// A push or commit that does not do what it says because HEAD is detached or on another branch is
// refused before a bash command runs.
//
// - `git push origin main` pushes the LOCAL branch `main`, not HEAD. On a detached HEAD (or on
//   another branch) it silently pushes the old `main` ("Everything up-to-date", or nothing printed),
//   and the commit the agent just made never leaves the machine: in a submodule-bump flow an agent
//   committed on a detached HEAD, `git push origin main` printed nothing and the deploy failed.
// - A `git commit` on a detached HEAD lands on no branch: the next checkout orphans it.
// The state is read from the repository when the command is checked (`git -C <dir>` and a literal
// `cd <dir> &&` before it are followed). Not refused: a push without a refspec (`git push`,
// `git push origin`), `git push origin HEAD:main`, `HEAD`, a sha, a tag, a deletion (`:branch`) or a
// full ref (`refs/heads/main`: an explicit wish to push that branch); a push of the branch HEAD is
// on; any check after an earlier `git checkout`/`switch`/`rebase`/… of the same command (the
// state is then unknown); commits during a rebase, cherry-pick, revert, merge or bisect (HEAD is
// detached by design); a commit run as `PI_DETACHED_COMMIT=1 git commit …` (a submodule bump, a
// deliberate detached commit).

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { COMMIT_VALUED_LONG, COMMIT_VALUED_SHORT, expandHome, git as runGit } from "./commit.ts";
import { commandsIn, gitCommand, gitOptions, refusalText } from "./commands.ts";

/** The variable that runs a commit on a detached HEAD. */
export const DETACHED_COMMIT = "PI_DETACHED_COMMIT";

/** Git subcommands after which the checked-out branch is unknown (they may move HEAD). */
const MOVES_HEAD = new Set(["checkout", "switch", "rebase", "reset", "merge", "pull", "cherry-pick", "revert", "bisect", "am", "worktree", "submodule", "clone", "init"]);

const PUSH_VALUED_LONG = new Set(["--repo", "--receive-pack", "--exec", "--push-option"]);
const PUSH_VALUED_SHORT = new Set(["o"]);

/** Where HEAD is in `dir`: the branch, null when detached, undefined when `dir` is no repository. */
export interface HeadState {
	branch: string | null;
	/** A rebase, cherry-pick, revert, merge or bisect is in progress. */
	busy: boolean;
}

export function headState(dir: string): HeadState | undefined {
	const gitDir = runGit(dir, ["rev-parse", "--absolute-git-dir"])?.trim();
	if (!gitDir) return undefined;
	const branch = runGit(dir, ["symbolic-ref", "-q", "--short", "HEAD"])?.trim() || null;
	const busy = ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "MERGE_HEAD", "BISECT_LOG"].some((name) => existsSync(join(gitDir, name)));
	return { branch, busy };
}

const isLocalBranch = (dir: string, name: string) => runGit(dir, ["rev-parse", "-q", "--verify", `refs/heads/${name}`]) !== undefined;
const where = (state: HeadState) => (state.branch === null ? "HEAD is detached" : `HEAD is on \`${state.branch}\``);

/** The local branches (as written) a push's refspecs would push, though they are not what HEAD points to. */
function mispushed(dir: string, state: HeadState, args: readonly string[]): string[] {
	const { flags, pathspecs } = gitOptions(args, PUSH_VALUED_LONG, PUSH_VALUED_SHORT);
	if (flags.has("--all") || flags.has("--mirror") || flags.has("--tags") || flags.has("--delete") || flags.has("d") || flags.has("--dry-run") || flags.has("n")) return [];
	const found: string[] = [];
	for (const spec of pathspecs.slice(1)) {
		const src = spec.replace(/^\+/, "").split(":")[0]!;
		if (src === "" || src === "HEAD" || src.startsWith("refs/") || src === state.branch) continue;
		if (isLocalBranch(dir, src)) found.push(src);
	}
	return found;
}

/** Why `source`, run in `cwd`, is refused for a push or commit that ignores where HEAD is; undefined otherwise. */
export function headRefusal(source: string, cwd: string): string | undefined {
	let dir = cwd;
	let unknown = false;
	const pushes: { text: string; lines: string[] }[] = [];
	const commits: { text: string; state: HeadState }[] = [];
	for (const command of commandsIn(source)) {
		if (command.name === "cd") {
			if (command.args.length === 1 && !command.args[0]!.includes("$")) dir = resolve(dir, expandHome(command.args[0]!));
			else unknown = true;
			continue;
		}
		const git = gitCommand(command);
		if (!git) continue;
		if (MOVES_HEAD.has(git.subcommand)) unknown = true;
		if (unknown || (git.subcommand !== "push" && git.subcommand !== "commit")) continue;
		const at = resolve(dir, ...git.dirs.map(expandHome));
		if (git.dirs.some((d) => d.includes("$")) || !isAbsolute(at)) continue;
		const state = headState(at);
		if (!state) continue;
		if (git.subcommand === "commit") {
			const { flags } = gitOptions(git.args, COMMIT_VALUED_LONG, COMMIT_VALUED_SHORT);
			if (state.branch === null && !state.busy && !command.env[DETACHED_COMMIT] && !flags.has("--dry-run")) commits.push({ text: command.text, state });
			continue;
		}
		for (const branch of mispushed(at, state, git.args)) pushes.push({ text: command.text, lines: [`${where(state)}: this pushes the local branch \`${branch}\`, not your commit.`] });
	}
	const parts: string[] = [];
	if (pushes.length > 0)
		parts.push(
			refusalText(
				"pushes a local branch that is not what HEAD points to",
				pushes.map((p) => p.text),
				...[...new Set(pushes.flatMap((p) => p.lines))],
				"`git push <remote> <branch>` pushes the branch ref, not HEAD: on a detached HEAD or another branch it pushes the old branch (\"Everything up-to-date\", nothing printed) and your commit stays local; a deploy that waits for it never starts.",
				"Push HEAD explicitly: `git push <remote> HEAD:<branch>`; or check out the branch first (`git switch <branch>`, after `git branch -f <branch> HEAD` / a merge if the commit is not on it). To push the branch itself on purpose, write its full ref: `git push <remote> refs/heads/<branch>`.",
			),
		);
	if (commits.length > 0)
		parts.push(
			refusalText(
				"commits on a detached HEAD",
				commits.map((c) => c.text),
				"HEAD is detached: the commit belongs to no branch, the next checkout leaves it unreachable, and `git push <remote> <branch>` will not push it.",
				"Check out a branch first (`git switch <branch>`, or `git switch -c <new-branch>` to keep the work), then commit.",
				`If the detached commit is deliberate (a submodule bump you push as \`HEAD:<branch>\`), run it as \`${DETACHED_COMMIT}=1 git commit …\`.`,
			),
		);
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}
