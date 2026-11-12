// note_improvement: the model's cheap capture of something the harness or a project should do
// better. It only appends to a backlog; dreaming (a t3 scheduled task) and /improve read the
// backlogs later, decide what to change and record it in the changelog.
//
// Backlogs are plain Markdown in the harness-neutral `.agents/` layout:
// - project: <repository root>/.agents/improvements.md, for the project's AGENTS.md, skills
//   and conventions;
// - harness: this repository's .agents/improvements.md, for the base prompt, global rules,
//   extensions, tools and models.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HARNESS_ROOT, repositoryRoot } from "../lib/repository.ts";
const BACKLOG = join(".agents", "improvements.md");
const HEADER = "# Improvement backlog\n\nNoted by agents with note_improvement; consumed by dreaming and /improve.\n";

const DESCRIPTION =
	"Note something the harness or this project should do better, for a later improvement pass. Use it when you notice friction worth fixing: the user corrected you or repeated an instruction, an instruction was missing, wrong or ambiguous, a tool failed or misled you, or you lost time on something a rule, skill or tool would have prevented. It only appends a note and returns at once; continue your task. Do not use it for the user's task itself.";

const parameters = Type.Object(
	{
		scope: Type.Union([Type.Literal("project"), Type.Literal("harness")], {
			description:
				"project: this repository's instructions, skills or conventions. harness: the agent itself (base prompt, global rules, tools, extensions, models), regardless of project.",
		}),
		observation: Type.String({ description: "What happened, with the concrete evidence (user words, error, file, command)." }),
		proposal: Type.String({ description: "The change you would make, as specific as you can (file, rule text, tool behaviour)." }),
	},
	{ additionalProperties: false },
);

export interface Note {
	scope: "project" | "harness";
	observation: string;
	proposal: string;
}

export function backlogPath(scope: Note["scope"], cwd: string, harnessRoot = HARNESS_ROOT): string {
	return join(scope === "harness" ? harnessRoot : repositoryRoot(cwd), BACKLOG);
}

/** One backlog entry. Multi-line text is indented under its label so entries stay separable. */
export function formatNote(note: Note, at: Date, sessionId: string, cwd: string): string {
	const field = (label: string, text: string) => `- **${label}:** ${text.trim().replace(/\n/g, "\n  ")}`;
	return [`\n## ${at.toISOString().slice(0, 16).replace("T", " ")} UTC`, field("Session", `${sessionId} (${cwd})`), field("Observation", note.observation), field("Proposal", note.proposal), ""].join("\n");
}

export function appendNote(file: string, entry: string): void {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, existsSync(file) ? entry : `${HEADER}${entry}`);
}

export default function improvements(pi: ExtensionAPI) {
	pi.registerTool({
		name: "note_improvement",
		label: "Note improvement",
		description: DESCRIPTION,
		promptSnippet: "Note friction the harness or project should fix later; returns at once",
		parameters,
		exposure: "model-only",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!params.observation.trim() || !params.proposal.trim()) throw new Error("observation and proposal must not be empty");
			const file = backlogPath(params.scope, ctx.cwd);
			appendNote(file, formatNote(params, new Date(), ctx.sessionManager.getSessionId(), ctx.cwd));
			return { content: [{ type: "text", text: `Noted in ${file}.` }], details: { file, ...params } };
		},
	});
}
