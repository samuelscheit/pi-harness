// Stopping a workflow run on purpose (`workflow { stop }`), from any session or process.
//
// The stop is a request file in the run's directory (`stop.json`); the process that holds the
// run's lock polls for it (`watchStop`) and aborts the run with `WorkflowStopped`. The run then
// ends as `stopped`, resumable. By default its agent runs keep going ("lingering"): the process
// keeps the run's lock and journal until they end, records their outcomes, and hands them to a
// resume in the same process (`takeLingering`), which adopts them. With `children` (stopChildren)
// they are cancelled, also later for a stopped run whose agents still linger.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "../lib/lock.ts";
import type { Work } from "./durable.ts";
import { runDir, runState } from "./journal.ts";

export const STOP_FILE = "stop.json";
const POLL_MS = 200;
/** How long `workflow { stop }` waits for the run to end. */
const STOP_WAIT_MS = 30_000;

export interface StopRequest {
	children: boolean;
}

const stopPath = (dir: string) => join(dir, STOP_FILE);
export const lockPath = (dir: string) => join(dir, "lock");

/** Whether a process holds the run's lock (it runs now, or waits for agents a stop left running). */
export function lockHeld(agentDir: string, id: string): boolean {
	const unlock = acquireLock(lockPath(runDir(agentDir, id)));
	unlock?.();
	return unlock === undefined;
}

/** A request no one took (the run ended first) must not stop a later execution. */
export function clearStopRequest(dir: string): void {
	rmSync(stopPath(dir), { force: true });
}

/** Call `onStop` for each stop request of the run in `dir`, until closed. */
export function watchStop(dir: string, onStop: (request: StopRequest) => void): { close: () => void } {
	const timer = setInterval(() => {
		if (!existsSync(stopPath(dir))) return;
		let request: StopRequest = { children: false };
		try {
			request = { children: (JSON.parse(readFileSync(stopPath(dir), "utf8")) as Partial<StopRequest>).children === true };
		} catch {
			// Half written: a plain stop.
		}
		clearStopRequest(dir);
		onStop(request);
	}, POLL_MS);
	timer.unref();
	return { close: () => clearInterval(timer) };
}

// ---- agents a stop left running ------------------------------------------------------------------

interface Lingering {
	works: Map<string, Work>;
	unlock: () => void;
	watch: { close: () => void };
}

// Process state: it outlives the extension instance (a harness reload) the run started in.
const state = globalThis as { __harnessWorkflowLingering?: Map<string, Lingering> };
const lingering = () => (state.__harnessWorkflowLingering ??= new Map());

/**
 * A stopped run's work goes on: hold the run's lock until it settled, cancel it on a stop request
 * with children, and run `settled` (close the journal, dispose the agents) once it settled.
 */
export function linger(dir: string, id: string, works: Map<string, Work>, unlock: () => void, settled: () => void): void {
	const watch = watchStop(dir, (request) => {
		if (request.children) for (const work of works.values()) work.cancel(new Error("stopped on request, with its agents"));
	});
	const entry: Lingering = { works, unlock, watch };
	lingering().set(id, entry);
	void Promise.all([...works.values()].map((work) => work.settled)).then(() => {
		settled();
		if (lingering().get(id) !== entry) return;
		lingering().delete(id);
		watch.close();
		unlock();
	});
}

/** A resume in this process takes over a stopped run's lock and its running work. */
export function takeLingering(id: string): { works: Map<string, Work>; unlock: () => void } | undefined {
	const entry = lingering().get(id);
	if (!entry) return undefined;
	lingering().delete(id);
	entry.watch.close();
	return { works: entry.works, unlock: entry.unlock };
}

// ---- workflow { stop } ---------------------------------------------------------------------------

const resumeHint = (id: string) => `Continue it with workflow { resume: "${id}" }, or with changed code: workflow { resume: "${id}", code: "…" }.`;

async function until(ok: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > deadline) return false;
		await new Promise((r) => setTimeout(r, 50));
	}
	return true;
}

/** Stop a running run (or cancel the agents a stopped one left running); resolves to the tool's text, throws when there is nothing to stop. */
export async function stopRun(agentDir: string, id: string, children: boolean, waitMs = STOP_WAIT_MS): Promise<string> {
	const { end } = runState(agentDir, id);
	const held = lockHeld(agentDir, id);
	const dir = runDir(agentDir, id);
	const request = () => writeFileSync(stopPath(dir), JSON.stringify({ children } satisfies StopRequest));
	if (end?.status === "stopped") {
		if (!held || !children) throw new Error(`workflow run ${id} is stopped already${held ? "; its agents still run: pass stopChildren: true to cancel them" : ""}. ${resumeHint(id)}`);
		request();
		if (!(await until(() => !lockHeld(agentDir, id), waitMs))) return `Asked workflow run ${id} to cancel its agents; they did not end within ${waitMs / 1000} s.`;
		return `Cancelled the agents of stopped workflow run ${id}. ${resumeHint(id)}`;
	}
	if (end) throw new Error(`workflow run ${id} already ended (${end.status}); there is nothing to stop.`);
	if (!held) throw new Error(`workflow run ${id} is not running: its process ended. Resume it with workflow { resume: "${id}" }, or leave it.`);
	request();
	if (!(await until(() => runState(agentDir, id).end !== undefined, waitMs))) return `Asked workflow run ${id} to stop; it did not end within ${waitMs / 1000} s.`;
	return `Stopped workflow run ${id}${children ? " and cancelled its agents" : ""}; its result arrives as a message. ${resumeHint(id)}`;
}
