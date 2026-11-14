// delegate() children as t3 delegated tasks: each child is a thread of its own under the calling thread,
// where the user can watch, steer and stop it. Used when the session has t3's tools (the t3 MCP
// bridge registers them as `mcp__t3-code__<name>`); a workflow script reaches them like any session
// tool (ctx.executeTool), where they resolve to the MCP result: `structuredContent` is t3's data.
//
// The first run is `delegate_task` in wait mode, waiting only START_WAIT_MS, so the task, thread
// and run ids reach the workflow's journal within seconds (a resume after a crash reattaches with
// them); later runs go to the same thread with `t3_thread_send` (a resume: the child's context and
// prompt cache are warm). Both carry a `clientRequestId` per run, which t3 dedupes within one MCP
// session (one Pi process; a new process gets a new task for the same id, seen 2026-11-14). A wait
// that times out does not end the run: it continues with `t3_thread_wait` until the run is over. A
// question or an approval the child waits for also ends a wait: the child's `waiting` hook (the
// workflow's onAsk) may answer it, else the code keeps waiting for whoever answers.
// Afterwards `task_status` reads the task, which marks its result delivered, so t3 does not wake
// the calling thread for a result the script already has.

export const T3_PREFIX = "mcp__t3-code__";
export const T3_DELEGATE = `${T3_PREFIX}delegate_task`;
/** How long one t3 wait call blocks. */
export const WAIT_MS = 10 * 60_000;
/** How long the starting delegate_task waits: short, so the ids are known (and journaled) early. */
export const START_WAIT_MS = 5_000;
/** A wait that returns sooner without the run being over (a pending question) is repeated after this. */
const RETRY_MS = 5_000;
/** Thread statuses after which the run is over. */
const OVER = new Set(["idle", "completed", "interrupted", "failed", "cancelled", "rolled_back"]);

export type T3Data = Record<string, unknown>;
/** Call a t3 tool by its bare name; resolves to t3's data, rejects with its error. */
export type T3Call = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<T3Data>;

/** t3's data from a tool's outcome: the MCP result's `structuredContent`, else its text as JSON. */
export function t3Data(name: string, value: unknown, text: string): T3Data {
	const structured = (value as { structuredContent?: unknown } | undefined)?.structuredContent;
	if (structured && typeof structured === "object") return structured as T3Data;
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object") return parsed as T3Data;
	} catch {
		// Not JSON.
	}
	throw new Error(`t3 ${name} returned no data: ${text.slice(0, 300)}`);
}

/** t3 for one workflow run: its tools, called by their bare names. */
export class T3 {
	readonly call: T3Call;

	constructor(call: T3Call) {
		this.call = call;
	}
}

/** Stop a t3 task (its running and queued turns); with a signal of its own, since the caller's may be aborted. Never throws. */
export function cancelTask(t3: T3, taskId: string, reason: string): void {
	void t3.call("task_cancel", { taskId, reason }, AbortSignal.timeout(30_000)).catch(() => undefined);
}

const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", stop);
			resolve();
		}, ms);
		const stop = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", stop, { once: true });
	});

const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** What identifies a child's t3 task, kept in the workflow's journal to reattach. */
export interface T3ChildIds {
	taskId?: string;
	threadId?: string;
	link?: string;
	/** The run of the latest message. */
	runId?: string;
}

/** Called while a run waits on something other than its work (a question, an approval); resolves to whether it answered something. */
export type Waiting = (child: T3Child, signal: AbortSignal) => Promise<boolean>;

/** One child as a t3 task and its thread. */
export class T3Child {
	taskId: string | undefined;
	threadId: string | undefined;
	link: string | undefined;
	runId: string | undefined;
	/** The last run's thread status and t3's summary of it. */
	status = "";
	summary: string | undefined;
	readonly t3: T3;
	/** delegate_task's arguments besides the task and how to wait. */
	private readonly params: Record<string, unknown>;
	private readonly waiting: Waiting | undefined;
	/** Why the task was cancelled, if it was. */
	private cancelled: string | undefined;

	constructor(t3: T3, params: Record<string, unknown>, waiting?: Waiting) {
		this.t3 = t3;
		this.params = params;
		this.waiting = waiting;
	}

	get ids(): T3ChildIds {
		const ids: T3ChildIds = {};
		if (this.taskId) ids.taskId = this.taskId;
		if (this.threadId) ids.threadId = this.threadId;
		if (this.link) ids.link = this.link;
		if (this.runId) ids.runId = this.runId;
		return ids;
	}

	restore(ids: T3ChildIds): void {
		this.taskId = ids.taskId ?? this.taskId;
		this.threadId = ids.threadId ?? this.threadId;
		this.link = ids.link ?? this.link;
		this.runId = ids.runId ?? this.runId;
	}

	/**
	 * Reattach to a run whose call was in flight when the workflow's process died: a run whose id is
	 * known is waited for; otherwise the call is repeated with the same request id (t3 dedupes it
	 * within one MCP session; the caller checks first that the child did not start the run).
	 */
	async reattach(message: string, requestId: string, runId: string | undefined, signal: AbortSignal, started: (ids: T3ChildIds) => void): Promise<void> {
		if (!runId) return this.run(message, requestId, signal, started);
		this.runId = runId;
		await this.wait(runId, signal);
		await this.deliver(signal);
	}

	/**
	 * Run one message: without a thread yet it starts the task, else it resumes the thread.
	 * `requestId` makes the call idempotent: the same id reattaches to the same run. Resolves when
	 * the run is over.
	 */
	async run(message: string, requestId: string, signal: AbortSignal, started: (ids: T3ChildIds) => void): Promise<void> {
		if (!this.threadId) {
			const task = await this.t3.call("delegate_task", { ...this.params, task: message, mode: "wait", timeoutMs: START_WAIT_MS, clientRequestId: requestId }, signal);
			this.taskId = str(task.taskId);
			this.threadId = str(task.childThreadId);
			this.link = str(task.link);
			this.runId = str(task.childRunId);
			if (!this.taskId || !this.threadId) throw new Error(`t3 delegate_task started no thread: ${JSON.stringify(task).slice(0, 300)}`);
			started(this.ids);
			// Cancelled while t3 was starting it.
			if (this.cancelled !== undefined) this.cancel(this.cancelled);
			this.status = String(task.status);
			const finished = ["completed", "failed", "cancelled", "interrupted"].includes(this.status) && task.waitTimedOut !== true;
			if (!finished) await this.wait(this.runId, signal);
		} else await this.send(message, "queue", requestId, signal, started);
		await this.deliver(signal);
	}

	/** Send a message to the thread: queued (a run, or Pi's /compact) and waited for, or steering the running turn. */
	async send(message: string, mode: "queue" | "steer", requestId: string, signal: AbortSignal, started: (ids: T3ChildIds) => void = () => undefined): Promise<void> {
		if (!this.threadId) throw new Error("the agent has no thread yet: run it first");
		const sent = await this.t3.call("t3_thread_send", { threadId: this.threadId, message, mode, clientRequestId: requestId }, signal);
		this.taskId = str(sent.taskId) ?? this.taskId;
		if (mode === "steer") return;
		this.runId = str(sent.runId);
		started(this.ids);
		await this.wait(this.runId, signal);
	}

	private async wait(runId: string | undefined, signal: AbortSignal): Promise<void> {
		for (;;) {
			const started = Date.now();
			const waited = await this.t3.call("t3_thread_wait", { threadId: this.threadId, ...(runId ? { runId } : {}), timeoutMs: WAIT_MS, untilDelegatedWorkSettled: true }, signal);
			this.status = String(waited.status);
			if (OVER.has(this.status)) return;
			if (waited.timedOut === true) continue;
			const answered = (await this.waiting?.(this, signal)) ?? false;
			if (!answered && Date.now() - started < RETRY_MS) await sleep(RETRY_MS, signal);
		}
	}

	/** Read the task: marks its result delivered, and keeps t3's summary for errors. */
	private async deliver(signal: AbortSignal): Promise<void> {
		if (!this.taskId) return;
		try {
			const task = await this.t3.call("task_status", { taskId: this.taskId }, signal);
			this.summary = str(task.summary) ?? str(task.latestTerminalSummary);
		} catch {
			// Only bookkeeping: the child's own report is the result.
		}
	}

	/** Stop the task (its running and queued turns); before t3 named it, as soon as it does. */
	cancel(reason = "the workflow that started it stopped"): void {
		this.cancelled = reason;
		if (this.taskId) cancelTask(this.t3, this.taskId, reason);
	}
}
