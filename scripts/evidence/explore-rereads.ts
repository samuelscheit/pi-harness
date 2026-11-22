// Whether the ranges `explore` returns are enough to act on: after each explore call, until the next
// user prompt, does the caller read the same code again, at or near a returned range?
//
// A read is a `read` call (path, offset, limit) or a bash command that prints part of a file:
// `sed -n 'A,Bp' f`, `head [-n] N f`, `cat f`, `nl f`. A read is "near" a returned range when it
// lies within NEAR lines of it in the same file (whole-file reads count when the file had a range):
// the range was too tight (the caller needed the surrounding function, the imports) or it did not
// trust it. A read of a file explore returned nothing for is "elsewhere": the explorer missed it,
// or the task moved on. Both are reported per explore call, with the turns until the next edit.
//
// Usage: node scripts/evidence/explore-rereads.ts [--since 2026-11-22]

import { resolve } from "node:path";
import { readEntries } from "./thinking-billing.ts";
import { openIndex } from "./shared.ts";

export const NEAR = 30;

export interface Span {
	path: string;
	start: number;
	end: number; // Infinity: to the end of the file
}

/** The parts of files a bash command prints (best effort over the common forms). */
export function bashReads(command: string, cwd: string): Span[] {
	const spans: Span[] = [];
	let dir = cwd;
	for (const part of command.split(/&&|;|\|\||\n/)) {
		const words = part.trim().match(/'[^']*'|"[^"]*"|\S+/g)?.map((w) => w.replace(/^['"]|['"]$/g, "")) ?? [];
		if (words[0] === "cd" && words[1]) dir = resolve(dir, words[1]);
		const at = (w: string) => resolve(dir, w);
		const files = (from: number) => words.slice(from).filter((w) => !w.startsWith("-") && !/^[|>]/.test(w) && /[./]/.test(w));
		if (words[0] === "sed" && words[1] === "-n") {
			const m = /^(\d+)(?:,(\d+|\$))?p$/.exec(words[2] ?? "");
			if (m) for (const f of files(3)) spans.push({ path: at(f), start: Number(m[1]), end: m[2] === "$" ? Infinity : Number(m[2] ?? m[1]) });
		} else if (words[0] === "head") {
			const n = words[1] === "-n" ? Number(words[2]) : /^-(\d+)$/.test(words[1] ?? "") ? Number(words[1]!.slice(1)) : 10;
			for (const f of files(words[1] === "-n" ? 3 : 1).filter((w) => !/^\d+$/.test(w))) spans.push({ path: at(f), start: 1, end: n });
		} else if (words[0] === "cat" || words[0] === "nl") {
			for (const f of files(1)) spans.push({ path: at(f), start: 1, end: Infinity });
		}
	}
	return spans;
}

/** Whether a read lies at or within NEAR lines of a returned range. */
export const near = (read: Span, returned: readonly Span[]) => returned.some((r) => r.path === read.path && read.start <= r.end + NEAR && read.end >= r.start - NEAR);

type Part = { type: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type Message = { role: string; content: Part[] | string; toolName?: string; toolCallId?: string; details?: { shown?: { path: string; start: number; end: number }[] } };

interface CallStats {
	ranges: number;
	nearReads: number;
	elsewhereReads: number;
	turnsToEdit: number | undefined;
}

export function analyseSession(file: string): CallStats[] {
	const entries = readEntries(file) as unknown as { type: string; cwd?: string; message?: Message }[];
	const cwd = entries.find((e) => e.type === "session")?.cwd ?? "/";
	const out: CallStats[] = [];
	let open: { stats: CallStats; returned: Span[]; turns: number }[] = [];
	for (const e of entries) {
		const m = e.message;
		if (!m) continue;
		if (m.role === "user") open = [];
		if (m.role === "toolResult" && m.toolName === "explore") {
			const returned = (m.details?.shown ?? []).map((r) => ({ path: resolve(cwd, r.path), start: r.start, end: r.end }));
			const stats: CallStats = { ranges: returned.length, nearReads: 0, elsewhereReads: 0, turnsToEdit: undefined };
			out.push(stats);
			open.push({ stats, returned, turns: 0 });
		}
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		const calls = m.content.filter((p) => p.type === "toolCall");
		for (const o of open) o.turns++;
		for (const c of calls) {
			const args = c.arguments ?? {};
			const reads: Span[] =
				c.name === "read" && typeof args.path === "string"
					? [{ path: resolve(cwd, args.path), start: Number(args.offset ?? 1), end: args.limit ? Number(args.offset ?? 1) + Number(args.limit) - 1 : Infinity }]
					: c.name === "bash" && typeof args.command === "string"
						? bashReads(args.command, cwd)
						: [];
			const edits = c.name === "edit" || c.name === "write" || (c.name === "bash" && /tool\s+edit\s+-/.test(String(args.command ?? "")));
			for (const o of open) {
				for (const r of reads) near(r, o.returned) ? o.stats.nearReads++ : o.stats.elsewhereReads++;
				if (edits && o.stats.turnsToEdit === undefined) o.stats.turnsToEdit = o.turns;
			}
		}
	}
	return out;
}

if (import.meta.main) {
	const since = process.argv.includes("--since") ? Date.parse(process.argv[process.argv.indexOf("--since") + 1]!) : 0;
	const files = (openIndex()
		.prepare("SELECT DISTINCT s.file FROM tool_results t JOIN sessions s ON s.id = t.session_id WHERE t.tool = 'explore' AND t.ts >= ?")
		.all(since) as { file: string }[]).map((r) => r.file);
	const calls = files.flatMap((f) => {
		try {
			return analyseSession(f);
		} catch {
			return [];
		}
	});
	const n = calls.length;
	const share = (k: number) => (n ? `${((100 * k) / n).toFixed(0)}%` : "–");
	const withNear = calls.filter((c) => c.nearReads > 0).length;
	const edited = calls.filter((c) => c.turnsToEdit !== undefined).map((c) => c.turnsToEdit!).sort((a, b) => a - b);
	console.log(`explore calls: ${n} in ${files.length} sessions; ranges returned: ${calls.reduce((a, c) => a + c.ranges, 0)}\n`);
	console.log("| measure | value |\n|---|---:|");
	console.log(`| calls followed by a read at or within ${NEAR} lines of a returned range | ${withNear} (${share(withNear)}) |`);
	console.log(`| such reads per call | ${(calls.reduce((a, c) => a + c.nearReads, 0) / (n || 1)).toFixed(2)} |`);
	console.log(`| calls followed by reads elsewhere | ${calls.filter((c) => c.elsewhereReads > 0).length} (${share(calls.filter((c) => c.elsewhereReads > 0).length)}) |`);
	console.log(`| calls followed by an edit (same package) | ${edited.length} (${share(edited.length)}) |`);
	console.log(`| median turns from explore to the first edit | ${edited.length ? edited[Math.floor(edited.length / 2)] : "–"} |`);
}
