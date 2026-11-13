// Detachable bash: a command the agent runs never blocks it for long.
//
// Pi's bash has no default timeout, so an agent waiting on a build sat in one tool call for 37 and
// 40 minutes (speicher-linux and the coordinator, 12.11.2026). Meanwhile it could do nothing else,
// and the user's messages waited for the call to end. Running the job in the background did not
// help: nothing woke the agent when it ended, so the background guard told it to wait in the
// foreground again.
//
// This wraps the built-in bash tool. A call the model made (not one a script made through
// `ctx.executeTool`, which needs the real output) moves to the background, without being stopped,
// once it runs `DETACH_AFTER_MS` or as soon as a user message arrives while it runs. The tool then
// returns at once with the output so far, the process group and a log of the latest output. The
// built-in call keeps running (its own `timeout` still applies) and, when it ends, its normal
// result reaches the session as a message that starts a run if the session is idle: the agent is
// woken, also after its turn ended. While jobs run, the session reports background work
// (`pi.setBackgroundWork`), so t3 keeps it loaded and keeps a delegated child's run open.
//
// Jobs live in process state, not in the extension instance: a harness release reloads the
// extensions while jobs run, and the job's end must reach the reloaded instance's API.

import { writeFileSync } from "node:fs";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type BashToolDetails, createBashToolDefinition, type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";

type BashResult = AgentToolResult<BashToolDetails | undefined>;

export const JOB_MESSAGE_TYPE = "background-job";
export const BACKGROUND_WORK_KEY = "bash-jobs";
/** How long a command runs in the foreground before it moves to the background. */
export const DETACH_AFTER_MS = 2 * 60_000;
/** Lines of output so far shown when a command moves to the background; the log has the rest. */
const TAIL_LINES = 20;
/** Least time between two writes of a job's log. */
const LOG_EVERY_MS = 1000;

export type DetachReason = "time" | "message";

export interface Job {
	callId: string;
	command: string;
	startedAt: number;
	/** The process group (the shell's pid), when the record line wrote it. */
	pgid: number | undefined;
	log: string;
}

interface SessionJobs {
	/** Calls the model made (no parent tool call): only those may move to the background. Their command as the model wrote it, by id. */
	topLevel: Map<string, string>;
	/** Foreground calls that can still move to the background, by call id. */
	foreground: Map<string, (reason: DetachReason) => void>;
	/** Calls running in the background. */
	jobs: Map<string, Job>;
	/** The API of the extension instance loaded last: the one a job's end reports through (none during a reload). */
	api: ExtensionAPI | undefined;
}

const killGroup = (pgid: number) => {
	try {
		process.kill(-pgid, "SIGTERM");
	} catch {
		// Already gone.
	}
};

const state = globalThis as { __harnessJobs?: Map<string, SessionJobs> };

export function sessionJobs(sessionId: string): SessionJobs {
	const all = (state.__harnessJobs ??= new Map());
	let jobs = all.get(sessionId);
	if (!jobs) all.set(sessionId, (jobs = { topLevel: new Map(), foreground: new Map(), jobs: new Map(), api: undefined }));
	return jobs;
}

const textOf = (result: Pick<AgentToolResult<unknown>, "content"> | undefined) =>
	(result?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");

const tail = (text: string, lines: number) => {
	const all = text.trimEnd().split("\n");
	return all.length > lines ? `[… ${all.length - lines} earlier lines in the log]\n${all.slice(-lines).join("\n")}` : all.join("\n");
};

const minutes = (ms: number) => {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

const clip = (text: string, max: number) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The tool result of a call that moved to the background. */
export function detachedText(job: Job, reason: DetachReason, output: string, now: number): string {
	const why = reason === "time" ? `It still ran after ${minutes(now - job.startedAt)}, so it` : "A new message arrived while it ran, so the command";
	const stop = job.pgid === undefined ? "" : ` (process group ${job.pgid}; stop it with \`kill -- -${job.pgid}\`)`;
	return [
		`${why} moved to the background and keeps running${stop}. Its latest output is in ${job.log}.`,
		"When it ends, its result reaches you as a new message, also after your turn has ended: do not wait or poll for it. Do the work that does not depend on it, or end your turn.",
		output.trim() ? `Output so far:\n${tail(output, TAIL_LINES)}` : "No output so far.",
	].join("\n\n");
}

/** The message a job's end sends: its command, how it ended and its result as the tool gives it. */
export function finishedText(job: Job, outcome: { result: AgentToolResult<unknown> & { isError?: boolean } } | { error: unknown }, now: number): string {
	const took = minutes(now - job.startedAt);
	const head = `Your background command \`${clip(job.command, 200)}\` (call ${job.callId})`;
	if ("error" in outcome) {
		const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
		return `${head} failed after ${took}:\n\n${message}`;
	}
	const exit = (outcome.result as { structuredContent?: { exit_code?: number } }).structuredContent?.exit_code;
	const code = exit === undefined ? "" : ` with exit code ${exit}`;
	const status = outcome.result.isError ? `failed${code}` : "finished";
	return `${head} ${status} after ${took}:\n\n${textOf(outcome.result) || "(no output)"}`;
}

export interface DetachOptions {
	/** Foreground time before a call moves to the background. */
	detachAfterMs?: number;
	/** The group file of a call (the record line's), read for its process group. */
	groupFileOf: (sessionId: string, callId: string) => string;
	/** Directory for job logs. */
	logDir: (sessionId: string) => string;
	readGroup: (file: string) => number | undefined;
}

/** A call's latest output; once opened, written to its log at most every `LOG_EVERY_MS`. */
class OutputLog {
	latest: BashResult | undefined;
	private path: string | undefined;
	private writtenAt = 0;
	private timer: NodeJS.Timeout | undefined;

	/** Keep `result` as the latest output; whether the log takes it (else the caller shows it). */
	update(result: BashResult): boolean {
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
		const full = this.latest?.details?.fullOutputPath;
		try {
			writeFileSync(this.path, (full ? `[latest output; all of it: ${full}]\n` : "") + textOf(this.latest));
		} catch {
			// The session ended and took its log directory: nothing reads this log any more.
		}
	}
}

/** Report the session's job count to the host (Pi without `setBackgroundWork` predates it: skipped). */
function reportWork(jobs: SessionJobs): void {
	const api = jobs.api as (ExtensionAPI & { setBackgroundWork?: (key: string, pending: number) => void }) | undefined;
	if (typeof api?.setBackgroundWork === "function") api.setBackgroundWork(BACKGROUND_WORK_KEY, jobs.jobs.size);
}

/** Register the detachable bash tool and its handlers. */
export function detachableBash(pi: ExtensionAPI, options: DetachOptions): void {
	const detachAfterMs = options.detachAfterMs ?? DETACH_AFTER_MS;
	const builtin = createBashToolDefinition(process.cwd());

	pi.on("session_start", (_event, ctx) => {
		const jobs = sessionJobs(ctx.sessionManager.getSessionId());
		jobs.api = pi;
		reportWork(jobs);
	});

	// Registered before the guard's handler, so the command is still the one the model wrote.
	pi.on("tool_call", (event, ctx) => {
		if (isToolCallEventType("bash", event) && event.parentToolCallId === undefined) {
			sessionJobs(ctx.sessionManager.getSessionId()).topLevel.set(event.toolCallId, event.input.command);
		}
	});

	// A reload: this instance goes stale, so jobs report through the reloaded one (its
	// session_start). Any other end of the session: nothing is left to report to, so jobs stop.
	pi.on("session_shutdown", (event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		const jobs = sessionJobs(id);
		jobs.api = undefined;
		if (event.reason === "reload") return;
		for (const job of jobs.jobs.values()) if (job.pgid !== undefined) killGroup(job.pgid);
		state.__harnessJobs?.delete(id);
	});

	// A message arriving during a run: every foreground command moves to the background, so the
	// agent reads the message after this tool call instead of after the command.
	pi.on("input", (event, ctx) => {
		if (event.streamingBehavior === undefined || event.source === "extension") return;
		for (const detach of sessionJobs(ctx.sessionManager.getSessionId()).foreground.values()) detach("message");
	});

	pi.registerTool({
		...builtin,
		promptGuidelines: [
			...(builtin.promptGuidelines ?? []),
			`A command still running after ${detachAfterMs / 60_000} minutes, or when the user sends a message, moves to the background and keeps running; its result reaches you as a new message when it ends, also after your turn. So run long builds and tests in the foreground: no \`&\`, no sleep or poll loops waiting for them.`,
		],
		async execute(callId, params, signal, onUpdate, ctx): Promise<BashResult> {
			const sessionId = ctx.sessionManager.getSessionId();
			const jobs = sessionJobs(sessionId);
			const command = jobs.topLevel.get(callId);
			if (command === undefined) return builtin.execute(callId, params, signal, onUpdate, ctx);
			jobs.topLevel.delete(callId);

			// The built-in call gets its own signal: an abort reaches it only while it is in the foreground.
			const controller = new AbortController();
			const forward = () => controller.abort(signal?.reason);
			if (signal?.aborted) controller.abort(signal.reason);
			else signal?.addEventListener("abort", forward, { once: true });

			const startedAt = Date.now();
			const output = new OutputLog();
			// In the foreground, updates reach the tool's display; in the background, the log.
			const update: AgentToolUpdateCallback<BashToolDetails | undefined> = (partial) => {
				if (!output.update(partial)) onUpdate?.(partial);
			};

			let detach!: (reason: DetachReason) => void;
			const detached = new Promise<DetachReason>((resolve) => (detach = resolve));
			jobs.foreground.set(callId, detach);
			const timer = setTimeout(() => detach("time"), detachAfterMs);
			const run = builtin.execute(callId, params, controller.signal, update, ctx).then(
				(result) => ({ result }) as const,
				(error: unknown) => ({ error }) as const,
			);
			const first = await Promise.race([run, detached]);
			clearTimeout(timer);
			jobs.foreground.delete(callId);
			if (typeof first === "object") {
				signal?.removeEventListener("abort", forward);
				if ("error" in first) throw first.error;
				return first.result;
			}

			// In the background from here: the turn's abort no longer stops it.
			signal?.removeEventListener("abort", forward);
			const job: Job = {
				callId,
				command,
				startedAt,
				pgid: options.readGroup(options.groupFileOf(sessionId, callId)),
				log: `${options.logDir(sessionId)}/${encodeURIComponent(callId)}.log`,
			};
			output.open(job.log);
			jobs.jobs.set(callId, job);
			reportWork(jobs);
			const text = detachedText(job, first, textOf(output.latest), Date.now());
			void run.then((outcome) => {
				// The log ends with the final output, also when a throttled write is still pending.
				if ("result" in outcome) output.update(outcome.result);
				output.write();
				if (!jobs.jobs.delete(callId)) return;
				// Outside any call: a throw here would be an unhandled rejection in Pi's process.
				try {
					reportWork(jobs);
					jobs.api?.sendMessage({ customType: JOB_MESSAGE_TYPE, content: finishedText(job, outcome, Date.now()), display: true }, { triggerTurn: true, deliverAs: "steer" });
				} catch (error) {
					console.error(`[background] cannot report the end of ${callId}:`, error);
				}
			});
			return { content: [{ type: "text", text }], details: output.latest?.details };
		},
	});
}
