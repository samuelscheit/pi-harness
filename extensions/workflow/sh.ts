// sh`…`: a shell command with every interpolated value inserted as one quoted shell word, so a
// value never becomes shell syntax: `; rm -rf /`, `$(…)`, backticks, quotes and newlines arrive as
// literal text. The template is taken raw (backslashes stay shell escapes). A value inside quotes
// of the template is refused, since the quoted value would carry its quotes into the string. A
// value starting with `-` is still read as an option by the command: put `--` before such values.

import { shellQuote } from "../lib/process.ts";

function word(value: unknown, index: number): string {
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError(`sh: value ${index + 1} is not a finite number`);
		return shellQuote(String(value));
	}
	if (typeof value === "string") {
		if (value.includes("\0")) throw new TypeError(`sh: value ${index + 1} contains a NUL character`);
		return shellQuote(value);
	}
	throw new TypeError(`sh: value ${index + 1} must be a string, a number or an array of them, got ${value === null ? "null" : typeof value}`);
}

/** The quote a literal leaves open, starting inside `quote`. */
function openQuote(literal: string, quote: "'" | '"' | undefined): "'" | '"' | undefined {
	for (let i = 0; i < literal.length; i++) {
		const char = literal[i]!;
		if (quote !== "'" && char === "\\") {
			i += 1;
			continue;
		}
		if (char !== "'" && char !== '"') continue;
		if (quote === undefined) quote = char;
		else if (quote === char) quote = undefined;
	}
	return quote;
}

/** Tag: the command with each value quoted (arrays: each element, separated by spaces). */
export function sh(strings: TemplateStringsArray, ...values: unknown[]): string {
	if (!strings || !Array.isArray(strings.raw)) throw new TypeError("sh is a template tag: sh`grep -rn -- ${pattern} src`");
	let quote: "'" | '"' | undefined;
	let command = "";
	strings.raw.forEach((literal, i) => {
		quote = openQuote(literal, quote);
		command += literal;
		if (i >= values.length) return;
		if (quote) throw new TypeError(`sh: value ${i + 1} stands inside ${quote === "'" ? "single" : "double"} quotes; values are quoted already, write it unquoted`);
		const value = values[i];
		command += Array.isArray(value) ? value.map((item) => word(item, i)).join(" ") : word(value, i);
	});
	return command;
}
