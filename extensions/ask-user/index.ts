// ask_user: Codex's asynchronous user-input tool (request_user_input_async), on Pi's dialogs.
//
// The base prompt (prompt/base.md) tells the model how to use it: ask early, keep
// working on what does not depend on the answer, wait for required answers. So the tool keeps
// Codex's contract: it shows the questions and returns `{"accepted":true}` at once; the answers
// arrive later as a message that steers the running turn or starts a new one.
//
// One call is one Pi questions dialog (`ctx.ui.questions`): in t3 one card holding all its
// questions, each also taking a typed answer; in the terminal the questions one after another.
// Calls do not wait for each other: a later call's card opens at once, even while an earlier one
// is still unanswered.

import type { ExtensionAPI, ExtensionUIQuestion } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Codex's bundled description (codex-rs/prompts/src/model_messages.rs).
const DESCRIPTION =
	"Ask the user one or more questions during ongoing work. Use this tool only to request missing information, preferences, constraints, clarification, or approval. The tool returns immediately without ending the turn or waiting for a reply; any reply arrives asynchronously as a new user message. Keep questions concise, self-contained, and easy to understand, using a level of detail appropriate to the user and task. The UI always allows a free-text answer, including when suggested options are provided. A preselected option is not submitted automatically.";

const parameters = Type.Object(
	{
		questions: Type.Array(
			Type.Object(
				{
					title: Type.String({ description: "The complete question shown to the user, including any context needed to answer it." }),
					options: Type.Optional(
						Type.Array(Type.String(), {
							minItems: 1,
							description:
								"Suggested answers, in display order. Put the recommended answer first; the first option is preselected by default. The user can select one option or enter a free-text answer. Do not include an Other option or a free-text placeholder; the UI provides free-text input automatically. Omit options for a free-text-only question.",
						}),
					),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, description: "One or more self-contained questions to present together, in display order." },
		),
	},
	{ additionalProperties: false },
);

/** Why the questions are unusable, or undefined when they are fine. */
export function invalidQuestions(questions: ExtensionUIQuestion[]): string | undefined {
	if (questions.length === 0) return "questions must not be empty";
	if (questions.some((q) => !q.title.trim())) return "question titles must not be empty";
	if (questions.some((q) => q.options && (q.options.length === 0 || q.options.some((o) => !o.trim())))) {
		return "options must contain at least one non-empty answer";
	}
	return undefined;
}

/** The message that delivers the answers; `answers` is undefined when the user dismissed the dialog. */
export function formatAnswers(questions: ExtensionUIQuestion[], answers: (string | undefined)[] | undefined): string {
	const lines = questions.map((q, i) => {
		const answer = answers?.[i];
		return `${questions.length > 1 ? `${i + 1}. ` : ""}${q.title}\nAnswer: ${answer === undefined ? "(dismissed without an answer)" : answer || "(empty answer)"}`;
	});
	return `The user answered your ask_user questions:\n\n${lines.join("\n\n")}`;
}

export default function askUser(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description: DESCRIPTION,
		promptSnippet: "Ask the user questions without stopping work; answers arrive later as a message",
		parameters,
		exposure: "model-only",
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const problem = invalidQuestions(params.questions);
			if (problem) throw new Error(problem);
			if (!ctx.hasUI) throw new Error("No user interface in this session: ask the questions in your reply instead.");
			const questions = params.questions;
			ctx.ui.questions(questions).then((answers) => {
				pi.sendMessage(
					{ customType: "ask_user", content: formatAnswers(questions, answers), display: true, details: { toolCallId, questions, answers } },
					{ deliverAs: "steer", triggerTurn: true },
				);
			}).catch((error: unknown) => {
				// The session was replaced or closed while the questions were open.
				console.error(`ask_user: ${error instanceof Error ? error.message : String(error)}`);
			});
			return { content: [{ type: "text", text: '{"accepted":true}' }], details: { questions } };
		},
	});
}
