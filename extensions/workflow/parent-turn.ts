// The parent session's turn, as t3 needs it to start a workflow's delegate() children.
//
// t3 starts a delegated task only under an active run of the calling thread: `delegate_task`
// fails with `parent_not_active` otherwise (t3code OrchestratorMcpService.delegateTask: the latest
// active run, owned by the caller's provider instance, with a root node the task hangs under). The
// session's background work (the workflow is one item, ../background/work.ts) does not count there;
// it only keeps the thread a live caller for waits, sends, reads and cancels (threadAccess.ts
// `isLiveCallerShell`), which is why a workflow's children already started keep running.
//
// A workflow runs in the background, and the agent ends its turn while it runs, as its guidelines
// say. So 17 of 30 delegate() calls of run 20261115-071237-996ba4 failed with parent_not_active.
// Now a start t3 refuses so waits for a run of the parent thread and is repeated:
//
// - The session is woken once (`wake`: a message that triggers a turn), however many starts wait:
//   t3's Pi adapter adopts a turn Pi starts on its own (`agent_start` without a turn of t3's) as a
//   new run of the thread. No wake while a turn runs: it is t3's run, or about to be adopted.
// - The woken turn may end before t3 adopted it and the starts went through (the agent has nothing
//   to do for them). t3 ends the run when Pi reports `agent_settled`, which Pi does only after the
//   extensions' `agent_settled` handlers finished: `settling` holds that while starts wait, at most
//   `holdMs`, so the run stays active until they are in.
// - Each start gives up after `deadlineMs` of waiting with t3's error; other errors pass at once.
//
// One per session, in process state: a run outlives the extension instance it started in (a
// harness reload), and every run of the session shares the wake.

/** Whether t3 refused a call because the calling thread has no active run. */
export const isParentInactive = (error: unknown) => /\bparent_not_active\b/.test(error instanceof Error ? error.message : String(error));

export interface ParentTurnOptions {
	/** How often a waiting start is tried again. */
	pollMs?: number;
	/** How long one start waits for an active run before it fails with t3's error. */
	deadlineMs?: number;
	/** How long the end of a turn is held while starts wait. */
	holdMs?: number;
}

const POLL_MS = 1_000;
const DEADLINE_MS = 3 * 60_000;
const HOLD_MS = 60_000;

export const WAKE_MESSAGE = "workflow-wake";
export const WAKE_TEXT =
	"A workflow running in the background is starting delegate() agents, and t3 starts a delegated agent only during a turn of this thread, so it woke you: they start during this turn. Nothing to do for them; their results arrive with the workflow's result. Continue with your work, or end your turn.";

export class ParentTurn {
	/** Between `agent_start` and the end of `agent_settled`'s handlers: t3 has the run, or adopts it. */
	private active: boolean;
	/** A wake was sent and its turn has not started yet. */
	private woken = false;
	/** Starts waiting for an active run. */
	private waiting = 0;
	private drained: (() => void)[] = [];
	private readonly wake: () => void;
	private readonly pollMs: number;
	private readonly deadlineMs: number;
	private readonly holdMs: number;

	constructor(wake: () => void, options: ParentTurnOptions = {}, active = false) {
		this.wake = wake;
		this.active = active;
		this.pollMs = options.pollMs ?? POLL_MS;
		this.deadlineMs = options.deadlineMs ?? DEADLINE_MS;
		this.holdMs = options.holdMs ?? HOLD_MS;
	}

	/** Starts waiting right now. */
	get pending(): number {
		return this.waiting;
	}

	/**
	 * `attempt`, repeated while t3 refuses it for lack of an active run: the session is woken and the
	 * attempt repeated every `pollMs`, for at most `deadlineMs`. `signal` ends the waiting (not an
	 * attempt in flight: the attempt has its own).
	 */
	async retry<T>(attempt: () => Promise<T>, signal: AbortSignal): Promise<T> {
		let since = 0;
		try {
			for (;;) {
				try {
					return await attempt();
				} catch (error) {
					if (signal.aborted || !isParentInactive(error)) throw error;
					if (!since) {
						since = Date.now();
						this.waiting++;
					}
					const waited = Date.now() - since;
					if (waited >= this.deadlineMs) {
						throw new Error(`${error instanceof Error ? error.message : String(error)} (the parent session was woken, but t3 had no active run of its thread for ${Math.round(waited / 1000)} s)`, { cause: error });
					}
					this.awake();
					await sleep(Math.min(this.pollMs, this.deadlineMs - waited), signal);
				}
			}
		} finally {
			if (since) {
				this.waiting--;
				if (this.waiting === 0) for (const done of this.drained.splice(0)) done();
			}
		}
	}

	/** `agent_start`: a turn runs, which t3 has or adopts. */
	started(): void {
		this.active = true;
		this.woken = false;
	}

	/** `agent_settled`: resolves once no start waits, or after `holdMs`; t3 ends the run after it. */
	async settling(): Promise<void> {
		if (this.waiting > 0) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await new Promise<void>((resolve) => {
				this.drained.push(resolve);
				timer = setTimeout(resolve, this.holdMs);
			});
			clearTimeout(timer);
		}
		this.active = false;
	}

	/** Wake the session unless a turn runs or a wake is on its way. */
	private awake(): void {
		if (this.active || this.woken) return;
		this.woken = true;
		try {
			this.wake();
		} catch (error) {
			this.woken = false;
			throw error;
		}
	}
}

const state = globalThis as { __harnessParentTurns?: Map<string, ParentTurn> };
const turns = () => (state.__harnessParentTurns ??= new Map());

/** The session's parent turn; created with `create` the first time. */
export function parentTurn(sessionId: string, create: () => ParentTurn): ParentTurn {
	let turn = turns().get(sessionId);
	if (!turn) turns().set(sessionId, (turn = create()));
	return turn;
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
