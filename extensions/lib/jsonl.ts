// Append-only JSON Lines files: the local ledgers of dreaming (labels, reviews, the spend economy,
// the rule ledger). A line a crash cut short, or one that fails `valid`, is skipped on read instead
// of failing every later run.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";

export function readJsonl<T>(file: string, valid: (value: unknown) => boolean = () => true): T[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.flatMap((line) => {
			try {
				const value: unknown = JSON.parse(line);
				return value && typeof value === "object" && valid(value) ? [value as T] : [];
			} catch {
				return [];
			}
		});
}

/** Whether the file exists and its last byte is not a newline (a line a crash cut short). */
function openLine(file: string): boolean {
	if (!existsSync(file)) return false;
	const { size } = statSync(file);
	if (size === 0) return false;
	const fd = openSync(file, "r");
	try {
		const last = Buffer.alloc(1);
		readSync(fd, last, 0, 1, size - 1);
		return last[0] !== 0x0a;
	} finally {
		closeSync(fd);
	}
}

/** Append records as lines; a cut-short last line is closed first, so it does not swallow the next record. */
export function appendJsonl(file: string, records: readonly unknown[]): void {
	if (records.length === 0) return;
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${openLine(file) ? "\n" : ""}${records.map((r) => `${JSON.stringify(r)}\n`).join("")}`);
}
