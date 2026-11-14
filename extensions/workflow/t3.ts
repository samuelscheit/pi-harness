// agent() children as t3 delegated tasks: each child is a thread of its own under the calling thread,
// where the user can watch, steer and stop it. Used when the session has t3's tools (the t3 MCP
// bridge registers them as `mcp__t3-code__<name>`); a workflow script reaches them like any session
// tool (ctx.executeTool), where they resolve to the MCP result: `structuredContent` is t3's data.
//
// The first run is `delegate_task` in wait mode; later runs go to the same thread with
// `t3_thread_send` (a resume: the child's context and prompt cache are warm). Both carry a
// `clientRequestId` per run, which t3 dedupes: repeating the call with the same id returns the same
// task and run, so a workflow resumed after its process died reattaches to a child whose start was
// in flight by making the same call again. A wait that times out
// does not end the run: it continues with `t3_thread_wait` until the run is over. A question or an
// approval the child waits for also ends a wait; the code keeps waiting for the user to answer.
// Afterwards `task_status` reads the task, which marks its result delivered, so t3 does not wake
// the calling thread for a result the script already has.

import type { Thinking } from "./models.ts";

export const T3_PREFIX = "mcp__t3-code__";
export const T3_DELEGATE = `${T3_PREFIX}delegate_task`;
/** How long one t3 wait call blocks. */
export const WAIT_MS = 10 * 60_000;
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

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The supported thinking value closest to the wanted one (the higher on a tie). */
export function nearestThinking(wanted: string, supported: readonly string[]): string {
	if (supported.includes(wanted)) return wanted;
	const at = THINKING_ORDER.indexOf(wanted);
	const ranked = supported.filter((value) => THINKING_ORDER.includes(value));
	if (!ranked.length) return wanted;
	return ranked.reduce((best, value) => {
		const distance = Math.abs(THINKING_ORDER.indexOf(value) - at);
		const bestDistance = Math.abs(THINKING_ORDER.indexOf(best) - at);
		return distance < bestDistance || (distance === bestDistance && THINKING_ORDER.indexOf(value) > THINKING_ORDER.indexOf(best)) ? value : best;
	});
}

interface ModelInfo {
	id: string;
	options?: { id: string; values: unknown[] }[] | null;
}
interface ProviderInfo {
	providerInstanceId: string;
	driverKind: string;
	canRunChildTask: boolean;
	models: ModelInfo[];
	omittedModels?: number | null;
}

export interface T3Target {
	providerInstanceId: string;
	model: string;
	options: { thinking: string };
}

/** t3 for one workflow run: tool calls, and the delegate target of a model (capabilities read once). */
export class T3 {
	private capabilities: Promise<T3Data> | undefined;
	readonly call: T3Call;

	constructor(call: T3Call) {
		this.call = call;
	}

	async target(model: string, thinking: Thinking, signal: AbortSignal): Promise<T3Target> {
		const piProvider = (data: T3Data) => (data.providers as ProviderInfo[] | undefined)?.find((p) => p.driverKind === "pi" && p.canRunChildTask);
		this.capabilities ??= this.call("orchestrator_capabilities", {}, signal);
		const provider = piProvider(await this.capabilities);
		if (!provider) throw new Error("t3 has no Pi provider that can run a child task");
		let info = provider.models.find((m) => m.id === model);
		if (!info && provider.omittedModels) info = piProvider(await this.call("orchestrator_capabilities", { search: model }, signal))?.models.find((m) => m.id === model);
		const values = info?.options?.find((o) => o.id === "thinking")?.values.filter((v): v is string => typeof v === "string");
		return { providerInstanceId: provider.providerInstanceId, model, options: { thinking: values?.length ? nearestThinking(thinking, values) : thinking } };
	}
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

export interface DelegateRequest {
	title: string;
	role: "implementation" | "research";
	model: string;
	thinking: Thinking;
}

/** What identifies a child's t3 task, kept in the workflow's journal to reattach. */
export interface T3ChildIds {
	taskId?: string;
	threadId?: string;
	link?: string;
	/** The run of the latest message. */
	runId?: string;
}

/** One child as a t3 task and its thread. */
export class T3Child {
	taskId: string | undefined;
	threadId: string | undefined;
	link: string | undefined;
	runId: string | undefined;
	/** The last run's thread status and t3's summary of it. */
	status = "";
	summary: string | undefined;
	private readonly t3: T3;
	private readonly request: DelegateRequest;

	constructor(t3: T3, request: DelegateRequest) {
		this.t3 = t3;
		this.request = request;
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
	 * known is waited for; otherwise the call is repeated with the same request id, which t3 dedupes.
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
			const target = await this.t3.target(this.request.model, this.request.thinking, signal);
			const task = await this.t3.call("delegate_task", { task: message, title: this.request.title, role: this.request.role, target, mode: "wait", timeoutMs: WAIT_MS, clientRequestId: requestId }, signal);
			this.taskId = str(task.taskId);
			this.threadId = str(task.childThreadId);
			this.link = str(task.link);
			this.runId = str(task.childRunId);
			if (!this.taskId || !this.threadId) throw new Error(`t3 delegate_task started no thread: ${JSON.stringify(task).slice(0, 300)}`);
			started(this.ids);
			this.status = String(task.status);
			const finished = ["completed", "failed", "cancelled", "interrupted"].includes(this.status) && task.waitTimedOut !== true;
			if (!finished) await this.wait(this.runId, signal);
		} else {
			const sent = await this.t3.call("t3_thread_send", { threadId: this.threadId, message, mode: "queue", clientRequestId: requestId }, signal);
			this.taskId = str(sent.taskId) ?? this.taskId;
			this.runId = str(sent.runId);
			started(this.ids);
			await this.wait(this.runId, signal);
		}
		await this.deliver(signal);
	}

	private async wait(runId: string | undefined, signal: AbortSignal): Promise<void> {
		for (;;) {
			const started = Date.now();
			const waited = await this.t3.call("t3_thread_wait", { threadId: this.threadId, ...(runId ? { runId } : {}), timeoutMs: WAIT_MS, untilDelegatedWorkSettled: true }, signal);
			this.status = String(waited.status);
			if (OVER.has(this.status)) return;
			if (waited.timedOut !== true && Date.now() - started < RETRY_MS) await sleep(RETRY_MS, signal);
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

	/** Stop the task (its running and queued turns); with a signal of its own, since the run's is aborted. */
	cancel(): void {
		if (!this.taskId) return;
		void this.t3.call("task_cancel", { taskId: this.taskId, reason: "the workflow that started it stopped" }, AbortSignal.timeout(30_000)).catch(() => undefined);
	}
}
