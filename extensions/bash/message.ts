// A commit or tag that reads its message from a file is refused before a bash command runs.
//
// 2026-11-15, four sessions: agents wrote commit messages to fixed names in the shared /tmp
// (`/tmp/msg.txt`, `/tmp/c5.txt`, `/tmp/msg2.md`, `/tmp/t3-msg.txt`) and ran `git commit -F
// /tmp/<file>` a few tool calls later. Parallel agents on the same machine picked the same names and
// overwrote each other's file in between, so commits went out with another agent's message and had
// to be amended. The prompt's rule ("commit via -F") invited the file, and rewording it did not stop
// the agents, so the tool refuses the form: `git commit`, `git commit-tree` and `git tag` whose
// `-F`/`--file` names a file (`-F f`, `-Ff`, `-aF f`, `--file=f`), or names stdin (`-` or
// `/dev/stdin`) redirected from a file (`-F - < f`). The message goes on stdin from a heredoc in the
// same command, which no other agent can touch. Without `-e`, git's cleanup for a message from `-F`
// is `whitespace`, so lines starting with `#` (a `## Why` heading) are kept.
//
// Not refused: a file piped in (`cat f | git commit -F -`); a message edited in an editor (`-e`,
// `git rebase -i` reword), whose `strip` cleanup drops `#` lines: telling a script editor from a
// person's, or a message with headings from one without, is not possible from the command line.

import { commandsIn, gitCommand, gitOptions, refusalText } from "./commands.ts";
import { COMMIT_VALUED_LONG, COMMIT_VALUED_SHORT } from "./commit.ts";

/** The git subcommands that take a message with `-F`, and their options that take a value. */
const MESSAGE_SUBCOMMANDS: Record<string, { long: ReadonlySet<string>; short: ReadonlySet<string> }> = {
	commit: { long: COMMIT_VALUED_LONG, short: COMMIT_VALUED_SHORT },
	"commit-tree": { long: new Set(), short: new Set(["p", "m", "F"]) },
	tag: {
		long: new Set(["--message", "--file", "--local-user", "--cleanup", "--format", "--sort", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--trailer"]),
		short: new Set(["m", "F", "u"]),
	},
};

const STDIN = new Set(["-", "/dev/stdin"]);

/** Why `source` is refused, when a commit or tag in it reads its message from a file; undefined otherwise. */
export function messageFileRefusal(source: string): string | undefined {
	const refused: string[] = [];
	for (const command of commandsIn(source)) {
		const git = gitCommand(command);
		const valued = git && MESSAGE_SUBCOMMANDS[git.subcommand];
		if (!valued) continue;
		const { values } = gitOptions(git.args, valued.long, valued.short);
		const files = [...(values.get("F") ?? []), ...(values.get("--file") ?? [])];
		if (files.some((file) => !STDIN.has(file) || command.stdin !== undefined)) refused.push(command.text);
	}
	if (refused.length === 0) return undefined;
	return refusalText(
		"reads a commit or tag message from a file",
		refused,
		"A message file is written in one call and read in a later one, and parallel agents on this machine pick the same names (`/tmp/msg.txt`): on 2026-11-15 they overwrote each other's files in between, and commits went out with another agent's message.",
		"Pass the message on stdin from a quoted heredoc in the same command, never through a file:",
		"```",
		"git commit --only <paths> -F - <<'EOF'",
		"<type>(<scope>): <title>",
		"",
		"<body>",
		"EOF",
		"```",
		"The same works for `git commit --amend -F -`, `git tag -a <name> -F -` and `git commit-tree -F -`. Without `-e` git keeps lines starting with `#` (such as `## Why`) in a message from `-F -`.",
	);
}
