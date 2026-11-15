// Background work as items: what keeps the session "waiting", one item per job, the same list for
// the host (`pi.setBackgroundWork`: t3 lists each as a pending background task) and for /jobs.
//
// t3 showed "Waiting · Pi background work" with one opaque entry, since Pi reported only a count;
// that hid a git fsmonitor daemon and a wait loop on a dead run that kept a coordinator waiting for
// hours (2026-11-14). Now each job is an item with what a person needs to judge it: what it runs,
// since when, its process or group, its log, its live view.
//
// Kinds:
// - `call`: a tool call of the model that moved to the background (index.ts), any tool. A bash
//   call carries its command and process group; a workflow call carries its run's live view.
// - `tool`: a `tool … &` command a bash call left running (../bash/bridge.ts).
// - `process`: an `&` job a bash call left running (../bash/leftovers.ts).
// - `workflow`: a workflow run no background call of the model runs (`tool workflow … &`, a call
//   still in its first seconds in the foreground).
//
// Processes programs left (named, not tracked: a daemon such as git's fsmonitor) are no items:
// nothing waits for them. /jobs lists them apart.
//
// A delegated child that submitted its run's result releases its jobs (`releaseWork`): every item
// says `awaited: false`, so t3 delivers the result to the parent at once instead of after the last
// job ends (a 3-hour Miri run held one for hours, 2026-11-15). The jobs still wake the child.

import type { BackgroundWorkItem } from "@earendil-works/pi-coding-agent";
import type { Leftover, Named } from "../bash/leftovers.ts";
import { defaultPs, type Ps, parseTable, signal, TABLE_ARGS, treeOf } from "../lib/ps.ts";
import { argsText, clip, type Job, minutes, type Run, type SessionJobs } from "./jobs.ts";

export const BACKGROUND_WORK_KEY = "background-jobs";
/** Longest label, in characters. */
const LABEL_MAX = 100;

/** An item and how to stop it: resolves to what was stopped, throws when it cannot. */
export interface WorkItem extends BackgroundWorkItem {
	stop: () => Promise<string>;
}

/** The reason a call stopped with /jobs stop has: its end message names it. */
export const STOPPED = "stopped by the user with /jobs stop";

function callItem(job: Job, run: Run | undefined): WorkItem {
	const command = job.toolName === "bash" && typeof job.input.command === "string" ? job.input.command : undefined;
	const label = run ? `workflow: ${run.name} run ${run.id}` : `${job.toolName}: ${clip(argsText(job.input), LABEL_MAX)}`;
	return {
		id: job.callId,
		kind: "call",
		label,
		...(command === undefined ? {} : { command }),
		startedAt: job.startedAt,
		...(job.pgid === undefined ? {} : { processGroup: job.pgid }),
		logPath: job.log,
		...(run ? { url: run.url } : {}),
		toolCallId: job.callId,
		stop: async () => {
			if (run) return run.stop();
			const killed = job.pgid !== undefined && signal(-job.pgid);
			job.controller.abort(new Error(STOPPED));
			return `Stopped ${label}: ${killed ? `killed process group ${job.pgid} and ` : ""}aborted its call ${job.callId}.`;
		},
	};
}

function leftoverItem(leftover: Leftover, ps: Ps): WorkItem {
	const kind = leftover.tool ? "tool" : "process";
	const label = leftover.tool ? clip(leftover.command, LABEL_MAX) : `process: ${clip(leftover.command, LABEL_MAX)}`;
	return {
		id: `${kind}-${leftover.pid}`,
		kind,
		label,
		command: leftover.command,
		startedAt: leftover.adoptedAt,
		pid: leftover.pid,
		processGroup: leftover.pgid,
		...(leftover.callId === undefined ? {} : { toolCallId: leftover.callId }),
		// Its process and what it started, not the whole group: the command that left it may have left other jobs in it.
		stop: async () => {
			const rows = parseTable(await ps(TABLE_ARGS));
			if (!rows.some((row) => row.pid === leftover.pid && row.pgid === leftover.pgid)) throw new Error(`${label} (pid ${leftover.pid}) has ended already.`);
			const tree = treeOf(rows, leftover.pid).filter((pid) => signal(pid));
			const below = tree.length - 1;
			return `Stopped ${label}: sent SIGTERM to pid ${leftover.pid}${below > 0 ? ` and ${below} process${below === 1 ? "" : "es"} it started` : ""}. Its end reaches the agent as a message.`;
		},
	};
}

const runItem = (run: Run): WorkItem => ({
	id: `workflow-${run.id}`,
	kind: "workflow",
	label: `workflow: ${run.name} run ${run.id}`,
	startedAt: run.startedAt,
	url: run.url,
	toolCallId: run.callId,
	stop: run.stop,
});

/** The session's background work, oldest first; `ps` serves the stops of processes. */
export function workItems(jobs: SessionJobs, ps: Ps = defaultPs): WorkItem[] {
	const runs = [...jobs.runs.values()];
	const calls = [...jobs.jobs.values()].map((job) => ({ job, run: runs.find((run) => run.callId === job.callId) }));
	const merged = new Set(calls.flatMap(({ run }) => (run ? [run.id] : [])));
	return [
		...calls.map(({ job, run }) => callItem(job, run)),
		...[...jobs.leftovers.values()].map((leftover) => leftoverItem(leftover, ps)),
		...runs.filter((run) => !merged.has(run.id)).map(runItem),
	].sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Report the session's background work to the host. Never throws: it also runs outside any call,
 * where a throw would be an unhandled rejection in Pi's process (the API is stale once the session
 * ended).
 */
export function reportWork(jobs: SessionJobs): void {
	const api = jobs.api;
	if (!api) return;
	const items = workItems(jobs).map(({ stop: _, ...item }) => (jobs.released ? { ...item, awaited: false } : item));
	try {
		api.setBackgroundWork(BACKGROUND_WORK_KEY, items);
	} catch (error) {
		// A Pi process started before items existed (a harness release reloads extensions into running
		// Pi builds) takes a count only, and refuses anything else with exactly this message.
		if (!(error instanceof Error && error.message === `Invalid background work: ${items}`)) return void console.error("[background] cannot report background work:", error);
		try {
			// SAFETY: this Pi build's setBackgroundWork takes (key, count), as the refusal above shows.
			(api.setBackgroundWork as unknown as (key: string, pending: number) => void)(BACKGROUND_WORK_KEY, items.length);
		} catch (fallback) {
			console.error("[background] cannot report background work:", fallback);
		}
	}
}

/**
 * Whether the session's result waits for its jobs (`released`: it does not), reported at once when
 * it changes: every item then says `awaited: false`, and t3 no longer holds a delegated child's
 * result for them.
 */
export function releaseWork(jobs: SessionJobs, released: boolean): void {
	if (jobs.released === released) return;
	jobs.released = released;
	reportWork(jobs);
}

/** The named processes still running (the others are forgotten); `ps` lists the live ones. */
export async function liveNamed(jobs: SessionJobs, ps: Ps = defaultPs): Promise<Named[]> {
	if (jobs.named.size === 0) return [];
	const live = new Set(parseTable(await ps(TABLE_ARGS)).map((row) => `${row.pid}:${row.pgid}`));
	for (const key of jobs.named.keys()) if (!live.has(key)) jobs.named.delete(key);
	return [...jobs.named.values()];
}

/** An item's details after its label: how long it runs, its process, log and live view. */
export function itemDetails(item: BackgroundWorkItem, now: number): string[] {
	const process = item.pid !== undefined ? `pid ${item.pid}${item.processGroup === undefined ? "" : ` (group ${item.processGroup})`}` : item.processGroup !== undefined ? `process group ${item.processGroup}` : undefined;
	return [minutes(now - item.startedAt), ...(process ? [process] : []), ...(item.logPath ? [`log ${item.logPath}`] : []), ...(item.url ? [item.url] : [])];
}

/** /jobs: the numbered items, then the processes programs left running. */
export function jobsText(items: readonly BackgroundWorkItem[], named: readonly Named[], now: number): string {
	const lines = items.length
		? [`Background work of this session (${items.length}):`, ...items.map((item, i) => `${i + 1}. ${item.label} · ${itemDetails(item, now).join(" · ")}`), "Stop one with /jobs stop <number>."]
		: ["No background work in this session."];
	if (named.length) {
		lines.push(
			"",
			"Left running by programs, not tracked (nothing waits for them; stop one with `kill <pid>`):",
			...named.map((p) => `- pid ${p.pid} (group ${p.pgid}): ${clip(p.command, LABEL_MAX)} · ${minutes(now - p.namedAt)} · left by \`${clip(p.startedBy, 60)}\``),
		);
	}
	return lines.join("\n");
}

/** `/jobs stop <which>`: the item by its number in the list (or its id); resolves to what was stopped. */
export async function stopItem(items: readonly WorkItem[], which: string): Promise<string> {
	const index = /^\d+$/.test(which) ? Number(which) - 1 : items.findIndex((item) => item.id === which);
	const item = items[index];
	if (!item) throw new Error(items.length ? `No background item ${which}: /jobs lists ${items.length === 1 ? "1 item" : `items 1 to ${items.length}`}.` : "No background work in this session.");
	return item.stop();
}
