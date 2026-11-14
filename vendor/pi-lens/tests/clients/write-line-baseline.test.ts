import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	changedLineRanges,
	MAX_ALIGNMENT_EDITS,
} from "../../clients/line-alignment.js";
import {
	_resetWriteLineBaselinesForTests,
	exactLineHashes,
	MAX_BASELINE_FILE_BYTES,
	MAX_BASELINE_TARGETS_PER_CALL,
	MAX_BASELINES,
	recordPreWriteLines,
	takeWriteChangedRanges,
} from "../../clients/write-line-baseline.js";
import { removeTempDirSync } from "./test-utils.js";

const lines = (count: number, prefix = "line") =>
	Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);

const ranges = (before: string[], after: string[]) =>
	changedLineRanges(
		exactLineHashes(before.join("\n"))!,
		exactLineHashes(after.join("\n"))!,
	);

describe("changedLineRanges", () => {
	it("names one replaced line, not the lines around it", () => {
		const before = lines(200);
		const after = [...before];
		after[14] = "const CLAUDE_IMPORTED = 1;";
		expect(ranges(before, after)).toEqual([{ start: 15, end: 15 }]);
	});

	it("names inserted lines at their new positions, and shifted lines stay unchanged", () => {
		const before = lines(10);
		const after = [...before.slice(0, 3), "new a", "new b", ...before.slice(3)];
		expect(ranges(before, after)).toEqual([{ start: 4, end: 5 }]);
	});

	it("names the line that now stands where a deleted run was", () => {
		const before = lines(10);
		const after = [...before.slice(0, 3), ...before.slice(6)];
		expect(ranges(before, after)).toEqual([{ start: 4, end: 4 }]);
	});

	it("names the last line when the deleted run was the file's tail", () => {
		const before = lines(10);
		expect(ranges(before, before.slice(0, 7))).toEqual([{ start: 7, end: 7 }]);
	});

	it("keeps scattered edits apart", () => {
		const before = lines(300);
		const after = [...before];
		after[4] = "x";
		after[299] = "y";
		expect(ranges(before, after)).toEqual([
			{ start: 5, end: 5 },
			{ start: 300, end: 300 },
		]);
	});

	it("counts a re-indented line as changed (indentation is meaning in Python and YAML)", () => {
		expect(ranges(["a:", "  b: 1"], ["a:", "b: 1"])).toEqual([
			{ start: 2, end: 2 },
		]);
	});

	it("is empty for equal lines and names every line of a file that was empty", () => {
		expect(ranges(lines(5), lines(5))).toEqual([]);
		expect(ranges([""], ["a", "b"])).toEqual([{ start: 1, end: 2 }]);
	});

	it("has no answer past the edit bound", () => {
		const before = lines(MAX_ALIGNMENT_EDITS + 10, "old");
		const after = lines(MAX_ALIGNMENT_EDITS + 10, "new");
		expect(ranges(before, after)).toBeUndefined();
	});
});

describe("write line baselines", () => {
	let dir: string;
	beforeEach(() => {
		_resetWriteLineBaselinesForTests();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-write-baseline-"));
	});
	afterEach(() => {
		_resetWriteLineBaselinesForTests();
		removeTempDirSync(dir);
	});

	const file = (name: string, content: string) => {
		const filePath = path.join(dir, name);
		fs.writeFileSync(filePath, content);
		return filePath;
	};

	it("narrows a write to the lines it changed, once", () => {
		const filePath = file("store.ts", `${lines(200).join("\n")}\n`);
		recordPreWriteLines("call-1", [filePath]);
		const after = lines(200);
		after[14] = "changed";
		const content = `${after.join("\n")}\n`;
		expect(takeWriteChangedRanges("call-1", filePath, content)).toEqual([
			{ start: 15, end: 15 },
		]);
		// Consumed: a second take has no baseline.
		expect(takeWriteChangedRanges("call-1", filePath, content)).toBeUndefined();
	});

	it("matches the baseline across spellings of one path and CRLF bytes", () => {
		const filePath = file("crlf.ts", "a\r\nb\r\nc\r\n");
		recordPreWriteLines("call-1", [path.join(dir, ".", "crlf.ts")]);
		expect(
			takeWriteChangedRanges("call-1", filePath, "a\r\nB\r\nc\r\n"),
		).toEqual([{ start: 2, end: 2 }]);
	});

	it("has no answer without a baseline of the same call and file", () => {
		const filePath = file("a.ts", "a\nb\n");
		const other = file("b.ts", "a\nb\n");
		recordPreWriteLines("call-1", [filePath]);
		recordPreWriteLines(undefined, [other]);
		expect(
			takeWriteChangedRanges("call-2", filePath, "a\nc\n"),
		).toBeUndefined();
		expect(
			takeWriteChangedRanges(undefined, filePath, "a\nc\n"),
		).toBeUndefined();
		expect(takeWriteChangedRanges("call-1", other, "a\nc\n")).toBeUndefined();
		// The created file had no bytes before the call.
		const created = path.join(dir, "new.ts");
		recordPreWriteLines("call-3", [created]);
		expect(takeWriteChangedRanges("call-3", created, "x\n")).toBeUndefined();
	});

	it("has no answer when nothing changed, so the write keeps its whole scope", () => {
		const filePath = file("same.ts", "a\nb\n");
		recordPreWriteLines("call-1", [filePath]);
		expect(
			takeWriteChangedRanges("call-1", filePath, "a\nb\n"),
		).toBeUndefined();
	});

	it("records nothing for a file past the byte cap", () => {
		const filePath = file("big.ts", "x".repeat(MAX_BASELINE_FILE_BYTES + 1));
		recordPreWriteLines("call-1", [filePath]);
		expect(takeWriteChangedRanges("call-1", filePath, "y\n")).toBeUndefined();
	});

	it("baselines at most the per-call cap of targets", () => {
		const targets = Array.from(
			{ length: MAX_BASELINE_TARGETS_PER_CALL + 1 },
			(_, i) => file(`t${i}.ts`, "a\nb\n"),
		);
		recordPreWriteLines("call-1", targets);
		expect(takeWriteChangedRanges("call-1", targets[0]!, "a\nc\n")).toEqual([
			{ start: 2, end: 2 },
		]);
		expect(
			takeWriteChangedRanges("call-1", targets.at(-1)!, "a\nc\n"),
		).toBeUndefined();
	});

	it("evicts the oldest baseline past the total cap", () => {
		const filePath = file("a.ts", "a\nb\n");
		for (let call = 0; call <= MAX_BASELINES; call += 1)
			recordPreWriteLines(`call-${call}`, [filePath]);
		expect(
			takeWriteChangedRanges("call-0", filePath, "a\nc\n"),
		).toBeUndefined();
		expect(
			takeWriteChangedRanges(`call-${MAX_BASELINES}`, filePath, "a\nc\n"),
		).toEqual([{ start: 2, end: 2 }]);
	});

	it("re-recording a call's file replaces its baseline", () => {
		const filePath = file("a.ts", "a\nb\n");
		recordPreWriteLines("call-1", [filePath]);
		fs.writeFileSync(filePath, "a\nc\n");
		recordPreWriteLines("call-1", [filePath]);
		expect(takeWriteChangedRanges("call-1", filePath, "a\nc\nd\n")).toEqual([
			{ start: 3, end: 3 },
		]);
	});
});
