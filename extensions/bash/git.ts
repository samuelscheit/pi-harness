// Git commands that throw away uncommitted work are refused before a bash command runs.
//
// Agents share checkouts (a delegated child with shared isolation, parallel threads) and a
// repository's worktrees share its stash. Commands that discard or move every uncommitted change
// take other agents' unfinished work with them:
// - 2026-11-14, pi-harness: a child ran `git stash` after its commit and took the uncommitted edits
//   of the coordinator and another child out of the checkout;
// - 2026-11-14, law-formalization, two sessions: `git stash; <measure>; git stash pop` in a git
//   worktree; the stash list is shared by all worktrees of a repository, so `stash@{0}` was
//   another package's work. A written rule did not stop the second one.
// So the tool refuses them: `git stash` except `list` and `show`, `git reset --hard`, `git clean`
// with `-f`, and discards of the whole tree (`git checkout -- .`, `git checkout -f`,
// `git restore .`, `git switch --discard-changes`). Each refusal names the safe way: a separate
// worktree for a clean state, the own paths for a commit or a restore.

import { commandsIn, type GitCommand, gitCommand, refusalText } from "./commands.ts";

type Kind = "stash" | "reset" | "clean" | "discard";

/** Pathspecs that name the whole tree (or the whole current directory). */
const WHOLE_TREE = /^(?:\.\/?|\*|:\/?\*?|:\/\.|:\(top\)\*?)$/;
/** A short option cluster (`-xdf`) that contains `letter`. */
const shortHas = (arg: string, letter: string) => /^-[A-Za-z]+$/.test(arg) && arg.includes(letter);
const has = (args: readonly string[], long: string, short?: string) => args.some((arg) => arg === long || (short !== undefined && shortHas(arg, short)));
/** The arguments after `--`, or every one that is not an option. */
const pathspecs = (args: readonly string[]) => {
	const split = args.indexOf("--");
	return split >= 0 ? args.slice(split + 1) : args.filter((arg) => !arg.startsWith("-"));
};

function kindOf({ subcommand, args }: GitCommand): Kind | undefined {
	switch (subcommand) {
		case "stash":
			return args[0] === "list" || args[0] === "show" ? undefined : "stash";
		case "reset":
			return args.includes("--hard") ? "reset" : undefined;
		case "clean":
			return has(args, "--force", "f") && !has(args, "--dry-run", "n") ? "clean" : undefined;
		case "checkout":
			return has(args, "--force", "f") || pathspecs(args).some((p) => WHOLE_TREE.test(p)) ? "discard" : undefined;
		case "restore": {
			const stagedOnly = has(args, "--staged", "S") && !has(args, "--worktree", "W");
			return !stagedOnly && pathspecs(args).some((p) => WHOLE_TREE.test(p)) ? "discard" : undefined;
		}
		case "switch":
			return has(args, "--discard-changes") || has(args, "--force", "f") ? "discard" : undefined;
		default:
			return undefined;
	}
}

const CLEAN_STATE = "For a clean state (to measure, test or build without the changes), use a separate worktree: `git worktree add /tmp/<name> HEAD`, then `git worktree remove /tmp/<name>`.";
const SHARED = "Other agents may work in this checkout or in another worktree of this repository.";

const MESSAGES: Record<Kind, { does: string; lines: string[] }> = {
	stash: {
		does: "runs `git stash`",
		lines: [
			`\`git stash\` takes every uncommitted change out of the working tree, other agents' too, and the stash list is shared by every worktree of the repository, so \`stash@{0}\` may be another agent's work. ${SHARED}`,
			CLEAN_STATE,
			"To keep your own work aside, commit only your paths (`git commit --only <your paths>`), or as a WIP commit on a branch in a worktree. `git stash list` and `git stash show` still run.",
		],
	},
	reset: {
		does: "runs `git reset --hard`",
		lines: [
			`\`git reset --hard\` discards every uncommitted change in the working tree, other agents' too. ${SHARED}`,
			CLEAN_STATE,
			"To move the branch but keep the working tree, use `git reset --soft <commit>` or `git reset <commit>`; to undo your own changes, restore only your paths: `git restore <your paths>`.",
		],
	},
	clean: {
		does: "runs `git clean` with `-f`",
		lines: [
			`\`git clean -f\` deletes every untracked file, other agents' new files too. ${SHARED}`,
			"Delete the files you made by name (`rm <path>`); `git status --short` lists the untracked ones and `git clean -n` shows what it would delete.",
			CLEAN_STATE,
		],
	},
	discard: {
		does: "discards the changes of the whole tree",
		lines: [
			`Checking out or restoring the whole tree (\`.\`, \`:/\`, \`-f\`, \`--discard-changes\`) throws away the uncommitted changes in every file, other agents' too. ${SHARED}`,
			"Restore only the paths you changed: `git restore <your paths>`.",
			CLEAN_STATE,
		],
	},
};

/** Why `source` is refused, when it runs a git command that discards uncommitted work; undefined otherwise. */
export function gitRefusal(source: string): string | undefined {
	const found = new Map<Kind, string[]>();
	for (const command of commandsIn(source)) {
		const git = gitCommand(command);
		const kind = git && kindOf(git);
		if (kind) found.set(kind, [...(found.get(kind) ?? []), command.text]);
	}
	if (found.size === 0) return undefined;
	return [...found].map(([kind, commands]) => refusalText(MESSAGES[kind].does, commands, ...MESSAGES[kind].lines)).join("\n\n");
}
