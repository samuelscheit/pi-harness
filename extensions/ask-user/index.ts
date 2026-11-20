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
//   t3's own notifications (a delegated task finished or asks, a watched PR changed, a
//   continuation) are not replies: t3 sends them through the same RPC prompt as the user's
//   messages, marked `origin: "notification"` (scripts/patch-t3.ts, notification-origin), which
//   Pi gives extensions as input source "notification". They are left to Pi, which queues them as
//   steers delivered after this call returns. Until 2026-11-19 they were consumed as the answer
//   ("Delegated task … [completed]" answered a question three times and the real decision was lost).
//   Fallback: a t3 without that patch (an update drops the patches; the new ones apply only when
//   t3 restarts, which can wait on the user or on macOS's App Management permission) sends them
//   as plain "rpc" input, so those are still told apart by their fixed text (`isT3Notification`).
// - The turn is aborted: the dialog closes and the call fails.
// When the time runs out, or with `wait_minutes: 0` at once, the call returns that no answer is
// there yet; the dialog stays open and its answers arrive later as a message that steers the
// running turn or starts a new one.
//
// extensions/background exempts the tool (WAITING_TOOLS) from moving to the background. It is a
// direct tool, so workflow scripts (tools.ask_user, which waits until answered) and `tool ask_user`
// in bash can call it too.

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionUIQuestion, InputEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const DEFAULT_WAIT_MINUTES = 15;

// Codex's points that still hold (codex-rs/prompts/src/model_messages.rs): concise, self-contained
// questions, options, free text always allowed.
const DESCRIPTION =
	"Ask whoever directs you one or more questions: at top level the user, as a delegated child your parent. Use it for missing information, preferences or approval, and whenever the plan no longer fits: ask rather than guess. Only for questions that need an answer: a status report or result goes into your normal reply, never into ask_user. The call waits for the answers, which are its result, up to `wait_minutes`; a reply in the chat answers too. Unanswered by then, it returns and the answers arrive later as a message. Set `wait_minutes: 0` when you have other work that does not depend on the answers. Keep questions concise and self-contained. Give each option a `description` that says what picking it means and what it costs: the card shows it under the label. A longer explanation goes into your visible reply before the call, never only into your thinking. When an answer asks for an explanation, write it in your reply and end your turn instead of asking again. A free-text answer is always possible, also when options are given; a preselected option is not submitted automatically.";

const parameters = Type.Object(
	{
		questions: Type.Array(
			Type.Object(
				{
					title: Type.String({ description: "The complete question, including any context needed to answer it." }),
					options: Type.Optional(
						Type.Array(
							Type.Object(
								{
									label: Type.String({ description: "The answer when picked: short, a few words." }),
									description: Type.Optional(Type.String({ description: "What picking it means: its effect and trade-off, in one or two sentences." })),
								},
								{ additionalProperties: false },
							),
							{
								minItems: 1,
								description:
									"Suggested answers, recommended first (it is preselected). Do not add an Other option: free text is always possible. Omit for a free-text-only question.",
							},
						),
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
	if (questions.some((q) => q.options && (q.options.length === 0 || q.options.some((o) => !o.label.trim())))) {
		return "options must contain at least one answer, each with a non-empty label";
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

// Fallback for a t3 without the notification-origin patch (see the top): t3's server-written
// messages (apps/server/src/orchestration-v2: Orchestrator.ts
// delegatedCompletionWakeDetail, ProviderContinuationService.ts, DelegatedTaskQuestionReactor.ts,
// pullRequestWatch.ts, UsageLimitRecoveryWorker.ts), each matched from its first line to its exact
// wording, so a user's reply that quotes one, mentions one or starts like one is still a reply.
const T3_NOTIFICATIONS = [
	// A delegated task's completion wake, one block per task: "Delegated task <id> (<title>) [<status>]:\n<result>" or "…]. Use task_status …".
	/^Delegated task \S+(?: \(.*\))? \[[a-z_]+\](?::\n|\. Use task_status with taskId \S+ to read the result\.)/,
	/^Delegated task \S+ reached a terminal state\. Use task_status with taskId \S+ to read the result\./,
	/^Delegated tasks \S+(?:, \S+)* reached terminal states\. Use task_status with each taskId to read the results\.$/,
	/^Delegated task \S+ (?:asked a question and is still working|is blocked on a question and cannot continue until it is answered)\. Read it with t3_pending_request /,
	/^Update on pull request #\d+ \(\S+\), which T3 Code is watching for you:\n/,
	/^Background task completed\.$/,
	/^Continue where you left off\.$/,
];

/** Whether a message is a notification t3 wrote (a delegated task finished or asks, a watched PR changed, …), not the user. */
export const isT3Notification = (text: string) => T3_NOTIFICATIONS.some((shape) => shape.test(text));

/** Whether input is the user's words, which answer waiting questions: not an extension's message, not a client's notification. */
export const isUserReply = (event: InputEvent) =>
	event.source !== "extension" && event.source !== "notification" && !(event.source === "rpc" && isT3Notification(event.text));

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
	// A user message while calls wait: it is their answer, not a new message. Messages from
	// extensions and t3's notifications go on to the agent as usual, after the waiting call.
	pi.on("input", (event, ctx) => {
		if (!isUserReply(event)) return;
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
