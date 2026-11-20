// Durable execution of a workflow script: every call to the outside goes through `Durable.call`,
// which journals it (journal.ts) and, when the run is resumed, answers it from the journal instead
// of running it again.
//
// A resume runs the script from its start:
// - a call with a recorded outcome (`done`, `failed`) runs nothing and returns or throws it;
// - a call recorded as started without an outcome was in flight when the run stopped: an agent run
//   a stop left running in this process is adopted (its outcome is awaited), other agent runs
//   reattach to their t3 task or child session (delegate.ts, through `reattach`); llm(), changes()
//   and workflows.* run again (no side effects of their own; a nested workflow's calls are
//   journaled one by one); shell and tools.* run again only when made with `{ idempotent: true }`
//   or when the resume says so (`inFlight: "rerun"`); with `inFlight: "fail"` they throw, and
//   without a decision the resume does not start (`blockingCalls`, checked before the script runs);
// - the first call without an entry runs live;
// - a failed agent run, llm() call or nested workflow (`retryable`) runs again: its failure was the
//   child's work failing (a request failed, a harness fault), and a resume that replayed it would
//   fail at the same place again. What the failed attempt spent still counts. It runs as a new
//   execution: the failed one's meta (an agent's run id, its request id) is not its `recorded`,
//   nor a later reattach's. A failure from a
//   budget (the run's or a phase's) is replayed: running again would only spend into it again.
//   Shell and tools.* failures are replayed: running them again could repeat their effects. Once
//   a call ran again, the script may take another path than the journal (the call now succeeds):
//   the resume matches leniently from then on, as for edited code, and takes over where the paths
//   part instead of stopping.
//
// The same code (strict): while recorded calls remain that the script has not asked for again, a
// new call waits, since in parallel code a recorded call may still come. When nothing can bring one
// any more (no call or script timer runs), the script took another path than the journal: the
// resume stops with an error naming the recorded call and the new one.
//
// Edited code (a resume with `code`, until it took over): a recorded call answers only when the new
// code asks for it after every recorded call that had finished before it started (it may have
// depended on them; this keeps occurrence numbers honest when the new code adds or removes an equal
// call before it). Where strict mode would stop, the new code takes over instead: a `takeover` entry
// records the position and the recorded calls left unused, and from then on every call runs live.
// Unused agent runs still in flight are cancelled.
//
// Date.now(), new Date() and Math.random() in the script return recorded values on replay
// (`now`, `random`), by occurrence, and live ones after a takeover.
//
// The calls of a nested workflow (workflows.*) have keys inside its own: `<workflow key>/<kind>:…`,
// counted on their own. A replayed nested workflow so skips its calls as a whole, and its calls do
// not shift the occurrence numbers of equal calls outside it.
//
// The script's calls reject as soon as the run stops. A call's work runs under its own signal
// (`signalFor`): an agent run's goes on when a stop keeps the children, records its outcome when
// it ends, and can be adopted by a resume (`unsettled`). Work that fails because its signal was
// aborted records no outcome: it stays in flight, as after a crash.

import { AsyncLocalStorage } from "node:async_hooks";
import { argsHash, type CallKind, type Journal, type JournalEntry, reviveError, type SerializedError, serializeError } from "./journal.ts";
import { recordable } from "./phases.ts";

/** What a resume does with shell and tools.* calls that were in flight. */
export type InFlightPolicy = "stop" | "rerun" | "fail";

export interface CallSpec {
	kind: CallKind;
	/** Hashed into the key: equal arguments are the same call. */
	args: unknown;
	label: string;
	model?: string;
	/** A shell or tools.* call that may run again when it was in flight. */
	idempotent?: boolean;
}

export interface LiveResult {
	/** Journaled, and returned to the script as JSON would bring it back. */
	value: unknown;
}

export interface CallContext {
	key: string;
	/** Note USD the call spent (counted against the budget by the call itself): recorded with its outcome, also a failure, so a resume counts it again. */
	spend(usd: number): void;
	/** Record what the call learned (an agent's thread), durably: a resume reattaches with it. */
	meta(data: Record<string, unknown>): void;
	/** Whatever meta the journal had for this call (a reattach). */
	recorded: Record<string, unknown>;
	/** The signal the call's work runs under (it may outlive the run's: see `signalFor`). */
	signal: AbortSignal;
}

/** Names of errors that interrupt a run rather than end it (its session ended, its context went stale, t3 stayed unreachable): it can be resumed. */
const INTERRUPTIONS = new Set(["SessionEnded", "ContextStale", "T3Unreachable"]);
export const isInterruption = (reason: unknown) => INTERRUPTIONS.has((reason as { name?: unknown } | null)?.name as string);

/** The reason of a run stopped on request (`workflow { stop }`); `children`: its agents are cancelled too. */
export class WorkflowStopped extends Error {
	readonly children: boolean;
	constructor(children: boolean) {
		super(children ? "stopped on request, with its agents" : "stopped on request");
		this.name = "WorkflowStopped";
		this.children = children;
	}
}
export const isStop = (reason: unknown): reason is WorkflowStopped => (reason as { name?: unknown } | null)?.name === "WorkflowStopped";

export class DivergenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DivergenceError";
	}
}

export class InterruptedCallError extends Error {
	constructor(label: string) {
		super(`${label} was cut off when the workflow stopped or its process ended; it may or may not have taken effect (the resume chose inFlight: "fail")`);
		this.name = "InterruptedCallError";
	}
}

type Start = Extract<JournalEntry, { t: "start" }>;
type Outcome = Extract<JournalEntry, { t: "done" | "failed" }>;

/** Kinds of calls whose recorded failure a resume runs again (see the header). */
const RETRYABLE: ReadonlySet<CallKind> = new Set<CallKind>(["delegate", "llm", "workflow"]);
/** Failures a resume replays whatever the call: a budget is used up. */
const BUDGET_FAILURES = new Set(["BudgetExceeded", "PhaseBudgetExceeded"]);
/** Whether a resume runs this recorded failure again. */
export const retryable = (kind: CallKind, outcome: Outcome): boolean => outcome.t === "failed" && RETRYABLE.has(kind) && !BUDGET_FAILURES.has(outcome.error.name ?? "");

/** The recorded failures a resume runs again, in journal order (a nested workflow's own failed calls included). */
export function retryableFailures(entries: readonly JournalEntry[]): Start[] {
	const { order, starts, outcomes } = foldJournal(entries);
	return order.flatMap((key) => {
		const start = starts.get(key)!;
		const outcome = outcomes.get(key);
		return outcome && retryable(start.kind, outcome) ? [start] : [];
	});
}

/** What a call's work came to: its outcome, or none (stopped before it had one). */
export type Settled = { outcome: "done"; value: unknown; cost: number } | { outcome: "failed"; error: SerializedError; cost: number } | { outcome: "none" };

/** A live call's work; an agent run's can outlive the execution that started it (a stop that keeps children). */
export interface Work {
	kind: CallKind;
	settled: Promise<Settled>;
	/** Stop the work; its outcome is not recorded. */
	cancel(reason: unknown): void;
}

/** A value as JSON brings it back from the journal, so a live call and its replay return alike. */
function roundTrip<T>(value: T): T {
	return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** The journal as a resume sees it: the latest start and outcome per call, takeovers applied. */
export interface Folded {
	starts: Map<string, Start>;
	outcomes: Map<string, Outcome>;
	metas: Map<string, Record<string, unknown>>;
	/** Recorded calls in the order of their first start. */
	order: string[];
	/** Journal positions of each call's first start and of its outcome (happens-before for edited code). */
	startAt: Map<string, number>;
	outcomeAt: Map<string, number>;
	clocks: { now: number[]; random: number[] };
	/** An edit that has not taken over yet: the resume matches leniently. */
	editPending: boolean;
}

export function foldJournal(entries: readonly JournalEntry[]): Folded {
	const folded: Folded = { starts: new Map(), outcomes: new Map(), metas: new Map(), order: [], startAt: new Map(), outcomeAt: new Map(), clocks: { now: [], random: [] }, editPending: false };
	entries.forEach((entry, at) => {
		switch (entry.t) {
			case "start":
				if (!folded.starts.has(entry.key)) folded.order.push(entry.key);
				// A failed call that runs again is a new execution: what the failed one learned is not its own.
				if (folded.outcomes.has(entry.key)) folded.metas.delete(entry.key);
				if (!folded.startAt.has(entry.key)) folded.startAt.set(entry.key, at);
				folded.starts.set(entry.key, entry);
				folded.outcomes.delete(entry.key);
				folded.outcomeAt.delete(entry.key);
				break;
			case "done":
			case "failed":
				if (!folded.starts.has(entry.key)) break;
				folded.outcomes.set(entry.key, entry);
				folded.outcomeAt.set(entry.key, at);
				break;
			case "meta":
				folded.metas.set(entry.key, { ...folded.metas.get(entry.key), ...entry.data });
				break;
			case "clock":
				folded.clocks[entry.kind][entry.n - 1] = entry.value;
				break;
			case "edit":
				folded.editPending = true;
				break;
			case "takeover": {
				const dropped = new Set(entry.dropped);
				for (const map of [folded.starts, folded.outcomes, folded.metas, folded.startAt, folded.outcomeAt]) for (const key of dropped) map.delete(key);
				folded.order = folded.order.filter((key) => !dropped.has(key));
				folded.clocks.now.length = Math.min(folded.clocks.now.length, entry.clocks.now);
				folded.clocks.random.length = Math.min(folded.clocks.random.length, entry.clocks.random);
				folded.editPending = false;
				break;
			}
		}
	});
	return folded;
}

/** The calls of a journal that were started and have no outcome, in journal order. */
export function inFlightCalls(entries: readonly JournalEntry[]): Start[] {
	const { order, starts, outcomes } = foldJournal(entries);
	return order.filter((key) => !outcomes.has(key)).map((key) => starts.get(key)!);
}

/** In-flight calls a resume may not run again without a decision: non-idempotent shell and tools.* calls. */
export const blockingCalls = (entries: readonly JournalEntry[]) => inFlightCalls(entries).filter((call) => (call.kind === "shell" || call.kind === "tool") && !call.idempotent);

export interface DurableOptions {
	journal: Journal;
	/** The journal so far (empty for a new run). */
	entries: readonly JournalEntry[];
	inFlight: InFlightPolicy;
	/** This execution's number (attempt), for the takeover entry. */
	attempt: number;
	/** The run's signal: the script's calls reject when it aborts. */
	signal: AbortSignal;
	/** The signal a call's work runs under: the run's, or for agents the children's, which a stop may leave running. */
	signalFor: (kind: CallKind) => AbortSignal;
	/** Work an earlier execution in this process left running (agents a stop kept), by key. */
	inherited?: ReadonlyMap<string, Work>;
	/** A replayed call's recorded cost and kind, to count. */
	replayed: (kind: CallKind, cost: number) => void;
	/** What the recorded attempt of a call that runs again spent, to count. */
	retried?: (kind: CallKind, cost: number) => void;
	/** The script took another path: stop the run with this error. */
	diverged: (error: DivergenceError) => void;
	/** Edited code took over: recorded agent runs in flight it does not use, whose children are not run here (to cancel). */
	dropped?: (calls: { start: Start; meta: Record<string, unknown> }[]) => void;
	/** The phase the caller runs in (phases.ts), recorded with each call's start. */
	phaseOf?: () => string | undefined;
}

export class Durable {
	private readonly journal: Journal;
	private readonly policy: InFlightPolicy;
	private readonly attempt: number;
	private readonly signal: AbortSignal;
	private readonly signalFor: DurableOptions["signalFor"];
	private readonly onReplayed: DurableOptions["replayed"];
	private readonly onRetried: DurableOptions["retried"];
	private readonly onDiverged: DurableOptions["diverged"];
	private readonly onDropped: DurableOptions["dropped"];
	private readonly phaseOf: DurableOptions["phaseOf"];
	private readonly folded: Folded;
	/** Matching leniently: edited code that has not taken over yet. */
	readonly editing: boolean;
	/** A recorded failure ran again: the script may part from the journal from there on. */
	private retried = false;
	/** Calls whose recorded failure ran again in this execution. */
	retriedCalls = 0;
	private tookOver = false;
	/** The key of the nested workflow a call runs in. */
	private readonly scope = new AsyncLocalStorage<string>();
	private readonly counts = { now: 0, random: 0 };
	private readonly occurrences = new Map<string, number>();
	/** Recorded calls the script has not asked for again, in journal order. */
	private pending: string[];
	/** Journal positions of the pending calls' outcomes, ascending: the first is the happens-before frontier. */
	private pendingOutcomes: number[];
	/** New calls waiting until a recorded one may match, or the journal is used up. */
	private readonly deferred: { key: string; label: string; release: (error?: Error) => void }[] = [];
	/** Work of this execution not settled yet (and adopted work). */
	private readonly works = new Map<string, Work>();
	private readonly inherited: Map<string, Work>;
	/** Live calls and script timers running: while any does, a recorded call may still come. */
	private active = 0;
	private checkScheduled = false;
	private diverged: DivergenceError | undefined;
	/** Calls answered from the journal in this execution. */
	replayedCalls = 0;
	/** Recorded calls the script did not use (edited code took over, or it returned without them). */
	readonly unused: Start[] = [];

	constructor(options: DurableOptions) {
		this.journal = options.journal;
		this.policy = options.inFlight;
		this.attempt = options.attempt;
		this.signal = options.signal;
		this.signalFor = options.signalFor;
		this.onReplayed = options.replayed;
		this.onRetried = options.retried;
		this.onDiverged = options.diverged;
		this.onDropped = options.dropped;
		this.phaseOf = options.phaseOf;
		this.folded = foldJournal(options.entries);
		this.editing = this.folded.editPending;
		this.pending = [...this.folded.order];
		this.pendingOutcomes = this.pending.flatMap((key) => (this.folded.outcomeAt.has(key) ? [this.folded.outcomeAt.get(key)!] : [])).sort((a, b) => a - b);
		this.inherited = new Map(options.inherited);
	}

	/** Date.now() for the script: recorded on replay, else the host's, recorded. */
	now(): number {
		return this.clock("now", Date.now);
	}

	random(): number {
		return this.clock("random", Math.random);
	}

	private clock(kind: "now" | "random", live: () => number): number {
		const n = ++this.counts[kind];
		const recorded = this.tookOver ? undefined : this.folded.clocks[kind][n - 1];
		if (recorded !== undefined) return recorded;
		const value = live();
		this.journal.append({ t: "clock", kind, n, value });
		return value;
	}

	/** Count something that may still ask for a recorded call (a script timer) while it runs. */
	hold(): () => void {
		this.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			this.scheduleCheck();
		};
	}

	/** Make one call: from the journal when recorded, else live (after the recorded calls). */
	async call(spec: CallSpec, live: (context: CallContext) => Promise<LiveResult>, reattach?: (context: CallContext) => Promise<LiveResult>): Promise<unknown> {
		if (this.diverged) throw this.diverged;
		if (this.signal.aborted) throw this.signal.reason;
		const parent = this.scope.getStore();
		const id = `${parent === undefined ? "" : `${parent}/`}${spec.kind}:${argsHash(spec.args)}`;
		const occurrence = (this.occurrences.get(id) ?? 0) + 1;
		this.occurrences.set(id, occurrence);
		const key = `${id}#${occurrence}`;
		for (;;) {
			if (this.matches(key)) return this.answer(key, spec, live, reattach);
			if (this.tookOver || this.pending.length === 0) break;
			await this.wait(key, spec.label);
		}
		if (this.lenient && !this.tookOver) this.takeover(key, spec.label);
		return this.guard(this.run(key, spec, live));
	}

	/** Matching as for edited code: edited code, or a recorded failure that ran again. */
	private get lenient(): boolean {
		return this.editing || this.retried;
	}

	/** Work not settled yet: this execution's (and adopted) and inherited work no call asked for. */
	unsettled(): Map<string, Work> {
		return new Map([...this.inherited, ...this.works]);
	}

	/** The script returned: recorded calls it never asked for are not used (edited code takes over for good). */
	finish(): void {
		if (this.pending.length === 0) return;
		if (this.lenient && !this.tookOver) this.takeover();
		else this.unused.push(...this.pending.map((key) => this.folded.starts.get(key)!));
	}

	private matches(key: string): boolean {
		if (this.tookOver || !this.pending.includes(key)) return false;
		return !this.lenient || this.folded.startAt.get(key)! < (this.pendingOutcomes[0] ?? Number.POSITIVE_INFINITY);
	}

	private consume(key: string): void {
		this.pending.splice(this.pending.indexOf(key), 1);
		const at = this.folded.outcomeAt.get(key);
		if (at !== undefined) this.pendingOutcomes.splice(this.pendingOutcomes.indexOf(at), 1);
	}

	private async answer(key: string, spec: CallSpec, live: (context: CallContext) => Promise<LiveResult>, reattach?: (context: CallContext) => Promise<LiveResult>): Promise<unknown> {
		this.consume(key);
		const outcome = this.folded.outcomes.get(key);
		if (outcome && retryable(spec.kind, outcome)) {
			// Its nested calls stay recorded: the workflow asks for them again (its finished ones replay).
			this.retried = true;
			this.retriedCalls++;
			this.folded.metas.delete(key);
			this.onRetried?.(spec.kind, outcome.cost ?? 0);
			this.notify();
			return this.guard(this.run(key, spec, live));
		}
		// A nested workflow answered from the journal makes none of its calls again; what they spent counts.
		if (outcome && spec.kind === "workflow")
			for (const nested of this.pending.filter((k) => k.startsWith(`${key}/`))) {
				this.consume(nested);
				const recorded = this.folded.outcomes.get(nested);
				if (recorded) this.onReplayed(this.folded.starts.get(nested)!.kind, recorded.cost ?? 0);
			}
		this.notify();
		if (outcome) {
			this.replayedCalls++;
			this.onReplayed(spec.kind, outcome.cost ?? 0);
			if (outcome.t === "failed") throw reviveError(outcome.error);
			return roundTrip(outcome.value);
		}
		// In flight when the run stopped.
		const work = this.inherited.get(key);
		if (work) {
			this.inherited.delete(key);
			return this.guard(this.adopt(key, spec, work, reattach ?? live));
		}
		if (spec.kind === "delegate" && reattach) return this.guard(this.run(key, spec, reattach));
		const start = this.folded.starts.get(key);
		if ((spec.kind === "shell" || spec.kind === "tool") && !start?.idempotent && !spec.idempotent) {
			if (this.policy === "fail") throw new InterruptedCallError(spec.label);
			if (this.policy !== "rerun") throw new Error(`${spec.label} was in flight when the run stopped; resume with inFlight "rerun" or "fail"`);
		}
		return this.guard(this.run(key, spec, live));
	}

	/** Await work an earlier execution left running; without an outcome (it was interrupted meanwhile) reattach. */
	private async adopt(key: string, spec: CallSpec, work: Work, reattach: (context: CallContext) => Promise<LiveResult>): Promise<unknown> {
		this.works.set(key, work);
		this.active++;
		let settled: Settled;
		try {
			settled = await work.settled;
		} finally {
			if (this.works.get(key) === work) this.works.delete(key);
			this.active--;
			this.scheduleCheck();
		}
		if (settled.outcome === "none") return this.run(key, spec, reattach);
		this.replayedCalls++;
		this.onReplayed(spec.kind, settled.cost);
		if (settled.outcome === "failed") throw reviveError(settled.error);
		return roundTrip(settled.value);
	}

	/** The script's side of a call: rejects as soon as the run stops, while the work may go on. */
	private guard<T>(work: Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const stop = () => reject(this.signal.reason);
			if (this.signal.aborted) stop();
			else this.signal.addEventListener("abort", stop, { once: true });
			work.then(
				(value) => {
					this.signal.removeEventListener("abort", stop);
					resolve(value);
				},
				(error: unknown) => {
					this.signal.removeEventListener("abort", stop);
					reject(error);
				},
			);
		});
	}

	private async run(key: string, spec: CallSpec, live: (context: CallContext) => Promise<LiveResult>): Promise<unknown> {
		if (this.signal.aborted) throw this.signal.reason;
		const phase = this.phaseOf?.();
		this.journal.append({ t: "start", key, kind: spec.kind, label: spec.label, at: Date.now(), ...(spec.idempotent ? { idempotent: true as const } : {}), ...(spec.model ? { model: spec.model } : {}), ...(phase ? { phase } : {}) }, true);
		const own = new AbortController();
		const signal = AbortSignal.any([this.signalFor(spec.kind), own.signal]);
		let spent = 0;
		const context: CallContext = {
			key,
			spend: (usd) => {
				if (usd > 0) spent += usd;
			},
			recorded: { ...this.folded.metas.get(key) },
			meta: (data) => {
				this.folded.metas.set(key, { ...this.folded.metas.get(key), ...data });
				this.journal.append({ t: "meta", key, at: Date.now(), data }, true);
			},
			signal,
		};
		let settle!: (settled: Settled) => void;
		const work: Work = { kind: spec.kind, settled: new Promise((resolve) => (settle = resolve)), cancel: (reason) => own.abort(reason) };
		this.works.set(key, work);
		this.active++;
		try {
			const result = spec.kind === "workflow" ? await this.scope.run(key, () => live(context)) : await live(context);
			// Cancelled after it finished (unused by edited code): its outcome is not recorded.
			if (own.signal.aborted) throw own.signal.reason;
			const value = roundTrip(result.value);
			this.journal.append({ t: "done", key, at: Date.now(), ...(value === undefined ? {} : { value }), ...(spent ? { cost: spent } : {}) }, true);
			settle({ outcome: "done", value, cost: spent });
			return value;
		} catch (error) {
			// Stopped by the run (a stop, an interruption): no outcome, a resume decides. A phase over its budget is the call's failure.
			const reason: unknown = signal.aborted ? signal.reason : undefined;
			if (signal.aborted && !recordable(reason)) {
				settle({ outcome: "none" });
				throw error;
			}
			const failed = serializeError(signal.aborted ? reason : error);
			this.journal.append({ t: "failed", key, at: Date.now(), error: failed, ...(spent ? { cost: spent } : {}) }, true);
			settle({ outcome: "failed", error: failed, cost: spent });
			throw signal.aborted ? reason : error;
		} finally {
			if (this.works.get(key) === work) this.works.delete(key);
			this.active--;
			this.scheduleCheck();
		}
	}

	/** Edited code takes over at `key` (or at its return): every recorded call not asked for yet is unused. */
	private takeover(key?: string, label?: string): void {
		this.tookOver = true;
		const dropped = this.pending.splice(0);
		this.pendingOutcomes = [];
		this.unused.push(...dropped.map((k) => this.folded.starts.get(k)!));
		this.journal.append({ t: "takeover", at: Date.now(), n: this.attempt, ...(key ? { key, label } : {}), replayed: this.replayedCalls, dropped, clocks: { ...this.counts } }, true);
		const elsewhere: { start: Start; meta: Record<string, unknown> }[] = [];
		for (const k of dropped) {
			if (this.folded.outcomes.has(k)) continue;
			const work = this.inherited.get(k);
			if (work) {
				this.inherited.delete(k);
				work.cancel(new Error("the edited code does not use this call"));
			} else if (this.folded.starts.get(k)!.kind === "delegate") elsewhere.push({ start: this.folded.starts.get(k)!, meta: { ...this.folded.metas.get(k) } });
		}
		if (elsewhere.length) this.onDropped?.(elsewhere);
	}

	private wait(key: string, label: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.deferred.push({ key, label, release: (error) => (error ? reject(error) : resolve()) });
			this.scheduleCheck();
		});
	}

	/** The recorded calls changed: waiting calls look again. */
	private notify(): void {
		for (const call of this.deferred.splice(0)) call.release();
	}

	/** After the microtasks settle: nothing runs, recorded calls remain and new ones wait → another path. */
	private scheduleCheck(): void {
		if (this.checkScheduled || this.deferred.length === 0) return;
		this.checkScheduled = true;
		setImmediate(() => {
			this.checkScheduled = false;
			if (this.active > 0 || this.deferred.length === 0 || this.pending.length === 0) return;
			const asked = this.deferred[0]!;
			if (this.lenient) {
				this.takeover(asked.key, asked.label);
				this.notify();
				return;
			}
			const recorded = this.folded.starts.get(this.pending[0]!)!;
			this.diverged = new DivergenceError(
				`the script took another path than its journal: the journal has ${recorded.kind} call ${recorded.key} (${recorded.label}) next, the script asked for ${asked.key} (${asked.label}) instead. The resume stopped; nothing of the new path ran. If you changed the script on purpose, resume with code.`,
			);
			for (const call of this.deferred.splice(0)) call.release(this.diverged);
			this.onDiverged(this.diverged);
		});
	}
}
