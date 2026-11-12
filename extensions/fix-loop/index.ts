// fix_loop: hand a failing check with a clear error and a known set of files to a cheap model in a
// child session with a short context (see loop.ts). Measured motivation (law-formalization, 863
// Claude Code sessions): repair chains (failed check → … → green) cost 17% of the project, 59% of
// that cache reads of a median 379k context per turn.
//
// Registered inactive; the `fix-loop` experiment (prompt/experiments/fix-loop.md) activates it in
// arm B.

import { type ExtensionAPI, getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_MODEL, DEFAULT_ROUNDS, type FixLoopDetails, MAX_ROUNDS, runFixLoop } from "./loop.ts";

let runtime: Promise<ModelRuntime> | undefined;
/** The models and credentials of the agent dir, loaded once per process. */
const modelRuntime = () => (runtime ??= ModelRuntime.create());

export default function fixLoop(pi: ExtensionAPI) {
	pi.registerTool({
		name: "fix_loop",
		label: "Fix loop",
		description: [
			"Make a failing check pass with a cheaper model in a fresh child session that sees only the goal, the files, the check and its failure, not this conversation.",
			"The tool runs `check` itself before the first and after every round: green means exit code 0. Between checks the child reads, edits and runs commands; it may change only `files` (others are refused or reverted).",
			"Returns whether the check passed, the rounds, the diff of the changed files, the last failure output when not green, and the child's cost.",
		].join(" "),
		promptSnippet: "Hand a failing check with clear error output and known files to a cheaper child model until it passes",
		promptGuidelines: [
			"Use fix_loop when a test, type check, lint or build fails with a clear error and the fix is confined to files you can name: give it the check command, those files and a one-line goal, then review the returned diff instead of rereading the files.",
			"Do not use fix_loop when the failure needs a design decision, the cause is unknown across the codebase, the check takes minutes per run, or the fix needs this conversation's context that you cannot put in `context`.",
		],
		parameters: Type.Object({
			goal: Type.String({ description: "What to achieve, in one or two sentences (e.g. 'make test_parse_dates pass without changing its expectations')." }),
			files: Type.Array(Type.String(), { minItems: 1, description: "Files or directories the child may change, relative to the working directory or absolute." }),
			check: Type.String({ description: "Shell command that passes with exit code 0 when the goal is reached, e.g. 'npm test -- parse.test.ts'. Keep it focused and fast." }),
			context: Type.Optional(Type.String({ description: "Short hints the child needs: the suspected cause, conventions, what not to touch." })),
			maxRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ROUNDS, description: `Most rounds (child turns between two checks), default ${DEFAULT_ROUNDS}.` })),
			model: Type.Optional(Type.String({ description: `Child model as provider/id, default ${DEFAULT_MODEL}.` })),
			checkTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, description: "Timeout of one check run, default 600." })),
		}),
		defaultActive: false,
		// Other calls must not change files while the loop compares the working tree.
		executionMode: "sequential",
		async execute(_id, params, signal, onUpdate, ctx) {
			const session = ctx.sessionManager;
			const parentSessionFile = session.getSessionFile();
			const { text, details } = await runFixLoop(params, {
				cwd: ctx.cwd,
				modelRuntime: await modelRuntime(),
				agentDir: getAgentDir(),
				sessionDir: parentSessionFile ? session.getSessionDir() : undefined,
				parentSessionFile,
				signal,
				onUpdate: (progress: FixLoopDetails) => onUpdate?.({ content: [{ type: "text", text: progress.log.join("\n") }], details: progress }),
			});
			return { content: [{ type: "text", text }], details };
		},
	});
}
