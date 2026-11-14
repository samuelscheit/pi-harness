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
// Both rely on the process group: Pi runs every bash command as the leader of its own group
// (detached spawn), and what the command starts stays in it. Before each bash call this extension
// prefixes the command with a line that writes the shell's `$$` (its pid, the group id) to a file
// named after the call; the transcript keeps the original command (Pi hands tool_call handlers a
// copy).

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition, type ExtensionAPI, type ExtensionToolContext, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_GUIDELINE, DETACH_AFTER_MS } from "../background/index.ts";
import { sessionJobs, setStopHint } from "../background/jobs.ts";
import { openBridge, TOOL_GUIDELINE, toolBinDir, withImages } from "./bridge.ts";
import { refusal, setsidCommands, systemGuideline } from "./detach.ts";
import { adoptLeftovers, defaultPs, leftText, type Ps } from "./leftovers.ts";

/** The line put before a bash command: the shell's pid (its process group) into `file`. */
export const recordLine = (file: string) => `printf '%s' "$$" > '${file.replaceAll("'", "'\\''")}' 2>/dev/null\n`;

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

	setStopHint("bash", (sessionId, callId) => {
		const pgid = readGroup(groupFile(sessionId, callId));
		return pgid === undefined ? undefined : `process group ${pgid}; stop it with \`kill -- -${pgid}\``;
	});

	// A command using `setsid` is refused here (detach.ts); Pi then runs no later handler.
	pi.on("tool_call", (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const setsid = setsidCommands(event.input.command);
		if (setsid.length > 0) return { block: true, reason: refusal(setsid) };
		const id = ctx.sessionManager.getSessionId();
		mkdirSync(sessionDir(id), { recursive: true });
		event.input.command = recordLine(groupFile(id, event.toolCallId)) + event.input.command;
	});

	// A reload keeps the session and its processes. Otherwise the session ends here (its jobs and
	// leftovers stop in ../background).
	pi.on("session_shutdown", (event, ctx) => {
		if (event.reason === "reload") return;
		rmSync(sessionDir(ctx.sessionManager.getSessionId()), { recursive: true, force: true });
	});

	/** The call has ended: adopt what it left running in its process group (and forget the group file). */
	const leave = async (sessionId: string, callId: string, command: string) => {
		const file = groupFile(sessionId, callId);
		const pgid = readGroup(file);
		rmSync(file, { force: true });
		const left = pgid === undefined ? [] : await adoptLeftovers(sessionJobs(sessionId), pgid, command, ps, pollMs).catch(() => []);
		return { pgid, left };
	};

	pi.registerTool({
		...builtin,
		promptGuidelines: [
			...(builtin.promptGuidelines ?? []),
			systemGuideline(),
			TOOL_GUIDELINE,
			BACKGROUND_GUIDELINE(options.detachAfterMs ?? DETACH_AFTER_MS),
			"Jobs a command starts with `&` (a server for a test, parallel jobs) may keep running after it: the tool tracks each one and its end reaches you as a new message. Redirect their output to a file (`./server > server.log 2>&1 &`): output to the tool's pipe is lost once the command returns. `setsid` is refused.",
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
			const { images, left } = await bridge.ended(() => leave(sessionId, callId, command));
			const note = left.length ? leftText(left) : undefined;
			if ("error" in outcome) {
				if (!note) throw outcome.error;
				throw new Error(`${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}\n\n${note}`);
			}
			const result = withImages(outcome.result, images);
			return note ? { ...result, content: [...result.content, { type: "text", text: `\n\n${note}` }] } : result;
		},
	});
}
