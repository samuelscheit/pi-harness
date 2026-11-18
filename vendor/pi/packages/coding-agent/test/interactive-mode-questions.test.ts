import { describe, expect, it } from "vitest";
import type { ExtensionUIDialogOptions, ExtensionUIQuestion } from "../src/core/extensions/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type Dialog = { kind: "select" | "input"; title: string; options?: string[]; signal?: AbortSignal };
type Questions = (
	questions: ExtensionUIQuestion[],
	opts?: ExtensionUIDialogOptions,
) => Promise<(string | undefined)[] | undefined>;

/** The terminal's questions dialog over scripted selector and input answers. */
function ask(answers: ((dialog: Dialog) => Promise<string | undefined> | string | undefined)[]) {
	const shown: Dialog[] = [];
	const next = (dialog: Dialog) => {
		shown.push(dialog);
		const answer = answers.shift();
		if (!answer) throw new Error(`unexpected dialog ${dialog.title}`);
		return Promise.resolve(answer(dialog));
	};
	const fake = {
		showExtensionSelector: (title: string, options: string[], opts?: ExtensionUIDialogOptions) =>
			next({ kind: "select", title, options, signal: opts?.signal }),
		showExtensionInput: (title: string, _placeholder?: string, opts?: ExtensionUIDialogOptions) =>
			next({ kind: "input", title, signal: opts?.signal }),
	};
	const questions = (InteractiveMode as any).prototype.showExtensionQuestions as Questions;
	return { shown, run: (q: ExtensionUIQuestion[], opts?: ExtensionUIDialogOptions) => questions.call(fake, q, opts) };
}

describe("InteractiveMode questions dialog", () => {
	it("asks one question after another: options with a typed-answer escape, free text as input, Escape skips", async () => {
		const { shown, run } = ask([
			() => "B — the second",
			() => "Type an answer…",
			() => "typed",
			() => "free",
			() => undefined,
		]);
		const answers = await run([
			{ title: "Pick", options: [{ label: "A" }, { label: "B", description: "the second" }] },
			{ title: "Or type", options: [{ label: "C" }] },
			{ title: "Free" },
			{ title: "Skip me" },
		]);
		expect(answers).toEqual(["B", "typed", "free", undefined]);
		expect(shown.map(({ kind, title, options }) => [kind, title, options])).toEqual([
			["select", "(1/4) Pick", ["A", "B — the second", "Type an answer…"]],
			["select", "(2/4) Or type", ["C", "Type an answer…"]],
			["input", "(2/4) Or type", undefined],
			["input", "(3/4) Free", undefined],
			["input", "(4/4) Skip me", undefined],
		]);
		expect(shown.every((dialog) => dialog.signal === undefined)).toBe(true);
	});

	it("numbers no single question and returns an empty answer as given", async () => {
		const { shown, run } = ask([() => ""]);
		expect(await run([{ title: "Only" }])).toEqual([""]);
		expect(shown[0]!.title).toBe("Only");
	});

	it("dismisses the whole set when the signal aborts, and asks nothing when it already has", async () => {
		const controller = new AbortController();
		const { shown, run } = ask([
			() => "A",
			() => {
				controller.abort();
				return undefined;
			},
		]);
		const answers = await run([{ title: "One", options: [{ label: "A" }] }, { title: "Two" }, { title: "Three" }], {
			signal: controller.signal,
		});
		expect(answers).toBeUndefined();
		expect(shown).toHaveLength(2);
		expect(shown[0]!.signal?.aborted).toBe(true);
		expect(await ask([]).run([{ title: "never" }], { signal: AbortSignal.abort() })).toBeUndefined();
	});

	it("times out the whole set, not each question", async () => {
		const { shown, run } = ask([
			() => "first",
			(dialog) =>
				new Promise<undefined>((resolve) => dialog.signal!.addEventListener("abort", () => resolve(undefined))),
		]);
		const started = Date.now();
		expect(await run([{ title: "One" }, { title: "Two" }], { timeout: 50 })).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(shown).toHaveLength(2);
		expect(shown[0]!.signal).toBe(shown[1]!.signal);
	});
});
