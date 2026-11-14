// The harness's bash: nothing a command leaves running goes unreported, and `tool` runs any tool.
//
// The most repeated correction in the user's sessions (docs/research/context-engineering/07, §10:
// 22 sessions over 10 days) was an agent ending its turn "waiting" on a background job: nothing
// woke it when the job finished, so the result reached no one. Instructions alone did not stop it.
// So the tool itself reports every end:
// - a command still running after two minutes, or when the user sends a message, moves to the
//   background, and its end wakes the session with its result: ../background does that for every
//   tool; here a command's process group is added to how to stop it;
// - every process a command leaves running (`cmd &`, a script's server) is tracked, and each one's
//   end wakes the session (leftovers.ts); a `tool` command left running (`tool workflow … &`)
//   keeps its call, and its end brings its exit code and result (bridge.ts);
// - `setsid`, which would move a job out of reach, is refused (detach.ts).
//
// Agents share checkouts, so commands that throw away other agents' uncommitted work are refused
// too (git.ts: `git stash`, `git reset --hard`, `git clean -f`, whole-tree discards), and so is a
// commit that takes changes the session's edit and write tools did not make (commit.ts).
//
// Both rely on the process group: Pi runs every bash command as the leader of its own group
// (detached spawn), and what the command starts stays in it. Before each bash call this extension
// prefixes the command with lines that write the shell's `$$` (its pid, the group id) to a file
// named after the call, and the shell's jobs (`jobs -l`: every `&` job, each process of a
// pipeline) to `<file>.jobs` when the shell exits and before a `disown`. A command's own EXIT trap
// runs as well (`trap` is wrapped to chain it, with the exit status in `$?`). The transcript keeps
// the original command (Pi hands tool_call handlers a copy).

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition, type ExtensionAPI, type ExtensionToolContext, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_GUIDELINE, DETACH_AFTER_MS } from "../background/index.ts";
import { sessionJobs, setProcessGroupOf } from "../background/jobs.ts";
import { shellQuote as quote } from "../lib/process.ts";
import { clientCommand, openBridge, TOOL_GUIDELINE, toolBinDir, withImages } from "./bridge.ts";
import { changeEnds, changeStarts, commitRefusal, dropSessionFiles, sessionFiles, toolPath } from "./commit.ts";
import { refusal, setsidCommands, systemGuideline } from "./detach.ts";
import { gitRefusal } from "./git.ts";
import { defaultPs, type Ps } from "../lib/ps.ts";
import { adoptLeftovers, leftText, type Untracked, untrackedText } from "./leftovers.ts";

/** The file the shell's jobs are written to, next to the group file. */
export const jobsFile = (file: string) => `${file}.jobs`;

/**
 * The lines put before a bash command: the shell's pid (its process group) into `file`, and its jobs
 * into {@link jobsFile} on exit and before `disown` (which drops jobs from the table). `trap … EXIT`
 * in the command sets the handler run after the jobs are written, with the exit status as `$?`
 * (`&& :` keeps `set -e` from ending the handler there).
 */
export const recordLine = (file: string) =>
	[
		`printf '%s' "$$" > ${quote(file)} 2>/dev/null`,
		`__pi_jobs() { jobs -l >> ${quote(jobsFile(file))} 2>/dev/null; }`,
		'__pi_status() { return "$1"; }',
		"__pi_exit_trap=",
		'__pi_exit() { local status=$?; __pi_jobs; __pi_status "$status" && :; eval "$__pi_exit_trap"; }',
		"builtin trap __pi_exit EXIT",
		"trap() {",
		"\tcase \"${1-}\" in -l | -p | '') builtin trap \"$@\"; return ;; --) shift ;; esac",
		'\tif [ "$#" -lt 2 ]; then case "${1-}" in EXIT | exit | 0 | SIGEXIT) __pi_exit_trap= ;; *) builtin trap "$@" ;; esac; return; fi',
		"\tlocal action=$1 signal status=0",
		"\tshift",
		'\tfor signal; do case "$signal" in EXIT | exit | 0 | SIGEXIT) if [ "$action" = - ]; then __pi_exit_trap=; else __pi_exit_trap=$action; fi ;; *) builtin trap -- "$action" "$signal" || status=$? ;; esac; done',
		'\treturn "$status"',
		"}",
		'disown() { __pi_jobs; builtin disown "$@"; }',
		"",
	].join("\n");

/** The pids of the jobs a jobs file lists (`jobs -l`), or undefined without one (the shell never wrote it: `exec`). */
export function readJobs(file: string): Set<number> | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const pids = new Set<number>();
	for (const line of text.split("\n")) {
		const match = /^(?:\[\d+\][+-]?)?\s*(\d+)\s/.exec(line);
		if (match) pids.add(Number(match[1]));
	}
	return pids;
}

/** The process group a group file holds, if any. */
export function readGroup(file: string): number | undefined {
	try {
		const pgid = Number(readFileSync(file, "utf8"));
		return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
	} catch {
		return undefined;
	}
}

/** How often processes calls left running are checked. */
const POLL_MS = 1000;

/** What the tool refuses to run, for its description. */
const REFUSED = "Refused before they run: `setsid`, `git stash` (except `list`/`show`), `git reset --hard`, `git clean -f`, whole-tree discards (`git checkout -- .`, `git restore .`), and a `git commit` of changes your edit and write tools did not make.";
/** How to work beside other agents, for the tool's guidelines. */
const SHARED_CHECKOUT_GUIDELINE =
	"Other agents may work in the same checkout or worktrees of the same repository, so `git stash` (except `list`/`show`), `git reset --hard`, `git clean -f` and whole-tree discards (`git checkout -- .`, `git restore .`) are refused: for a clean state use `git worktree add /tmp/<name> HEAD`, and restore or commit only your own paths. A `git commit` that would take changes your edit and write tools did not make is refused with the paths; after `git diff` shows they are yours, run it as `PI_COMMIT_CHECKED=1 git commit …`.";

export interface BashOptions {
	/** Directory for the group files; default a per-process directory in the system temp dir. */
	dir?: string;
	/** The background limit the guideline names (../background applies it). */
	detachAfterMs?: number;
	/** How often processes calls left running are checked. */
	pollMs?: number;
	/** `ps` (leftovers.ts). */
	ps?: Ps;
}

export default function bash(pi: ExtensionAPI, options: BashOptions = {}) {
	if (process.platform === "win32") return;
	const root = options.dir ?? join(tmpdir(), "pi-harness-background", String(process.pid));
	const sessionDir = (id: string) => join(root, encodeURIComponent(id));
	const groupFile = (id: string, callId: string) => join(sessionDir(id), encodeURIComponent(callId));
	const ps = options.ps ?? defaultPs;
	const pollMs = options.pollMs ?? POLL_MS;
	const builtin = createBashToolDefinition(process.cwd());
	const binDir = toolBinDir();

	setProcessGroupOf("bash", (sessionId, callId) => readGroup(groupFile(sessionId, callId)));

	// The session's edits and writes, for the commit check (commit.ts).
	const FILE_TOOLS = new Set(["edit", "write"]);
	pi.on("tool_call", (event, ctx) => {
		const path = FILE_TOOLS.has(event.toolName) ? (event.input as { path?: unknown }).path : undefined;
		if (typeof path === "string") changeStarts(sessionFiles(ctx.sessionManager.getSessionId()), event.toolCallId, toolPath(path, ctx.cwd));
	});
	pi.on("tool_result", (event, ctx) => {
		if (FILE_TOOLS.has(event.toolName)) changeEnds(sessionFiles(ctx.sessionManager.getSessionId()), event.toolCallId, event.isError);
	});

	// A command using `setsid`, discarding uncommitted work (git.ts) or committing changes that are
	// not the session's (commit.ts) is refused here; Pi then runs no later handler.
	pi.on("tool_call", (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const { command } = event.input;
		const setsid = setsidCommands(command);
		const id = ctx.sessionManager.getSessionId();
		const reasons = [setsid.length > 0 ? refusal(setsid) : undefined, gitRefusal(command), commitRefusal(sessionFiles(id), command, ctx.cwd)].filter((r) => r !== undefined);
		if (reasons.length > 0) return { block: true, reason: reasons.join("\n\n") };
		mkdirSync(sessionDir(id), { recursive: true });
		event.input.command = recordLine(groupFile(id, event.toolCallId)) + event.input.command;
	});

	// A reload keeps the session and its processes. Otherwise the session ends here (its jobs and
	// leftovers stop in ../background).
	pi.on("session_shutdown", (event, ctx) => {
		if (event.reason === "reload") return;
		rmSync(sessionDir(ctx.sessionManager.getSessionId()), { recursive: true, force: true });
		dropSessionFiles(ctx.sessionManager.getSessionId());
	});

	/**
	 * The call has ended: adopt the jobs it left running in its process group, its shell's and
	 * `tool` commands (and forget the group's files). The other processes left are `untracked`.
	 */
	const leave = async (sessionId: string, callId: string, command: string) => {
		const file = groupFile(sessionId, callId);
		const pgid = readGroup(file);
		const shellJobs = readJobs(jobsFile(file));
		rmSync(file, { force: true });
		rmSync(jobsFile(file), { force: true });
		const isJob = (pid: number, line: string) => shellJobs === undefined || shellJobs.has(pid) || clientCommand(line) !== undefined;
		const none = { left: [], untracked: [] as Untracked[] };
		const adopted = pgid === undefined ? none : await adoptLeftovers(sessionJobs(sessionId), pgid, { startedBy: command, callId }, ps, pollMs, isJob).catch(() => none);
		return { pgid, ...adopted };
	};

	pi.registerTool({
		...builtin,
		description: `${builtin.description} ${REFUSED}`,
		promptGuidelines: [
			...(builtin.promptGuidelines ?? []),
			systemGuideline(),
			TOOL_GUIDELINE,
			BACKGROUND_GUIDELINE(options.detachAfterMs ?? DETACH_AFTER_MS),
			"Jobs a command starts with `&` (a server for a test, parallel jobs) may keep running after it: the tool tracks each one and its end reaches you as a new message. Redirect their output to a file (`./server > server.log 2>&1 &`): output to the tool's pipe is lost once the command returns. Processes that programs start on their own (a daemon such as git's fsmonitor, the `&` jobs of a script or `bash -c`) are named in the result but not tracked: to be told when a script's job ends, run the script itself with `&`. `setsid` is refused.",
			SHARED_CHECKOUT_GUIDELINE,
		],
		// Run the built-in call with `tool` on its PATH and adopt what it left; the result (or error) names the leftovers.
		async execute(callId, params, signal, onUpdate, ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			// The command as written, after the record line the tool_call handler put before it.
			const line = recordLine(groupFile(sessionId, callId));
			if (!params.command.startsWith(line)) return builtin.execute(callId, params, signal, onUpdate, ctx);
			const command = params.command.slice(line.length);
			const bridge = await openBridge(ctx as ExtensionToolContext, signal, binDir, sessionJobs(sessionId), pollMs);
			let outcome: { result: Awaited<ReturnType<typeof builtin.execute>> } | { error: unknown };
			try {
				outcome = { result: await builtin.execute(callId, { ...params, command: bridge.line + params.command }, signal, onUpdate, ctx) };
			} catch (error) {
				outcome = { error };
			}
			let untracked: Untracked[] = [];
			const { images, left } = await bridge.ended(async () => {
				const adopted = await leave(sessionId, callId, command);
				untracked = adopted.untracked;
				return adopted;
			});
			const notes = [...(left.length ? [leftText(left)] : []), ...(untracked.length ? [untrackedText(untracked)] : [])];
			const note = notes.length ? notes.join("\n\n") : undefined;
			if ("error" in outcome) {
				if (!note) throw outcome.error;
				throw new Error(`${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}\n\n${note}`);
			}
			const result = withImages(outcome.result, images);
			return note ? { ...result, content: [...result.content, { type: "text", text: `\n\n${note}` }] } : result;
		},
	});
}
