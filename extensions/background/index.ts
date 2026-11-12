// Background-work guard: a run must not end while processes its bash commands started keep running.
//
// The most repeated correction in the user's sessions (docs/research/context-engineering/07, §10:
// 22 sessions over 10 days) is an agent ending its turn "waiting" on a background job: nothing
// wakes it when the job finishes, so the result reaches no one. Instructions alone did not stop it.
//
// Pi runs every bash command as the leader of its own process group (detached spawn), and the
// shell's background jobs (`cmd &`, `nohup cmd &`) stay in that group after the shell exits. So
// before each bash call this extension prefixes the command with a line that writes the shell's
// `$$` (its pid, the group id) to a file; the transcript keeps the original command (Pi hands
// tool_call handlers a copy). When the run is about to settle, it lists the live processes in the
// recorded groups with one `ps`. If there are any, it appends a message naming them and asks for
// one more turn: wait for them in the foreground and finish, stop them, or say why they keep
// running. Each set of processes is reported once, so the agent can still end its turn on purpose.
// A process that leaves its group (`setsid`, a daemonizing server) is not seen.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";

export const MESSAGE_TYPE = "background-work";

export interface BackgroundProcess {
	pid: number;
	pgid: number;
	/** `ps` elapsed time, `[[dd-]hh:]mm:ss`. */
	elapsed: string;
	command: string;
}

/** The line put before a bash command: the shell's pid (its process group) into `file`. */
export const recordLine = (file: string) => `printf '%s' "$$" > '${file.replaceAll("'", "'\\''")}' 2>/dev/null\n`;

/** Live processes (zombies excluded) of `ps -A -o pid=,pgid=,stat=,etime=,command=` output in the given groups. */
export function processesInGroups(ps: string, groups: ReadonlySet<number>): BackgroundProcess[] {
	const found: BackgroundProcess[] = [];
	for (const line of ps.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
		if (!match) continue;
		const [, pid, pgid, stat, elapsed, command] = match;
		if (!groups.has(Number(pgid)) || stat!.startsWith("Z")) continue;
		found.push({ pid: Number(pid), pgid: Number(pgid), elapsed: elapsed!, command: command!.trim() });
	}
	return found;
}

const clip = (text: string, max: number) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The message for processes still running, grouped by the bash command that started them. */
export function backgroundMessage(processes: readonly BackgroundProcess[], commandOf: (pgid: number) => string | undefined): string {
	const groups = new Map<number, BackgroundProcess[]>();
	for (const p of processes) groups.set(p.pgid, [...(groups.get(p.pgid) ?? []), p]);
	const lines = [...groups].flatMap(([pgid, list]) => {
		const started = commandOf(pgid);
		return [
			started ? `- from your bash command \`${clip(started, 160)}\`:` : `- process group ${pgid}:`,
			...list.map((p) => `  - pid ${p.pid}, running ${p.elapsed}: \`${clip(p.command, 160)}\``),
		];
	});
	return [
		"Your run is about to end, but processes your bash commands started are still running in the background:",
		...lines,
		"Nothing wakes you when they finish: after this turn ends, their results reach no one. If the task needs them, do the remaining work that does not depend on them, then wait for them in the foreground (poll with a bounded timeout) and finish the task. If they are not needed, stop them. If they should keep running after your turn (for example a server the user asked for), say so in your reply.",
	].join("\n");
}

/**
 * The live processes of the groups recorded in `dir`, each with its group file (named after the
 * bash call). Files of groups without live processes are removed, so a reused pid is never
 * mistaken for one; unreadable files too.
 */
export function scanGroups(dir: string, ps: () => string): { running: BackgroundProcess[]; fileOf: Map<number, string> } {
	const fileOf = new Map<number, string>();
	let files: string[] = [];
	try {
		files = readdirSync(dir);
	} catch {
		// No bash call recorded a group yet.
	}
	for (const file of files) {
		const pgid = Number(readFileSync(join(dir, file), "utf8"));
		if (Number.isInteger(pgid) && pgid > 0) fileOf.set(pgid, file);
		else rmSync(join(dir, file), { force: true });
	}
	if (fileOf.size === 0) return { running: [], fileOf };
	const running = processesInGroups(ps(), new Set(fileOf.keys()));
	const live = new Set(running.map((p) => p.pgid));
	for (const [pgid, file] of fileOf) if (!live.has(pgid)) rmSync(join(dir, file), { force: true });
	return { running, fileOf };
}

/** Per process, across reloads (module state is new after each): bash commands by call, and reported process sets, per session. */
const state = globalThis as { __harnessBackground?: Map<string, { commands: Map<string, string>; reported: Set<string> }> };

export interface BackgroundOptions {
	/** Directory for the group files; default a per-process directory in the system temp dir. */
	dir?: string;
	/** `ps -A -o pid=,pgid=,stat=,etime=,command=`. */
	ps?: () => string;
}

export default function background(pi: ExtensionAPI, options: BackgroundOptions = {}) {
	if (process.platform === "win32") return;
	const root = options.dir ?? join(tmpdir(), "pi-harness-background", String(process.pid));
	const ps = options.ps ?? (() => execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat=,etime=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
	const sessions = (state.__harnessBackground ??= new Map());
	const sessionState = (id: string) => sessions.get(id) ?? sessions.set(id, { commands: new Map(), reported: new Set() }).get(id)!;
	const sessionDir = (id: string) => join(root, encodeURIComponent(id));

	pi.on("tool_call", (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const id = ctx.sessionManager.getSessionId();
		const dir = sessionDir(id);
		mkdirSync(dir, { recursive: true });
		sessionState(id).commands.set(event.toolCallId, event.input.command);
		event.input.command = recordLine(join(dir, encodeURIComponent(event.toolCallId))) + event.input.command;
	});

	pi.on("agent_before_settle", (event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		const { running, fileOf } = scanGroups(sessionDir(id), ps);
		if (running.length === 0) return;
		const { commands, reported } = sessionState(id);
		const key = running
			.map((p) => p.pid)
			.sort((a, b) => a - b)
			.join(",");
		if (reported.has(key)) return;
		reported.add(key);
		const callOf = (pgid: number) => {
			const file = fileOf.get(pgid);
			return file === undefined ? undefined : commands.get(decodeURIComponent(file));
		};
		const content = backgroundMessage(running, callOf);
		return { entries: [...event.entries, { type: "custom_message", customType: MESSAGE_TYPE, content, display: true }], continue: true };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		sessions.delete(id);
		rmSync(sessionDir(id), { recursive: true, force: true });
	});
}
