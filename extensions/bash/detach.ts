// Detached jobs: a bash command that starts a job and leaves it running is refused before it runs.
//
// Child agents on macOS detached long jobs with Linux-only `setsid` (2026-11-13: `setsid nohup bash
// -c '… embed …' > embed.log &` → "setsid: command not found"); the job never started and the agent
// noticed three minutes later. Detaching is never needed: the bash tool moves a command that runs
// long to the background itself (jobs.ts) and reports its end as a new message, which a job the
// command detached loses.
//
// The command is parsed with unbash (a Bash 5.3 parser; pi-lens installs it), so `&&`, `2>&1`,
// `&>`, `>&2`, `|&`, quoted text and heredoc bodies never count as backgrounding. A command detaches
// a job when it
// - ends a statement with `&` (`cmd &`, `( … ) &`, also inside `$( … )`, functions, loops), unless a
//   later command waits for it or stops it (`wait`, `kill`, `pkill`, `killall`) or a `trap` does,
// - runs `setsid` or `disown`,
// also inside a literal `bash -c '…'` script, and behind wrappers such as `nohup`, `env` or `sudo`.

import { type Command, forEachChild, parse, type SyntaxNode } from "../../vendor/pi-lens/node_modules/unbash/dist/parser.js";

export type DetachKind = "background" | "setsid" | "disown";

export interface Detach {
	kind: DetachKind;
	/** The statement (`background`) or command that detaches, as written. */
	text: string;
}

/** Commands that run their arguments as a command. */
const WRAPPERS = new Set(["builtin", "caffeinate", "command", "env", "exec", "gtimeout", "nice", "nohup", "stdbuf", "sudo", "time", "timeout"]);
/** Words a wrapper takes before the command: options, `env` assignments and durations or priorities. */
const WRAPPER_ARGUMENT = /^(?:-.*|[A-Za-z_][A-Za-z0-9_]*=.*|\d+(?:\.\d+)?[smhd]?)$/;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
/** Commands after which a background job no longer outlives the command. */
const REAPERS = new Set(["wait", "kill", "pkill", "killall"]);

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

/** What in `source` detaches a job, in source order. */
export function detaches(source: string): Detach[] {
	const background: { text: string; end: number }[] = [];
	const found: Detach[] = [];
	const reapers: number[] = [];
	let trapped = false;
	const visit = (node: SyntaxNode) => {
		if (node.type === "Statement" && node.background) background.push({ text: source.slice(node.pos, node.end), end: node.end });
		if (node.type === "Command") {
			for (const { name, args } of commandsOf(node)) {
				if (name === "setsid" || name === "disown") found.push({ kind: name, text: source.slice(node.pos, node.end) });
				if (REAPERS.has(name)) reapers.push(node.pos);
				if (name === "trap") trapped = true;
				const script = shellScript(name, args);
				if (script !== undefined) found.push(...detaches(script));
			}
		}
		forEachChild(node, visit);
	};
	visit(parse(source));
	if (!trapped) {
		for (const job of background) if (!reapers.some((pos) => pos > job.end)) found.push({ kind: "background", text: job.text });
	}
	return found;
}

const clip = (text: string, max: number) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const REASONS: Record<DetachKind, (platform: NodeJS.Platform) => string> = {
	background: () => "runs in the background (`&`), and nothing in the command waits for it (`wait`) or stops it (`kill`)",
	setsid: (platform) => (platform === "darwin" ? "`setsid` does not exist on macOS (command not found), so the job would never start" : "`setsid` moves it out of the tool's process group"),
	disown: () => "`disown` detaches it from the shell",
};

/** The tool result of a refused command: what detaches, and to run it in the foreground. */
export function refusal(found: readonly Detach[], detachAfterMs: number, platform: NodeJS.Platform = process.platform): string {
	const lines = [...new Map(found.map((d) => [`${d.kind}\0${d.text}`, d])).values()].map((d) => `- \`${clip(d.text, 120)}\`: ${REASONS[d.kind](platform)}`);
	return [
		"Not run: this command detaches a job, so its result would reach no one.",
		...lines,
		`The bash tool backgrounds long commands itself: a command still running after ${detachAfterMs / 60_000} minutes, or when the user sends a message, moves to the background, keeps running, and its end reaches you as a new message with its output, also after your turn. Run the command in the foreground instead, without \`&\`, nohup, setsid or disown; redirect its output to a log only if you want one. To run jobs in parallel within one command, end it with \`wait\`.`,
		...(platform === "darwin" && !found.some((d) => d.kind === "setsid") ? ["On macOS `setsid` does not exist."] : []),
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
