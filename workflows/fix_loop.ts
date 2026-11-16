// fix_loop: hand a failing check with a clear error and a known set of files to a cheaper model in
// a child agent with a short context. Measured motivation (law-formalization, 863 Claude Code
// sessions): repair chains (failed check → … → green) cost 17% of the project, 59% of that cache
// reads of a median 379k context per turn.
//
// The workflow runs the check itself before the first and after every round, so "green" is the
// check's exit code, never the child's claim. A round is one message to the child (it may run the
// check itself in between). The `fix-loop` rule (prompt/rules/fix-loop.md) activates it.
//
// The child (delegate()) is only told `files` (children run in parallel in one working tree, as t3
// tasks), so this workflow holds its own contract: a round counts as green only when the check passes and
// nothing outside `files` changed since the workflow started. Changes outside are not undone for the
// child; it is told to undo them, and they are returned as `outside` while they remain.
//
// The check runs with `pipefail` (checkCommand): a check ending in a filter (`pytest … | tail -1`)
// otherwise exits with the filter's code, 0, so a failing check read as "already passes" before any
// round (2026-11-16).

/** The check as the workflow runs it: a pipeline fails when any of its commands fails. */
export const checkCommand = (check: string): string => `set -o pipefail\n${check}`;

export const meta: WorkflowMeta = {
	description: [
		"Make a failing check pass with a cheaper model in a fresh child agent that sees only the goal, the files, the check and its failure, not this conversation.",
		"The tool runs `check` itself before the first and after every round: green means exit code 0 and no file outside `files` changed. Between checks the child reads, edits and runs commands; changes outside `files` are sent back to it to undo.",
		"Returns whether it is green, the rounds, the diff of the changed files, files changed outside `files`, the last failure output when the check fails, and the child's summary.",
	].join(" "),
	guidelines: [
		"Use fix_loop when a test, type check, lint or build fails with a clear error and the fix is confined to files you can name: give it the check command, those files and a one-line goal, then review the returned diff instead of rereading the files.",
		"Do not use fix_loop when the failure needs a design decision, the cause is unknown across the codebase, the check takes minutes per run, or the fix needs this conversation's context that you cannot put in `context`.",
	],
	parameters: {
		type: "object",
		properties: {
			goal: { type: "string", description: "What to achieve, in one or two sentences (e.g. 'make test_parse_dates pass without changing its expectations')." },
			files: { type: "array", items: { type: "string" }, minItems: 1, description: "Files or directories the child may change, relative to the working directory or absolute." },
			check: { type: "string", description: "Shell command that passes with exit code 0 when the goal is reached, e.g. 'npm test -- parse.test.ts'. Keep it focused and fast. It runs with pipefail, so `… | tail -20` fails when the command before the pipe fails." },
			context: { type: "string", description: "Short hints the child needs: the suspected cause, conventions, what not to touch." },
			maxRounds: { type: "integer", minimum: 1, maximum: 20, description: "Most rounds (child turns between two checks), default 6." },
			model: { type: "string", description: "Child model as provider/id, default anthropic/claude-sonnet-5-5." },
			checkTimeoutSeconds: { type: "integer", minimum: 1, description: "Timeout of one check run, default 600." },
		},
		required: ["goal", "files", "check"],
	},
	budget: 5,
};

interface Input {
	goal: string;
	files: string[];
	check: string;
	context?: string;
	maxRounds?: number;
	model?: string;
	checkTimeoutSeconds?: number;
}

/** The last lines of a check's output, fenced. */
const tail = (output: string, lines: number) => {
	const all = output.trimEnd().split("\n");
	const kept = all.slice(-lines).join("\n").replaceAll("```", "``\u200b`");
	return `${all.length > lines ? `[… ${all.length - lines} earlier lines cut]\n` : ""}\`\`\`\n${kept}\n\`\`\``;
};

const exitText = (result: { exitCode: number | null; timedOut: boolean }) => (result.timedOut ? "timed out" : `exit ${result.exitCode}`);

/** A path as changes() reports it: relative to cwd, without `./` or a trailing slash. */
const relativePath = (path: string) => {
	const trimmed = path.trim();
	const relative = trimmed.startsWith(`${cwd}/`) ? trimmed.slice(cwd.length + 1) : trimmed;
	return relative.replace(/^(\.\/)+/, "").replace(/\/+$/, "") || ".";
};

export default async function ({ goal, files, check, context, maxRounds = 6, model = "anthropic/claude-sonnet-5-5", checkTimeoutSeconds = 600 }: Input) {
	const runCheck = () => shell(checkCommand(check), { timeoutSeconds: checkTimeoutSeconds });
	let result = await runCheck();
	if (result.exitCode === 0) return { ok: true, rounds: 0, summary: "The check already passes; nothing to fix." };

	const allowed = files.map(relativePath);
	const isAllowed = (path: string) => allowed.some((entry) => entry === "." || path === entry || path.startsWith(`${entry}/`));
	const child = delegate({
		target: { model },
		title: `fix_loop: ${goal.slice(0, 60)}`,
		role: "implementation",
		tools: ["read", "bash", "edit", "write"],
		system: [
			"You make a failing check pass in a code repository. You start without the conversation that led here; everything you need is below or in the files.",
			"",
			`Goal: ${goal}`,
			`Check: \`${check}\` (run it with bash; exit code 0 means it passes)`,
			...(context?.trim() ? ["", `Context from the caller:\n${context.trim()}`] : []),
			"",
			`Read the failure, find its cause, change only ${files.join(", ")}, run the check, repeat until it passes. Fix the cause: do not weaken, skip or delete tests or the check, and do not commit. Changes to other files make the result fail until they are undone.`,
			"When the check passes, or you cannot make progress, stop and answer in one or two sentences: what you changed and why.",
		].join("\n"),
	});
	let message = `The check fails (${exitText(result)}):\n${tail(result.output, 200)}`;
	let rounds = 0;
	let summary = "";
	let outside: string[] = [];
	while (rounds < maxRounds) {
		rounds++;
		log(`round ${rounds}/${maxRounds}`);
		const reply = await child.run(message);
		summary = reply.text;
		result = await runCheck();
		outside = (await changes()).files.filter((path) => !isAllowed(path));
		if (result.exitCode === 0 && !outside.length) break;
		const note = outside.length ? `\nYou changed files outside ${files.join(", ")}: ${outside.join(", ")}. Undo those changes (put them back as they were); change only ${files.join(", ")}.` : "";
		message =
			result.exitCode === 0
				? `The check passes (round ${rounds} of ${maxRounds}), but not with only the allowed files changed.${note}`
				: `The check still fails (${exitText(result)}, round ${rounds} of ${maxRounds}):\n${tail(result.output, 200)}${note}`;
	}

	const ok = result.exitCode === 0 && !outside.length;
	const { diff } = await changes();
	return {
		ok,
		rounds,
		...(outside.length ? { outside } : {}),
		diff: diff || "No files changed.",
		...(result.exitCode === 0 ? {} : { lastCheckOutput: tail(result.output, 40) }),
		summary,
	};
}
