// The commands a bash command line runs, for the refusals before it runs (detach.ts, git.ts,
// commit.ts, gate.ts).
//
// The command is parsed with unbash (a Bash 5.3 parser; pi-lens installs it), so a command name in
// quoted text, a comment or a heredoc body does not count, while one behind wrappers (`nohup`,
// `env`, `sudo`), in an `&&` chain, a function, a `$(…)`, an `eval` or a literal `bash -c '…'`
// script does.

import { type Command, forEachChild, parse, type SyntaxNode } from "../../vendor/pi-lens/node_modules/unbash/dist/parser.js";
import { clip } from "../background/jobs.ts";

/** One command a command line runs: its name without a directory, its arguments after quote removal. */
export interface RunCommand {
	name: string;
	args: string[];
	/** The simple command as written (wrappers included). */
	text: string;
	/** Variables set for it: `X=1 cmd`, `env X=1 cmd`. */
	env: Record<string, string>;
}

/** Commands that run their arguments as a command. */
const WRAPPERS = new Set(["builtin", "caffeinate", "command", "env", "exec", "gtimeout", "nice", "nohup", "stdbuf", "sudo", "time", "timeout"]);
/** Words a wrapper takes before the command: options, `env` assignments and durations or priorities. */
const WRAPPER_ARGUMENT = /^(?:-.*|[A-Za-z_][A-Za-z0-9_]*=.*|\d+(?:\.\d+)?[smhd]?)$/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** The commands a simple command runs: its name, then the command each wrapper runs, with their arguments. */
export function unwrap(command: Command, text: string): RunCommand[] {
	const words = [command.name, ...command.args].flatMap((word) => (word?.type === "Word" ? [word.value] : []));
	const env: Record<string, string> = {};
	for (const part of command.prefix) if (part.type === "Assignment") env[part.name] = part.value?.type === "Word" ? part.value.value : "";
	const found: RunCommand[] = [];
	let i = 0;
	while (i < words.length) {
		const name = words[i]!.replace(/^.*\//, "");
		found.push({ name, args: words.slice(i + 1), text, env: { ...env } });
		if (!WRAPPERS.has(name)) break;
		i += 1;
		while (i < words.length && WRAPPER_ARGUMENT.test(words[i]!)) {
			const assignment = ASSIGNMENT.exec(words[i]!);
			if (name === "env" && assignment) env[assignment[1]!] = assignment[2]!;
			i += 1;
		}
	}
	return found;
}

/** The script a command runs as shell code, when it is literal text: `bash -c '…'` (also `-lc`, `-ec`), `eval …`. */
export function scriptOf({ name, args }: RunCommand): string | undefined {
	if (name === "eval") return args.join(" ");
	if (!SHELLS.has(name)) return undefined;
	const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
	return flag < 0 ? undefined : args[flag + 1];
}

/** Every command `source` runs, wrappers and the commands they run included, in source order. */
export function commandsIn(source: string): RunCommand[] {
	const found: RunCommand[] = [];
	const visit = (node: SyntaxNode) => {
		if (node.type === "Command") {
			for (const command of unwrap(node, source.slice(node.pos, node.end))) {
				found.push(command);
				const script = scriptOf(command);
				if (script !== undefined) found.push(...commandsIn(script));
			}
		}
		forEachChild(node, visit);
	};
	visit(parse(source));
	return found;
}

/** A `git` command: the directories its `-C` options name (each relative to the one before), its subcommand and that one's arguments. */
export interface GitCommand {
	dirs: string[];
	subcommand: string;
	args: string[];
	command: RunCommand;
}

/** Git's options before the subcommand that take the next word as their value. */
const GIT_VALUED = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"]);

export function gitCommand(command: RunCommand): GitCommand | undefined {
	if (command.name !== "git") return undefined;
	const { args } = command;
	const dirs: string[] = [];
	let i = 0;
	while (i < args.length && args[i]!.startsWith("-")) {
		if (args[i] === "-C") dirs.push(args[i + 1] ?? ".");
		i += args[i] === "-C" || GIT_VALUED.has(args[i]!) ? 2 : 1;
	}
	const subcommand = args[i];
	return subcommand === undefined ? undefined : { dirs, subcommand, args: args.slice(i + 1), command };
}

/**
 * The tool result of a refused command: what it does, the commands that do it (each once, clipped),
 * then why it is refused and what to do instead.
 */
export function refusalText(does: string, commands: readonly string[], ...lines: string[]): string {
	return [`Not run: this command ${does}:`, ...[...new Set(commands)].map((c) => `- \`${clip(c, 120)}\``), ...lines].join("\n");
}
