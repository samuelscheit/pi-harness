// Refusal of a commit or push gated on a pipeline that ends in a filter (extensions/bash/gate.ts).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { gatedPublishes, gateRefusal } from "../extensions/bash/gate.ts";

const INCIDENT = 'cd /repo && bun test src/ 2>&1 | grep -E " pass$| fail$" && git add -A && git commit -m "fix: parse" && git push';

describe("refused: a publish gated on a pipeline whose status is a filter's", () => {
	for (const [command, pipelines, commands] of [
		[INCIDENT, ['bun test src/ 2>&1 | grep -E " pass$| fail$"'], ['git commit -m "fix: parse"', "git push"]],
		["npm test | tail -20 && git push", ["npm test | tail -20"], ["git push"]],
		["bun test 2>&1 | tee log && git commit -m x", ["bun test 2>&1 | tee log"], ["git commit -m x"]],
		["bun test |& tee log && git commit -m x", ["bun test |& tee log"], ["git commit -m x"]],
		// The producer's status is dropped; the tool cannot tell a check from a query, and `set -o pipefail;` is a one-word fix.
		["git log | grep x && git commit -m y", ["git log | grep x"], ["git commit -m y"]],
		["tests | grep -q ok || git commit -m y", ["tests | grep -q ok"], ["git commit -m y"]],
		["tests | grep -q ok && make && git -C repo commit -m y", ["tests | grep -q ok"], ["git -C repo commit -m y"]],
		["if npm test | tail -3; then git commit -m y; fi", ["npm test | tail -3"], ["git commit -m y"]],
		["if true; then :; elif npm test | tail -3; then git push; fi", ["npm test | tail -3"], ["git push"]],
		["if npm test | tail -3; then :; else git push; fi", ["npm test | tail -3"], ["git push"]],
		["while npm test | grep -q flaky; do git push; done", ["npm test | grep -q flaky"], ["git push"]],
		["(npm test | tail -3) && git push", ["npm test | tail -3"], ["git push"]],
		["{ npm test | tail -3; } && git push", ["npm test | tail -3"], ["git push"]],
		["out=$(npm test | tail -3) && git push", ["npm test | tail -3"], ["git push"]],
		["npm test | tail -3 && echo $(git commit -m y)", ["npm test | tail -3"], ["git commit -m y"]],
		["npm test | tail -3 && bash -c 'git push'", ["npm test | tail -3"], ["git push"]],
		["bash -c 'npm test | tail -3 && git push'", ["npm test | tail -3"], ["git push"]],
		["eval 'npm test | tail -3 && git push'", ["npm test | tail -3"], ["git push"]],
		["npm test | tail -3 && gh pr create --fill", ["npm test | tail -3"], ["gh pr create --fill"]],
		["npm test | tail -3 && gh pr merge 12", ["npm test | tail -3"], ["gh pr merge 12"]],
		["npm test | tail -3 && npm publish", ["npm test | tail -3"], ["npm publish"]],
		["npm test | tail -3 && nohup env A=1 git push", ["npm test | tail -3"], ["nohup env A=1 git push"]],
		// Under `set -e` a sequence is gated too; the list's status is its last command's.
		["set -e; npm test | tail -3; git commit -m y", ["npm test | tail -3"], ["git commit -m y"]],
		["set -o errexit\nnpm test | tail -3\ngit push", ["npm test | tail -3"], ["git push"]],
		["set -e; make || true; npm test | tail -3 && echo ok; git push", [], []],
		// A negated pipeline hides the failure even with pipefail.
		["set -o pipefail; ! npm test | grep -q fail && git push", ["! npm test | grep -q fail"], ["git push"]],
		// pipefail set and then unset, or set only in a subshell or another shell.
		["set -o pipefail; set +o pipefail; npm test | tail -3 && git push", ["npm test | tail -3"], ["git push"]],
		["(set -o pipefail); npm test | tail -3 && git push", ["npm test | tail -3"], ["git push"]],
		["bash -o pipefail -c true; npm test | tail -3 && git push", ["npm test | tail -3"], ["git push"]],
		// Multi-line, with a heredoc before it.
		["cd repo\ncat > notes <<'EOF'\nnpm test | tail && git push\nEOF\nnpm test 2>&1 |\n  tail -5 &&\n  git push", ["npm test 2>&1 |\n  tail -5"], ["git push"]],
	] as const) {
		test(JSON.stringify(command), () => {
			const found = gatedPublishes(command);
			assert.deepEqual(found.pipelines, pipelines);
			assert.deepEqual(found.commands, commands);
		});
	}
});

describe("allowed", () => {
	for (const command of [
		// The check's own status gates the commit.
		"bun test > test.log 2>&1 && git commit -m x",
		"bun test && git commit -m x && git push",
		// pipefail keeps the producer's failure; a filter at the end can only add a condition.
		"set -o pipefail; npm test | tail -20 && git push",
		"set -o pipefail; bun test 2>&1 | grep -E ' pass$| fail$' && git commit -m x",
		"set -euo pipefail\nnpm test | tail -20\ngit push",
		"set -o pipefail && npm test | tail -20 && git push",
		"bash -o pipefail -c 'npm test | tail -20 && git push'",
		"bash -euo pipefail -c 'npm test | tail -20 && git push'",
		// Unconditional sequences (no `set -e`).
		"npm test | tail -20; git commit -m x",
		"npm test | tail -20\ngit push",
		"npm test | tail -20 & git push",
		// The publish comes first, or the pipeline only follows it.
		"git commit -m x && git log --oneline | head -3",
		"git push 2>&1 | tail -2",
		"git commit -m x | tee commit.log",
		// A pipeline in a substitution the gate does not depend on.
		'echo "$(npm test | tail -3)" && git commit -m x',
		"git commit -m \"$(git diff | head -1)\"",
		// Only printing into a filter: nothing to hide.
		"cat test.log | grep -q '0 fail' && git commit -m x",
		"echo $out | grep -q ok && git push",
		"grep -q '0 fail' test.log && git commit -m x",
		// The last command decides, and it is the check.
		"echo y | npm test && git push",
		// `|` in quoted text, a comment or a heredoc is not a pipeline.
		"git commit -m 'tests | grep pass && done'",
		'echo "a | grep b" && git push',
		"# npm test | tail && git push\ngit status",
		"cat <<'EOF' && git push\nnpm test | tail -3\nEOF",
		// No publish.
		"npm test | grep -E ' pass$| fail$' && echo ok",
		"git log | grep x && git show HEAD",
		"if npm test | tail -3; then echo ok; fi; git push",
		"",
	]) {
		test(JSON.stringify(command), () => assert.equal(gateRefusal(command), undefined));
	}
});

describe("the refusal", () => {
	test("names what is published, the pipeline, the gated commands, why, and what to do instead", () => {
		const text = gateRefusal(INCIDENT)!;
		assert.match(text, /^Not run: this command runs `git commit`, `git push` only if a pipeline ending in a filter succeeds:\n- `bun test src\/ 2>&1 \| grep -E " pass\$\| fail\$"`\n/);
		assert.match(text, /Gated: `git commit -m "fix: parse"`, `git push`\./);
		assert.match(text, /A pipeline's exit status is its last command's/);
		assert.match(text, /would run even when the tests or the build fail/);
		assert.match(text, /`cmd > check\.log 2>&1 && git commit …`, then read the log/);
		assert.match(text, /`set -o pipefail; cmd 2>&1 \| tail -20 && git commit …`/);
	});

	test("each pipeline once, long commands clipped", () => {
		const long = `git commit -m ${"x".repeat(300)}`;
		const text = gateRefusal(`a | tail && ${long} && git push; a | tail && git push`)!;
		assert.equal(text.match(/^- `a \| tail`$/gm)?.length, 1);
		assert.match(text, /`git commit -m x+…`/);
	});
});
