// Run a shell command and capture its combined output, for tools that need the exit code
// themselves (fix_loop's check) rather than the model-facing bash tool.

import { spawn } from "node:child_process";

export interface ShellResult {
	/** Exit code; null when the process was killed (timeout, abort) or ended by a signal. */
	exitCode: number | null;
	/** stdout and stderr interleaved as they arrived. */
	output: string;
	timedOut: boolean;
	aborted: boolean;
}

/**
 * Run `command` with bash in `cwd`. The command runs in its own process group, so a timeout or an
 * abort kills everything it started (test runners spawn workers), not only the shell.
 */
export function runShell(command: string, { cwd, signal, timeoutMs }: { cwd: string; signal?: AbortSignal; timeoutMs?: number }): Promise<ShellResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			resolve({ exitCode: null, output: "", timedOut: false, aborted: true });
			return;
		}
		const child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let timedOut = false;
		let aborted = false;
		const kill = () => {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				// Already gone.
			}
		};
		const onAbort = () => {
			aborted = true;
			kill();
		};
		const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("error", (error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ exitCode: timedOut || aborted ? null : code, output: Buffer.concat(chunks).toString("utf8"), timedOut, aborted });
		});
	});
}

/** Quote a value as one POSIX shell word: single quotes, each `'` as `'\''`. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
