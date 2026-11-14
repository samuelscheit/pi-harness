// The harness's bash: commands never block the agent for long, and nothing they leave running goes
// unreported.
//
// The most repeated correction in the user's sessions (docs/research/context-engineering/07, §10:
// 22 sessions over 10 days) was an agent ending its turn "waiting" on a background job: nothing
// woke it when the job finished, so the result reached no one. Instructions alone did not stop it.
// So the tool itself reports every end:
// - a command still running after two minutes, or when the user sends a message, moves to the
//   background, and its end wakes the session with its result (jobs.ts);
// - every process a command leaves running (`cmd &`, a script's server) is tracked, and each one's
//   end wakes the session (leftovers.ts);
// - `setsid`, which would move a job out of reach, is refused (detach.ts).
//
// Both rely on the process group: Pi runs every bash command as the leader of its own group
// (detached spawn), and what the command starts stays in it. Before each bash call this extension
// prefixes the command with a line that writes the shell's `$$` (its pid, the group id) to a file
// named after the call; the transcript keeps the original command (Pi hands tool_call handlers a
// copy).

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { DETACH_AFTER_MS, detachableBash } from "./jobs.ts";

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

export interface BackgroundOptions {
	/** Directory for the group files; default a per-process directory in the system temp dir. */
	dir?: string;
	/** Foreground time before a bash call moves to the background. */
	detachAfterMs?: number;
	/** How often processes calls left running are checked. */
	pollMs?: number;
}

export default function background(pi: ExtensionAPI, options: BackgroundOptions = {}) {
	if (process.platform === "win32") return;
	const root = options.dir ?? join(tmpdir(), "pi-harness-background", String(process.pid));
	const sessionDir = (id: string) => join(root, encodeURIComponent(id));
	// Beside the group files, not among them: a session directory holds group files only.
	const logDir = (id: string) => {
		const dir = join(`${root}-logs`, encodeURIComponent(id));
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		return dir;
	};

	// Registered first, so its tool_call handler (the setsid refusal, the call's command as written)
	// runs before the record line is put in front of the command.
	detachableBash(pi, {
		detachAfterMs: options.detachAfterMs ?? DETACH_AFTER_MS,
		...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
		groupFileOf: (id, callId) => join(sessionDir(id), encodeURIComponent(callId)),
		logDir,
		readGroup,
	});

	pi.on("tool_call", (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const dir = sessionDir(ctx.sessionManager.getSessionId());
		mkdirSync(dir, { recursive: true });
		event.input.command = recordLine(join(dir, encodeURIComponent(event.toolCallId))) + event.input.command;
	});

	// A reload keeps the session and its processes. Otherwise the session ends here (its jobs and
	// leftovers stop in jobs.ts).
	pi.on("session_shutdown", (event, ctx) => {
		if (event.reason === "reload") return;
		const id = ctx.sessionManager.getSessionId();
		rmSync(sessionDir(id), { recursive: true, force: true });
		rmSync(join(`${root}-logs`, encodeURIComponent(id)), { recursive: true, force: true });
	});
}
