// `ps`, asked only for what is needed: every process with numbers only (pid, parent, group, state),
// and command lines only for chosen pids. Command lines run to hundreds of kilobytes each (test
// runners, browsers), so listing them all exceeded child_process's output limit when many
// processes ran (ENOBUFS).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

/** `pid` and every live process below it, parents first. */
export function treeOf(rows: readonly PsRow[], pid: number): number[] {
	const tree = [pid];
	for (let i = 0; i < tree.length; i++) for (const row of rows) if (row.ppid === tree[i] && !tree.includes(row.pid)) tree.push(row.pid);
	return tree;
}

/** Send `signal` to `pid` (a negative one: its group); whether it was there to get it. */
export function signal(pid: number, name: NodeJS.Signals | 0 = "SIGTERM"): boolean {
	try {
		process.kill(pid, name);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
