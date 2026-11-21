// The commands a bash command line runs, for the refusals before it runs (detach.ts, git.ts,
// commit.ts, gate.ts, wait.ts).
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
	/** The file its standard input is redirected from (`< file`, `0< file`), if any; heredocs and here-strings are not files. */
	stdin?: string;
	/** It runs in a background job: under a list item ended by `&` (`cmd &`, `( … ) &`, `{ …; } &`) or a `coproc`. */
	background?: boolean;
	/** The innermost loop (`while`, `until`, `for`, `select`) it runs in, clause or body; one node per loop. */
	loop?: SyntaxNode;
	/** Every loop it runs in, outermost first (`loop` is the last). */
	loops?: SyntaxNode[];
}

/** Where a command runs: in a background job, in a loop. */
type Context = Pick<RunCommand, "background" | "loop" | "loops">;
const LOOPS = new Set(["While", "For", "ArithmeticFor", "Select"]);

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
	const stdin = command.redirects
		.flatMap((r) => (r.type === "Redirect" && r.operator === "<" && (r.descriptor === undefined || (r.descriptor.type === "FileDescriptor" && r.descriptor.value === 0)) && r.target ? [r.target.value] : []))
		.at(-1);
	const found: RunCommand[] = [];
	let i = 0;
	while (i < words.length) {
		const name = words[i]!.replace(/^.*\//, "");
		found.push({ name, args: words.slice(i + 1), text, env: { ...env }, ...(stdin === undefined ? {} : { stdin }) });
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

/**
 * Every command `source` runs, wrappers and the commands they run included, in source order, each
 * with where it runs ({@link RunCommand.background}, {@link RunCommand.loop}); a script it runs
 * (`bash -c`, `eval`) runs where the command does.
 */
export function commandsIn(source: string, context: Context = {}): RunCommand[] {
	const found: RunCommand[] = [];
	const visit = (node: SyntaxNode, context: Context) => {
		if ((node.type === "Statement" && node.background) || node.type === "Coproc") context = { ...context, background: true };
		if (LOOPS.has(node.type)) context = { ...context, loop: node, loops: [...(context.loops ?? []), node] };
		if (node.type === "Command") {
			for (const command of unwrap(node, source.slice(node.pos, node.end))) {
				const located = { ...command, ...(context.background ? { background: true } : {}), ...(context.loop ? { loop: context.loop, loops: context.loops } : {}) };
				found.push(located);
				const script = scriptOf(command);
				if (script !== undefined) found.push(...commandsIn(script, context));
			}
		}
		forEachChild(node, (child) => visit(child, context));
	};
	visit(parse(source), context);
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

/** A git subcommand's options: flags (short ones by letter, long ones as written), the values of valued ones, and the pathspecs. */
export interface GitOptions {
	flags: Set<string>;
	/** Each valued option's values in order, keyed like `flags` (`-Fx`, `-F x`, `--file=x` and `--file x` all under their name). */
	values: Map<string, string[]>;
	pathspecs: string[];
}

/** Parses a git subcommand's arguments; `valuedLong` and `valuedShort` name its options that take a value. */
export function gitOptions(args: readonly string[], valuedLong: ReadonlySet<string>, valuedShort: ReadonlySet<string>): GitOptions {
	const flags = new Set<string>();
	const values = new Map<string, string[]>();
	const pathspecs: string[] = [];
	const value = (name: string, v: string | undefined) => {
		if (v !== undefined) values.set(name, [...(values.get(name) ?? []), v]);
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") {
			pathspecs.push(...args.slice(i + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
			flags.add(name);
			if (!valuedLong.has(name)) continue;
			if (inline !== undefined) value(name, inline);
			else value(name, args[++i]);
		} else if (arg.startsWith("-") && arg.length > 1) {
			for (let j = 1; j < arg.length; j++) {
				const letter = arg[j]!;
				flags.add(letter);
				if (!valuedShort.has(letter)) continue;
				value(letter, j < arg.length - 1 ? arg.slice(j + 1) : args[++i]);
				break;
			}
		} else pathspecs.push(arg);
	}
	return { flags, values, pathspecs };
}

/**
 * The tool result of a refused command: what it does, the commands that do it (each once, clipped),
 * then why it is refused and what to do instead.
 */
export function refusalText(does: string, commands: readonly string[], ...lines: string[]): string {
	return [`Not run: this command ${does}:`, ...[...new Set(commands)].map((c) => `- \`${clip(c, 120)}\``), ...lines].join("\n");
}
