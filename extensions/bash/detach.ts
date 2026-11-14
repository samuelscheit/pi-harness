// `setsid` is refused before a bash command runs.
//
// Jobs a command leaves running (`cmd &`, `nohup cmd &`, `disown`) stay in the command's process
// group, so the bash tool tracks each one and reports its end (leftovers.ts). `setsid` moves a job
// into a new session and process group, out of that tracking; on macOS it does not even exist, so
// the job never starts (2026-11-13: `setsid nohup bash -c '… embed …' > embed.log &` → "setsid:
// command not found", noticed three minutes later).

import { commandsIn, refusalText } from "./commands.ts";

/** The commands in `source` that run `setsid`, as written, in source order. */
export function setsidCommands(source: string): string[] {
	return commandsIn(source).flatMap((command) => (command.name === "setsid" ? [command.text] : []));
}

/** The tool result of a refused command: why, and how to start the job instead. */
export function refusal(commands: readonly string[], platform: NodeJS.Platform = process.platform): string {
	return refusalText(
		"uses `setsid`",
		commands,
		platform === "darwin"
			? "`setsid` does not exist on macOS, so the job would never start."
			: "`setsid` moves the job out of the command's process group, where the bash tool cannot track it.",
		"Start the job with `&` instead (`nohup` is not needed), its output redirected to a file, e.g. `./job > job.log 2>&1 &`. The bash tool tracks every process a command leaves running and wakes you with a message when each one ends, also after your turn.",
	);
}

/** The system the commands run on, for the bash tool's guidelines. */
export function systemGuideline(platform: NodeJS.Platform = process.platform): string {
	if (platform === "darwin")
		return "Commands run on macOS with its BSD userland, not GNU: there is no `setsid`, `sed -i` takes a suffix argument (`sed -i ''`), and `grep` has no `-P`.";
	if (platform === "linux") return "Commands run on Linux with the GNU userland.";
	if (platform === "win32") return "Commands run in Git Bash on Windows.";
	return `Commands run on ${platform}.`;
}
