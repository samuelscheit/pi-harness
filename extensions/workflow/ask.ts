// Questions go up the chain, like a condition system: a delegated child's `ask_user` question
// reaches the workflow that delegated it, whose `onAsk` handler may answer it (from data, with
// llm(), by asking its own parent with tools.ask_user) or throw to stop the run. A handler that
// returns undefined passes the question up unchanged: whoever runs the workflow (the orchestrator,
// at top level the user) answers it, as without a handler.
//
// - In t3 the child's question is a pending request in its thread. A wait for the child's run ends
//   early while it is pending (t3.ts); the workflow then reads it (`t3_pending_request` read) and
//   responds with the handler's answers, which the child's blocking `ask_user` returns as its tool
//   result. A question passed up stays pending; t3 reports it to the parent thread as before.
// - In-process the child's `ask_user` shows its questions on a UI the workflow gives the child
//   session: the handler answers, and a question passed up goes to the workflow session's own
//   `ask_user`.
//
// Every question and its answer is a journaled call (kind `ask`), so a resume replays the answer
// instead of asking the handler again.

import type { ExtensionUIContext, ExtensionUIQuestion } from "@earendil-works/pi-coding-agent";
import type { T3Call } from "./t3.ts";

/** A question as onAsk sees it. */
export interface Question {
	id: string;
	title: string;
	options?: string[];
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
	options?: { label: string }[];
}

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
		const questions: Question[] = pending.map((q) => ({ id: q.id, title: q.question, ...(q.options?.length ? { options: q.options.map((o) => o.label) } : {}) }));
		handled.add(requestId);
		const answers = await ask(questions, signal);
		if (!answers) continue;
		const byId = Object.fromEntries(questions.flatMap((q, i) => (answers[i] === undefined ? [] : [[q.id, answers[i]]])));
		await call("t3_pending_request", { action: "respond", threadId, requestId, answers: byId }, signal);
		answered = true;
	}
	return answered;
}

/** The in-process side: a headless UI whose questions dialogs `ask` answers; everything else does nothing. */
export function questionsUi(ask: Ask): ExtensionUIContext {
	const questions = async (asked: ExtensionUIQuestion[], opts?: { signal?: AbortSignal }) =>
		ask(
			asked.map((q, i) => ({ id: String(i), title: q.title, ...(q.options ? { options: q.options } : {}) })),
			opts?.signal ?? new AbortController().signal,
		);
	const methods: Partial<ExtensionUIContext> = { questions, select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined };
	return new Proxy(methods, { get: (target, name) => (name in target ? target[name as keyof typeof target] : () => undefined) }) as ExtensionUIContext;
}
