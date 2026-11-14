// Leftovers: processes a bash command leaves running are tracked, and each one's end wakes the agent.
//
// An agent "waiting" on a background job with nothing to wake it was the user's most repeated
// correction (docs/research/context-engineering/07, §10: 22 sessions in 10 days). Refusing `&`
// (2026-11-14, for a few hours) made scripting stiff: a server started for a test, or two jobs
// started and left to run, are ordinary shell. So `&`, `nohup` and `disown` run, and the tool
// adopts what they leave behind.
//
// Pi runs each bash command as the leader of its own process group, and index.ts records the
// group of every call. When a call ends, `ps` lists the live processes of its group whose
// parent is no longer in the group: the jobs the command's shell started and left (their own
// children are part of them). Each is adopted with the command that started it and listed in the
// call's result. A poll per session checks them each second; when one has ended, a message names
// it and wakes the session (as a background call's end does, ../background). Children it left in turn
// are adopted then. A process outside the group (`setsid`, a daemon that forks into its own
// session) is not seen: `setsid` is refused (detach.ts).
//
// `ps` lists every process with numbers only (pid, parent, group, state), and command lines only
// for the processes adopted: command lines run to hundreds of kilobytes each (test runners, browsers),
// so listing them all exceeded child_process's output limit when many processes ran (ENOBUFS).
//
// A non-child's exit code is unknown: the message says when it ended, and its output is wherever
// the command redirected it. Leftovers stop with the session (not on a harness reload;
// ../background/index.ts).
//
// A `tool` command left running is a leftover too (counted, stopped with the session), but the
// bridge serving its call reports its end, with its exit code and result (bridge.ts). One rule
// keeps every end reported once: whoever removes a leftover from the map reports it, the sweep
// here when the process is gone, the bridge (`release`) when the call answers or its client dies.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { clip, minutes, reportWork, type SessionJobs, wake } from "../background/jobs.ts";

/** One live process: its pid, parent and group. */
export interface PsRow {
	pid: number;
	ppid: number;
	pgid: number;
}

/** Runs `ps` with `args`, resolving to its output. */
export type Ps = (args: readonly string[]) => Promise<string>;

/** Every process, numbers only: some 25 bytes a process. */
export const TABLE_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,stat="];
/** The command lines of `pids`. */
export const commandArgs = (pids: readonly number[]) => ["-o", "pid=,command=", "-p", pids.join(",")];

/** The live processes (zombies excluded) in `ps` output with {@link TABLE_ARGS}. */
export function parseTable(ps: string): PsRow[] {
	const rows: PsRow[] = [];
	for (const line of ps.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
		if (!match || match[4]!.startsWith("Z")) continue;
		rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) });
	}
	return rows;
}

/** Command line by pid in `ps` output with {@link commandArgs}. */
export function parseCommands(ps: string): Map<number, string> {
	const commands = new Map<number, string>();
	for (const line of ps.split("\n")) {
		const match = /^\s*(\d+)\s(.*)$/.exec(line);
		if (match) commands.set(Number(match[1]), match[2]!.trim());
	}
	return commands;
}

/** The command lines of `pids`; a process that exited meanwhile has none. */
export async function commandsOf(ps: Ps, pids: readonly number[]): Promise<Map<number, string>> {
	return pids.length === 0 ? new Map() : parseCommands(await ps(commandArgs(pids)));
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
	/** A `tool` command: the bridge reports its end with its exit code and result. */
	tool?: boolean;
}

const list = (processes: readonly Pick<Leftover, "pid" | "command">[]) => processes.map((p) => `- pid ${p.pid}: \`${clip(p.command, 160)}\``);

/** The note a call's result gets when the call left processes running. */
export function leftText(processes: readonly Leftover[]): string {
	const tools = processes.some((p) => p.tool) ? " (a `tool` command's with its exit code and result)" : "";
	return [
		`Still running in the background, left by this command (${processes.length === 1 ? "1 process" : `${processes.length} processes`}):`,
		...list(processes),
		`Each one's end reaches you as a new message${tools}, also after your turn: do not wait or poll for them. Stop one with \`kill <pid>\`. They stop when the session ends.`,
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

/** The roots of groups `pgids` not tracked yet: the processes {@link adopt} needs the command lines of. */
export const untrackedRoots = (leftovers: Leftovers, rows: readonly PsRow[], pgids: readonly number[]): number[] =>
	[...new Set(pgids)].flatMap((pgid) => rootsOf(rows, pgid).filter((row) => !leftovers.has(row.pid)).map((row) => row.pid));

/**
 * Adopt the jobs left in group `pgid` (those not tracked yet) by `startedBy`; returns the new ones.
 * `commands` has the command lines of {@link untrackedRoots}; a root without one has exited since.
 */
export function adopt(leftovers: Leftovers, rows: readonly PsRow[], pgid: number, startedBy: string, now: number, commands: ReadonlyMap<number, string>): Leftover[] {
	const adopted: Leftover[] = [];
	for (const row of rootsOf(rows, pgid)) {
		const command = commands.get(row.pid);
		if (leftovers.has(row.pid) || command === undefined) continue;
		const leftover = { pid: row.pid, pgid, command, startedBy, adoptedAt: now };
		leftovers.set(row.pid, leftover);
		adopted.push(leftover);
	}
	return adopted;
}

/** The leftovers that ended: no live process has their pid in their group (a reused pid elsewhere does not count). */
export function endedOf(leftovers: Leftovers, rows: readonly PsRow[]): Leftover[] {
	const live = new Set(rows.map((r) => `${r.pid}:${r.pgid}`));
	return [...leftovers.values()].filter((l) => !live.has(`${l.pid}:${l.pgid}`));
}

/**
 * The leftovers that ended, each with the processes it left (adopted here, with their command lines
 * in `commands`: those of {@link untrackedRoots} of the ended ones' groups).
 */
export function sweep(leftovers: Leftovers, rows: readonly PsRow[], now: number, commands: ReadonlyMap<number, string>): { ended: Leftover; orphans: Leftover[] }[] {
	const ended = endedOf(leftovers, rows);
	for (const l of ended) leftovers.delete(l.pid);
	return ended.map((l) => ({ ended: l, orphans: adopt(leftovers, rows, l.pgid, l.startedBy, now, commands) }));
}

const execFileAsync = promisify(execFile);
/**
 * `ps` itself. It exits 1 when a pid of `-p` is unknown and still lists the others. The listing
 * stays small (see the top), the limit only guards against a runaway output.
 */
export const defaultPs: Ps = async (args) => {
	try {
		return (await execFileAsync("ps", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout;
	} catch (error) {
		const e = error as { code?: unknown; stdout?: string };
		if (e.code === 1 && typeof e.stdout === "string") return e.stdout;
		throw error;
	}
};

/** The live processes, and the command lines of the untracked roots of `pgids` (of those `pgids` returns given the rows). */
async function snapshot(ps: Ps, leftovers: Leftovers, pgids: (rows: readonly PsRow[]) => number[]) {
	const rows = parseTable(await ps(TABLE_ARGS));
	return { rows, commands: await commandsOf(ps, untrackedRoots(leftovers, rows, pgids(rows))) };
}

const stopPollWhenEmpty = (jobs: SessionJobs) => {
	if (jobs.leftovers.size > 0) return;
	clearInterval(jobs.poll);
	jobs.poll = undefined;
};

/**
 * Take leftover `pid` of group `pgid` out of tracking, so the caller reports its end; whether it
 * was tracked (else its end is reported already, or it is no leftover).
 */
export function release(jobs: SessionJobs, pid: number, pgid: number): boolean {
	if (jobs.leftovers.get(pid)?.pgid !== pgid) return false;
	jobs.leftovers.delete(pid);
	stopPollWhenEmpty(jobs);
	reportWork(jobs);
	return true;
}

/** One check of the session's leftovers: each one that ended wakes the session with its own message. */
async function checkLeftovers(jobs: SessionJobs, ps: Ps): Promise<void> {
	const { rows, commands } = await snapshot(ps, jobs.leftovers, (rows) => endedOf(jobs.leftovers, rows).map((l) => l.pgid));
	const ended = sweep(jobs.leftovers, rows, Date.now(), commands);
	if (ended.length === 0) return;
	stopPollWhenEmpty(jobs);
	reportWork(jobs);
	for (const { ended: leftover, orphans } of ended) wake(jobs, endedText(leftover, orphans, Date.now()), `the end of pid ${leftover.pid}`);
}

/** Adopt what a call left running in group `pgid`, and check the session's leftovers while there are any. */
export async function adoptLeftovers(jobs: SessionJobs, pgid: number, command: string, ps: Ps, pollMs: number): Promise<Leftover[]> {
	const { rows, commands } = await snapshot(ps, jobs.leftovers, () => [pgid]);
	const adopted = adopt(jobs.leftovers, rows, pgid, command, Date.now(), commands);
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
