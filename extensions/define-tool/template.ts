// Tools defined by the agent at runtime (define_tool): a name, a description, string and number
// parameters, and a shell command template whose `{{parameter}}` placeholders take the call's
// values, each quoted as one shell word. A value therefore never becomes shell syntax: `; rm -rf
// /`, `$(…)`, backticks, quotes and newlines arrive as literal text. Placeholders inside quotes in
// the template are refused, since the quoted value would carry its quotes into the string. A value
// starting with `-` is still read as an option by the command; templates put `--` before positional
// values where that matters.

import { shellQuote } from "../lib/process.ts";

export interface ParameterSpec {
	name: string;
	type: "string" | "number";
	description: string;
	/** Makes the parameter optional; used when the call leaves it out. */
	default?: string | number;
}

export interface ToolSpec {
	name: string;
	description: string;
	parameters: ParameterSpec[];
	command: string;
	/** Shell command that gets the output on stdin and prints what the model sees (e.g. `grep -E 'FAIL|Error'`). */
	outputFilter?: string;
	/** Keep only the last lines of the (filtered) output. */
	maxLines?: number;
	/** Directory to run in, relative to the session's working directory. */
	cwd?: string;
	/** `session` (default): this session only. `project`: also every later session in the repository. */
	scope?: "session" | "project";
}

export const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const PARAMETER_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** The placeholders of a template, in order, with whether each stands inside single or double quotes. */
export function placeholders(command: string): { name: string; quoted: boolean }[] {
	const found: { name: string; quoted: boolean }[] = [];
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		if (quote !== "'" && char === "\\") {
			i += 1;
			continue;
		}
		if (char === "'" || char === '"') {
			if (quote === undefined) quote = char;
			else if (quote === char) quote = undefined;
			continue;
		}
		if (char === "{" && command[i + 1] === "{") {
			PLACEHOLDER.lastIndex = i;
			const match = PLACEHOLDER.exec(command);
			if (match && match.index === i) {
				found.push({ name: match[1]!, quoted: quote !== undefined });
				i += match[0].length - 1;
			}
		}
	}
	return found;
}

/** Why a definition is invalid (undefined when valid). Name conflicts are the registry's concern. */
export function specProblem(spec: ToolSpec): string | undefined {
	if (!TOOL_NAME.test(spec.name)) return `name must match ${TOOL_NAME.source}`;
	if (!spec.description.trim()) return "description is empty";
	if (!spec.command.trim()) return "command is empty";
	const names = spec.parameters.map((p) => p.name);
	const bad = spec.parameters.find((p) => !PARAMETER_NAME.test(p.name));
	if (bad) return `parameter name ${JSON.stringify(bad.name)} must match ${PARAMETER_NAME.source}`;
	const duplicate = names.find((name, i) => names.indexOf(name) !== i);
	if (duplicate) return `parameter ${duplicate} is declared twice`;
	for (const p of spec.parameters) {
		if (p.type !== "string" && p.type !== "number") return `parameter ${p.name}: type must be string or number`;
		if (p.default !== undefined && typeof p.default !== p.type) return `parameter ${p.name}: default must be a ${p.type}`;
	}
	const used = placeholders(spec.command);
	const quoted = used.find((p) => p.quoted);
	if (quoted) return `placeholder {{${quoted.name}}} stands inside quotes; values are quoted already, write it unquoted`;
	const unknown = used.find((p) => !names.includes(p.name));
	if (unknown) return `placeholder {{${unknown.name}}} is not a declared parameter`;
	const unused = names.find((name) => !used.some((p) => p.name === name));
	if (unused) return `parameter ${unused} is not used in the command`;
	if (spec.maxLines !== undefined && (!Number.isInteger(spec.maxLines) || spec.maxLines < 1)) return "maxLines must be a positive integer";
	if (spec.outputFilter !== undefined && !spec.outputFilter.trim()) return "outputFilter is empty";
	if (spec.scope !== undefined && spec.scope !== "session" && spec.scope !== "project") return "scope must be session or project";
	return undefined;
}

/** One value as a shell word; throws for values a shell argument cannot hold. */
function quoteValue(p: ParameterSpec, value: unknown): string {
	if (p.type === "number") {
		if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${p.name} must be a finite number`);
		return shellQuote(String(value));
	}
	if (typeof value !== "string") throw new Error(`${p.name} must be a string`);
	if (value.includes("\0")) throw new Error(`${p.name} contains a NUL character`);
	return shellQuote(value);
}

/**
 * The shell script a call runs: the template with quoted values, in `cwd` when set, its output
 * (stdout and stderr) through the filter and cut to the last lines when set, exiting with the
 * command's own status.
 */
export function renderCommand(spec: ToolSpec, args: Record<string, unknown>): string {
	const byName = new Map(spec.parameters.map((p) => [p.name, p]));
	let command = spec.command.replace(PLACEHOLDER, (_, name: string) => {
		const p = byName.get(name)!;
		const value = args[name] ?? p.default;
		if (value === undefined) throw new Error(`missing parameter ${name}`);
		return quoteValue(p, value);
	});
	if (spec.cwd) command = `cd -- ${shellQuote(spec.cwd)} || exit\n${command}`;
	if (spec.outputFilter === undefined && spec.maxLines === undefined) return command;
	const filter = [spec.outputFilter, spec.maxLines === undefined ? undefined : `tail -n ${spec.maxLines}`].filter(Boolean).join(" | ");
	// The output is kept in a variable, not a temp file: no file write, so the metrics' shell
	// analysis does not count every call of a filtered tool as a file change. The command runs in a
	// subshell, so an `exit` in it ends only the command, not the filter after it.
	return [
		`__define_tool_out=$( (\n${command}\n) 2>&1 )`,
		"__define_tool_status=$?",
		`__define_tool_shown=$(printf '%s\\n' "$__define_tool_out" | { ${filter}\n})`,
		// A filter that drops everything usually expects another output format: say so instead of nothing.
		'if [ -z "$__define_tool_shown" ] && [ -n "$__define_tool_out" ]; then echo "[the output filter printed nothing; the command printed $(printf \'%s\\n\' "$__define_tool_out" | wc -l | tr -d " ") lines]"; else printf \'%s\\n\' "$__define_tool_shown"; fi',
		"exit $__define_tool_status",
	].join("\n");
}
