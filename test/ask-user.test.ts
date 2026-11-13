import assert from "node:assert/strict";
import { describe, test } from "node:test";
import askUser, { formatAnswers, invalidQuestions } from "../extensions/ask-user/index.ts";

type Answers = (string | undefined)[] | undefined;
type Question = { title: string; options?: string[] };

/** ask_user registered on a fake Pi whose questions dialogs the test settles. */
function setup() {
	let tool: any;
	const sent: { message: any; options: any }[] = [];
	const dialogs: { questions: Question[]; settle: (answers: Answers) => void; fail: (error: Error) => void }[] = [];
	askUser({
		registerTool: (definition: unknown) => (tool = definition),
		sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
	} as any);
	const ctx = {
		hasUI: true,
		ui: {
			questions: (questions: Question[]) =>
				new Promise<Answers>((settle, fail) => dialogs.push({ questions, settle, fail })),
		},
	};
	const call = (id: string, questions: Question[], context: object = ctx) =>
		tool.execute(id, { questions }, undefined, undefined, context);
	return { tool, sent, dialogs, call };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("ask_user", () => {
	test("returns at once and shows each call as one dialog, without waiting for earlier ones", async () => {
		const { sent, dialogs, call } = setup();
		const first = [{ title: "Area?", options: ["A", "B"] }, { title: "Why?" }];
		const second = [{ title: "Go?", options: ["yes"] }];
		assert.deepEqual((await call("c1", first)).content, [{ type: "text", text: '{"accepted":true}' }]);
		await call("c2", second);
		// Both cards are open while neither is answered.
		assert.deepEqual(dialogs.map((d) => d.questions), [first, second]);
		assert.equal(sent.length, 0);

		// The later card answered first is delivered first.
		dialogs[1]!.settle(["yes"]);
		await settled();
		dialogs[0]!.settle(["B", undefined]);
		await settled();
		assert.deepEqual(sent.map((s) => s.message.details.toolCallId), ["c2", "c1"]);
		assert.deepEqual(sent[1]!.message, {
			customType: "ask_user",
			content: "The user answered your ask_user questions:\n\n1. Area?\nAnswer: B\n\n2. Why?\nAnswer: (dismissed without an answer)",
			display: true,
			details: { toolCallId: "c1", questions: first, answers: ["B", undefined] },
		});
		assert.deepEqual(sent[1]!.options, { deliverAs: "steer", triggerTurn: true });
	});

	test("reports a dismissed dialog as every question dismissed, and survives a dialog that fails", async () => {
		const { sent, dialogs, call } = setup();
		await call("c1", [{ title: "One?" }, { title: "Two?" }]);
		dialogs[0]!.settle(undefined);
		await settled();
		assert.match(sent[0]!.message.content, /One\?\nAnswer: \(dismissed without an answer\)\n\n2\. Two\?\nAnswer: \(dismissed/);

		await call("c2", [{ title: "Three?" }]);
		const logged: unknown[] = [];
		const error = console.error;
		console.error = (...args: unknown[]) => logged.push(args.join(" "));
		try {
			dialogs[1]!.fail(new Error("session replaced"));
			await settled();
		} finally {
			console.error = error;
		}
		assert.equal(sent.length, 1);
		assert.deepEqual(logged, ["ask_user: session replaced"]);
	});

	test("refuses unusable questions and sessions without a user interface", async () => {
		const { call } = setup();
		await assert.rejects(call("c", []), /questions must not be empty/);
		await assert.rejects(call("c", [{ title: "  " }]), /titles must not be empty/);
		await assert.rejects(call("c", [{ title: "x", options: [] }]), /at least one non-empty answer/);
		await assert.rejects(call("c", [{ title: "x", options: ["a", " "] }]), /at least one non-empty answer/);
		await assert.rejects(call("c", [{ title: "x" }], { hasUI: false }), /No user interface/);
		assert.equal(invalidQuestions([{ title: "x", options: ["a"] }, { title: "y" }]), undefined);
	});

	test("formats one question without a number and keeps an empty answer distinct", () => {
		assert.equal(formatAnswers([{ title: "Name?" }], [""]), "The user answered your ask_user questions:\n\nName?\nAnswer: (empty answer)");
	});
});
