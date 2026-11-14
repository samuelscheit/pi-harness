// Durable execution of a workflow script: every call to the outside goes through `Durable.call`,
// which journals it (journal.ts) and, when the run is resumed after its process died, answers it
// from the journal instead of running it again.
//
// A resume runs the same script from its start:
// - a call with a recorded outcome (`done`, `failed`) runs nothing and returns or throws it;
// - a call recorded as started without an outcome was in flight when the process died:
//   agent runs reattach to their t3 task or child session (agent.ts, through `reattach`), llm(),
//   changes() and workflows.* run again (no side effects of their own; a nested workflow's calls
//   are journaled one by one), shell and tools.* run again only when made with
//   `{ idempotent: true }` or when the resume says so (`inFlight: "rerun"`); with
//   `inFlight: "fail"` they throw, and without a decision the resume does not start
//   (`blockingCalls`, checked before the script runs);
// - the first call without an entry runs live.
//
// While recorded calls remain that the script has not asked for again, a new call waits: in
// parallel code a recorded call may still come. When nothing can bring one any more (no call or
// script timer runs), the script took another path than the journal: the resume stops with an
// error naming the recorded call and the new one. It never continues silently.
//
// Date.now(), new Date() and Math.random() in the script return recorded values on replay
// (`now`, `random`), by occurrence.
//
// The calls of a nested workflow (workflows.*) have keys inside its own: `<workflow key>/<kind>:…`,
// counted on their own. A replayed nested workflow so skips its calls as a whole, and its calls do
// not shift the occurrence numbers of equal calls outside it.
//
// A call that fails because the run was stopped (abort, budget, the session ended) records no
// outcome: it stays in flight, as it would after a crash.

import { AsyncLocalStorage } from "node:async_hooks";
import { argsHash, type CallKind, type Journal, type JournalEntry, reviveError, serializeError } from "./journal.ts";

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
	/** USD the call spent (already counted by the call itself). */
	cost?: number;
}

export interface CallContext {
	key: string;
	/** Record what the call learned (an agent's thread), durably: a resume reattaches with it. */
	meta(data: Record<string, unknown>): void;
	/** Whatever meta the journal had for this call (a reattach). */
	recorded: Record<string, unknown>;
}

/** Names of errors that interrupt a run rather than end it (its session ended, its context went stale): it can be resumed. */
const INTERRUPTIONS = new Set(["SessionEnded", "ContextStale"]);
export const isInterruption = (reason: unknown) => INTERRUPTIONS.has((reason as { name?: unknown } | null)?.name as string);

export class DivergenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DivergenceError";
	}
}

export class InterruptedCallError extends Error {
	constructor(label: string) {
		super(`${label} was running when the workflow's process ended; it may or may not have taken effect (the resume chose inFlight: "fail")`);
		this.name = "InterruptedCallError";
	}
}

type Start = Extract<JournalEntry, { t: "start" }>;
type Outcome = Extract<JournalEntry, { t: "done" | "failed" }>;

/** A value as JSON brings it back from the journal, so a live call and its replay return alike. */
function roundTrip<T>(value: T): T {
	return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** The calls of a journal that were started and have no outcome, in journal order. */
export function inFlightCalls(entries: readonly JournalEntry[]): Start[] {
	const open = new Map<string, Start>();
	for (const entry of entries) {
		if (entry.t === "start") open.set(entry.key, entry);
		else if (entry.t === "done" || entry.t === "failed") open.delete(entry.key);
	}
	return [...open.values()];
}

/** In-flight calls a resume may not run again without a decision: non-idempotent shell and tools.* calls. */
export const blockingCalls = (entries: readonly JournalEntry[]) => inFlightCalls(entries).filter((call) => (call.kind === "shell" || call.kind === "tool") && !call.idempotent);

export interface DurableOptions {
	journal: Journal;
	/** The journal so far (empty for a new run). */
	entries: readonly JournalEntry[];
	inFlight: InFlightPolicy;
	/** A replayed call's recorded cost and kind, to count. */
	replayed: (kind: CallKind, cost: number) => void;
	/** The script took another path: stop the run with this error. */
	diverged: (error: DivergenceError) => void;
	/** Whether the run was stopped: a call failing now records no outcome. */
	stopped: () => boolean;
}

export class Durable {
	private readonly journal: Journal;
	private readonly policy: InFlightPolicy;
	private readonly onReplayed: DurableOptions["replayed"];
	private readonly onDiverged: DurableOptions["diverged"];
	private readonly stopped: DurableOptions["stopped"];
	/** The key of the nested workflow a call runs in. */
	private readonly scope = new AsyncLocalStorage<string>();
	private readonly starts = new Map<string, Start>();
	private readonly outcomes = new Map<string, Outcome>();
	private readonly metas = new Map<string, Record<string, unknown>>();
	private readonly clocks = { now: [] as number[], random: [] as number[] };
	private readonly counts = { now: 0, random: 0 };
	private readonly occurrences = new Map<string, number>();
	/** Recorded calls the script has not asked for again, in journal order. */
	private readonly pending: string[];
	/** New calls waiting until the recorded ones are all asked for. */
	private readonly deferred: { key: string; label: string; release: (error?: Error) => void }[] = [];
	/** Live calls and script timers running: while any does, a recorded call may still come. */
	private active = 0;
	private checkScheduled = false;
	private diverged: DivergenceError | undefined;
	/** Calls answered from the journal in this execution. */
	replayedCalls = 0;

	constructor(options: DurableOptions) {
		this.journal = options.journal;
		this.policy = options.inFlight;
		this.onReplayed = options.replayed;
		this.onDiverged = options.diverged;
		this.stopped = options.stopped;
		const order: string[] = [];
		for (const entry of options.entries) {
			if (entry.t === "start") {
				if (!this.starts.has(entry.key)) order.push(entry.key);
				this.starts.set(entry.key, entry);
				this.outcomes.delete(entry.key);
			} else if (entry.t === "done" || entry.t === "failed") this.outcomes.set(entry.key, entry);
			else if (entry.t === "meta") this.metas.set(entry.key, { ...this.metas.get(entry.key), ...entry.data });
			else if (entry.t === "clock") this.clocks[entry.kind][entry.n - 1] = entry.value;
		}
		this.pending = order;
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
		const recorded = this.clocks[kind][n - 1];
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
		const parent = this.scope.getStore();
		const id = `${parent === undefined ? "" : `${parent}/`}${spec.kind}:${argsHash(spec.args)}`;
		const occurrence = (this.occurrences.get(id) ?? 0) + 1;
		this.occurrences.set(id, occurrence);
		const key = `${id}#${occurrence}`;
		const at = this.pending.indexOf(key);
		const start = this.starts.get(key);
		if (at >= 0) {
			this.pending.splice(at, 1);
			const outcome = this.outcomes.get(key);
			// A nested workflow answered from the journal makes none of its calls again.
			if (outcome && spec.kind === "workflow") for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i]!.startsWith(`${key}/`)) this.pending.splice(i, 1);
			if (this.pending.length === 0) this.release();
			if (outcome) {
				this.replayedCalls++;
				this.onReplayed(spec.kind, outcome.cost ?? 0);
				if (outcome.t === "failed") throw reviveError(outcome.error);
				return roundTrip(outcome.value);
			}
			// In flight when the process died.
			if (spec.kind === "agent" && reattach) return this.run(key, spec, reattach);
			if ((spec.kind === "shell" || spec.kind === "tool") && !start?.idempotent && !spec.idempotent) {
				if (this.policy === "fail") throw new InterruptedCallError(spec.label);
				if (this.policy !== "rerun") throw new Error(`${spec.label} was in flight when the process ended; resume with inFlight "rerun" or "fail"`);
			}
			return this.run(key, spec, live);
		}
		if (this.pending.length > 0) await this.wait(key, spec.label);
		return this.run(key, spec, live);
	}

	private async run(key: string, spec: CallSpec, live: (context: CallContext) => Promise<LiveResult>): Promise<unknown> {
		this.journal.append({ t: "start", key, kind: spec.kind, label: spec.label, at: Date.now(), ...(spec.idempotent ? { idempotent: true as const } : {}), ...(spec.model ? { model: spec.model } : {}) }, true);
		const context: CallContext = {
			key,
			recorded: { ...this.metas.get(key) },
			meta: (data) => {
				this.metas.set(key, { ...this.metas.get(key), ...data });
				this.journal.append({ t: "meta", key, at: Date.now(), data }, true);
			},
		};
		this.active++;
		try {
			const result = spec.kind === "workflow" ? await this.scope.run(key, () => live(context)) : await live(context);
			const value = roundTrip(result.value);
			this.journal.append({ t: "done", key, at: Date.now(), ...(value === undefined ? {} : { value }), ...(result.cost ? { cost: result.cost } : {}) }, true);
			return value;
		} catch (error) {
			if (this.stopped()) throw error;
			const cost = (error as { cost?: unknown } | null)?.cost;
			this.journal.append({ t: "failed", key, at: Date.now(), error: serializeError(error), ...(typeof cost === "number" && cost > 0 ? { cost } : {}) }, true);
			throw error;
		} finally {
			this.active--;
			this.scheduleCheck();
		}
	}

	private wait(key: string, label: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.deferred.push({ key, label, release: (error) => (error ? reject(error) : resolve()) });
			this.scheduleCheck();
		});
	}

	private release(): void {
		for (const call of this.deferred.splice(0)) call.release();
	}

	/** After the microtasks settle: nothing runs, recorded calls remain and new ones wait → another path. */
	private scheduleCheck(): void {
		if (this.checkScheduled || this.deferred.length === 0) return;
		this.checkScheduled = true;
		setImmediate(() => {
			this.checkScheduled = false;
			if (this.active > 0 || this.deferred.length === 0 || this.pending.length === 0) return;
			const recorded = this.starts.get(this.pending[0]!)!;
			const asked = this.deferred[0]!;
			this.diverged = new DivergenceError(
				`the script took another path than its journal: the journal has ${recorded.kind} call ${recorded.key} (${recorded.label}) next, the script asked for ${asked.key} (${asked.label}) instead. The resume stopped; nothing of the new path ran.`,
			);
			for (const call of this.deferred.splice(0)) call.release(this.diverged);
			this.onDiverged(this.diverged);
		});
	}
}
