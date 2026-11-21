// Refusal of a `tool` command fed a heredoc the shell expands (extensions/bash/heredoc.ts).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { expandedToolInputs, quotedToolSubstitutions, toolHeredocRefusal, toolQuotedArgumentRefusal } from "../extensions/bash/heredoc.ts";

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

describe("refused: a double-quoted tool argument with a command substitution", () => {
	for (const [command, expansions] of [
		// The incident: a backtick span in a message.
		['tool mcp__t3-code__t3_thread_send --threadId t1 --message "bitte `uebernehmen ns` und weiter"', ["`uebernehmen ns`"]],
		['tool send --message "result: $(git rev-parse HEAD)"', ["$(git rev-parse HEAD)"]],
		['tool send --message "a `b` and $(c) and `b`"', ["`b`", "$(c)"]],
		['tool send --message="x `y`"', ["`y`"]],
		['tool send "`y`"', ["`y`"]],
		['tool read "$(pwd)/a.ts"', ["$(pwd)"]],
		['tool send --message "multi\nline `x`\nmore"', ["`x`"]],
		['tool send --a "ok" --b "bad `x`"', ["`x`"]],
		['tool send --message "a \\`esc\\` and `real`"', ["`real`"]],
		['tool send --message "nested $(echo "$(inner)")"', ["$(echo \"$(inner)\")"]],
		// Behind wrappers, in chains, loops, functions, background, pipelines.
		['timeout 60 tool send --message "x `y`"', ["`y`"]],
		['cd x && tool send --message "x `y`" && echo ok', ["`y`"]],
		['for t in a b; do tool send --threadId $t --message "x `y`"; done', ["`y`"]],
		['tool send --message "x `y`" > out.log 2>&1 &', ["`y`"]],
		['echo hi | tool send --message "x `y`"', ["`y`"]],
		['f() { tool send --message "x `y`"; }; f', ["`y`"]],
		['if tool send --message "x $(y)"; then :; fi', ["$(y)"]],
	] as const) {
		test(command, () => {
			assert.deepEqual(quotedToolSubstitutions(command).flatMap((f) => f.expansions), expansions);
			const text = toolQuotedArgumentRefusal(command)!;
			assert.match(text, /^Not run: this command passes `tool` a double-quoted argument with a command substitution/);
			assert.match(text, /single quotes/);
			assert.match(text, /--message - <<'EOF'/);
		});
	}
});

describe("allowed: tool arguments", () => {
	for (const command of [
		// Single quotes, escapes, variables, plain text.
		"tool send --message 'bitte `uebernehmen ns` und $(x)'",
		'tool send --message "bitte \\`uebernehmen ns\\` und \\$(x)"',
		'tool send --message "path $HOME/a and ${X}"',
		'tool send --message "plain text"',
		"tool send --message - <<'EOF'\nbitte `uebernehmen ns` $(x)\nEOF",
		"tool edit - <<'EOF'\n`x` $(y)\nEOF",
		// Substitution outside quotes is deliberate (a tool path from a command).
		"tool read $(pwd)/a.ts",
		"tool send --message `cat msg.txt`",
		// The command substitution is another command's argument.
		'echo "`date`" && tool read a.ts',
		'tool read a.ts; git commit -m "fix `x` and $(y)"',
		'git commit -m "tool send --message \\"`x`\\""',
		'x="$(tool read a.ts)"',
		'echo "tool send --message \\"`x`\\""',
		"# tool send --message \"`x`\"",
		"cat <<'EOF'\ntool send --message \"`x`\"\nEOF",
		'grep "`x`" notes',
		"",
	]) {
		test(JSON.stringify(command), () => assert.equal(toolQuotedArgumentRefusal(command), undefined));
	}
});
