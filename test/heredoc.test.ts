// Refusal of a `tool` command fed a heredoc the shell expands (extensions/bash/heredoc.ts).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { expandedToolInputs, toolHeredocRefusal } from "../extensions/bash/heredoc.ts";

const BLOCK = "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE";
const INCIDENT = `V=Zpo/Fiktion.lean\ntool edit - <<EOF && lake build\n$V\n<<<<<<< SEARCH\n/-- see \`zpo.p130e_1_fiktion\` -/\n=======\n/-- see \`zpo.p130e_1\` -/\n>>>>>>> REPLACE\nEOF\n`;

describe("refused: a tool reads an unquoted heredoc with expansions", () => {
	for (const [command, expansions] of [
		[INCIDENT, ["$V", "`zpo.p130e_1_fiktion`", "`zpo.p130e_1`"]],
		[`tool edit - <<EOF\na.ts\n${BLOCK}\nconst s = \`\${x}\`\nEOF`, ["`${x}`"]],
		["tool edit - <<EOF\n$(pwd)/a.ts\nEOF", ["$(pwd)"]],
		["tool edit - <<EOF\n${DIR}/a.ts\nEOF", ["${DIR}"]],
		["tool edit - <<EOF\nx = $((1 + 2))\nEOF", ["$((1 + 2))"]],
		["tool edit - <<EOF\n$1\nEOF", ["$1"]],
		// `<<-` strips tabs; the body is expanded all the same.
		["tool edit - <<-EOF\n\ta.ts `x`\n\tEOF", ["`x`"]],
		// Other tools that read stdin, and wrappers.
		["tool workflow --args - <<EOF\n{\"code\": \"return \\`$HOME\\`\"}\nEOF", ["$HOME"]],
		["timeout 60 tool edit - <<EOF\n$X\nEOF", ["$X"]],
		["tool edit - 0<<EOF\n$X\nEOF", ["$X"]],
		// Piped into the tool.
		["cat <<EOF | tool edit -\n$X\nEOF", ["$X"]],
		// One of several heredocs, in a chain after other heredocs.
		["cat > notes <<EOF\n$keep\nEOF\ntool edit - <<'A' && tool edit - <<B\n$quoted\nA\n`run`\nB", ["`run`"]],
		["if true; then tool edit - <<EOF\n$X\nEOF\nfi", ["$X"]],
	] as const) {
		test(JSON.stringify(command), () => assert.deepEqual(expandedToolInputs(command).flatMap((f) => f.expansions), expansions));
	}
});

describe("allowed", () => {
	for (const command of [
		// Quoted delimiters pass the body verbatim.
		`tool edit - <<'EOF'\na.ts\n${BLOCK}\n\`x\` $y $(z)\nEOF`,
		'tool edit - <<"EOF"\n`x` $y\nEOF',
		"tool edit - <<\\EOF\n`x` $y\nEOF",
		"tool edit - <<E'O'F\n`x` $y\nEOF",
		"tool edit - <<-'EOF'\n\t`x` $y\n\tEOF",
		// Unquoted without expansions reaches the tool unchanged; escaped ones are literal.
		`tool edit - <<EOF\na.ts\n${BLOCK}\nEOF`,
		"tool edit - <<EOF\nprice \\$5 and \\`x\\`\nEOF",
		// Heredocs of other commands, also beside a tool command.
		"cat > a.sh <<EOF\n$HOME `pwd`\nEOF",
		"git commit -F - <<EOF\nfix: $X\nEOF",
		"cat <<EOF > blocks\n$X\nEOF\ntool edit - < blocks",
		"tool read a.ts; cat <<EOF\n$X\nEOF",
		"tool edit - <<'EOF' | grep x\n$X\nEOF",
		// A heredoc on another descriptor than stdin.
		"tool edit - 3<<EOF\n$X\nEOF",
		// Arguments of a tool, not stdin.
		'tool read "$HOME/a.ts"',
		"",
	]) {
		test(JSON.stringify(command), () => assert.equal(toolHeredocRefusal(command), undefined));
	}
});

describe("the refusal", () => {
	test("names the tool command, the expansions, why, and the quoted form", () => {
		const text = toolHeredocRefusal(INCIDENT)!;
		assert.match(text, /^Not run: this command feeds `tool` a heredoc with an unquoted delimiter, so the shell expands its body first:\n- `tool edit - <<EOF`\n/);
		assert.match(text, /Expanded: `\$V`, `` `zpo\.p130e_1_fiktion` ``|Expanded: `\$V`, `\`zpo\.p130e_1_fiktion\``/);
		assert.match(text, /backtick spans in Lean doc comments ran as commands/);
		assert.match(text, /`tool edit - <<'EOF'`/);
	});
});
