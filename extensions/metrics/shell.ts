// What a shell command reads and writes, for the metrics: agents edit through bash as often as
// through edit tools (`sed -i`, `cat > f <<EOF`, inline Python that rewrites a file, `cp`, `rm`,
// formatters), so "did this call change files, and which" needs the command itself.
//
// A small bash tokenizer (quotes, escapes, heredocs, redirections, command separators) feeds a
// table of known writers. It is static: a write whose target is computed at run time (a loop
// variable, `$(...)`, an f-string) marks the call as mutating without naming the file.

import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { inlineScripts, scriptWrites } from "../../vendor/pi-lens/clients/inline-script-writes.ts";

export interface ShellCommand {
	/** Words after quote removal; separators, redirections and heredoc bodies excluded. */
	words: string[];
	redirects: { op: string; target: string }[];
	/** Heredoc bodies and here-strings fed to this command. */
	inputs: string[];
	/** Subshell nesting (`( … )`, `$( … )`, backticks): a `cd` inside does not outlive it. */
	depth: number;
}

const ANSI_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0" };
const OPERATOR = /^(?:&>>|&>|<<<|<<-|<<|<>|<&|>&|>>|>\||<|>)/;

/** Splits a bash command line into simple commands. Pipelines, lists, subshells and `$(...)` all separate. */
export function parseShell(source: string): ShellCommand[] {
	const commands: ShellCommand[] = [];
	let depth = 0;
	let current: ShellCommand = { words: [], redirects: [], inputs: [], depth };
	let word: string | null = null;
	let redirect: string | null = null;
	let heredocNext: { strip: boolean } | null = null;
	let heredocs: { command: ShellCommand; delimiter: string; strip: boolean }[] = [];

	const endWord = () => {
		if (word === null) return;
		if (heredocNext) heredocs.push({ command: current, delimiter: word, strip: heredocNext.strip });
		else if (redirect === "<<<") current.inputs.push(word);
		else if (redirect) current.redirects.push({ op: redirect, target: word });
		else current.words.push(word);
		heredocNext = null;
		redirect = null;
		word = null;
	};
	const endCommand = () => {
		endWord();
		if (current.words.length || current.redirects.length || current.inputs.length) commands.push(current);
		current = { words: [], redirects: [], inputs: [], depth };
	};

	let i = 0;
	while (i < source.length) {
		const c = source[i]!;
		if (c === "\\") {
			if (source[i + 1] !== "\n") word = (word ?? "") + (source[i + 1] ?? "");
			i += 2;
		} else if (c === "'") {
			const end = source.indexOf("'", i + 1);
			const stop = end < 0 ? source.length : end;
			word = (word ?? "") + source.slice(i + 1, stop);
			i = stop + 1;
		} else if (c === "$" && source[i + 1] === "'") {
			let j = i + 2;
			let text = "";
			while (j < source.length && source[j] !== "'") {
				if (source[j] === "\\" && j + 1 < source.length) {
					j += 1;
					text += ANSI_ESCAPES[source[j]!] ?? source[j];
				} else text += source[j];
				j += 1;
			}
			word = (word ?? "") + text;
			i = j + 1;
		} else if (c === '"') {
			let j = i + 1;
			let text = "";
			while (j < source.length && source[j] !== '"') {
				if (source[j] === "\\" && '"\\$`\n'.includes(source[j + 1] ?? "")) j += 1;
				text += source[j];
				j += 1;
			}
			word = (word ?? "") + text;
			i = j + 1;
		} else if (c === "#" && word === null) {
			while (i < source.length && source[i] !== "\n") i += 1;
		} else if (c === " " || c === "\t") {
			endWord();
			i += 1;
		} else if (c === "\n") {
			endCommand();
			i += 1;
			for (const doc of heredocs) {
				const lines: string[] = [];
				while (i < source.length) {
					const next = source.indexOf("\n", i);
					const line = source.slice(i, next < 0 ? source.length : next);
					i = next < 0 ? source.length : next + 1;
					if ((doc.strip ? line.replace(/^\t+/, "") : line).trim() === doc.delimiter) break;
					lines.push(line);
				}
				doc.command.inputs.push(lines.join("\n"));
			}
			heredocs = [];
		} else if ((c === ">" || c === "<" || (c === "&" && source[i + 1] === ">")) && !(c === "<" && source[i + 1] === "(")) {
			// A word of digits right before the operator is a file descriptor (`2>`), not an argument.
			if (word !== null && /^\d+$/.test(word) && source[i - 1] !== " ") word = null;
			endWord();
			const op = OPERATOR.exec(source.slice(i))![0];
			if (op === "<<" || op === "<<-") heredocNext = { strip: op === "<<-" };
			else redirect = op;
			i += op.length;
		} else if (";&|()`{}".includes(c) || (c === "$" && source[i + 1] === "(")) {
			// `{`/`}` only separate as whole words (group commands), not inside `${VAR}` or `a{b,c}`.
			if ((c === "{" || c === "}") && word !== null) {
				word += c;
				i += 1;
				continue;
			}
			if (c === "{" && /\S/.test(source[i + 1] ?? "") && source[i + 1] !== "\n") {
				word = (word ?? "") + c;
				i += 1;
				continue;
			}
			// `> $(mktemp)`: the target is computed; keep it as an unresolvable word.
			if (redirect && word === null && (c === "$" || c === "`")) word = "$(...)";
			endCommand();
			if (c === "(" || c === "$") depth += 1;
			else if (c === ")") depth = Math.max(0, depth - 1);
			else if (c === "`") depth += source.slice(0, i).split("`").length % 2 === 1 ? 1 : -1;
			current.depth = depth;
			i += c === "$" ? 2 : 1;
		} else {
			word = (word ?? "") + c;
			i += 1;
		}
	}
	endCommand();
	return commands;
}

export interface Effect {
	/** Files and directories the command named (read or written), absolute. */
	files: string[];
	/** The subset it writes, creates, moves or deletes. */
	writes: string[];
	/** Whether it changes files at all, also when the target is not known statically. */
	mutates: boolean;
}

// A path-like word: has a slash (`src/a`, `docs/`) or a file extension (`a.ts`).
const PATH_WORD = /(?:^|[\s"'=(:,])((?:~|\.{1,2}|[\w@.-]+)?(?:\/[\w@.+-]+)+\/?|[\w@.+-]+\/|[\w@+-]+(?:\.[\w-]+)*\.[A-Za-z][\w]{0,5})(?=$|[\s"'),;:|&>])/g;

const expandHome = (path: string) => (path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path);

/** Words a writer command takes as option values, so they are not mistaken for its operands. */
const VALUE_OPTIONS: Record<string, string[]> = {
	sed: ["-e", "--expression", "-f", "--file", "-l", "--line-length"],
	perl: ["-e", "-E", "-I", "-M", "-m"],
	truncate: ["-s", "--size", "-r", "--reference"],
	cp: ["-t", "--target-directory", "-S", "--suffix"],
	mv: ["-t", "--target-directory", "-S", "--suffix"],
	install: ["-t", "--target-directory", "-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix"],
	ln: ["-t", "--target-directory", "-S", "--suffix"],
	mkdir: ["-m", "--mode"],
	git: ["-C", "-c", "--git-dir", "--work-tree", "--namespace"],
	prettier: ["--config", "--ignore-path", "--plugin", "--parser", "--log-level", "--loglevel"],
	eslint: ["-c", "--config", "--ext", "--rule", "--format", "-f", "-o", "--output-file", "--ignore-path", "--max-warnings"],
	black: ["-l", "--line-length", "--config", "-t", "--target-version", "--include", "--exclude"],
	ruff: ["--config", "--select", "--ignore", "--line-length", "--target-version", "--extend-select"],
	"clang-format": ["--style", "-style", "--assume-filename"],
	curl: ["-o", "--output", "-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "-m", "--max-time", "--connect-timeout", "-w", "--write-out", "-F", "--form", "-x", "--proxy", "-T", "--upload-file", "--retry", "-r", "--range", "-K", "--config"],
	wget: ["-O", "--output-document", "-P", "--directory-prefix", "-o", "--output-file", "-U", "--user-agent", "--header", "-t", "--tries", "-T", "--timeout"],
};

/** Operands (non-option words) of a command, skipping option values; `--` ends options. */
function operands(name: string, args: string[]): { operands: string[]; options: Map<string, string | true> } {
	const valued = new Set(VALUE_OPTIONS[name] ?? []);
	const result: string[] = [];
	const options = new Map<string, string | true>();
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--") {
			result.push(...args.slice(i + 1));
			break;
		}
		if (arg.startsWith("-") && arg.length > 1) {
			const eq = arg.indexOf("=");
			if (eq > 0) options.set(arg.slice(0, eq), arg.slice(eq + 1));
			else if (valued.has(arg)) options.set(arg, args[++i] ?? "");
			else options.set(arg, true);
			continue;
		}
		result.push(arg);
	}
	return { operands: result, options };
}

/**
 * Words that are a program or pattern rather than a file (`sed 's/a/b/' f`, `rg 'src/x' .`,
 * `awk '{print $1}' f`, `jq '.a' f`, `perl -e '…'`): skipped when collecting named files.
 */
function patternWords(name: string, args: string[]): Set<string> {
	const scripts = new Set<string>();
	const flagged = ["-e", "--expression", "--regexp", "-E"].flatMap((flag) => args.flatMap((a, i) => (a === flag && args[i + 1] !== undefined ? [args[i + 1]!] : [])));
	for (const word of flagged) scripts.add(word);
	if (["sed", "awk", "gawk", "grep", "egrep", "fgrep", "rg", "ag", "jq", "yq"].includes(name) && flagged.length === 0) {
		const valued = name === "awk" || name === "gawk" ? ["-v", "-F", "-f"] : name === "rg" || name === "grep" ? ["-g", "--glob", "-t", "--type", "-A", "-B", "-C", "-m", "--max-count", "-f", "--file"] : (VALUE_OPTIONS[name] ?? []);
		const first = args.find((a, i) => !a.startsWith("-") && !valued.includes(args[i - 1] ?? "") && !(name === "sed" && args[i - 1] === "-i" && a === ""));
		if (first !== undefined) scripts.add(first);
	}
	return scripts;
}

const has = (options: Map<string, string | true>, ...names: string[]) => names.some((name) => options.has(name));

/** Commands that run the rest of their words as another command. */
const WRAPPERS = new Set(["sudo", "command", "builtin", "exec", "nohup", "time", "nice", "env", "caffeinate", "stdbuf", "timeout", "xargs", "npx", "bunx", "pnpx", "uvx", "dotenv"]);
const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const FORMATTERS: Record<string, (options: Map<string, string | true>, operands: string[]) => boolean> = {
	prettier: (o) => has(o, "--write", "-w"),
	eslint: (o) => has(o, "--fix"),
	biome: (o, a) => ["format", "check", "lint"].includes(a[0] ?? "") && has(o, "--write", "--apply", "--fix"),
	black: () => true,
	isort: () => true,
	ruff: (o, a) => a[0] === "format" || (a[0] === "check" && has(o, "--fix")),
	gofmt: (o) => has(o, "-w"),
	goimports: (o) => has(o, "-w"),
	rustfmt: () => true,
	"clang-format": (o) => has(o, "-i"),
	swiftformat: () => true,
};
const GIT_WRITERS = new Set(["apply", "am", "checkout", "switch", "restore", "merge", "rebase", "pull", "cherry-pick", "revert", "mv", "rm", "clean", "stash"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_CHANGES = new Set(["install", "i", "add", "remove", "rm", "uninstall", "un"]);

interface Writes {
	paths: string[];
	unknown: boolean;
}

/** What one simple command (after wrappers) writes, as unresolved words. */
function commandWrites(name: string, args: string[]): Writes {
	const none: Writes = { paths: [], unknown: false };
	const { operands: ops, options } = operands(name, args);
	switch (name) {
		case "sed": {
			const inPlace = args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"));
			if (!inPlace) return none;
			// BSD sed: `-i ''` / `-i .bak` takes the backup suffix as its own word.
			const words = args.flatMap((a, i) => (args[i - 1] === "-i" && (a === "" || /^\.\w*$/.test(a)) ? [] : [a]));
			const rest = operands(name, words);
			const files = has(rest.options, "-e", "--expression", "-f", "--file") ? rest.operands : rest.operands.slice(1);
			return { paths: files, unknown: files.length === 0 };
		}
		case "perl": {
			if (!args.some((a) => /^-[a-zA-Z0-9]*i/.test(a))) return none;
			const files = has(options, "-e", "-E") ? ops : ops.slice(1);
			return { paths: files, unknown: files.length === 0 };
		}
		case "tee":
		case "rm":
		case "rmdir":
		case "unlink":
		case "touch":
		case "mkdir":
		case "truncate":
			return { paths: ops, unknown: false };
		case "mv":
			return { paths: [...ops, ...(typeof options.get("-t") === "string" ? [options.get("-t") as string] : [])], unknown: false };
		case "cp":
		case "install":
		case "ln":
		case "rsync": {
			const target = options.get("-t") ?? options.get("--target-directory");
			if (typeof target === "string") return { paths: [target], unknown: false };
			return ops.length >= 2 ? { paths: [ops.at(-1)!], unknown: false } : none;
		}
		case "dd": {
			const of = args.find((a) => a.startsWith("of="));
			return of ? { paths: [of.slice(3)], unknown: false } : none;
		}
		case "curl": {
			const out = options.get("-o") ?? options.get("--output");
			return typeof out === "string" && out !== "-" ? { paths: [out], unknown: false } : has(options, "-O", "--remote-name") ? { paths: [], unknown: true } : none;
		}
		case "wget": {
			const out = options.get("-O") ?? options.get("--output-document");
			if (typeof out === "string") return out === "-" ? none : { paths: [out], unknown: false };
			return { paths: [], unknown: true };
		}
		case "patch":
			return { paths: ops.slice(0, 1), unknown: ops.length === 0 };
		case "git": {
			const [sub, ...rest] = ops;
			if (!sub || !GIT_WRITERS.has(sub)) return none;
			if (sub === "stash" && ["list", "show"].includes(rest[0] ?? "")) return none;
			const dash = args.indexOf("--");
			if (sub === "mv" || sub === "rm" || sub === "restore") return { paths: rest, unknown: rest.length === 0 };
			if (sub === "checkout" && dash >= 0) return { paths: args.slice(dash + 1), unknown: false };
			return { paths: [], unknown: true };
		}
	}
	if (PACKAGE_MANAGERS.has(name) && PACKAGE_CHANGES.has(ops[0] ?? "")) return { paths: [], unknown: ops.length > 1 };
	const formatter = FORMATTERS[name];
	if (formatter) {
		if (!formatter(options, ops)) return none;
		const files = name === "biome" || name === "ruff" ? ops.slice(1) : ops;
		return { paths: files, unknown: files.length === 0 };
	}
	return none;
}

/** Resolves a shell word to an absolute path, or undefined when it depends on run-time values. */
/** `$NAME` / `${NAME}` replaced from the variables assigned so far; unknown ones stay. */
const substitute = (word: string, dir: string, env: Map<string, string>) =>
	word.replace(/\$\{?(\w+)\}?/g, (all, name: string) => (name === "PWD" ? dir : (env.get(name) ?? all)));

function resolver(dir: () => string, env: Map<string, string>) {
	return (word: string): string | undefined => {
		const expanded = substitute(word, dir(), env);
		if (!expanded || expanded.includes("$") || /[*?[\]]/.test(expanded) || expanded.startsWith("-")) return undefined;
		return resolve(dir(), expandHome(expanded));
	};
}

/** The files a shell command line names, writes, and whether it changes files at all. */
export function shellEffect(command: string, cwd: string): Effect {
	const files = new Set<string>();
	const writes = new Set<string>();
	let mutates = false;
	let dir = cwd;
	const env = new Map<string, string>([["HOME", homedir()]]);
	const path = resolver(() => dir, env);
	const write = (words: string[], unknown: boolean, base = path) => {
		if (unknown) mutates = true;
		for (const word of words) {
			const resolved = base(word);
			if (resolved === undefined) mutates = true;
			else if (!resolved.startsWith("/dev/")) {
				writes.add(resolved);
				files.add(resolved);
				mutates = true;
			}
		}
	};

	// The directory outside each open subshell, restored when it closes.
	const outer: string[] = [];
	for (const { words: all, redirects, inputs, depth } of parseShell(command)) {
		while (outer.length < depth) outer.push(dir);
		while (outer.length > depth) dir = outer.pop()!;
		let words = all;
		// Compound-command keywords lead into the command they run (`do sed -i …`, `then rm …`).
		while (words[0] !== undefined && KEYWORDS.has(words[0])) words = words.slice(1);
		while (words[0] !== undefined && /^[A-Za-z_]\w*=/.test(words[0])) {
			const eq = words[0].indexOf("=");
			const value = words[0].slice(eq + 1);
			env.set(words[0].slice(0, eq), substitute(value, dir, env));
			words = words.slice(1);
		}
		// `export A=b`, `local A=b`: assignments without a command.
		if (words[0] === "export" || words[0] === "local" || words[0] === "declare") {
			for (const word of words.slice(1)) {
				const eq = word.indexOf("=");
				if (eq > 0) env.set(word.slice(0, eq), substitute(word.slice(eq + 1), dir, env));
			}
			continue;
		}
		let fromStdin = false;
		while (words[0] !== undefined && WRAPPERS.has(basename(words[0]))) {
			const wrapper = basename(words[0]);
			if (wrapper === "xargs") fromStdin = true;
			words = words.slice(1);
			while (words[0] !== undefined && (words[0].startsWith("-") || /^[A-Za-z_]\w*=/.test(words[0]) || (wrapper === "timeout" && /^\d/.test(words[0])))) {
				const option = words[0];
				words = words.slice(1);
				// Options with a separate value (`xargs -I {}`, `nice -n 5`, `sudo -u x`).
				if (/^-(?:I|n|u|g|L|P|s|d|E)$/.test(option) && words[0] !== undefined) words = words.slice(1);
			}
		}
		if (words[0] === "pnpm" && (words[1] === "exec" || words[1] === "dlx")) words = words.slice(2);
		else if (words[0] === "yarn" && words[1] === "dlx") words = words.slice(2);
		else if (words[0] === "uv" && words[1] === "run") words = words.slice(2);
		// `PY=…/venv/bin/python3; $PY - <<EOF`: the command word can be a variable too.
		const name = words[0] === undefined ? "" : basename(substitute(words[0], dir, env));
		const args = words.slice(1);

		if (name === "cd" || name === "pushd") {
			dir = path(args.find((a) => !a.startsWith("-")) ?? "~") ?? dir;
			continue;
		}
		const patterns = patternWords(name, args);
		for (const arg of words) {
			if (/\s/.test(arg) || patterns.has(arg)) continue;
			for (const match of ` ${arg}`.matchAll(PATH_WORD)) {
				const candidate = match[1]!.replace(/\/$/, "");
				// URLs, flags and version-like numbers are not files.
				if (/^[\d.]+$/.test(candidate) || arg.includes("://") || candidate.startsWith("-")) continue;
				const resolved = path(candidate);
				if (resolved) files.add(resolved);
			}
		}
		for (const { op, target } of redirects) {
			if (op === "<") {
				const resolved = path(target);
				if (resolved) files.add(resolved);
			} else if (op !== "<&" && !(op === ">&" && /^(?:\d+|-)$/.test(target))) {
				// Output redirections; `2>&1` and `<&3` duplicate descriptors.
				write([target], false);
			}
		}
		if (SHELLS.has(name)) {
			const index = args.indexOf("-c");
			const scripts = index >= 0 && args[index + 1] !== undefined ? [args[index + 1]!] : args.length === 0 || args[0] === "-s" ? inputs : [];
			for (const script of scripts) {
				const inner = shellEffect(script, dir);
				for (const file of inner.files) files.add(file);
				for (const file of inner.writes) writes.add(file);
				mutates ||= inner.mutates;
			}
			continue;
		}
		if (fromStdin) {
			// xargs appends operands read from stdin: a writer under it changes files we cannot name.
			const withOperand = commandWrites(name, [...args, "operand"]);
			if (withOperand.paths.length > 0 || withOperand.unknown) mutates = true;
			continue;
		}
		const found = commandWrites(name, args);
		write(found.paths, found.unknown);
		for (const script of inlineScripts(name, args, inputs)) {
			const inner = scriptWrites(script);
			write(inner.paths, inner.unknown, (p) => resolve(dir, expandHome(p)));
		}
	}
	return { files: [...files], writes: [...writes], mutates };
}
