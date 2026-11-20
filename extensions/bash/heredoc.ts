// A `tool` command fed an unquoted heredoc that the shell expands is refused before it runs.
//
// 2026-11-19, twice in one thread: `tool edit - <<EOF` (unquoted, to expand a `$V` path) ran the
// backtick spans of Lean doc comments as command substitutions. Each became an empty string
// ("bash: zpo.p130e_1_fiktion: command not found") and the edit still reported "Successfully
// replaced": the file lost the text silently. A heredoc whose delimiter is unquoted (`<<EOF`,
// `<<-EOF`) expands `$x`, `${x}`, `$(…)`, backticks and `$((…))` in its body; a quoted one
// (`<<'EOF'`, `<<"EOF"`, `<<\EOF`, `<<E"O"F`) passes it verbatim. A tool reads stdin as content
// (SEARCH/REPLACE blocks, `--args -` JSON), so any expansion there changes what the tool gets.
//
// Refused: a heredoc with an unquoted delimiter and at least one expansion in its body, on the
// stdin of a `tool` command (behind wrappers too) or of a command piped into one
// (`cat <<EOF | tool edit -`). An unquoted heredoc without expansions reaches the tool unchanged
// and is allowed, as are heredocs of other commands (`cat <<EOF > file`, `git commit -F - <<EOF`).

import { type Command, forEachChild, type HereDoc, parse, type SyntaxNode } from "../../vendor/pi-lens/node_modules/unbash/dist/parser.js";
import { TOOL_COMMAND } from "./bridge.ts";
import { refusalText, unwrap } from "./commands.ts";

const EXPANSIONS = new Set(["SimpleExpansion", "ParameterExpansion", "CommandExpansion", "ArithmeticExpansion"]);

/** The heredocs on `command`'s stdin. */
const stdinHeredocs = (command: Command): HereDoc[] =>
	command.redirects.flatMap((r) => (r.type === "HereDoc" && (r.descriptor === undefined || (r.descriptor.type === "FileDescriptor" && r.descriptor.value === 0)) ? [r] : []));

/** The expansions (as written) the shell makes in `heredoc`'s body; none when its delimiter is quoted. */
const expansionsOf = (heredoc: HereDoc): string[] =>
	heredoc.delimiter?.quoted === false ? (heredoc.body.parts ?? []).flatMap((part) => (EXPANSIONS.has(part.type) ? [part.text] : [])) : [];

/** For each tool command fed an expanding heredoc in `source`: the tool command and the expansions. */
export function expandedToolInputs(source: string): { command: string; expansions: string[] }[] {
	const found = new Map<Command, string[]>();
	const isTool = (node: SyntaxNode): node is Command => node.type === "Command" && unwrap(node, source.slice(node.pos, node.end)).some((c) => c.name === TOOL_COMMAND);
	/** Records the expansions of the stdin heredocs of `feeders` against `tool`. */
	const feed = (tool: Command, feeders: readonly SyntaxNode[]) => {
		const expansions = feeders.flatMap((node) => (node.type === "Command" ? stdinHeredocs(node).flatMap(expansionsOf) : []));
		if (expansions.length > 0) found.set(tool, [...new Set([...(found.get(tool) ?? []), ...expansions])]);
	};
	const visit = (node: SyntaxNode) => {
		if (node.type === "Pipeline") node.commands.forEach((command, i) => isTool(command) && feed(command, node.commands.slice(0, i + 1)));
		else if (isTool(node)) feed(node, [node]);
		forEachChild(node, visit);
	};
	visit(parse(source));
	return [...found].map(([command, expansions]) => ({ command: source.slice(command.pos, command.end), expansions }));
}

/** Why `source` is refused, when a `tool` command reads an unquoted heredoc the shell expands; undefined otherwise. */
export function toolHeredocRefusal(source: string): string | undefined {
	const found = expandedToolInputs(source);
	if (found.length === 0) return undefined;
	return refusalText(
		`feeds \`${TOOL_COMMAND}\` a heredoc with an unquoted delimiter, so the shell expands its body first`,
		found.map((f) => f.command),
		`Expanded: ${[...new Set(found.flatMap((f) => f.expansions))].map((e) => `\`${e}\``).join(", ")}.`,
		"With `<<EOF` (or `<<-EOF`) the shell replaces `$x`, `${x}`, `$(…)`, backticks and `$((…))` in the body before the tool reads it (2026-11-19: backtick spans in Lean doc comments ran as commands and were replaced by empty text, and `tool edit` still reported success).",
		`Quote the delimiter so the body reaches the tool verbatim: \`${TOOL_COMMAND} edit - <<'EOF'\`, and write paths literally instead of through variables.`,
	);
}
