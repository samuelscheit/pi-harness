// fix_loop: hand a failing check with a clear error and a known set of files to a cheaper model in
// a child agent with a short context. Measured motivation (law-formalization, 863 Claude Code
// sessions): repair chains (failed check → … → green) cost 17% of the project, 59% of that cache
// reads of a median 379k context per turn.
//
// The workflow runs the check itself before the first and after every round, so "green" is the
// check's exit code, never the child's claim. A round is one message to the child (it may run the
// check itself in between). The `fix-loop` experiment (prompt/experiments/fix-loop.md) activates it.

export const meta: WorkflowMeta = {
	description: [
		"Make a failing check pass with a cheaper model in a fresh child agent that sees only the goal, the files, the check and its failure, not this conversation.",
		"The tool runs `check` itself before the first and after every round: green means exit code 0. Between checks the child reads, edits and runs commands; it may change only `files` (others are refused or reverted).",
		"Returns whether the check passed, the rounds, the diff of the changed files, the last failure output when not green, and the child's summary.",
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
			check: { type: "string", description: "Shell command that passes with exit code 0 when the goal is reached, e.g. 'npm test -- parse.test.ts'. Keep it focused and fast." },
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

export default async function ({ goal, files, check, context, maxRounds = 6, model = "anthropic/claude-sonnet-5-5", checkTimeoutSeconds = 600 }: Input) {
	const runCheck = () => shell(check, { timeoutSeconds: checkTimeoutSeconds });
	let result = await runCheck();
	if (result.exitCode === 0) return { ok: true, rounds: 0, summary: "The check already passes; nothing to fix." };

	const child = agent({
		model,
		files,
		system: [
			"You make a failing check pass in a code repository. You start without the conversation that led here; everything you need is below or in the files.",
			"",
			`Goal: ${goal}`,
			`Check: \`${check}\` (run it with bash; exit code 0 means it passes)`,
			...(context?.trim() ? ["", `Context from the caller:\n${context.trim()}`] : []),
			"",
			"Read the failure, find its cause, change the allowed files, run the check, repeat until it passes. Fix the cause: do not weaken, skip or delete tests or the check, and do not commit.",
			"When the check passes, or you cannot make progress, stop and answer in one or two sentences: what you changed and why.",
		].join("\n"),
	});
	let message = `The check fails (${exitText(result)}):\n${tail(result.output, 200)}`;
	let rounds = 0;
	let summary = "";
	const reverted = new Set<string>();
	while (rounds < maxRounds) {
		rounds++;
		log(`round ${rounds}/${maxRounds}`);
		const reply = await child.run(message);
		summary = reply.text;
		for (const path of reply.reverted) reverted.add(path);
		result = await runCheck();
		if (result.exitCode === 0) break;
		const note = reply.reverted.length ? `\nYour changes to ${reply.reverted.join(", ")} were reverted: change only ${files.join(", ")}.` : "";
		message = `The check still fails (${exitText(result)}, round ${rounds} of ${maxRounds}):\n${tail(result.output, 200)}${note}`;
	}

	const ok = result.exitCode === 0;
	const { diff } = await changes();
	return {
		ok,
		rounds,
		...(reverted.size ? { reverted: [...reverted] } : {}),
		diff: diff || "No files changed.",
		...(ok ? {} : { lastCheckOutput: tail(result.output, 40) }),
		summary,
	};
}
