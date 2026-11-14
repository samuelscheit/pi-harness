// ask_user: ask whoever directs the agent (the user at top level, the parent of a delegated child)
// questions on Pi's dialogs, and wait for the answers.
//
// One call is one Pi questions dialog (`ctx.ui.questions`): in t3 one card holding all its
// questions, each also taking a typed answer (a delegated child's card becomes a pending request
// t3 reports to its parent thread); in the terminal the questions one after another.
//
// The call waits up to `wait_minutes` (default 15) and its result is the answers. Until 2026-11
// it returned `{"accepted":true}` at once (Codex's request_user_input_async) and the answers came as
// a later message; agents then guessed and went on instead of waiting, or ended their turn. The
// wait ends early in three ways:
// - The dialog is answered (or dismissed): the answers are the result.
// - A user message arrives (a reply in the chat instead of on the card): its text answers every
//   question, the dialog closes (`dismiss` takes the t3 card down), and the message is consumed, so
//   it does not reach the conversation a second time. Any user message counts: while the agent is
//   blocked on its questions, a message is almost always the reply, and an unrelated instruction
//   still reaches the agent in full, as the tool result, with a note that it was a chat reply.
// - The turn is aborted: the dialog closes and the call fails.
// When the time runs out, or with `wait_minutes: 0` at once, the call returns that no answer is
// there yet; the dialog stays open and its answers arrive later as a message that steers the
// running turn or starts a new one.
//
// extensions/background exempts the tool (WAITING_TOOLS) from moving to the background. It is a
// direct tool, so workflow scripts (tools.ask_user, which waits until answered) and `tool ask_user`
// in bash can call it too.

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionUIQuestion } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const DEFAULT_WAIT_MINUTES = 15;

// Codex's points that still hold (codex-rs/prompts/src/model_messages.rs): concise, self-contained
// questions, options, free text always allowed.
const DESCRIPTION =
	"Ask whoever directs you one or more questions: at top level the user, as a delegated child your parent. Use it for missing information, preferences or approval, and whenever the plan no longer fits: ask rather than guess. The call waits for the answers, which are its result, up to `wait_minutes`; a reply in the chat answers too. Unanswered by then, it returns and the answers arrive later as a message. Set `wait_minutes: 0` when you have other work that does not depend on the answers. Keep questions concise and self-contained. A free-text answer is always possible, also when options are given; a preselected option is not submitted automatically.";

const parameters = Type.Object(
	{
		questions: Type.Array(
			Type.Object(
				{
					title: Type.String({ description: "The complete question, including any context needed to answer it." }),
					options: Type.Optional(
						Type.Array(Type.String(), {
							minItems: 1,
							description:
								"Suggested answers, recommended first (it is preselected). Do not add an Other option: free text is always possible. Omit for a free-text-only question.",
						}),
					),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, description: "One or more self-contained questions, shown together in this order." },
		),
		wait_minutes: Type.Optional(
			Type.Number({
				minimum: 0,
				description: `How long to wait for the answers; default ${DEFAULT_WAIT_MINUTES}. 0 returns at once, and the answers arrive later as a message.`,
			}),
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

/** The answers as text; `answers` is undefined when the dialog was dismissed. A chat reply is the same answer to every question. */
export function formatAnswers(questions: ExtensionUIQuestion[], answers: (string | undefined)[] | undefined, chat = false): string {
	const lines = questions.map((q, i) => {
		const answer = answers?.[i];
		return `${questions.length > 1 ? `${i + 1}. ` : ""}${q.title}\nAnswer: ${answer === undefined ? "(dismissed without an answer)" : answer || "(empty answer)"}`;
	});
	const how = !chat ? "" : questions.length > 1 ? " with one reply in the chat, given here for each question" : " with a reply in the chat";
	return `The user answered your ask_user questions${how}:\n\n${lines.join("\n\n")}`;
}

export const pendingText = (waitedMinutes: number) =>
	`${waitedMinutes > 0 ? `No answer after ${waitedMinutes} min. ` : ""}The questions stay open. Continue with the work that does not depend on the answers, or end your turn: the answers arrive later as a message.`;

/** A call waiting for its answers takes a chat reply. */
type ChatWait = (text: string, images: ImageContent[] | undefined) => void;

/** Waiting calls by session, in process state so a call made before a harness reload still takes the reply. */
const waitsOf = (sessionId: string): Set<ChatWait> => {
	const all = ((globalThis as { __harnessAskUserWaits?: Map<string, Set<ChatWait>> }).__harnessAskUserWaits ??= new Map());
	let waits = all.get(sessionId);
	if (!waits) all.set(sessionId, (waits = new Set()));
	return waits;
};

type Outcome = { answers: (string | undefined)[] | undefined } | { chat: string; images: ImageContent[] | undefined } | { error: unknown } | { timeout: true } | { aborted: true };

export default function askUser(pi: ExtensionAPI) {
	// A user message while calls wait: it is their answer, not a new message.
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		const waits = waitsOf(ctx.sessionManager.getSessionId());
		if (waits.size === 0) return;
		for (const answer of [...waits]) answer(event.text, event.images);
		return { action: "handled" };
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description: DESCRIPTION,
		promptSnippet: "Ask the user (or your parent, as a delegated child) questions and wait for the answers",
		parameters,
		exposure: "direct",
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const problem = invalidQuestions(params.questions);
			if (problem) throw new Error(problem);
			if (!ctx.hasUI) throw new Error("No user interface in this session: ask the questions in your reply instead.");
			const { questions } = params;
			const minutes = params.wait_minutes ?? DEFAULT_WAIT_MINUTES;
			const dialog = new AbortController();
			const shown = ctx.ui.questions(questions, { signal: dialog.signal });
			const deliverLater = () => {
				shown.then((answers) => {
					pi.sendMessage(
						{ customType: "ask_user", content: formatAnswers(questions, answers), display: true, details: { toolCallId, questions, answers } },
						{ deliverAs: "steer", triggerTurn: true },
					);
				}).catch((error: unknown) => {
					// The session was replaced or closed while the questions were open.
					console.error(`ask_user: ${error instanceof Error ? error.message : String(error)}`);
				});
			};
			const pending = (waited: number) => {
				deliverLater();
				return { content: [{ type: "text" as const, text: pendingText(waited) }], details: { questions } };
			};
			if (minutes === 0) return pending(0);

			const waits = waitsOf(ctx.sessionManager.getSessionId());
			let settle!: (outcome: Outcome) => void;
			const outcome = new Promise<Outcome>((resolve) => {
				// Leaves the waits at once, so a message after the dialog's answer is not taken as a reply too.
				settle = (o) => (waits.delete(chat), resolve(o));
			});
			const chat: ChatWait = (text, images) => settle({ chat: text, images });
			waits.add(chat);
			shown.then((answers) => settle({ answers }), (error: unknown) => settle({ error }));
			const timer = setTimeout(() => settle({ timeout: true }), minutes * 60_000);
			const onAbort = () => settle({ aborted: true });
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			const first = await outcome;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);

			if ("timeout" in first) return pending(minutes);
			if ("error" in first) throw first.error;
			if ("aborted" in first) {
				dialog.abort();
				throw new Error("Aborted: the questions were closed without an answer.");
			}
			if ("answers" in first) {
				return { content: [{ type: "text", text: formatAnswers(questions, first.answers) }], details: { questions, answers: first.answers } };
			}
			dialog.abort();
			const answers = questions.map(() => first.chat);
			const content: (TextContent | ImageContent)[] = [{ type: "text", text: formatAnswers(questions, answers, true) }, ...(first.images ?? [])];
			return { content, details: { questions, answers, chat: true } };
		},
	});
}
