// A commit or push gated on a pipeline that ends in a filter is refused before a bash command runs.
//
// 2026-11-15, phishing_reporter: an agent ran
// `bun test … | grep -E " pass$| fail$" && git commit … && git push`. A pipeline's exit status is
// its last command's, so grep matching "1 fail" made it succeed: a syntax error was committed and
// pushed, and the auto-deploy failed. Writing the rule down does not stop this, so the tool checks
// how the command line is built:
// - a pipeline masks when it has a command before a filter at its end (`grep`, `tail`, `tee`, …)
//   whose status is lost: no `set -o pipefail` is in effect, or the pipeline is negated (`! …`).
//   A pipeline that only prints into a filter (`cat log | grep -q ok`) checks nothing it could hide;
// - a commit, push, `gh pr create|merge` or package publish is gated on one when it runs after it
//   in an `&&`/`||` list, in the branches of an `if` or the body of a `while` it decides, or after
//   it in a list under `set -e`. Subshells, `{ …; }`, `x=$(…)`, `$(…)`, `eval` and `bash -c '…'`
//   pass the status and the gate through.
// A `;` sequence without `set -e` runs the commit regardless and is not refused; nor is a pipeline
// elsewhere in the command. With pipefail any failing command fails the pipeline, so a filter at
// its end (even `grep`) can only add a condition, never hide a failure.

import { forEachChild, parse, type Pipeline, type Statement, type SyntaxNode } from "../../vendor/pi-lens/node_modules/unbash/dist/parser.js";
import { clip } from "../background/jobs.ts";
import { gitCommand, type RunCommand, refusalText, scriptOf, unwrap } from "./commands.ts";

/** Commands whose exit status is their own, not that of what they read. */
const FILTERS = new Set([
	"ack", "ag", "awk", "bat", "cat", "column", "cut", "egrep", "fgrep", "fold", "gawk", "grep", "head", "iconv", "jq", "less", "more", "nl", "perl", "rev", "rg",
	"sed", "sort", "sponge", "tac", "tail", "tee", "tr", "true", "uniq", "wc", "yq",
]);
/** Commands that only print, so a pipeline from them into a filter hides no failure. */
const PRINTERS = new Set([...FILTERS, "echo", "printf", "yes"]);

/** The shell options a pipeline's status depends on. */
interface Options {
	pipefail: boolean;
	errexit: boolean;
}

/** Applies `set`-style options (`-e`, `+e`, `-o pipefail`, `-euo pipefail`) to `options`. */
function applyOptions(args: readonly string[], options: Options): void {
	for (let i = 0; i < args.length; i++) {
		const cluster = /^([-+])([A-Za-z]+)$/.exec(args[i]!);
		if (!cluster) break;
		const on = cluster[1] === "-";
		for (const letter of cluster[2]!) {
			if (letter === "e") options.errexit = on;
			if (letter !== "o") continue;
			const name = args[++i];
			if (name === "pipefail") options.pipefail = on;
			if (name === "errexit") options.errexit = on;
		}
	}
}

/** What `command` publishes when it runs (a commit, a push, a PR, a package), or undefined. */
function publishes(command: RunCommand): string | undefined {
	const git = gitCommand(command);
	if (git) return git.subcommand === "commit" || git.subcommand === "push" ? `git ${git.subcommand}` : undefined;
	const [first, second] = command.args;
	if (command.name === "gh" && first === "pr" && (second === "create" || second === "merge")) return `gh pr ${second}`;
	if (["npm", "pnpm", "yarn", "bun"].includes(command.name) && first === "publish") return `${command.name} publish`;
	return undefined;
}

/** The pipelines that mask a failure and the publishing commands gated on them, in `source`. */
export function gatedPublishes(source: string): { pipelines: string[]; commands: string[]; publish: string[] } {
	const masked = new Map<Pipeline, string>();
	const pipelines = new Set<string>();
	const commands = new Set<string>();
	const publish = new Set<string>();

	/** The masking pipelines whose status is `node`'s status. */
	const deciders = (node: SyntaxNode): string[] => {
		switch (node.type) {
			case "Statement":
				return node.background ? [] : deciders(node.command);
			case "Pipeline": {
				const text = masked.get(node);
				return text !== undefined ? [text] : deciders(node.commands.at(-1)!);
			}
			case "AndOr":
				return node.commands.flatMap(deciders);
			case "Subshell":
			case "BraceGroup":
				return deciders(node.body);
			case "Redirected":
				return deciders(node.command);
			case "Script":
			case "CompoundList":
				return node.commands.length > 0 ? deciders(node.commands.at(-1)!) : [];
			case "Command": {
				// `x=$(…)` alone has the status of its last command substitution.
				if (node.name) return [];
				const scripts = node.prefix.flatMap((part) =>
					part.type === "Assignment" && part.value.type === "Word" ? (part.value.parts ?? []).flatMap((p) => (p.type === "CommandExpansion" && p.script ? [p.script] : [])) : [],
				);
				return scripts.length > 0 ? deciders(scripts.at(-1)!) : [];
			}
			default:
				return [];
		}
	};

	/** What `set -e` stops on after a statement: an `&&`/`||` list stops it only by its last command. */
	const exitDeciders = (statement: Statement): string[] =>
		statement.background ? [] : statement.command.type === "AndOr" ? deciders(statement.command.commands.at(-1)!) : deciders(statement.command);

	const masks = (pipeline: Pipeline, options: Options, text: string): boolean => {
		if (pipeline.commands.length < 2) return false;
		const names = pipeline.commands.map((command) => (command.type === "Command" ? unwrap(command, text).at(-1)?.name : undefined));
		if (names.slice(0, -1).every((name) => name !== undefined && PRINTERS.has(name))) return false;
		if (pipeline.prefixes.some((prefix) => prefix.type === "Negation")) return true;
		const last = names.at(-1);
		return !options.pipefail && last !== undefined && FILTERS.has(last);
	};

	const walk = (node: SyntaxNode, gates: readonly string[], options: Options, source: string): void => {
		const list = (statements: readonly Statement[]) => {
			let current = gates;
			for (const statement of statements) {
				walk(statement, current, options, source);
				if (options.errexit) current = [...current, ...exitDeciders(statement)];
			}
		};
		switch (node.type) {
			case "Script":
				if (node.source !== undefined) source = node.source;
				return list(node.commands);
			case "CompoundList":
				return list(node.commands);
			case "AndOr": {
				let current = gates;
				for (const command of node.commands) {
					walk(command, current, options, source);
					current = [...current, ...deciders(command)];
				}
				return;
			}
			case "Pipeline": {
				// Every command of a pipeline runs in a subshell: options it sets stay there.
				for (const prefix of node.prefixes) walk(prefix, gates, options, source);
				for (const command of node.commands) walk(command, gates, node.commands.length > 1 ? { ...options } : options, source);
				if (masks(node, options, source)) masked.set(node, source.slice(node.pos, node.end));
				return;
			}
			case "If": {
				let current = gates;
				for (const branch of [{ clause: node.clause, then: node.then }, ...node.elif]) {
					walk(branch.clause, current, options, source);
					current = [...current, ...deciders(branch.clause)];
					walk(branch.then, current, options, source);
				}
				if (node.else) walk(node.else, current, options, source);
				return;
			}
			case "While":
				walk(node.clause, gates, options, source);
				return walk(node.body, [...gates, ...deciders(node.clause)], options, source);
			case "Subshell":
				return walk(node.body, gates, { ...options }, source);
			case "CommandExpansion":
			case "ProcessSubstitution":
				if (node.script) walk(node.script, gates, { ...options }, source);
				return;
			case "Command": {
				// Words first: their substitutions run before the command.
				forEachChild(node, (child) => walk(child, gates, options, source));
				for (const command of unwrap(node, source.slice(node.pos, node.end))) {
					if (command.name === "set") applyOptions(command.args, options);
					const what = publishes(command);
					if (what && gates.length > 0) {
						for (const gate of gates) pipelines.add(gate);
						commands.add(command.text);
						publish.add(what);
					}
					const script = scriptOf(command);
					if (script === undefined) continue;
					// `eval` runs in this shell; `bash -c` starts a new one with only the options it is given.
					const inner = command.name === "eval" ? options : { pipefail: false, errexit: false };
					if (command.name !== "eval") applyOptions(command.args, inner);
					walk(parse(script), gates, inner, script);
				}
				return;
			}
			default:
				forEachChild(node, (child) => walk(child, gates, options, source));
		}
	};

	walk(parse(source), [], { pipefail: false, errexit: false }, source);
	return { pipelines: [...pipelines], commands: [...commands], publish: [...publish] };
}

/** Why `source` is refused, when it publishes only if a pipeline ending in a filter succeeds; undefined otherwise. */
export function gateRefusal(source: string): string | undefined {
	const { pipelines, commands, publish } = gatedPublishes(source);
	if (commands.length === 0) return undefined;
	return refusalText(
		`runs ${publish.map((p) => `\`${p}\``).join(", ")} only if a pipeline ending in a filter succeeds`,
		pipelines,
		`Gated: ${commands.map((c) => `\`${clip(c, 120)}\``).join(", ")}.`,
		"A pipeline's exit status is its last command's: `grep`, `tail` or `tee` succeeds on the output even when the command before it fails, so this would run even when the tests or the build fail (2026-11-15: `bun test | grep -E \" pass$| fail$\" && git commit` matched \"1 fail\", committed and pushed a syntax error).",
		"Run the check unfiltered and gate on its own exit status: `cmd > check.log 2>&1 && git commit …`, then read the log; or put `set -o pipefail;` first, so the pipeline fails when any of its commands fails: `set -o pipefail; cmd 2>&1 | tail -20 && git commit …`.",
	);
}
