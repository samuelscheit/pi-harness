// Background jobs: the session state, messages and reports of tool calls that moved to the
// background (index.ts) and of processes bash calls left running (../bash/leftovers.ts).
//
// The state lives in process state, not in an extension instance: a harness release reloads the
// extensions while jobs run, and a job's end must reach the reloaded instance's API.

import { writeFileSync } from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Leftovers } from "../bash/leftovers.ts";

export const JOB_MESSAGE_TYPE = "background-job";
export const BACKGROUND_WORK_KEY = "background-jobs";
/** Lines of output so far shown when a call moves to the background; the log has the rest. */
const TAIL_LINES = 20;
/** Least time between two writes of a job's log. */
const LOG_EVERY_MS = 1000;

/** Why a call moved to the background: it ran too long, a message arrived, or its tool always runs there. */
export type DetachReason = "time" | "message" | "start";

export interface Job {
	callId: string;
	toolName: string;
	/** The arguments as the model wrote them. */
	input: Record<string, unknown>;
	startedAt: number;
	/** How to stop it, from the tool's {@link StopHint} (bash: its process group). */
	stop: string | undefined;
	log: string;
	/** Stops the call: at the session's end. */
	controller: AbortController;
}

export interface SessionJobs {
	/** Foreground calls that can still move to the background, by call id. */
	foreground: Map<string, (reason: DetachReason) => void>;
	/** Calls running in the background: every one counts as pending background work. */
	jobs: Map<string, Job>;
	/** Processes ended bash calls left running (../bash/leftovers.ts). */
	leftovers: Leftovers;
	/** The check for the leftovers' end, while there are any. */
	poll: NodeJS.Timeout | undefined;
	/** The API of the extension instance loaded last: the one a job's end reports through (none during a reload). */
	api: ExtensionAPI | undefined;
}

/** How to stop a call of one tool that moved to the background, as a clause; undefined: nothing to add. */
export type StopHint = (sessionId: string, callId: string) => string | undefined;

const state = globalThis as { __harnessJobs?: Map<string, SessionJobs>; __harnessStopHints?: Map<string, StopHint> };

/**
 * A session's jobs. The state outlives the extension instance that made it (a harness release
 * reloads extensions while jobs run), so a field a newer release added is filled in on first use.
 */
export function sessionJobs(sessionId: string): SessionJobs {
	const all = (state.__harnessJobs ??= new Map());
	const fresh: SessionJobs = { foreground: new Map(), jobs: new Map(), leftovers: new Map(), poll: undefined, api: undefined };
	const jobs = all.get(sessionId);
	if (!jobs) {
		all.set(sessionId, fresh);
		return fresh;
	}
	for (const key of Object.keys(fresh) as (keyof SessionJobs)[]) if (!(key in jobs)) Object.assign(jobs, { [key]: fresh[key] });
	return jobs;
}

/** Forget a session's state (its end). */
export function dropSession(sessionId: string): void {
	state.__harnessJobs?.delete(sessionId);
}

/** Set how calls of `toolName` that moved to the background are stopped (the extension loaded last wins). */
export function setStopHint(toolName: string, hint: StopHint): void {
	(state.__harnessStopHints ??= new Map()).set(toolName, hint);
}

export const stopHintOf = (toolName: string): StopHint | undefined => state.__harnessStopHints?.get(toolName);

export const textOf = (result: Pick<AgentToolResult<unknown>, "content"> | undefined) =>
	(result?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");

const tail = (text: string, lines: number) => {
	const all = text.trimEnd().split("\n");
	return all.length > lines ? `[… ${all.length - lines} earlier lines in the log]\n${all.slice(-lines).join("\n")}` : all.join("\n");
};

export const minutes = (ms: number) => {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

export const clip = (text: string, max: number) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** A call in a line: the tool and its arguments (a lone string argument as is, e.g. bash's command). */
export function callLabel(toolName: string, input: Record<string, unknown>): string {
	const values = Object.values(input);
	const args = values.length === 1 && typeof values[0] === "string" ? values[0] : JSON.stringify(input);
	return `\`${toolName}\` call \`${clip(args, 200)}\``;
}

/** The tool result of a call that moved to the background. */
export function detachedText(job: Job, reason: DetachReason, output: string, now: number): string {
	const stop = job.stop === undefined ? "" : ` (${job.stop})`;
	const where = `Its latest output is in ${job.log}.`;
	const after = "When it ends, its result reaches you as a new message, also after your turn has ended: do not wait or poll for it. Do the work that does not depend on it, or end your turn.";
	if (reason === "start") return [`\`${job.toolName}\` always runs in the background: the call started and keeps running${stop}. ${where}`, after, ...(output.trim() ? [tail(output, TAIL_LINES)] : [])].join("\n\n");
	const why = reason === "time" ? `It still ran after ${minutes(now - job.startedAt)}, so the call` : "A new message arrived while it ran, so the call";
	return [
		`${why} moved to the background and keeps running${stop}. ${where}`,
		after,
		output.trim() ? `Output so far:\n${tail(output, TAIL_LINES)}` : "No output so far.",
	].join("\n\n");
}

export type Outcome = { result: AgentToolResult<unknown> & { isError?: boolean } } | { error: unknown };

/** The message a job's end sends: its call, how it ended and its result as the tool gives it. */
export function finishedText(job: Pick<Job, "callId" | "toolName" | "input" | "startedAt">, outcome: Outcome, now: number): string {
	const took = minutes(now - job.startedAt);
	const head = `Your background ${callLabel(job.toolName, job.input)} (call ${job.callId})`;
	if ("error" in outcome) {
		const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
		return `${head} failed after ${took}:\n\n${message}`;
	}
	const exit = (outcome.result as { structuredContent?: { exit_code?: number } }).structuredContent?.exit_code;
	const code = exit === undefined ? "" : ` with exit code ${exit}`;
	const status = outcome.result.isError ? `failed${code}` : "finished";
	return `${head} ${status} after ${took}:\n\n${textOf(outcome.result) || "(no output)"}`;
}

/** The content of a job's end message: its text, and the images of its result. */
export function finishedContent(text: string, outcome: Outcome): string | (ImageContent | { type: "text"; text: string })[] {
	const images = "result" in outcome ? outcome.result.content.filter((c): c is ImageContent => c.type === "image") : [];
	return images.length ? [{ type: "text", text }, ...images] : text;
}

/** A call's latest output; once opened, written to its log at most every `LOG_EVERY_MS`. */
export class OutputLog {
	latest: AgentToolResult<unknown> | undefined;
	private path: string | undefined;
	private writtenAt = 0;
	private timer: NodeJS.Timeout | undefined;

	/** Keep `result` as the latest output; whether the log takes it (else the caller shows it). */
	update(result: AgentToolResult<unknown>): boolean {
		this.latest = result;
		if (this.path === undefined) return false;
		this.timer ??= setTimeout(() => this.write(), Math.max(0, LOG_EVERY_MS - (Date.now() - this.writtenAt)));
		return true;
	}

	open(path: string): void {
		this.path = path;
		this.write();
	}

	write(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.path === undefined) return;
		this.writtenAt = Date.now();
		const full = (this.latest?.details as { fullOutputPath?: string } | undefined)?.fullOutputPath;
		try {
			writeFileSync(this.path, (full ? `[latest output; all of it: ${full}]\n` : "") + textOf(this.latest));
		} catch {
			// The session ended and took its log directory: nothing reads this log any more.
		}
	}
}

/**
 * Report the session's background work (jobs and leftovers) to the host. Never throws: it also runs
 * outside any call, where a throw would be an unhandled rejection in Pi's process (the API is stale
 * once the session ended).
 */
export function reportWork(jobs: SessionJobs): void {
	try {
		jobs.api?.setBackgroundWork(BACKGROUND_WORK_KEY, jobs.jobs.size + jobs.leftovers.size);
	} catch (error) {
		console.error("[background] cannot report background work:", error);
	}
}

/** Send `content` to the session as a message that wakes it. Never throws: it runs outside any call. */
export function wake(jobs: SessionJobs, content: string | (ImageContent | { type: "text"; text: string })[], what: string): void {
	try {
		jobs.api?.sendMessage({ customType: JOB_MESSAGE_TYPE, content, display: true }, { triggerTurn: true, deliverAs: "steer" });
	} catch (error) {
		console.error(`[background] cannot report ${what}:`, error);
	}
}
