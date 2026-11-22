// The line ranges the explorer names, read by the harness and returned verbatim (exact text the
// caller can edit with), ranked, under a token budget, and without ranges an earlier explore call of
// the same context returned unchanged (same file, lines and content hash).

import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface Range {
	path: string;
	start: number;
	end: number;
	why?: string;
}

/** A returned range as the result's details record it: what the caller's context now holds. */
export interface Shown {
	path: string;
	start: number;
	end: number;
	hash: string;
}

export interface Selection {
	/** Ranges returned in full or cut to the budget, in rank order, with their text. */
	shown: (Shown & { why?: string; text: string; cut: boolean })[];
	/** Ranges the caller already has, unchanged. */
	known: Range[];
	/** Ranges left out because the budget was used up. */
	omitted: Range[];
	/** Ranges that could not be read (missing file, no such lines). */
	invalid: (Range & { problem: string })[];
}

/**
 * Ranges as the explorer reports them: one per line, `path:start-end why` (also `path:line`, a
 * dash or en dash, and an optional `-`/`—`/`(…)` before the reason). The explorer reports them as
 * text: Haiku's array-of-objects arguments reached the tool without the field on 5 of 6 calls
 * through the gateway (2026-11-22), while plain strings arrive intact. Lines that are not ranges are
 * returned as `rejected`.
 */
export function parseRangeLines(text: string): { ranges: Range[]; rejected: string[] } {
	const ranges: Range[] = [];
	const rejected: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, "").replace(/^`([^`]+)`/, "$1");
		if (!line) continue;
		const m = /^(\S+?):(\d+)(?:\s*[-–]\s*(\d+))?(?:[\s,:;]+(?:[-–—]\s*)?\(?(.*?)\)?)?$/.exec(line);
		if (!m) {
			rejected.push(raw.trim());
			continue;
		}
		const start = Number(m[2]);
		const end = m[3] ? Number(m[3]) : start;
		const why = m[4]?.trim();
		ranges.push({ path: m[1]!, start: Math.min(start, end), end: Math.max(start, end), ...(why ? { why } : {}) });
	}
	return { ranges, rejected };
}

/** Files above this size are not read (a range in a large log or bundle is a mistake). */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** A file's lines, or why it cannot be shown: not a file, too large, binary (a NUL byte in its first 8 KB). */
function readLines(path: string): string[] | Error {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return new Error("not a file");
		if (stat.size > MAX_FILE_BYTES) return new Error(`too large (${Math.round(stat.size / 1024 / 1024)} MB)`);
		const head = Buffer.alloc(Math.min(8192, stat.size));
		const fd = openSync(path, "r");
		try {
			readSync(fd, head, 0, head.length, 0);
		} finally {
			closeSync(fd);
		}
		if (head.includes(0)) return new Error("binary");
		return readFileSync(path, "utf8").split("\n");
	} catch (error) {
		return error as Error;
	}
}

/** Tokens of a text, the usual 4-characters estimate. */
export const tokensOf = (text: string) => Math.ceil(text.length / 4);

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Ranges that overlap or touch in the same file merged, keeping the first's rank and joining reasons. */
export function mergeRanges(ranges: readonly Range[]): Range[] {
	const out: Range[] = [];
	for (const r of ranges) {
		const same = out.find((o) => o.path === r.path && r.start <= o.end + 1 && r.end >= o.start - 1);
		if (!same) {
			out.push({ ...r });
			continue;
		}
		same.start = Math.min(same.start, r.start);
		same.end = Math.max(same.end, r.end);
		if (r.why && r.why !== same.why) same.why = same.why ? `${same.why}; ${r.why}` : r.why;
	}
	return out;
}

/**
 * Read ranked ranges from `cwd` within `budget` tokens. A range the caller already holds (`seen`, by
 * path, lines and content hash) is listed as known instead. When the next range does not fit, it
 * is cut to the remaining budget if at least `minLines` fit; the ranges after it are still tried.
 */
export function selectRanges(cwd: string, ranges: readonly Range[], budget: number, seen: readonly Shown[], minLines = 8): Selection {
	const selection: Selection = { shown: [], known: [], omitted: [], invalid: [] };
	const files = new Map<string, string[] | Error>();
	const linesOf = (path: string) => files.get(path) ?? files.set(path, readLines(path)).get(path)!;
	let left = budget;
	for (const raw of mergeRanges(ranges.map((r) => ({ ...r, path: displayPath(cwd, r.path) })))) {
		const lines = linesOf(resolve(cwd, raw.path));
		if (lines instanceof Error) {
			selection.invalid.push({ ...raw, problem: lines.message.split("\n")[0]! });
			continue;
		}
		const last = lines.at(-1) === "" ? lines.length - 1 : lines.length;
		const start = Math.max(1, Math.floor(raw.start));
		const end = Math.min(last, Math.floor(raw.end));
		if (!(start <= end)) {
			selection.invalid.push({ ...raw, problem: `the file has ${last} lines` });
			continue;
		}
		const range = { ...raw, start, end };
		const text = lines.slice(start - 1, end).join("\n");
		const hash = hashOf(text);
		if (seen.some((s) => s.path === range.path && s.start <= start && s.end >= end && s.hash === hashOf(lines.slice(s.start - 1, s.end).join("\n")))) {
			selection.known.push(range);
			continue;
		}
		const cost = tokensOf(text) + 20;
		if (cost <= left) {
			selection.shown.push({ ...range, hash, text, cut: false });
			left -= cost;
			continue;
		}
		// Cut to what fits, if enough lines do.
		let fit = start - 1;
		let used = 20;
		while (fit < end && used + tokensOf(lines[fit]!) + 1 <= left) used += tokensOf(lines[fit++]!) + 1;
		if (fit - start + 1 >= minLines) {
			const cutText = lines.slice(start - 1, fit).join("\n");
			selection.shown.push({ ...range, end: fit, hash: hashOf(cutText), text: cutText, cut: true });
			selection.omitted.push({ ...range, start: fit + 1 });
			left -= used;
		} else selection.omitted.push(range);
	}
	return selection;
}

/** A path relative to `cwd` when inside it, else absolute. */
export function displayPath(cwd: string, path: string): string {
	const absolute = isAbsolute(path) ? path : resolve(cwd, path);
	const inside = relative(cwd, absolute);
	return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : absolute;
}

const fence = (text: string) => {
	const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
	return "`".repeat(longest + 1);
};

/** The tool result's text: the answer, then each shown range verbatim, then what was left out and why. */
export function renderSelection(answer: string, selection: Selection): string {
	const parts = [answer.trim() || "(no answer)"];
	for (const r of selection.shown) {
		const f = fence(r.text);
		parts.push(`${r.path}:${r.start}-${r.end}${r.why ? ` (${r.why})` : ""}${r.cut ? " [cut to the budget]" : ""}\n${f}\n${r.text}\n${f}`);
	}
	const list = (rs: readonly Range[]) => rs.map((r) => `${r.path}:${r.start}-${r.end}${r.why ? ` (${r.why})` : ""}`).join("; ");
	if (selection.known.length) parts.push(`Already returned by an earlier explore call and unchanged, not repeated: ${list(selection.known)}`);
	if (selection.omitted.length) parts.push(`Over the budget, not shown (read them if you need them, or raise budget_tokens): ${list(selection.omitted)}`);
	if (selection.invalid.length) parts.push(`Not readable: ${selection.invalid.map((r) => `${r.path}:${r.start}-${r.end} (${r.problem})`).join("; ")}`);
	return parts.join("\n\n");
}
