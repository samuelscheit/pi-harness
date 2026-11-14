// `setsid` is refused before a bash command runs.
//
// Jobs a command leaves running (`cmd &`, `nohup cmd &`, `disown`) stay in the command's process
// group, so the bash tool tracks each one and reports its end (leftovers.ts). `setsid` moves a job
// into a new session and process group, out of that tracking; on macOS it does not even exist, so
// the job never starts (2026-11-13: `setsid nohup bash -c '… embed …' > embed.log &` → "setsid:
// command not found", noticed three minutes later).
//
// The command is parsed with unbash (a Bash 5.3 parser; pi-lens installs it), so `setsid` in quoted
// text or a heredoc body does not count, while `setsid` behind wrappers (`nohup`, `env`, `sudo`) and
// inside a literal `bash -c '…'` script does.

import { type Command, forEachChild, parse, type SyntaxNode } from "../../vendor/pi-lens/node_modules/unbash/dist/parser.js";

/** Commands that run their arguments as a command. */
const WRAPPERS = new Set(["builtin", "caffeinate", "command", "env", "exec", "gtimeout", "nice", "nohup", "stdbuf", "sudo", "time", "timeout"]);
/** Words a wrapper takes before the command: options, `env` assignments and durations or priorities. */
const WRAPPER_ARGUMENT = /^(?:-.*|[A-Za-z_][A-Za-z0-9_]*=.*|\d+(?:\.\d+)?[smhd]?)$/;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** The commands a simple command runs: its name, then the command each wrapper runs, with their arguments. */
function commandsOf(command: Command): { name: string; args: string[] }[] {
	const words = [command.name, ...command.args].flatMap((word) => (word?.type === "Word" ? [word.value] : []));
	const found: { name: string; args: string[] }[] = [];
	let i = 0;
	while (i < words.length) {
		const name = words[i]!.replace(/^.*\//, "");
		found.push({ name, args: words.slice(i + 1) });
		if (!WRAPPERS.has(name)) break;
		i += 1;
		while (i < words.length && WRAPPER_ARGUMENT.test(words[i]!)) i += 1;
	}
	return found;
}

/** The script a shell runs with `-c` (also `-lc`, `-ec`), when it is literal text. */
function shellScript(name: string, args: readonly string[]): string | undefined {
	if (!SHELLS.has(name)) return undefined;
	const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
	return flag < 0 ? undefined : args[flag + 1];
}

/** The commands in `source` that run `setsid`, as written, in source order. */
export function setsidCommands(source: string): string[] {
	const found: string[] = [];
	const visit = (node: SyntaxNode) => {
		if (node.type === "Command") {
			for (const { name, args } of commandsOf(node)) {
				if (name === "setsid") found.push(source.slice(node.pos, node.end));
				const script = shellScript(name, args);
				if (script !== undefined) found.push(...setsidCommands(script));
			}
		}
		forEachChild(node, visit);
	};
	visit(parse(source));
	return found;
}

const clip = (text: string, max: number) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The tool result of a refused command: why, and how to start the job instead. */
export function refusal(commands: readonly string[], platform: NodeJS.Platform = process.platform): string {
	return [
		"Not run: this command uses `setsid`:",
		...[...new Set(commands)].map((c) => `- \`${clip(c, 120)}\``),
		platform === "darwin"
			? "`setsid` does not exist on macOS, so the job would never start."
			: "`setsid` moves the job out of the command's process group, where the bash tool cannot track it.",
		"Start the job with `&` instead (`nohup` is not needed), its output redirected to a file, e.g. `./job > job.log 2>&1 &`. The bash tool tracks every process a command leaves running and wakes you with a message when each one ends, also after your turn.",
	].join("\n");
}

/** The system the commands run on, for the bash tool's guidelines. */
export function systemGuideline(platform: NodeJS.Platform = process.platform): string {
	if (platform === "darwin")
		return "Commands run on macOS with its BSD userland, not GNU: there is no `setsid`, `sed -i` takes a suffix argument (`sed -i ''`), and `grep` has no `-P`.";
	if (platform === "linux") return "Commands run on Linux with the GNU userland.";
	if (platform === "win32") return "Commands run in Git Bash on Windows.";
	return `Commands run on ${platform}.`;
}
