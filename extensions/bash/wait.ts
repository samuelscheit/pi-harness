// A command that waits idly in the foreground is refused before a bash command runs.
//
// The rule "do not wait on long running processes, use the time" did not hold: on 2026-11-17 the
// user corrected agents in two sessions ("you should not endlessly wait for CI and just continue
// with all stuff and only at the end fix everything"). Their transcripts show the turn blocked on
// `timeout 3000 gh run watch <id> …; gh run view …`, `gh pr merge 521 --merge; sleep 20; …` and
// `(bun mockup … &) ; sleep 100; tail log`. A wait started as a background job costs nothing: its
// end wakes the session with a message, and the agent works on meanwhile. So the tool refuses:
// - `gh run watch` and `gh pr checks --watch` in the foreground: they block until CI ends;
// - `sleep` in the foreground totalling at least 10 seconds (all arguments summed, with GNU
//   suffixes `s`, `m`, `h`, `d`, and `infinity`): outside loops all such sleeps of the command add
//   up; inside a `while`/`until`/`for`/`select` loop those of one iteration do, so a loop that
//   polls every 10 seconds or more is refused, while a readiness loop with a short sleep
//   (`until curl -s localhost:3000; do sleep 1; done`) runs: it ends as soon as the thing is ready.
// Wrappers (`timeout 3000 gh run watch`), `&&`/`;` lists, `$(…)`, `eval` and `bash -c '…'` count;
// a background job (`cmd &`, `( … ) &`, `{ …; } &`, `nohup … &`, `coproc`) does not, nor does text
// in quotes or a heredoc. A sleep whose duration is not literal (`sleep $n`) is not counted.
// No escape hatch: the background form does everything the foreground one does, and when every
// remaining step depends on the wait, the agent ends its turn and the job's end wakes it.
// Polling a rate-limited API is refused too, in the foreground and in a background job alike:
// a loop (`while`, `until`, `for`, `select`) that runs `gh` and sleeps less than 60 seconds per
// iteration (`while [ "$(gh run view <id> --json status -q .status)" != completed ]; do sleep 9; done`
// exhausted the GitHub API rate limit for every agent on the machine). One `gh run watch <id>
// --exit-status > log 2>&1 &` does the same with one request per its own interval; a loop that
// sleeps 60 seconds or more is allowed. A sleep that is not literal is not counted, a loop
// without `sleep` (it ends on its own condition) is left alone.
// Not refused: `wait` for a job the command started (`job & wait`), which the 2-minute move to the
// background (../background) bounds.

import { commandsIn, type RunCommand, refusalText } from "./commands.ts";

/** Foreground sleep, in seconds, from which a command counts as waiting idly. */
export const SLEEP_LIMIT_S = 10;

const UNIT_S: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86_400 };

/** The seconds `sleep` waits for its arguments (summed, like GNU's), or undefined when one is not a literal duration. */
export function sleepSeconds(args: readonly string[]): number | undefined {
	let total = 0;
	for (const arg of args) {
		if (arg === "infinity") return Number.POSITIVE_INFINITY;
		const match = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(arg);
		if (!match) return undefined;
		total += Number(match[1]) * UNIT_S[match[2]!]!;
	}
	return total;
}

/** Whether `command` watches CI until it ends: `gh run watch`, `gh pr checks --watch`. */
function watchesCi({ name, args }: RunCommand): boolean {
	if (name !== "gh") return false;
	const [group, sub] = args;
	return (group === "run" && sub === "watch") || (group === "pr" && sub === "checks" && args.includes("--watch"));
}

/** The commands in `source` that wait idly in the foreground: CI watches and the sleeps of a scope (the command, or one loop iteration) totalling {@link SLEEP_LIMIT_S} or more. */
export function foregroundWaits(source: string): string[] {
	const commands = commandsIn(source).filter((command) => !command.background);
	const sleeps = new Map<RunCommand["loop"], { seconds: number; commands: RunCommand[] }>();
	for (const command of commands) {
		if (command.name !== "sleep") continue;
		const seconds = sleepSeconds(command.args);
		if (seconds === undefined) continue;
		const scope = sleeps.get(command.loop) ?? { seconds: 0, commands: [] };
		scope.seconds += seconds;
		scope.commands.push(command);
		sleeps.set(command.loop, scope);
	}
	const long = new Set([...sleeps.values()].flatMap((scope) => (scope.seconds >= SLEEP_LIMIT_S ? scope.commands : [])));
	return commands.flatMap((command) => (watchesCi(command) || long.has(command) ? [command.text] : []));
}

/** Per-iteration sleep, in seconds, under which a loop that calls `gh` polls too fast for GitHub's rate limit. */
export const POLL_LIMIT_S = 60;

/** The loops in `source` (foreground or background) that run `gh` and sleep under {@link POLL_LIMIT_S} per iteration: each loop's `gh` commands and its sleep. */
export function fastGhPolls(source: string): { gh: string[]; sleep: string; seconds: number }[] {
	const commands = commandsIn(source);
	const polls = new Map<NonNullable<RunCommand["loop"]>, { seconds: number; sleeps: RunCommand[] }>();
	for (const command of commands) {
		if (command.name !== "sleep" || !command.loop) continue;
		const seconds = sleepSeconds(command.args);
		if (seconds === undefined) continue;
		const poll = polls.get(command.loop) ?? { seconds: 0, sleeps: [] };
		poll.seconds += seconds;
		poll.sleeps.push(command);
		polls.set(command.loop, poll);
	}
	return [...polls].flatMap(([loop, { seconds, sleeps }]) => {
		const gh = commands.filter((command) => command.name === "gh" && command.loops?.includes(loop)).map((command) => command.text);
		return seconds < POLL_LIMIT_S && gh.length > 0 ? [{ gh: [...new Set(gh)], sleep: sleeps.map((s) => s.text).join("; "), seconds }] : [];
	});
}

/** Why `source` is refused, when it waits idly in the foreground or polls `gh` in a fast loop; undefined otherwise. */
export function waitRefusal(source: string): string | undefined {
	const waits = foregroundWaits(source);
	const polls = fastGhPolls(source);
	const parts: string[] = [];
	if (waits.length > 0)
		parts.push(
			refusalText(
				`waits idly in the foreground (CI watch, or ${SLEEP_LIMIT_S}s or more of \`sleep\`)`,
				waits,
				"The turn would idle until it ends; on 2026-11-17 the user corrected agents that waited on CI instead of continuing with the rest of the work.",
				"Start the wait as a background job, its output in a file: `gh run watch <id> --exit-status > ci.log 2>&1 &`. Its end wakes you with a message, also after your turn. Continue with the next task right away; collect all CI failures and fix them in one pass at the end.",
				"For a run that does not exist yet, put the delay in the job too: `(sleep 20; gh run watch \"$(gh run list --branch main --limit 1 --json databaseId -q '.[0].databaseId')\" --exit-status) > ci.log 2>&1 &`. For a server, poll its readiness with a short sleep (`until curl -s localhost:3000; do sleep 1; done`) or just run the step that needs it.",
			),
		);
	if (polls.length > 0)
		parts.push(
			refusalText(
				`polls GitHub in a loop that sleeps under ${POLL_LIMIT_S}s per iteration`,
				polls.flatMap((p) => p.gh),
				`Sleeping: ${polls.map((p) => `\`${p.sleep}\``).join(", ")}.`,
				"Every iteration is an API request, and all agents on this machine share one GitHub rate limit: a background loop of `gh run view … ; sleep 9` exhausted it for everyone, background or not.",
				"Use one request stream that GitHub paces itself: `gh run watch <id> --exit-status > ci.log 2>&1 &` (also `gh pr checks <n> --watch > ci.log 2>&1 &`); its end wakes you. If you must loop, sleep 60 s or more per iteration.",
			),
		);
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}
