// Background calls: no tool call the model makes blocks the agent for long.
//
// Bash commands that ran 37 and 40 minutes (12.11.2026) moved to the background first. Other tools
// blocked without limit: on one day, child agents sat in `workflow` calls of 233, 76 and 62 minutes,
// a 19-minute `fix_loop` and several 5-minute `delegate_task` waits (about 7 hours), and the user's
// messages could not reach them.
//
// Every tool call the model makes (Pi's `pi.wrapToolExecution`: built-in, extension and MCP tools;
// not calls a tool makes through `ctx.executeTool`, whose caller needs the result) moves to the
// background, without being stopped, once it runs `DETACH_AFTER_MS` or as soon as a user message
// arrives while it runs. The tool returns at once with the output so far and a log of the latest
// output. The call keeps running and, when it ends, its normal result (images included) reaches the
// session as a message that starts a run if the session is idle. While jobs run, the session
// reports background work (`pi.setBackgroundWork`), so t3 keeps it loaded and keeps a delegated
// child's run open.
//
// Some tools (`BACKGROUND_TOOLS`: `workflow`) run long as a rule and their caller rarely needs the
// result before other work: a model's call of one moves to the background at its first progress
// update (which names what it started, e.g. a workflow's run and live view), at the latest after
// START_GRACE_MS; one that ends sooner returns its result directly. `foregroundCall` names calls of
// such a tool that answer at once (`workflow { show }`).
// Their nested calls (a script's, or `tool workflow …` in bash) stay in the foreground of their
// caller, which needs the result; `tool workflow … &` in bash makes one a job of its own.
//
// The turn's abort stops a call in the foreground, not one in the background. A background call
// stops at the session's end (its AbortSignal), not on a harness reload: its end reaches the
// reloaded extension (jobs.ts keeps the state in process state).

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type DetachReason,
	detachedText,
	dropSession,
	finishedContent,
	finishedText,
	type Job,
	type Outcome,
	OutputLog,
	reportWork,
	sessionJobs,
	stopHintOf,
	textOf,
	wake,
} from "./jobs.ts";

/** How long a call runs in the foreground before it moves to the background. */
export const DETACH_AFTER_MS = 2 * 60_000;

/** How long a call of a background tool may stay in the foreground at its start: until its first update, or it ends (a refusal answers at once). */
export const START_GRACE_MS = 5_000;

/** Tools whose calls the model makes run in the background from their start. */
export const BACKGROUND_TOOLS: readonly string[] = ["workflow"];

/** Calls of a background tool that answer at once and stay in the foreground: `workflow { show }` renders a page, `workflow { stop }` stops a run. */
export const foregroundCall = (toolName: string, input: Record<string, unknown>) => toolName === "workflow" && (input.show !== undefined || input.stop !== undefined);

/** The reason background calls stop at the session's end; a workflow stopped by it can be resumed. */
export class SessionEnded extends Error {
	constructor() {
		super("the session ended");
		this.name = "SessionEnded";
	}
}

export const BACKGROUND_GUIDELINE = (detachAfterMs: number) =>
	`No tool call blocks you for more than ${detachAfterMs / 60_000} minutes: a call still running then, or when the user sends a message, moves to the background and keeps running, and its result reaches you as a new message when it ends, also after your turn. \`workflow\` always starts in the background. To start other work in the background at once: \`cmd > log 2>&1 &\` in bash, \`tool <name> … > out 2>&1 &\` in bash for any tool, or \`delegate_task\` in async mode. Never wait for background work with sleep or poll loops (\`until grep …; do sleep …; done\`): its end wakes you.`;

export interface BackgroundOptions {
	/** Foreground time before a call moves to the background. */
	detachAfterMs?: number;
	/** Tools that run in the background from their start; default {@link BACKGROUND_TOOLS}. */
	backgroundTools?: readonly string[];
	/** Directory for job logs; default a per-process directory in the system temp dir. */
	logRoot?: string;
}

const killProcess = (pid: number) => {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Already gone.
	}
};

export default function background(pi: ExtensionAPI, options: BackgroundOptions = {}) {
	const detachAfterMs = options.detachAfterMs ?? DETACH_AFTER_MS;
	const backgroundTools = new Set(options.backgroundTools ?? BACKGROUND_TOOLS);
	const logRoot = options.logRoot ?? join(tmpdir(), "pi-harness-jobs", String(process.pid));
	const logDir = (sessionId: string) => {
		const dir = join(logRoot, encodeURIComponent(sessionId));
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		return dir;
	};

	pi.on("session_start", (_event, ctx) => {
		const jobs = sessionJobs(ctx.sessionManager.getSessionId());
		jobs.api = pi;
		reportWork(jobs);
	});

	// A reload: this instance goes stale, so jobs report through the reloaded one (its
	// session_start). Any other end of the session: nothing is left to report to, so its background
	// calls and the processes bash calls left stop.
	pi.on("session_shutdown", (event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		const jobs = sessionJobs(id);
		jobs.api = undefined;
		if (event.reason === "reload") return;
		for (const job of jobs.jobs.values()) job.controller.abort(new SessionEnded());
		for (const pid of jobs.leftovers.keys()) killProcess(pid);
		clearInterval(jobs.poll);
		dropSession(id);
		rmSync(join(logRoot, encodeURIComponent(id)), { recursive: true, force: true });
	});

	// A message arriving during a run: every foreground call moves to the background, so the agent
	// reads the message after this tool call instead of after the call.
	pi.on("input", (event, ctx) => {
		if (event.streamingBehavior === undefined || event.source === "extension") return;
		for (const detach of sessionJobs(ctx.sessionManager.getSessionId()).foreground.values()) detach("message");
	});

	pi.wrapToolExecution(async (execution, ctx) => {
		const { toolCallId: callId, toolName, input, signal } = execution;
		const sessionId = ctx.sessionManager.getSessionId();
		const jobs = sessionJobs(sessionId);

		// The call gets its own signal: the turn's abort reaches it only while it is in the foreground.
		const controller = new AbortController();
		const forward = () => controller.abort(signal?.reason);
		if (signal?.aborted) controller.abort(signal.reason);
		else signal?.addEventListener("abort", forward, { once: true });

		const startedAt = Date.now();
		const output = new OutputLog();
		let detach!: (reason: DetachReason) => void;
		const detached = new Promise<DetachReason>((resolve) => (detach = resolve));
		jobs.foreground.set(callId, detach);
		// A background tool's call moves at its first update (which names what it started), at the latest after START_GRACE_MS.
		const atStart = backgroundTools.has(toolName) && !foregroundCall(toolName, input);
		const timer = atStart ? setTimeout(() => detach("start"), START_GRACE_MS) : setTimeout(() => detach("time"), detachAfterMs);
		// In the foreground, updates reach the tool's display; in the background, the log.
		const update: AgentToolUpdateCallback = (partial) => {
			if (!output.update(partial)) execution.onUpdate(partial);
			if (atStart) detach("start");
		};
		const run: Promise<Outcome> = execution.execute(controller.signal, update).then(
			(result) => ({ result }),
			(error: unknown) => ({ error }),
		);
		const first = await Promise.race([run, detached]);
		clearTimeout(timer);
		jobs.foreground.delete(callId);
		signal?.removeEventListener("abort", forward);
		if (typeof first === "object") {
			if ("error" in first) throw first.error;
			return first.result;
		}

		// In the background from here: the turn's abort no longer stops it.
		const job: Job = {
			callId,
			toolName,
			input,
			startedAt,
			stop: stopHintOf(toolName)?.(sessionId, callId),
			log: join(logDir(sessionId), `${encodeURIComponent(callId)}.log`),
			controller,
		};
		output.open(job.log);
		jobs.jobs.set(callId, job);
		reportWork(jobs);
		void run.then((outcome) => {
			// The log ends with the final output, also when a throttled write is still pending.
			if ("result" in outcome) output.update(outcome.result);
			output.write();
			if (!jobs.jobs.delete(callId)) return;
			reportWork(jobs);
			wake(jobs, finishedContent(finishedText(job, outcome, Date.now()), outcome), `the end of ${callId}`);
		});
		return { content: [{ type: "text", text: detachedText(job, first, textOf(output.latest), Date.now()) }], details: output.latest?.details } satisfies AgentToolResult<unknown>;
	});
}
