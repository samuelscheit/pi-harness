/**
 * Files an inline interpreter script writes: `python3 - <<'EOF' … open(p, "w") … EOF`,
 * `node -e "fs.writeFileSync(…)"`. Agents rewrite files this way about as often as through the
 * edit tool, so a bash write scan that skips them misses most of their edits.
 *
 * Pure (no imports): the pi-harness metrics read the same module to count these writes.
 * Static: a target computed at run time (a loop variable, an f-string) is `unknown`, not named.
 */

/** A command name (basename) that runs inline code. */
export const INTERPRETER = /^(?:python[\d.]*|node|bun|deno|ruby|tsx|ts-node)$/;

const SCRIPT_FLAGS = ["-c", "-e", "--eval", "-p", "--print"];

/**
 * The code an interpreter command runs inline: its `-c`/`-e`/`--eval`/`-p` arguments (and
 * `deno eval <code>`), else its stdin (`heredocs`) when it names no script file (`python3 -`,
 * `node <<EOF`). A script file's stdin is data, not code. Empty for other commands.
 */
export function inlineScripts(name: string, args: readonly string[], heredocs: readonly string[]): string[] {
	if (!INTERPRETER.test(name)) return [];
	const scripts: string[] = [];
	for (const flag of SCRIPT_FLAGS) {
		const index = args.indexOf(flag);
		if (index >= 0 && args[index + 1] !== undefined) scripts.push(args[index + 1]!);
	}
	if (name === "deno" && args[0] === "eval" && args[1] !== undefined) scripts.push(args[1]);
	if (scripts.length > 0) return scripts;
	const operand = args.find((arg) => arg === "-" || !arg.startsWith("-"));
	return operand === undefined || operand === "-" ? [...heredocs] : [];
}

export interface ScriptWrites {
	/** Paths as the script names them, relative to its working directory unless absolute. */
	paths: string[];
	/** Whether it writes somewhere it does not name statically. */
	unknown: boolean;
}
/** A quoted string literal whose quote is capture group `group` and whose text is group `group + 1`. */
const literal = (group: number) => `(['"\\x60])((?:(?!\\${group})[^\\\\\\n]|\\\\.)*)\\${group}`;

/**
 * Files an inline Python, JavaScript or Ruby script writes: `open(p, "w")`, `Path(p).write_text`,
 * `fs.writeFileSync(p, …)`, `shutil.copy(a, b)`, `os.remove(p)`, `File.write(p, …)`. A literal or
 * a variable assigned a literal earlier in the script resolves; anything else counts as unknown.
 */
export function scriptWrites(script: string): ScriptWrites {
	const assignments: { name: string; value: string; at: number }[] = [];
	const assign = new RegExp(String.raw`(?:^|[\s;(,])(?:const\s+|let\s+|var\s+)?([A-Za-z_]\w*)\s*=\s*(?:(?:pathlib\.)?Path\(\s*)?${literal(2)}`, "gm");
	for (const m of script.matchAll(assign)) assignments.push({ name: m[1]!, value: m[3]!, at: m.index! });

	// `p = Path(f)` / `q = p`: one name standing for another.
	const aliases: { name: string; target: string; at: number }[] = [];
	for (const m of script.matchAll(/(?:^|[\s;])(?:const\s+|let\s+|var\s+)?([A-Za-z_]\w*)\s*=\s*(?:(?:pathlib\.)?Path\(\s*)?([A-Za-z_]\w*)\s*\)?\s*(?=$|[;\n])/gm)) {
		if (m[1] !== m[2]) aliases.push({ name: m[1]!, target: m[2]!, at: m.index! });
	}
	// Edit helpers (`def sub(p, old, new): … open(p, "w")`), to resolve a parameter from the calls.
	const functions: { name: string; params: string[]; at: number }[] = [];
	for (const m of script.matchAll(/\bdef\s+(\w+)\s*\(([^)]*)\)|\bfunction\s+(\w+)\s*\(([^)]*)\)|\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g)) {
		const params = (m[2] ?? m[4] ?? m[6]!).split(",").map((p) => p.replace(/[:=].*$/s, "").replace(/^[*\s]+/, "").trim());
		functions.push({ name: (m[1] ?? m[3] ?? m[5])!, params, at: m.index! });
	}

	const paths: string[] = [];
	let unknown = false;
	/** Records the paths an expression names; a computed one makes the result unknown. */
	const add = (text: string, at: number, depth = 0): void => {
		const expr = text.trim();
		const quoted = new RegExp(`^${literal(1)}$`).exec(expr);
		if (quoted) {
			if (quoted[1] === "`" && quoted[2]!.includes("${")) unknown = true;
			else paths.push(quoted[2]!);
			return;
		}
		const wrapped = /^(?:pathlib\.)?Path\(([\s\S]*)\)$/.exec(expr);
		if (wrapped) return add(wrapped[1]!, at, depth);
		if (!/^[A-Za-z_]\w*$/.test(expr) || depth > 3) {
			unknown = true;
			return;
		}
		const latest = [...assignments.filter((a) => a.name === expr && a.at < at).map((a) => ({ ...a, alias: false })),
			...aliases.filter((a) => a.name === expr && a.at < at).map((a) => ({ name: a.name, value: a.target, at: a.at, alias: true }))]
			.sort((a, b) => a.at - b.at).at(-1);
		if (latest) {
			if (latest.alias) add(latest.value, latest.at, depth + 1);
			else paths.push(latest.value);
			return;
		}
		const helper = functions.filter((f) => f.at < at && f.params.includes(expr)).at(-1);
		const calls = helper ? [...script.matchAll(new RegExp(String.raw`(?<!def\s|function\s)\b${helper.name}\(`, "g"))].filter((c) => c.index !== helper.at) : [];
		if (!helper || calls.length === 0) {
			unknown = true;
			return;
		}
		const index = helper.params.indexOf(expr);
		for (const call of calls) add(callArguments(call.index! + call[0].length - 1)[index] ?? "", call.index!, depth + 1);
	};
	/** The comma-separated arguments of the call whose `(` is at `open`, at the top nesting level. */
	const callArguments = (open: number): string[] => {
		const args: string[] = [];
		let depth = 0;
		let start = open + 1;
		let quote: string | null = null;
		for (let i = open; i < script.length; i += 1) {
			const c = script[i]!;
			if (quote) {
				if (c === "\\") i += 1;
				else if (c === quote) quote = null;
			} else if (c === "'" || c === '"' || c === "`") quote = c;
			else if ("([{".includes(c)) depth += 1;
			else if (")]}".includes(c)) {
				depth -= 1;
				if (depth === 0) {
					args.push(script.slice(start, i));
					break;
				}
			} else if (c === "," && depth === 1) {
				args.push(script.slice(start, i));
				start = i + 1;
			}
		}
		return args;
	};

	for (const m of script.matchAll(/\bopen\(/g)) {
		const args = callArguments(m.index! + 4);
		const mode = args.slice(1).map((a) => a.replace(/^\s*mode\s*=\s*/, "").trim()).find((a) => /^['"][a-z+]*['"]$/.test(a));
		// Python: a write mode; Perl-style `open(F, ">x")` is not covered.
		if (mode && /[wax+]/.test(mode)) add(args[0] ?? "", m.index!);
	}
	for (const m of script.matchAll(/\.(write_text|write_bytes|unlink|rename|replace|touch|mkdir|rmdir)\(/g)) {
		const receiver = /((?:pathlib\.)?Path\(\s*(['"])(?:(?!\2).)*\2\s*\)|[A-Za-z_]\w*|\))$/.exec(script.slice(0, m.index!))?.[1];
		// `str.replace(a, b)` is far more common than `Path.replace`: rename and replace count only on a
		// receiver that is a Path, written out or assigned one.
		if (m[1] === "replace" || m[1] === "rename") {
			const isPath = receiver !== undefined && (receiver.includes("Path(") || /^[A-Za-z_]\w*$/.test(receiver) && new RegExp(String.raw`\b${receiver}\s*=\s*(?:pathlib\.)?Path\(`).test(script));
			if (!isPath) continue;
		}
		if (receiver && receiver !== ")") add(receiver, m.index!);
		else unknown = true;
	}
	const firstArgument = /\b(?:fs\.|fsp\.|promises\.)?(?:writeFileSync|writeFile|appendFileSync|appendFile|rmSync|unlinkSync|unlink|rm|mkdirSync|copyFileSync|renameSync|cpSync)\(|\bBun\.write\(|\bFile\.(?:write|delete|rename)\(|\bos\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir)\(|\bshutil\.(?:rmtree)\(/g;
	for (const m of script.matchAll(firstArgument)) {
		// Bare `rm(`/`unlink(` only after `fs.`-style receivers or as Node imports; skip method calls on other objects.
		if (/^(?:rm|unlink)\($/.test(m[0]) && !/(?:fs|fsp|promises)\.$/.test(script.slice(Math.max(0, m.index! - 9), m.index!))) continue;
		const args = callArguments(m.index! + m[0].length - 1);
		const isCopy = /copyFileSync|renameSync|cpSync|rename|replace/.test(m[0]);
		add(args[0] ?? "", m.index!);
		if (isCopy) add(args[1] ?? "", m.index!);
	}
	for (const m of script.matchAll(/\bshutil\.(?:copy\w*|move)\(/g)) {
		const args = callArguments(m.index! + m[0].length - 1);
		add(args[1] ?? "", m.index!);
		if (m[0].includes("move")) add(args[0] ?? "", m.index!);
	}
	return { paths, unknown };
}
