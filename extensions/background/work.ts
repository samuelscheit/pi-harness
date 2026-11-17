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
//
// A job that ends stays reported until the turn its end message wakes has settled (`wake`,
// `settleWoken`). t3 finalizes a delegated child as soon as its last held item goes: reported gone
// before the woken turn started, the child's previous turn, which only said what it waits for, was
// delivered to the parent as the child's result. Four children of workflow run
// 20261116-174918-b2d928 did so ("Waiting for the e2e regression run (call toolu_…)"), each the
// moment its job ended, and the coordinator sent each one a message to continue.

import type { BackgroundWorkItem } from "@earendil-works/pi-coding-agent";
import type { Leftover, Named } from "../bash/leftovers.ts";
import { defaultPs, type Ps, parseTable, signal, TABLE_ARGS, treeOf } from "../lib/ps.ts";
import { argsText, clip, type EndContent, JOB_MESSAGE_TYPE, type Job, minutes, type Run, type SessionJobs } from "./jobs.ts";

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

/** A leftover's item id: a `tool … &` job's or an `&` process's. */
export const leftoverId = (leftover: Pick<Leftover, "pid" | "tool">) => `${leftover.tool ? "tool" : "process"}-${leftover.pid}`;

function leftoverItem(leftover: Leftover, ps: Ps): WorkItem {
	const label = leftover.tool ? clip(leftover.command, LABEL_MAX) : `process: ${clip(leftover.command, LABEL_MAX)}`;
	return {
		id: leftoverId(leftover),
		kind: leftover.tool ? "tool" : "process",
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
 * Report the session's background work to the host: the running jobs, then the ended ones whose end
 * message is not answered yet. Never throws: it also runs outside any call, where a throw would be
 * an unhandled rejection in Pi's process (the API is stale once the session ended).
 */
export function reportWork(jobs: SessionJobs): void {
	const tracked = workItems(jobs).map(({ stop: _, ...item }): BackgroundWorkItem => item);
	const ids = new Set(tracked.map((item) => item.id));
	// Oldest first; jobs that started together keep their order, so a job that ends changes nothing until its turn settled.
	const before = new Map(jobs.reported.map((item, index) => [item.id, index]));
	const at = (item: BackgroundWorkItem) => before.get(item.id) ?? Number.POSITIVE_INFINITY;
	jobs.reported = [...tracked, ...[...jobs.woken.values()].flatMap(({ item }) => (ids.has(item.id) ? [] : [item]))].sort((a, b) => a.startedAt - b.startedAt || at(a) - at(b));
	const api = jobs.api;
	if (!api) return;
	const items = jobs.reported.map((item) => (jobs.released ? { ...item, awaited: false } : item));
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

/** A job's end: its item's id, its end message, and what it is (for an error). */
export interface JobEnd {
	id: string;
	content: EndContent;
	what: string;
}

/**
 * Wake the session with one message per job that ended; the caller took them out of tracking and
 * did not report that. Each item stays reported, as it was last, until the turn its message wakes
 * has settled (`settleWoken`), so t3 never sees the session without work and without a run in
 * between. Never throws: it runs outside any call.
 */
export function wake(jobs: SessionJobs, ends: readonly JobEnd[]): void {
	const api = jobs.api;
	for (const { id } of ends) {
		const item = jobs.reported.find((reported) => reported.id === id);
		// Without an API (a reload) no message wakes the session: nothing to hold for.
		if (item && api) jobs.woken.set(id, { item, sentAfterRuns: jobs.agentRuns, seen: false });
	}
	reportWork(jobs);
	let lost = false;
	for (const { id, content, what } of ends) {
		try {
			api?.sendMessage({ customType: JOB_MESSAGE_TYPE, content, display: true, details: { workId: id } }, { triggerTurn: true, deliverAs: "steer" });
		} catch (error) {
			lost = jobs.woken.delete(id) || lost;
			console.error(`[background] cannot report ${what}:`, error);
		}
	}
	if (lost) reportWork(jobs);
}

/** The id of the job a message reports the end of, if it is such a message. */
export function endedWorkId(message: { role: string; customType?: string; details?: unknown }): string | undefined {
	if (message.role !== "custom" || message.customType !== JOB_MESSAGE_TYPE) return undefined;
	const id = (message.details as { workId?: unknown } | undefined)?.workId;
	return typeof id === "string" ? id : undefined;
}

/**
 * The session settled: the ended jobs it answered are no longer reported. Answered: its end message
 * entered the conversation, or a run started after the message was sent (a cleared queue dropped
 * it: it never comes). A message sent while the session settles waits for the run it starts.
 */
export function settleWoken(jobs: SessionJobs): void {
	let changed = false;
	for (const [id, woken] of jobs.woken) {
		if (!woken.seen && woken.sentAfterRuns >= jobs.agentRuns) continue;
		jobs.woken.delete(id);
		changed = true;
	}
	if (changed) reportWork(jobs);
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
