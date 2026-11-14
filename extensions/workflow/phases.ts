// Phases make a workflow's process visible without fixing its shape: `phase(name, fn, { budget? })`
// runs `fn` as a named phase, nestable and repeatable (iterations are numbered: "review · round 2"),
// and `plan.expect([...])` names the phases expected next in the current scope, only for display.
//
// The journal records each phase's enter and exit and each plan (journal.ts), and every call's start
// names its phase, so the page (render.ts), the dashboard's live view and `workflow { status }` show
// a phase tree: done, running and expected phases, with their cost and time. A phase over its budget
// throws PhaseBudgetExceeded (the code can catch it): its calls in flight are aborted, and they
// record the failure, so a resume replays it.
//
// The current phase follows the script's async context (AsyncLocalStorage), so parallel phases
// (`map` over phases) each count their own calls and cost. Ids are paths of names and iteration
// numbers ("build#1/review#2"), the same on every replay.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Journal } from "./journal.ts";

export class PhaseBudgetExceeded extends Error {
	/** Calls it aborts record it as their failure (a resume replays it). */
	readonly recordable = true;
	constructor(phase: string, limit: number, spent: number) {
		super(`phase ${phase} is over its budget of $${limit.toFixed(2)} ($${spent.toFixed(4)} spent)`);
		this.name = "PhaseBudgetExceeded";
	}
}

/** Whether an abort reason is recorded as the failure of the calls it aborts. */
export const recordable = (reason: unknown) => (reason as { recordable?: unknown } | null)?.recordable === true;

/** A phase's name as shown: "review", then "review · round 2". */
export const phaseLabel = (name: string, n: number) => (n > 1 ? `${name} · round ${n}` : name);

interface Scope {
	/** Iterations entered per child name. */
	counts: Map<string, number>;
	/** Status of each child name's latest iteration. */
	children: Map<string, "running" | "done" | "failed">;
	/** The latest plan.expect of this scope. */
	plan?: string[];
}

interface Active extends Scope {
	id: string;
	name: string;
	n: number;
	parent?: Active;
	budget?: number;
	spent: number;
	controller: AbortController;
}

export interface PhaseOptions {
	budget?: number;
}

export class Phases {
	private readonly storage = new AsyncLocalStorage<Active>();
	private readonly root: Scope = { counts: new Map(), children: new Map() };
	private readonly journal: Journal;
	private readonly progress: (line: string) => void;

	constructor(journal: Journal, progress: (line: string) => void) {
		this.journal = journal;
		this.progress = progress;
	}

	/** The id of the phase the caller runs in, for the journal. */
	current(): string | undefined {
		return this.storage.getStore()?.id;
	}

	/** Aborted when the caller's phase, or one around it, goes over its budget. */
	signal(): AbortSignal | undefined {
		const signals: AbortSignal[] = [];
		for (let phase = this.storage.getStore(); phase; phase = phase.parent) signals.push(phase.controller.signal);
		return signals.length ? AbortSignal.any(signals) : undefined;
	}

	/** Count spending against the caller's phase and those around it. */
	spend(usd: number): void {
		for (let phase = this.storage.getStore(); phase; phase = phase.parent) {
			phase.spent += usd;
			if (phase.budget !== undefined && phase.spent > phase.budget && !phase.controller.signal.aborted) {
				phase.controller.abort(new PhaseBudgetExceeded(phaseLabel(phase.name, phase.n), phase.budget, phase.spent));
			}
		}
	}

	async run<T>(name: unknown, fn: unknown, options: unknown): Promise<T> {
		if (typeof name !== "string" || !name.trim() || /[/#]/.test(name)) throw new TypeError("phase(name, fn, options?): name must be a non-empty string without / or #");
		if (typeof fn !== "function") throw new TypeError("phase(name, fn, options?): fn must be a function");
		const budget = (options as PhaseOptions | undefined)?.budget;
		if (budget !== undefined && !(typeof budget === "number" && budget > 0)) throw new TypeError("phase(): budget must be a positive number of USD");
		const parent = this.storage.getStore();
		const scope: Scope = parent ?? this.root;
		const n = (scope.counts.get(name) ?? 0) + 1;
		scope.counts.set(name, n);
		scope.children.set(name, "running");
		const id = `${parent ? `${parent.id}/` : ""}${name}#${n}`;
		const phase: Active = { id, name, n, ...(parent ? { parent } : {}), ...(budget !== undefined ? { budget } : {}), spent: 0, controller: new AbortController(), counts: new Map(), children: new Map() };
		this.journal.append({ t: "phase", ev: "enter", id, name, n, at: Date.now(), ...(parent ? { parent: parent.id } : {}), ...(budget !== undefined ? { budget } : {}) });
		this.progress(`phase ${this.path(phase)}`);
		const over = new Promise<never>((_resolve, reject) => phase.controller.signal.addEventListener("abort", () => reject(phase.controller.signal.reason), { once: true }));
		over.catch(() => undefined);
		let status: "done" | "failed" | "over budget" = "done";
		try {
			return await Promise.race([this.storage.run(phase, () => (fn as () => Promise<T>)()), over]);
		} catch (error) {
			status = phase.controller.signal.aborted ? "over budget" : "failed";
			throw error;
		} finally {
			scope.children.set(name, status === "done" ? "done" : "failed");
			this.journal.append({ t: "phase", ev: "exit", id, at: Date.now(), status, cost: phase.spent });
		}
	}

	/** plan.expect(names): the phases expected next in the caller's scope; only for display. */
	expect(names: unknown): void {
		if (!Array.isArray(names) || !names.every((n) => typeof n === "string" && n.trim())) throw new TypeError("plan.expect(names): names must be an array of phase names");
		const phase = this.storage.getStore();
		(phase ?? this.root).plan = [...names];
		this.journal.append({ t: "plan", at: Date.now(), ...(phase ? { phase: phase.id } : {}), expect: [...names] });
	}

	private path(phase: Active): string {
		const names: string[] = [];
		for (let p: Active | undefined = phase; p; p = p.parent) names.unshift(phaseLabel(p.name, p.n));
		return names.join(" › ");
	}

	/** The header a delegate's run gets inside a phase: the phase path and its scope's plan; undefined outside phases. */
	header(): string | undefined {
		const phase = this.storage.getStore();
		if (!phase) return undefined;
		const scope: Scope = phase.parent ?? this.root;
		const planned = scope.plan ?? [];
		const names = [...new Set([...scope.children.keys(), ...planned])];
		const state = (name: string) => {
			const status = scope.children.get(name);
			return status === "done" ? `${name} ✓` : status === "running" ? `${name} (running)` : status === "failed" ? `${name} (failed)` : `${name} (expected)`;
		};
		const plan = planned.length || names.length > 1 ? ` | plan: ${names.map(state).join(" · ")}` : "";
		return `[workflow phase: ${this.path(phase)}${plan}]`;
	}
}
