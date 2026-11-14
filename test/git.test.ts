// Git commands that discard uncommitted work (extensions/bash/git.ts), and the command parsing they
// share with the `setsid` refusal (extensions/bash/commands.ts).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { commandsIn, gitCommand } from "../extensions/bash/commands.ts";
import { gitRefusal } from "../extensions/bash/git.ts";

const refusedAs = (command: string) => [...(gitRefusal(command) ?? "").matchAll(/^Not run: this command ([^:]+):/gm)].map((m) => m[1]);

describe("commands a command line runs", () => {
	test("wrappers, assignments, chains, functions, substitutions, eval and bash -c; quoted text, comments and heredoc bodies do not run", () => {
		const source = [
			"FOO=1 nohup env BAR=2 git -C dir status && echo 'git stash' \"git stash\"",
			"f() { sudo -E git log; }; x=$(git rev-parse HEAD)",
			"eval git fetch; bash -lc 'cd /x && git pull'",
			"# git stash in a comment",
			"cat <<'EOF'\ngit stash\nEOF",
		].join("\n");
		const commands = commandsIn(source);
		assert.deepEqual(
			commands.map((c) => [c.name, ...c.args].join(" ")),
			[
				"nohup env BAR=2 git -C dir status",
				"env BAR=2 git -C dir status",
				"git -C dir status",
				"echo git stash git stash",
				"sudo -E git log",
				"git log",
				"git rev-parse HEAD",
				"eval git fetch",
				"git fetch",
				"bash -lc cd /x && git pull",
				"cd /x",
				"git pull",
				"cat",
			],
		);
		assert.deepEqual(commands[2]!.env, { FOO: "1", BAR: "2" }, "the prefix assignment and env's");
		assert.equal(commands[2]!.text, "FOO=1 nohup env BAR=2 git -C dir status");
	});

	test("git's options before the subcommand: -C dirs in order, valued options skipped", () => {
		const git = (source: string) => gitCommand(commandsIn(source)[0]!);
		assert.deepEqual(git("git -C a -C 'b c' -c core.x=1 --no-pager --git-dir .git stash pop"), {
			dirs: ["a", "b c"],
			subcommand: "stash",
			args: ["pop"],
			command: commandsIn("git -C a -C 'b c' -c core.x=1 --no-pager --git-dir .git stash pop")[0],
		});
		assert.equal(git("git --version"), undefined);
		assert.equal(git("/usr/bin/git status")?.subcommand, "status");
		assert.equal(git("gitk --all"), undefined);
	});
});

describe("refused git commands", () => {
	for (const [command, kinds] of [
		["git stash", ["runs `git stash`"]],
		["git stash -u", ["runs `git stash`"]],
		["git stash push -m wip src/a.ts", ["runs `git stash`"]],
		["git stash save x", ["runs `git stash`"]],
		["git stash pop", ["runs `git stash`"]],
		["git stash apply stash@{1}", ["runs `git stash`"]],
		["git stash drop", ["runs `git stash`"]],
		["git stash clear", ["runs `git stash`"]],
		["git stash; npm run bench; git stash pop", ["runs `git stash`"]],
		["git -C /repo stash", ["runs `git stash`"]],
		["cd pkg && GIT_DIR=.git nohup git stash &", ["runs `git stash`"]],
		["env -i git stash", ["runs `git stash`"]],
		["bash -c 'git stash && make && git stash pop'", ["runs `git stash`"]],
		["git reset --hard", ["runs `git reset --hard`"]],
		["git reset --hard HEAD~1", ["runs `git reset --hard`"]],
		["git -C ../x reset -q --hard origin/main", ["runs `git reset --hard`"]],
		["git clean -f", ["runs `git clean` with `-f`"]],
		["git clean -fdx", ["runs `git clean` with `-f`"]],
		["git clean -d --force", ["runs `git clean` with `-f`"]],
		["git checkout -- .", ["discards the changes of the whole tree"]],
		["git checkout .", ["discards the changes of the whole tree"]],
		["git checkout HEAD -- :/", ["discards the changes of the whole tree"]],
		["git checkout -f main", ["discards the changes of the whole tree"]],
		["git checkout --force", ["discards the changes of the whole tree"]],
		["git restore .", ["discards the changes of the whole tree"]],
		["git restore --worktree --staged ./", ["discards the changes of the whole tree"]],
		["git restore -s HEAD~2 '*'", ["discards the changes of the whole tree"]],
		["git switch --discard-changes main", ["discards the changes of the whole tree"]],
		["git switch -f main", ["discards the changes of the whole tree"]],
		["git stash && git reset --hard && git stash pop", ["runs `git stash`", "runs `git reset --hard`"]],
	] as const) {
		test(`refused: ${JSON.stringify(command)}`, () => assert.deepEqual(refusedAs(command), kinds));
	}
});

describe("git commands that run", () => {
	for (const command of [
		"git stash list",
		"git stash show -p stash@{0}",
		"git -C /repo stash list",
		"git reset",
		"git reset --soft HEAD~1",
		"git reset HEAD src/a.ts",
		"git reset --keep HEAD~1",
		"git clean -n",
		"git clean -nfd",
		"git clean -f --dry-run",
		"git checkout main",
		"git checkout -b feature",
		"git checkout -- src/a.ts",
		"git checkout HEAD~1 -- src/a.ts ./b.ts",
		"git restore src/a.ts",
		"git restore --staged .",
		"git restore -S :/",
		"git switch main",
		"git switch -c feature",
		"git worktree add /tmp/x HEAD",
		"git commit -m 'git stash; git reset --hard'",
		"echo git stash | tee notes",
		"grep -rn 'git reset --hard' docs",
		"cat <<'EOF'\ngit stash\ngit clean -fdx\nEOF",
		"# git stash\ngit status",
		"",
	]) {
		test(`runs: ${JSON.stringify(command)}`, () => assert.equal(gitRefusal(command), undefined));
	}
});

describe("messages", () => {
	test("each refusal names the commands and the safe way", () => {
		const text = gitRefusal("git stash; make bench; git stash pop")!;
		assert.match(text, /^Not run: this command runs `git stash`:\n- `git stash`\n- `git stash pop`\n/);
		assert.match(text, /stash list is shared by every worktree/);
		assert.match(text, /`git worktree add \/tmp\/<name> HEAD`/);
		assert.match(text, /git commit --only <your paths>/);
		assert.match(text, /`git stash list` and `git stash show` still run/);
		assert.match(gitRefusal("git reset --hard")!, /git reset --soft <commit>`.*git restore <your paths>/s);
		assert.match(gitRefusal("git clean -fd")!, /`rm <path>`.*`git clean -n`/s);
		assert.match(gitRefusal("git checkout -- .")!, /Restore only the paths you changed: `git restore <your paths>`/);
	});

	test("two kinds in one command: one paragraph each, the same command listed once", () => {
		const text = gitRefusal("git stash && git stash && git clean -f")!;
		assert.equal(text.split("\n\n").length, 2);
		assert.equal(text.match(/^- `git stash`$/gm)?.length, 1);
	});
});
