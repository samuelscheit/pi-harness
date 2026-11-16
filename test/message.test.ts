// Refusal of a commit or tag that reads its message from a file (extensions/bash/message.ts), and the
// option and stdin parsing it shares (extensions/bash/commands.ts).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { commandsIn, gitOptions } from "../extensions/bash/commands.ts";
import { messageFileRefusal } from "../extensions/bash/message.ts";

/** The commands a refusal lists, or undefined when the command runs. */
const refused = (source: string) => {
	const text = messageFileRefusal(source);
	if (text === undefined) return undefined;
	assert.match(text, /^Not run: this command reads a commit or tag message from a file:\n/);
	return [...text.matchAll(/^- `(.*)`$/gm)].map((m) => m[1]);
};

describe("a message read from a file", () => {
	for (const [source, commands] of [
		["git commit -F /tmp/msg.txt", ["git commit -F /tmp/msg.txt"]],
		["git commit --only a.ts b.ts -F /tmp/c5.txt", ["git commit --only a.ts b.ts -F /tmp/c5.txt"]],
		["git commit -F/tmp/msg.txt", ["git commit -F/tmp/msg.txt"]],
		["git commit -aF msg.txt", ["git commit -aF msg.txt"]],
		["git commit -qaFmsg.txt", ["git commit -qaFmsg.txt"]],
		["git commit --file /tmp/m", ["git commit --file /tmp/m"]],
		["git commit --file=/tmp/m", ["git commit --file=/tmp/m"]],
		["git commit --amend -F '/tmp/my msg.md'", ["git commit --amend -F '/tmp/my msg.md'"]],
		["git commit --amend --no-edit -F \"$F\"", ["git commit --amend --no-edit -F \"$F\""]],
		["git -C /repo commit -F /tmp/m", ["git -C /repo commit -F /tmp/m"]],
		["git -c commit.cleanup=verbatim commit -F /tmp/m", ["git -c commit.cleanup=verbatim commit -F /tmp/m"]],
		["F=$(mktemp); printf 'x\\n' > \"$F\"; git commit -F \"$F\"", ["git commit -F \"$F\""]],
		["git add a && git commit -F m.txt && git push", ["git commit -F m.txt"]],
		["cd /repo; git commit -F m.txt | tail -1", ["git commit -F m.txt"]],
		["nohup env X=1 git commit -F m.txt", ["nohup env X=1 git commit -F m.txt"]],
		["bash -c 'git commit -F /tmp/m'", ["git commit -F /tmp/m"]],
		["x=$(git commit-tree HEAD^{tree} -p HEAD -F /tmp/m)", ["git commit-tree HEAD^{tree} -p HEAD -F /tmp/m"]],
		["git tag -a v1 -F notes.md", ["git tag -a v1 -F notes.md"]],
		["git tag --file=notes.md -a v1", ["git tag --file=notes.md -a v1"]],
		["git commit -F - < /tmp/msg.txt", ["git commit -F - < /tmp/msg.txt"]],
		["git commit -F /dev/stdin 0< /tmp/msg.txt", ["git commit -F /dev/stdin 0< /tmp/msg.txt"]],
		["git commit -m a -F /tmp/m -m b", ["git commit -m a -F /tmp/m -m b"]],
		["git commit -F - -F /tmp/m <<'EOF'\nx\nEOF", ["git commit -F - -F /tmp/m <<'EOF'"]],
	] as const) {
		test(`refused: ${source.split("\n")[0]}`, () => assert.deepEqual(refused(source), commands));
	}

	for (const source of [
		"git commit --only a.ts -F - <<'EOF'\nfeat: x\n\n## Why\nbody\nEOF",
		"git commit -F- <<'EOF'\nx\nEOF",
		"git commit --file=- <<'EOF'\nx\nEOF",
		"git commit --file - <<'EOF'\nx\nEOF",
		"git commit -qaF - <<'EOF'\nx\nEOF",
		"git commit -F /dev/stdin <<'EOF'\nx\nEOF",
		"git commit --amend -F - <<< 'fix: title'",
		"git -C /repo commit -F - <<'EOF'\nx\nEOF",
		"git commit -m 'feat: x' -m 'body'",
		"git commit -m-F -m /tmp/x",
		"git commit -qm 'uses -F /tmp/m in text'",
		"git commit --message=-F",
		"git commit -C HEAD --amend",
		"git commit --fixup HEAD~2",
		"git commit --author 'A <a@b>' -m x -- -F",
		"git commit -F - 2> err.log <<'EOF'\nx\nEOF",
		"git commit-tree HEAD^{tree} -p HEAD -m x",
		"git tag -a v1 -m 'release'",
		"git log -F --grep x",
		"echo 'git commit -F /tmp/m'",
		"cat <<'EOF'\ngit commit -F /tmp/m\nEOF",
		"# git commit -F /tmp/m",
		"gitk -F /tmp/m",
	]) {
		test(`runs: ${source.split("\n")[0]}`, () => assert.equal(messageFileRefusal(source), undefined));
	}

	test("the refusal shows the heredoc form, and why", () => {
		const text = messageFileRefusal("git commit -F /tmp/msg.txt")!;
		assert.match(text, /```\ngit commit --only <paths> -F - <<'EOF'\n<type>\(<scope>\): <title>\n\n<body>\nEOF\n```/);
		assert.match(text, /overwrote each other's files/);
		assert.match(text, /keeps lines starting with `#`/);
	});

	test("lists each refused command once", () => {
		assert.deepEqual(refused("git commit -F m && git commit -F m; git tag -F n v1"), ["git commit -F m", "git tag -F n v1"]);
	});
});

describe("git option parsing", () => {
	const valuedLong = new Set(["--file", "--message"]);
	const valuedShort = new Set(["F", "m"]);
	const parse = (...args: string[]) => {
		const { flags, values, pathspecs } = gitOptions(args, valuedLong, valuedShort);
		return { flags: [...flags], values: Object.fromEntries(values), pathspecs };
	};

	test("short clusters, attached and separate values, long options with = and without, --", () => {
		assert.deepEqual(parse("-qaFmsg", "-m", "a b", "--file=f1", "--file", "f2", "--only", "x.ts", "--", "-F", "y"), {
			flags: ["q", "a", "F", "m", "--file", "--only"],
			values: { F: ["msg"], m: ["a b"], "--file": ["f1", "f2"] },
			pathspecs: ["x.ts", "-F", "y"],
		});
	});

	test("a value that looks like an option is the option's value; a valued option at the end has none", () => {
		assert.deepEqual(parse("-m", "-F", "-F"), { flags: ["m", "F"], values: { m: ["-F"] }, pathspecs: [] });
		assert.deepEqual(parse("--file=", "--message=a=b"), { flags: ["--file", "--message"], values: { "--file": [""], "--message": ["a=b"] }, pathspecs: [] });
	});
});

describe("stdin of a command", () => {
	const stdin = (source: string) => commandsIn(source).map((c) => c.stdin);

	test("a `<` or `0<` redirect names it; heredocs, here-strings, other descriptors and outputs do not", () => {
		assert.deepEqual(stdin("git commit -F - < /tmp/m"), ["/tmp/m"]);
		assert.deepEqual(stdin("< a git commit -F - 0< b"), ["b"], "the last redirect wins, also from the prefix");
		assert.deepEqual(stdin("nohup git commit -F - < m"), ["m", "m"], "wrapped commands share it");
		assert.deepEqual(stdin("git commit -F - <<'EOF'\nx\nEOF"), [undefined]);
		assert.deepEqual(stdin("git commit -F - <<< x"), [undefined]);
		assert.deepEqual(stdin("git commit -F - 3< m > out 2>&1"), [undefined]);
		assert.deepEqual(stdin("git commit -F - {fd}< m"), [undefined]);
	});
});
