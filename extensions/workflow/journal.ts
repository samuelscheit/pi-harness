// The journal of a workflow run: `<agentDir>/workflows/<id>/journal.jsonl`, append-only, one JSON
// entry per line. It makes a run durable (durable.ts replays it after the process died) and is the
// only input of the run's page (render.ts) and of the dashboard's live view.
//
// Every call the script makes to the outside (shell, tools.*, llm, delegate runs, workflows.*,
// changes) has a key: its kind, a hash of its arguments and its occurrence among calls with the
// same kind and hash (`shell:3fa2c9d1e0b4#2`). Not a global sequence: parallel calls (map,
// Promise.all) finish in varying order, while the nth call with the same arguments is the same
// call on every replay. The journal records `start` before a call and `done` or `failed` after it;
// `meta` entries carry what a call learned while running (an agent's thread and task), so a resume
// can reattach to it. Entries that change what a resume does are fsynced before the call goes on.
//
// A resume may bring edited code: an `edit` entry holds it (the latest one is the run's code from
// then on), and a `takeover` entry marks where it took over from the recorded calls, listing the
// recorded calls it did not use (`dropped`). Later replays forget those (durable.ts, foldJournal).

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

export const JOURNAL_FILE = "journal.jsonl";
export const SNAPSHOT_FILE = "snapshot.json";
/** Journals of completed runs are kept this long for inspection; interrupted ones until resumed or a week old. */
export const KEEP_DONE_MS = 24 * 60 * 60_000;
export const KEEP_INTERRUPTED_MS = 7 * 24 * 60 * 60_000;

export type CallKind = "shell" | "tool" | "llm" | "delegate" | "workflow" | "changes";

export interface SerializedError {
	name: string;
	message: string;
	stack?: string;
}

export interface RunHeader {
	t: "run";
	id: string;
	at: number;
	/** What runs: inline code or a saved workflow's source, as at the start. */
	entry: { source: string; filename: string; inline: boolean; name?: string; input?: unknown };
	budget: number;
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
}

export type JournalEntry =
	| RunHeader
	/** One execution of the script: 1 at the start, then one per resume, with its budget for the whole run. */
	| { t: "attempt"; n: number; at: number; pid: number; budget?: number }
	/** A resume with edited code (attempt `n`): from now on the run's code. */
	| { t: "edit"; at: number; n: number; hash: string; source: string }
	/**
	 * The edited code took over at call `key` (absent: it returned without a live call) after
	 * `replayed` calls from the journal; `dropped` recorded calls it did not use; the clock values it
	 * had used (later ones are live).
	 */
	| { t: "takeover"; at: number; n: number; key?: string; label?: string; replayed: number; dropped: string[]; clocks: { now: number; random: number } }
	| { t: "start"; key: string; kind: CallKind; label: string; at: number; idempotent?: true; model?: string }
	| { t: "meta"; key: string; at: number; data: Record<string, unknown> }
	/** `value` is absent when the call returned undefined. */
	| { t: "done"; key: string; at: number; value?: unknown; cost?: number }
	| { t: "failed"; key: string; at: number; error: SerializedError; cost?: number }
	/** A value of Date.now()/new Date() or Math.random() the script saw, by occurrence. */
	| { t: "clock"; kind: "now" | "random"; n: number; value: number }
	/** `lingering`: agent calls a stop left running; their outcomes may follow. */
	| { t: "end"; at: number; status: string; ok: boolean; cost: number; text: string; lingering?: string[] };

export const workflowsDir = (agentDir: string) => join(agentDir, "workflows");
export const runDir = (agentDir: string, id: string) => join(workflowsDir(agentDir), id);
export const journalPath = (agentDir: string, id: string) => join(runDir(agentDir, id), JOURNAL_FILE);

/** Run ids: sortable by start, readable, unique. */
export const newRunId = (now = Date.now()) => `${new Date(now).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}-${randomBytes(3).toString("hex")}`;
export const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

/** JSON with sorted object keys, so equal arguments hash alike. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) => {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
		}
		return v === undefined ? null : v;
	}) ?? "null";
}

export const argsHash = (args: unknown) => createHash("sha256").update(canonicalJson(args)).digest("hex").slice(0, 12);
export const codeHash = (source: string) => createHash("sha256").update(source).digest("hex").slice(0, 12);

/** The run's code now: the latest edit's, else the start's. */
export function currentSource(entries: readonly JournalEntry[]): string {
	const edit = entries.findLast((e) => e.t === "edit");
	if (edit?.t === "edit") return edit.source;
	const header = entries[0];
	if (header?.t !== "run") throw new Error("not a workflow journal: the first entry is no run header");
	return header.entry.source;
}

/** Statuses a run can be resumed from without new code. */
export const RESUMABLE = new Set(["interrupted", "stopped", "aborted", "over budget"]);

export function serializeError(error: unknown): SerializedError {
	// Errors thrown in the script's realm are no `instanceof Error` here.
	if (error && typeof error === "object" && "message" in error) {
		const e = error as { name?: unknown; message: unknown; stack?: unknown };
		return { name: typeof e.name === "string" ? e.name : "Error", message: String(e.message), ...(typeof e.stack === "string" ? { stack: e.stack } : {}) };
	}
	return { name: "Error", message: String(error) };
}

export function reviveError(error: SerializedError): Error {
	const revived = new Error(error.message);
	revived.name = error.name;
	if (error.stack) revived.stack = error.stack;
	return revived;
}

/**
 * Parse a journal's text. A torn line (the process died while writing it) is skipped: it was the
 * last line of its attempt, and a resume continues on the next line.
 */
export function parseJournal(text: string): JournalEntry[] {
	const entries: JournalEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as JournalEntry);
		} catch {
			// Torn.
		}
	}
	return entries;
}

export function readJournal(path: string): JournalEntry[] {
	return parseJournal(readFileSync(path, "utf8"));
}

type End = Extract<JournalEntry, { t: "end" }>;

/** The end of the latest execution, if it ended (an end before a newer attempt belongs to an earlier one). */
export function lastEnd(entries: readonly JournalEntry[]): End | undefined {
	const lastAttempt = entries.findLastIndex((e) => e.t === "attempt");
	const endAt = entries.findLastIndex((e) => e.t === "end");
	return endAt > lastAttempt ? (entries[endAt] as End) : undefined;
}

/** The state of a run as its journal tells it; throws when there is no such run. */
export function runState(agentDir: string, id: string): { entries: JournalEntry[]; header: RunHeader; end?: End } {
	const path = journalPath(agentDir, id);
	if (!existsSync(path)) throw new Error(`no workflow run ${id} (no journal ${path})`);
	const entries = readJournal(path);
	const header = entries[0];
	if (header?.t !== "run") throw new Error(`the journal ${path} has no run header`);
	const end = lastEnd(entries);
	return { entries, header, ...(end ? { end } : {}) };
}

/** An open journal file; appends are synchronous, so the order of lines is the order of events. */
export class Journal {
	readonly path: string;
	private fd: number | undefined;

	constructor(path: string) {
		this.path = path;
		mkdirSync(join(path, ".."), { recursive: true });
		// A torn last line from a crash is cut off by starting the next entry on a line of its own.
		const torn = existsSync(path) && statSync(path).size > 0 && !readFileSync(path, "utf8").endsWith("\n");
		this.fd = openSync(path, "a");
		if (torn) writeSync(this.fd, "\n");
	}

	/**
	 * Append one entry; `durable` fsyncs it before returning (entries a resume decides on). After the
	 * run closed the journal, a call the script never awaited may still end: its entry is dropped.
	 */
	append(entry: JournalEntry, durable = false): void {
		if (this.fd === undefined) return;
		writeSync(this.fd, `${JSON.stringify(entry)}\n`);
		if (durable) fsyncSync(this.fd);
	}

	close(): void {
		if (this.fd === undefined) return;
		fsyncSync(this.fd);
		closeSync(this.fd);
		this.fd = undefined;
	}
}

export interface RunSummary {
	id: string;
	header: RunHeader;
	/** The last end entry, if the run ended. */
	end?: Extract<JournalEntry, { t: "end" }>;
	/** When the journal last changed. */
	modified: number;
}

/** The runs in the journal directory, newest first; unreadable ones are skipped. */
export function listRuns(agentDir: string): RunSummary[] {
	const dir = workflowsDir(agentDir);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const runs: RunSummary[] = [];
	for (const id of names.filter((name) => RUN_ID.test(name))) {
		try {
			const path = journalPath(agentDir, id);
			const entries = readJournal(path);
			const header = entries[0];
			if (header?.t !== "run") continue;
			const end = lastEnd(entries);
			runs.push({ id, header, ...(end ? { end } : {}), modified: statSync(path).mtimeMs });
		} catch {
			// Removed meanwhile, or not a journal.
		}
	}
	return runs.sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * Remove journals no one needs: runs that ended more than KEEP_DONE_MS ago, and any run (an
 * interrupted or stopped one never resumed) untouched for KEEP_INTERRUPTED_MS. Returns the removed ids.
 */
export function sweepRuns(agentDir: string, now = Date.now()): string[] {
	const removed: string[] = [];
	for (const run of listRuns(agentDir)) {
		const age = now - run.modified;
		const finished = run.end && run.end.status !== "interrupted" && run.end.status !== "stopped";
		if ((finished && age > KEEP_DONE_MS) || age > KEEP_INTERRUPTED_MS) {
			rmSync(runDir(agentDir, run.id), { recursive: true, force: true });
			removed.push(run.id);
		}
	}
	return removed;
}
