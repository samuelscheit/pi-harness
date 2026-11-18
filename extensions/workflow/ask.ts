// Questions go up the chain, like a condition system: a delegated child's `ask_user` question
// reaches the workflow that delegated it, whose `onAsk` handler may answer it (from data, with
// llm(), by asking its own parent with tools.ask_user) or throw to stop the run. A handler that
// returns undefined passes the question up unchanged: whoever runs the workflow (the orchestrator,
// at top level the user) answers it, as without a handler.
//
// - In t3 the child's question is a pending request in its thread. t3's thread wait does not end on
//   it, so with a handler the wait goes in short slices (t3.ts), and in between the workflow reads
//   pending requests (`t3_pending_request` list, read) and responds with the handler's answers,
//   which the child's blocking `ask_user` returns as its tool result. A question passed up stays pending; t3 reports it to the parent thread as before.
// - In-process the child's `ask_user` shows its questions on a UI the workflow gives the child
//   session: the handler answers, and a question passed up goes to the workflow session's own
//   `ask_user`.
//
// Every question and its answer is a journaled call (kind `ask`), so a resume replays the answer
// instead of asking the handler again.

import type { ExtensionUIContext, ExtensionUIQuestion, ExtensionUIQuestionOption } from "@earendil-works/pi-coding-agent";
import type { T3Call } from "./t3.ts";

/** A question as onAsk sees it. */
export interface Question {
	id: string;
	title: string;
	options?: ExtensionUIQuestionOption[];
}

/** What onAsk may return: answers in question order, or by question id; undefined passes the questions up. */
export type HandlerAnswers = readonly (string | undefined)[] | Readonly<Record<string, string>> | undefined;

/** Answers in question order (undefined: none for that question); throws for a malformed one. */
export function answersInOrder(questions: readonly Question[], answers: unknown): (string | undefined)[] {
	if (Array.isArray(answers)) {
		if (answers.length > questions.length) throw new TypeError(`onAsk returned ${answers.length} answers for ${questions.length} questions`);
		return questions.map((_q, i) => {
			const answer: unknown = answers[i];
			if (answer !== undefined && answer !== null && typeof answer !== "string") throw new TypeError("onAsk: answers must be strings");
			return answer ?? undefined;
		});
	}
	if (answers && typeof answers === "object") {
		const record = answers as Record<string, unknown>;
		const unknown = Object.keys(record).find((key) => !questions.some((q) => q.id === key));
		if (unknown) throw new TypeError(`onAsk: no question with id ${unknown} (ids: ${questions.map((q) => q.id).join(", ")})`);
		return questions.map((q) => {
			const answer = record[q.id];
			if (answer !== undefined && typeof answer !== "string") throw new TypeError("onAsk: answers must be strings");
			return answer;
		});
	}
	throw new TypeError("onAsk must return answers (an array in question order, or an object by question id) or undefined");
}

/** Answer a child's questions: resolves to the answers, or undefined to pass them up. Journaled by the caller. */
export type Ask = (questions: Question[], signal: AbortSignal) => Promise<(string | undefined)[] | undefined>;

interface PendingQuestion {
	id: string;
	question: string;
	options?: { label: string; description?: string }[];
}

/** A card's option as asked: t3 repeats the label as the description of an option without one. */
const askedOption = ({ label, description }: { label: string; description?: string }): ExtensionUIQuestionOption =>
	description && description !== label ? { label, description } : { label };

/**
 * The t3 side: answer the questions pending in a child's thread with `ask`. Each request is handled
 * once (`handled`), answered or passed up; resolves to whether one was answered.
 */
export async function answerPending(call: T3Call, threadId: string, handled: Set<string>, ask: Ask, signal: AbortSignal): Promise<boolean> {
	const listed = await call("t3_pending_request", { action: "list", threadId }, signal);
	const ids = (Array.isArray(listed.requestIds) ? listed.requestIds : []).filter((id): id is string => typeof id === "string" && !handled.has(id));
	let answered = false;
	for (const requestId of ids) {
		const read = await call("t3_pending_request", { action: "read", threadId, requestId }, signal);
		const pending = (Array.isArray(read.questions) ? read.questions : []) as PendingQuestion[];
		const questions: Question[] = pending.map((q) => ({ id: q.id, title: q.question, ...(q.options?.length ? { options: q.options.map(askedOption) } : {}) }));
		handled.add(requestId);
		const answers = await ask(questions, signal);
		if (!answers) continue;
		const byId = Object.fromEntries(questions.flatMap((q, i) => (answers[i] === undefined ? [] : [[q.id, answers[i]]])));
		await call("t3_pending_request", { action: "respond", threadId, requestId, answers: byId }, signal);
		answered = true;
	}
	return answered;
}

/** UI methods a headless child session may call: they do nothing. */
const SILENT = ["notify", "setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "addAutocompleteProvider", "setEditorComponent", "setToolsExpanded"];

/**
 * The in-process side: a headless UI whose questions dialogs `ask` answers; other dialogs are
 * dismissed and everything else does nothing. A plain object, since Pi copies it (a Proxy's
 * fallbacks would be lost).
 */
export function questionsUi(ask: Ask): ExtensionUIContext {
	const ui = {
		...Object.fromEntries(SILENT.map((name) => [name, () => undefined])),
		questions: async (asked: ExtensionUIQuestion[], opts?: { signal?: AbortSignal }) =>
			ask(
				asked.map((q, i) => ({ id: String(i), title: q.title, ...(q.options ? { options: q.options } : {}) })),
				opts?.signal ?? new AbortController().signal,
			),
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
		custom: async () => undefined,
		onTerminalInput: () => () => undefined,
		getEditorText: () => "",
		getEditorComponent: () => undefined,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "no user interface" }),
		getToolsExpanded: () => false,
	};
	return ui as unknown as ExtensionUIContext;
}
