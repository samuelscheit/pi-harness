// Leftovers: processes a bash command leaves running are tracked, and each one's end wakes the agent.
//
// An agent "waiting" on a background job with nothing to wake it was the user's most repeated
// correction (docs/research/context-engineering/07, §10: 22 sessions in 10 days). Refusing `&`
// (2026-11-14, for a few hours) made scripting stiff: a server started for a test, or two jobs
// started and left to run, are ordinary shell. So `&`, `nohup` and `disown` run, and the tool
// adopts what they leave behind.
//
// Pi runs each bash command as the leader of its own process group, and index.ts records the
// group of every call. When a call ends, one `ps` lists the live processes of its group whose
// parent is no longer in the group: the jobs the command's shell started and left (their own
// children are part of them). Each is adopted with the command that started it and listed in the
// call's result. A poll per session checks them each second; when one has ended, a message names
// it and wakes the session (as a background call's end does, ../background). Children it left in turn
// are adopted then. A process outside the group (`setsid`, a daemon that forks into its own
// session) is not seen: `setsid` is refused (detach.ts).
//
// A non-child's exit code is unknown: the message says when it ended, and its output is wherever
// the command redirected it. Leftovers stop with the session (not on a harness reload;
// ../background/index.ts).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { clip, minutes, reportWork, type SessionJobs, wake } from "../background/jobs.ts";

/** One live process of `ps -A -o pid=,ppid=,pgid=,stat=,etime=,command=`. */
export interface PsRow {
	pid: number;
	ppid: number;
	pgid: number;
	/** `ps` elapsed time, `[[dd-]hh:]mm:ss`. */
	elapsed: string;
	command: string;
}

export const PS_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,stat=,etime=,command="];

/** The live processes (zombies excluded) in `ps` output with {@link PS_ARGS}. */
export function parsePs(ps: string): PsRow[] {
	const rows: PsRow[] = [];
	for (const line of ps.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
		if (!match || match[4]!.startsWith("Z")) continue;
		rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), elapsed: match[5]!, command: match[6]!.trim() });
	}
	return rows;
}

/** The processes of group `pgid` whose parent is not a live process of the group: the jobs left in it. */
export function rootsOf(rows: readonly PsRow[], pgid: number): PsRow[] {
	const group = rows.filter((r) => r.pgid === pgid);
	const pids = new Set(group.map((r) => r.pid));
	return group.filter((r) => !pids.has(r.ppid));
}

export interface Leftover {
	pid: number;
	pgid: number;
	command: string;
	/** The bash command that left it, as the agent wrote it. */
	startedBy: string;
	adoptedAt: number;
}


const list = (processes: readonly Pick<Leftover, "pid" | "command">[]) => processes.map((p) => `- pid ${p.pid}: \`${clip(p.command, 160)}\``);

/** The note a call's result gets when the call left processes running. */
export function leftText(processes: readonly Leftover[]): string {
	return [
		`Still running in the background, left by this command (${processes.length === 1 ? "1 process" : `${processes.length} processes`}):`,
		...list(processes),
		"Each one's end reaches you as a new message, also after your turn: do not wait or poll for them. Stop one with `kill <pid>`. They stop when the session ends.",
	].join("\n");
}

/** The message when a leftover ended; `orphans` are the processes it left running in turn, now tracked too. */
export function endedText(ended: Leftover, orphans: readonly Leftover[], now: number): string {
	return [
		`Background process pid ${ended.pid} \`${clip(ended.command, 160)}\` ended (running at least ${minutes(now - ended.adoptedAt)} since your command \`${clip(ended.startedBy, 160)}\` returned). Its exit code is not known; its output is wherever that command sent it.`,
		...(orphans.length ? ["It left running, now tracked as well:", ...list(orphans)] : []),
	].join("\n");
}

/** A session's leftovers, by pid. */
export type Leftovers = Map<number, Leftover>;

/** Adopt the jobs left in group `pgid` (those not tracked yet) by `startedBy`; returns the new ones. */
export function adopt(leftovers: Leftovers, rows: readonly PsRow[], pgid: number, startedBy: string, now: number): Leftover[] {
	const adopted: Leftover[] = [];
	for (const row of rootsOf(rows, pgid)) {
		if (leftovers.has(row.pid)) continue;
		const leftover = { pid: row.pid, pgid, command: row.command, startedBy, adoptedAt: now };
		leftovers.set(row.pid, leftover);
		adopted.push(leftover);
	}
	return adopted;
}

/**
 * The leftovers that ended, each with the processes it left (adopted here). A process counts as
 * the same while a live process has its pid in its group, so a reused pid elsewhere does not.
 */
export function sweep(leftovers: Leftovers, rows: readonly PsRow[], now: number): { ended: Leftover; orphans: Leftover[] }[] {
	const live = new Set(rows.map((r) => `${r.pid}:${r.pgid}`));
	const ended = [...leftovers.values()].filter((l) => !live.has(`${l.pid}:${l.pgid}`));
	for (const l of ended) leftovers.delete(l.pid);
	return ended.map((l) => ({ ended: l, orphans: adopt(leftovers, rows, l.pgid, l.startedBy, now) }));
}

const execFileAsync = promisify(execFile);
export const defaultPs = async () => (await execFileAsync("ps", PS_ARGS, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout;

/** One check of the session's leftovers: each one that ended wakes the session with its own message. */
async function checkLeftovers(jobs: SessionJobs, ps: () => Promise<string>): Promise<void> {
	const ended = sweep(jobs.leftovers, parsePs(await ps()), Date.now());
	if (ended.length === 0) return;
	if (jobs.leftovers.size === 0) {
		clearInterval(jobs.poll);
		jobs.poll = undefined;
	}
	reportWork(jobs);
	for (const { ended: leftover, orphans } of ended) wake(jobs, endedText(leftover, orphans, Date.now()), `the end of pid ${leftover.pid}`);
}

/** Adopt what a call left running in group `pgid`, and check the session's leftovers while there are any. */
export async function adoptLeftovers(jobs: SessionJobs, pgid: number, command: string, ps: () => Promise<string>, pollMs: number): Promise<Leftover[]> {
	const adopted = adopt(jobs.leftovers, parsePs(await ps()), pgid, command, Date.now());
	if (adopted.length === 0) return adopted;
	if (jobs.poll === undefined) {
		let busy = false;
		jobs.poll = setInterval(() => {
			if (busy) return;
			busy = true;
			checkLeftovers(jobs, ps)
				.catch((error: unknown) => console.error("[background] cannot check leftover processes:", error))
				.finally(() => (busy = false));
		}, pollMs);
		jobs.poll.unref?.();
	}
	reportWork(jobs);
	return adopted;
}
