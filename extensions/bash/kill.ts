// Killing processes by name is refused before a bash command runs.
//
// Agents share a machine with other agents, and `pkill -f <pattern>`, `pkill <name>` and
// `killall <name>` match every process of every user session by name or command line, not only the
// ones the command started. An agent ran `pkill -f "kernel serve" -P 1` to stop its own orphaned
// kernel: it also matches (and kills) the kernels of every other agent on the machine.
// Refused: `pkill`, `killall`, `skill` and `killall5`, behind wrappers (`sudo pkill`),
// in chains, `$(…)`, `bash -c '…'` and loops; text in quotes (`grep pkill`, `echo "pkill -f x"`,
// a commit message) is not a command and runs. `pgrep` (it only lists) and `kill <pid>` run.

import { commandsIn, refusalText } from "./commands.ts";

const BY_NAME = new Set(["pkill", "killall", "killall5", "skill"]);

/** The commands in `source` that kill processes by name. */
export const killsByName = (source: string): string[] => commandsIn(source).flatMap((command) => (BY_NAME.has(command.name) ? [command.text] : []));

/** Why `source` is refused, when it kills processes by name; undefined otherwise. */
export function killRefusal(source: string): string | undefined {
	const kills = killsByName(source);
	if (kills.length === 0) return undefined;
	return refusalText(
		"kills processes by name or command line",
		kills,
		"`pkill`/`killall` match every process on this machine, other agents' included (an agent ran `pkill -f \"kernel serve\" -P 1` to stop its own orphaned kernel and would have taken every other agent's kernels with it).",
		"Kill only your own processes by pid: `kill <pid>`. The bash tool reports the processes a command left running with their pids (`Left running …: pid N`); for others, list candidates with `pgrep -fl <pattern>` (or `ps -o pid,ppid,command -p <pid>`), check each is yours (your command, your cwd, started by you), then `kill <pid> [<pid>…]`.",
	);
}
