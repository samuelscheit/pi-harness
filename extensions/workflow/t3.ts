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
// question the child waits for does not end a thread wait (t3 reports it to the calling thread), so
// with a `waiting` hook (the workflow's onAsk) the code waits in short slices and the hook looks
// for pending questions in between (verified in a real run on 2026-11-14).
// Afterwards `task_status` reads the task, which marks its result delivered, so t3 does not wake
// the calling thread for a result the script already has.
//
// The transport: t3's MCP bridge answers a tool call with one HTTP response when the tool is done,
// over Pi's global fetch, whose undici dispatcher cuts a response whose headers take longer than
// Pi's `httpIdleTimeoutMs` (default 300 s) with "fetch failed". A wait slice therefore stays below
// that timeout (`waitSliceMs`): a 10-minute wait was cut at 300 s on 2026-11-14 and failed four
// healthy children. A call that fails in transport (reset, refused, cut) is repeated: every t3 call
// here is idempotent (reads, waits, cancels; starts and sends carry a clientRequestId t3 dedupes).
// When t3 stays unreachable past `RETRY_DEADLINE_MS`, the call fails with `T3Unreachable`, an
// interruption: the run stops resumable, its children keep running, a resume reattaches to them.

export const T3_PREFIX = "mcp__t3-code__";
export const T3_DELEGATE = `${T3_PREFIX}delegate_task`;
/** The longest a t3 wait call blocks, also without an HTTP timeout. */
export const MAX_WAIT_MS = 4 * 60_000;
/** How long the starting delegate_task waits: short, so the ids are known (and journaled) early. */
export const START_WAIT_MS = 5_000;
/** How long t3 may stay unreachable (consecutive transport failures) before a call gives up. */
export const RETRY_DEADLINE_MS = 3 * 60_000;
/** The pause before the first repeat of a call that failed in transport; it doubles up to `MAX_BACKOFF_MS`. */
const FIRST_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 15_000;
/** A wait that returns sooner without the run being over is repeated after this. */
const RETRY_MS = 5_000;
/**
 * With a `waiting` hook (onAsk), how long one wait slice blocks before pending questions are looked
 * at: t3's thread wait does not end on a question (only on the run's end), so the code looks itself.
 */
export const ASK_POLL_MS = 2_000;
/** Thread statuses after which the run is over. */
const OVER = new Set(["idle", "completed", "interrupted", "failed", "cancelled", "rolled_back"]);

/**
 * How long one wait call may block so that its HTTP response comes before Pi's idle timeout cuts
 * it: a margin below `httpIdleTimeoutMs` (0: no timeout), at most `MAX_WAIT_MS`.
 */
export function waitSliceMs(httpIdleTimeoutMs: number): number {
	if (!(httpIdleTimeoutMs > 0)) return MAX_WAIT_MS;
	return Math.min(MAX_WAIT_MS, Math.max(1_000, httpIdleTimeoutMs - Math.min(30_000, httpIdleTimeoutMs / 4)));
}

/** A failure of the way to t3 (the request did not get an answer), not t3's answer: worth repeating. */
const TRANSPORT_FAILURE = /fetch failed|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EHOSTUNREACH|socket hang up|other side closed|\bterminated\b|UND_ERR|Headers Timeout|Body Timeout|network error|failed \((?:502|503|504)\)/i;
export const isTransportFailure = (error: unknown) => TRANSPORT_FAILURE.test(error instanceof Error ? error.message : String(error));

/** t3 stayed unreachable past the deadline: an interruption (durable.ts), so the run stops resumable and its children run on. */
export class T3Unreachable extends Error {
	constructor(name: string, failures: number, ms: number, last: unknown) {
		super(
			`t3 did not answer ${name} for ${Math.round(ms / 1000)} s (${failures} attempts; last: ${last instanceof Error ? last.message : String(last)}). Its child threads keep running; resume the workflow to reattach to them.`,
		);
		this.name = "T3Unreachable";
	}
}

export type T3Data = Record<string, unknown>;
/** Call a t3 tool by its bare name; resolves to t3's data, rejects with its error. */
export type T3Call = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<T3Data>;

export interface T3Options {
	/** How long one wait call blocks (`waitSliceMs`). */
	waitMs?: number;
	/** How long consecutive transport failures are repeated before `T3Unreachable`. */
	retryDeadlineMs?: number;
	/** The first pause between repeats; it doubles up to 15 s. */
	backoffMs?: number;
	/** Called with `T3Unreachable` before it is thrown: the run interrupts itself (the callers then see an aborted signal). */
	unreachable?: (error: T3Unreachable) => void;
}

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

/** t3 for one workflow run: its tools, called by their bare names; transport failures are repeated. */
export class T3 {
	readonly call: T3Call;
	readonly waitMs: number;

	constructor(call: T3Call, options: T3Options = {}) {
		this.waitMs = options.waitMs ?? MAX_WAIT_MS;
		const deadlineMs = options.retryDeadlineMs ?? RETRY_DEADLINE_MS;
		const firstBackoff = options.backoffMs ?? FIRST_BACKOFF_MS;
		this.call = async (name, args, signal) => {
			let failures = 0;
			let since = 0;
			for (;;) {
				try {
					return await call(name, args, signal);
				} catch (error) {
					if (signal.aborted || !isTransportFailure(error)) throw error;
					failures++;
					since ||= Date.now();
					const waited = Date.now() - since;
					if (waited >= deadlineMs) {
						const unreachable = new T3Unreachable(name, failures, waited, error);
						options.unreachable?.(unreachable);
						throw unreachable;
					}
					await sleep(Math.min(MAX_BACKOFF_MS, firstBackoff * 2 ** (failures - 1), deadlineMs - waited), signal);
				}
			}
		};
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
			// Not aborted with the run: t3 creates the task anyway, and only its id lets a cancel reach it.
			const task = await this.t3.call("delegate_task", { ...this.params, task: message, mode: "wait", timeoutMs: START_WAIT_MS, clientRequestId: requestId }, AbortSignal.timeout(START_WAIT_MS + 60_000));
			this.taskId = str(task.taskId);
			this.threadId = str(task.childThreadId);
			this.link = str(task.link);
			this.runId = str(task.childRunId);
			if (!this.taskId || !this.threadId) throw new Error(`t3 delegate_task started no thread: ${JSON.stringify(task).slice(0, 300)}`);
			started(this.ids);
			// Cancelled while t3 was starting it.
			if (this.cancelled !== undefined) this.cancel(this.cancelled);
			if (signal.aborted) throw signal.reason;
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
			const waited = await this.t3.call("t3_thread_wait", { threadId: this.threadId, ...(runId ? { runId } : {}), timeoutMs: this.waiting ? Math.min(ASK_POLL_MS, this.t3.waitMs) : this.t3.waitMs, untilDelegatedWorkSettled: true }, signal);
			this.status = String(waited.status);
			if (OVER.has(this.status)) return;
			const answered = (await this.waiting?.(this, signal)) ?? false;
			if (waited.timedOut === true) continue;
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
