// A commit, push, PR or publish that runs even when a check before it failed is refused before
// the bash command runs.
//
// 2026-11-19: an agent ran `(unit tests | grep …); (lint | grep …); git commit …; gh pr merge` in
// one command. 18 tests failed and the commit and merge ran anyway: `;` and a newline run the next
// command whatever the one before returned, and a pipeline or a subshell drops a check's status
// on the way. gate.ts only refuses a publish gated (`&&`, `if`, `set -e`) on a pipeline ending in a
// filter; this refuses one that a check's failure does not stop at all.
//
// A check is a test, lint, type check or build ({@link isCheck}). For each check the walk works out
// what its failure does, assuming everything else succeeds ({@link Outcome}): exit the shell, fail
// the node, make it succeed (`!`), or be lost. Each publishing command is refused when a check
// whose failure still reaches it ran before it. A failure stops at:
// - `&&`: the commands after it are skipped up to the next `||`;
// - `|| exit` and `|| { …; exit 1; }`, and `if`/`while` branches on its status that end in `exit` or
//   `return` (`if ! npm test; then exit 1; fi`), but not an `exit` in a subshell `( … )`;
// - `set -e` (not in a condition or a non-last part of an `&&`/`||` list, as in Bash).
// A pipeline passes its last command's status (any command's with `set -o pipefail`), a subshell
// and a brace group their last statement's, `x=$(…)` its substitution's; `cmd $(check)`, a
// background job and a loop body lose it. Functions are not followed (their body runs later).

import { type Command, forEachChild, parse, type Statement, type SyntaxNode } from "../../vendor/pi-lens/node_modules/unbash/dist/parser.js";
import { clip } from "../background/jobs.ts";
import { type RunCommand, refusalText, scriptOf, unwrap } from "./commands.ts";
import { applyOptions, type Options, publishes } from "./gate.ts";

/** Tools that are a check whatever their arguments. */
const CHECK_TOOLS = new Set([
	"ava", "biome", "ctest", "eslint", "flake8", "golangci-lint", "gradle", "gradlew", "jest", "knip", "ktlint", "mocha", "mvn", "mvnw", "mypy", "nox", "oxlint", "phpunit",
	"py.test", "pylint", "pyright", "pytest", "rspec", "rubocop", "ruff", "shellcheck", "stylelint", "swiftlint", "tox", "tsc", "tsgo", "vitest", "vue-tsc", "xcodebuild",
]);
/** Tools that are a check with one of these subcommands. */
const CHECK_SUBCOMMANDS: Record<string, RegExp> = {
	bazel: /^(?:build|test)$/,
	bazelisk: /^(?:build|test)$/,
	cargo: /^(?:build|check|clippy|nextest|test)$/,
	cypress: /^run$/,
	dart: /^(?:analyze|test)$/,
	deno: /^(?:check|lint|test)$/,
	dotnet: /^(?:build|test)$/,
	flutter: /^(?:analyze|build|test)$/,
	go: /^(?:build|test|vet)$/,
	lake: /^(?:build|lint|test)$/,
	mix: /^(?:compile|test)$/,
	playwright: /^test$/,
	swift: /^(?:build|test)$/,
	zig: /^(?:build|test)$/,
};
/** Commands that run the command in their arguments, after their own subcommand (`uv run pytest`) or none (`npx tsc`). */
const RUNNERS: Record<string, RegExp | undefined> = {
	bunx: undefined,
	npx: undefined,
	pnpx: undefined,
	bundle: /^exec$/,
	hatch: /^run$/,
	npm: /^exec$/,
	pdm: /^run$/,
	pipenv: /^run$/,
	pnpm: /^(?:dlx|exec)$/,
	poetry: /^run$/,
	rye: /^run$/,
	uv: /^run$/,
	yarn: /^(?:dlx|exec)$/,
};
/** Script or target names that name a check: `test`, `lint:fix`, `typecheck`, `check-types`, `build`, `test:e2e`. */
const CHECK_SCRIPT = /(?:^|[^a-z])(?:build|check|ci|e2e|lint|spec|test|tests|tsc|typecheck|types|unittest|verify)(?:$|[^a-z])/i;
/** A file of tests: `test/gate.test.ts`, `tests/test_x.py`, `foo.spec.js`, `manage.py test`. */
const TEST_FILE = /(?:^|[/._-])(?:spec|test|tests)(?:$|[/._-])/;
/** Interpreters whose script argument may be a test file. */
const INTERPRETERS = new Set(["bun", "deno", "node", "python", "python3", "ts-node", "tsx"]);
/** A check script run by path: `./test.sh`, `scripts/ci.sh`, `./run_tests.sh`. */
const CHECK_SCRIPT_FILE = /^(?:run[-_]?)?(?:build|check|ci|lint|test|tests|typecheck|verify)(?:[-_.][\w.-]*)?$/;

/** The command a runner runs (`npx tsc` → `tsc`), or undefined. */
function runs({ name, args }: Pick<RunCommand, "name" | "args">): Pick<RunCommand, "name" | "args"> | undefined {
	if (!(name in RUNNERS)) return undefined;
	const sub = RUNNERS[name];
	let i = 0;
	if (sub) {
		if (!sub.test(args[0] ?? "")) return undefined;
		i = 1;
	}
	while (i < args.length && (args[i]!.startsWith("-") || args[i] === "--")) i++;
	const inner = args[i];
	return inner === undefined ? undefined : { name: inner.replace(/^.*\//, ""), args: args.slice(i + 1) };
}

/** Whether `command` is a test, lint, type check or build, whose exit status says whether it passed. */
export function isCheck(command: Pick<RunCommand, "name" | "args">): boolean {
	const { name, args } = command;
	const inner = runs(command);
	if (inner) return isCheck(inner);
	if (CHECK_TOOLS.has(name)) return true;
	const first = args[0] ?? "";
	if (CHECK_SUBCOMMANDS[name]?.test(first)) return true;
	if (["npm", "pnpm", "yarn", "bun"].includes(name)) {
		if (["t", "test", "tst"].includes(first)) return true;
		const script = first === "run" || first === "run-script" ? args.find((a, i) => i > 0 && !a.startsWith("-")) : name === "npm" ? undefined : first;
		return script !== undefined && CHECK_SCRIPT.test(script);
	}
	if (["make", "just", "ninja", "task"].includes(name)) {
		const targets = args.filter((a) => !a.startsWith("-") && !a.includes("="));
		return targets.length === 0 || targets.some((t) => CHECK_SCRIPT.test(t));
	}
	if (name === "cmake") return args.includes("--build");
	if (name === "prettier" || name === "black") return args.includes("--check");
	if (INTERPRETERS.has(name)) {
		const module = args.indexOf("-m");
		if (module >= 0) return isCheck({ name: args[module + 1] ?? "", args: args.slice(module + 2) }) || args[module + 1] === "unittest";
		return args.includes("--test") || args.some((a) => !a.startsWith("-") && TEST_FILE.test(a));
	}
	return CHECK_SCRIPT_FILE.test(name);
}

/**
 * What a check's failure does to a node, everything else succeeding: `exit` the shell, make the
 * node `fail` (status ≠ 0), make it `pass` (status 0, through `!`), or be `lost` (the node's status
 * does not depend on it, or execution goes on whatever it is).
 */
type Outcome = "exit" | "fail" | "pass" | "lost";
/** One check that ran; an object, so that two runs of the same command stay apart. */
interface Check {
	text: string;
}
type Outcomes = Map<Check, Outcome>;

/** Every outcome but `exit` as `lost`: execution goes on after the node whatever the check did. */
const survive = (outcomes: Outcomes): Outcomes => new Map([...outcomes].map(([c, o]) => [c, o === "exit" ? "exit" : "lost"]));
const merge = (...all: Outcomes[]): Outcomes => new Map(all.flatMap((m) => [...m]));
/** The checks whose outcome is one of `kinds`. */
const having = (outcomes: Outcomes, ...kinds: Outcome[]): Check[] => [...outcomes].flatMap(([c, o]) => (kinds.includes(o) ? [c] : []));

/** Whether running `node` always ends the shell it runs in (`exit`, `return`, `{ echo …; exit 1; }`). */
function terminates(node: SyntaxNode | undefined, source: string): boolean {
	switch (node?.type) {
		case "Command":
			return ["exit", "return"].includes(unwrap(node, source.slice(node.pos, node.end)).at(-1)?.name ?? "");
		case "Statement":
			return !node.background && terminates(node.command, source);
		case "Pipeline":
			return node.commands.length === 1 && node.prefixes.length === 0 && terminates(node.commands[0], source);
		case "AndOr":
			return node.operators.every((op) => op === "&&") && terminates(node.commands.at(-1), source);
		case "BraceGroup":
			return terminates(node.body, source);
		case "Redirected":
			return terminates(node.command, source);
		case "Script":
		case "CompoundList":
			return node.commands.some((statement: Statement) => terminates(statement, source));
		case "If":
			return node.else !== undefined && [node.then, ...node.elif.map((e) => e.then), node.else].every((body) => terminates(body, source));
		default:
			return false;
	}
}

/** The publishing commands in `source` that run even when a check before them failed, and those checks. */
export function ungatedPublishes(source: string): { checks: string[]; commands: string[]; publish: string[] } {
	const checks = new Set<string>();
	const commands = new Set<string>();
	const publish = new Set<string>();

	/** `fail` under `set -e` outside a condition ends the shell. */
	const stop = (outcome: Outcome, options: Options, condition: boolean): Outcome => (outcome === "fail" && options.errexit && !condition ? "exit" : outcome);

	/** Walks `node` with `loose` the checks whose failure reaches it, records publishes, and returns its checks' outcomes. */
	const walk = (node: SyntaxNode, loose: readonly Check[], options: Options, condition: boolean, source: string): Outcomes => {
		switch (node.type) {
			case "Script":
			case "CompoundList": {
				if (node.type === "Script" && node.source !== undefined) source = node.source;
				const outcomes: Outcomes = new Map();
				let current = loose;
				node.commands.forEach((statement, i) => {
					const last = i === node.commands.length - 1;
					for (const [check, outcome] of walk(statement, current, options, condition, source)) {
						outcomes.set(check, outcome === "exit" || last ? outcome : "lost");
						if (outcome !== "exit") current = [...current, check];
					}
				});
				return outcomes;
			}
			case "Statement":
				return node.background ? survive(walk(node.command, loose, { ...options }, true, source)) : walk(node.command, loose, options, condition, source);
			case "AndOr": {
				const outcomes: Outcomes = new Map();
				let current = loose;
				/** Checks that failed, waiting for the next `||` (the `&&` parts are skipped). */
				let failed: Check[] = [];
				node.commands.forEach((part, i) => {
					if (i > 0 && node.operators[i - 1] === "||") {
						const exits = terminates(part, source);
						for (const check of failed) outcomes.set(check, exits ? "exit" : "lost");
						if (!exits) current = [...current, ...failed];
						failed = [];
					}
					const last = i === node.commands.length - 1;
					for (const [check, outcome] of walk(part, current, options, condition || !last, source)) {
						if (outcome === "fail" && !last) failed.push(check);
						else {
							outcomes.set(check, last || outcome === "exit" ? outcome : "lost");
							if (outcome !== "exit") current = [...current, check];
						}
					}
				});
				for (const check of failed) outcomes.set(check, "fail");
				return outcomes;
			}
			case "Pipeline": {
				const negated = node.prefixes.some((prefix) => prefix.type === "Negation");
				if (node.commands.length === 1) {
					const outcomes = walk(node.commands[0]!, loose, options, condition || negated, source);
					if (!negated) return outcomes;
					return new Map([...outcomes].map(([c, o]) => [c, o === "fail" ? "pass" : o === "pass" ? "fail" : o]));
				}
				// Every command of a pipeline runs in a subshell; its status is the last command's, or the
				// first failing one's from the right with pipefail.
				const outcomes: Outcomes = new Map();
				node.commands.forEach((command, i) => {
					const last = i === node.commands.length - 1;
					for (const [check, inner] of walk(command, loose, { ...options }, true, source)) {
						let outcome: Outcome = inner === "exit" || inner === "fail" ? "fail" : inner;
						if (!last && !(options.pipefail && outcome === "fail")) outcome = "lost";
						if (negated) outcome = outcome === "fail" ? "pass" : outcome === "pass" ? "fail" : outcome;
						outcomes.set(check, stop(outcome, options, condition || negated));
					}
				});
				return outcomes;
			}
			case "Subshell": {
				const inner = walk(node.body, loose, { ...options }, condition, source);
				return new Map([...inner].map(([c, o]) => [c, stop(o === "exit" ? "fail" : o, options, condition)]));
			}
			case "BraceGroup":
				return walk(node.body, loose, options, condition, source);
			case "Redirected":
				return walk(node.command, loose, options, condition, source);
			case "If": {
				const outcomes: Outcomes = new Map();
				let rest = loose;
				const branches = [{ clause: node.clause, then: node.then }, ...node.elif];
				branches.forEach(({ clause, then }, i) => {
					const tested = walk(clause, rest, options, true, source);
					const otherwise = i < branches.length - 1 ? undefined : node.else;
					for (const [check, outcome] of tested) {
						// A failure that makes the clause pass runs `then`; one that makes it fail runs the next branch.
						const branch = outcome === "pass" ? then : outcome === "fail" ? (i < branches.length - 1 ? undefined : otherwise) : undefined;
						outcomes.set(check, outcome === "exit" || (branch !== undefined && terminates(branch, source)) ? "exit" : "lost");
					}
					const reaching = (...kinds: Outcome[]) => having(tested, ...kinds).filter((c) => outcomes.get(c) !== "exit");
					for (const [check, outcome] of walk(then, [...rest, ...reaching("pass", "lost")], options, condition, source)) outcomes.set(check, outcome);
					rest = [...rest, ...reaching("fail", "lost")];
				});
				if (node.else) for (const [check, outcome] of walk(node.else, rest, options, condition, source)) outcomes.set(check, outcome);
				return outcomes;
			}
			case "While": {
				// The loop ends when its clause fails (`while`) or passes (`until`): a failure that keeps it
				// going never gets past it (`until npm test; do sleep 1; done`), as if it exited.
				const tested = walk(node.clause, loose, options, true, source);
				const looping: Outcome = node.kind === "while" ? "pass" : "fail";
				const body = walk(node.body, [...loose, ...having(tested, looping, "lost")], options, condition, source);
				return merge(survive(body), new Map([...survive(tested)].map(([c, o]) => [c, tested.get(c) === looping ? "exit" : o])));
			}
			case "Function":
				return new Map();
			case "Command":
				return command(node, loose, options, condition, source);
			default: {
				// `for`, `select`, `case`, `[[ … ]]` and words: whatever their parts' checks do, execution goes on.
				const outcomes: Outcomes[] = [];
				forEachChild(node, (child) => void outcomes.push(walk(child, loose, options, true, source)));
				return survive(merge(...outcomes));
			}
		}
	};

	const command = (node: Command, loose: readonly Check[], options: Options, condition: boolean, source: string): Outcomes => {
		// Substitutions run first, each in a subshell; `x=$(…)` alone has its last one's status.
		const substitutions: Outcomes[] = [];
		forEachChild(node, function visit(child) {
			if (child.type === "CommandExpansion" || child.type === "ProcessSubstitution") {
				if (child.script) substitutions.push(walk(child.script, loose, { ...options }, true, source));
			} else forEachChild(child, visit);
		});
		const outcomes = survive(merge(...substitutions));
		if (!node.name && substitutions.length > 0) {
			for (const [check, outcome] of substitutions.at(-1)!) outcomes.set(check, stop(outcome === "exit" ? "fail" : outcome, options, condition));
		}
		for (const run of unwrap(node, source.slice(node.pos, node.end))) {
			if (run.name === "set") applyOptions(run.args, options);
			const what = publishes(run);
			if (what && loose.length > 0) {
				for (const check of loose) checks.add(check.text);
				commands.add(run.text);
				publish.add(what);
			}
			if (isCheck(run)) outcomes.set({ text: run.text }, stop("fail", options, condition));
			const script = scriptOf(run);
			if (script === undefined) continue;
			// `eval` runs in this shell; `bash -c` starts a new one with only the options it is given.
			if (run.name === "eval") {
				for (const [check, outcome] of walk(parse(script), loose, options, condition, script)) outcomes.set(check, outcome);
			} else {
				const inner = { pipefail: false, errexit: false };
				applyOptions(run.args, inner);
				for (const [check, outcome] of walk(parse(script), loose, inner, false, script)) outcomes.set(check, stop(outcome === "exit" ? "fail" : outcome, options, condition));
			}
		}
		return outcomes;
	};

	walk(parse(source), [], { pipefail: false, errexit: false }, false, source);
	return { checks: [...checks], commands: [...commands], publish: [...publish] };
}

/** Why `source` is refused, when it publishes even if a check before it failed; undefined otherwise. */
export function ungatedRefusal(source: string): string | undefined {
	const { checks, commands, publish } = ungatedPublishes(source);
	if (commands.length === 0) return undefined;
	return refusalText(
		`runs ${publish.map((p) => `\`${p}\``).join(", ")} even when a check before it fails`,
		checks,
		`Not gated: ${commands.map((c) => `\`${clip(c, 120)}\``).join(", ")}.`,
		"`;` and a newline run the next command whatever the one before returned, and a pipeline (`check | grep …`), a subshell or `$(…)` drops a check's status on the way (2026-11-19: `(tests | grep …); (lint | grep …); git commit …; gh pr merge` committed and merged with 18 failing tests).",
		"Gate the publish on each check's own status: `check > check.log 2>&1 && git commit …`, then read the log; or `set -eo pipefail;` first, or `check || exit 1;`. To publish whatever the checks say, run the publish as a command of its own.",
	);
}
