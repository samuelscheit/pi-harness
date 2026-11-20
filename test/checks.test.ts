// Refusal of a publish that runs even when a check before it failed (extensions/bash/checks.ts).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isCheck, ungatedPublishes, ungatedRefusal } from "../extensions/bash/checks.ts";

const INCIDENT = "cd repo && (npm run test:unit 2>&1 | grep -E 'pass|fail'); (npm run lint 2>&1 | tail -5); git commit -m 'fix: x' --only a.ts; gh pr merge 12 --squash";

const words = (line: string) => {
	const [name, ...args] = line.split(" ");
	return { name: name!, args };
};

describe("isCheck", () => {
	for (const line of [
		"npm test", "npm t", "npm run test:unit", "npm run -s typecheck", "npm run lint", "npm run build", "pnpm lint", "pnpm run check-types", "yarn test", "yarn typecheck", "bun test",
		"bun run build", "npx tsc --noEmit", "npx -y vitest run", "pnpm exec eslint .", "uv run pytest -q", "poetry run mypy src", "bundle exec rspec", "pytest", "py.test", "jest",
		"vitest", "tsc", "eslint .", "biome check", "ruff check .", "mypy .", "cargo test", "cargo build --release", "cargo clippy", "go test ./...", "go vet ./...", "deno test",
		"dotnet test", "swift build", "lake build", "make", "make test", "make -j4 lint", "just check", "cmake --build build", "prettier --check .", "black --check .",
		"node --test test/gate.test.ts", "node test/gate.test.ts", "python -m pytest", "python3 -m unittest", "python manage.py test", "python tests/test_x.py", "tsx foo.spec.ts",
		"test.sh", "ci.sh", "run_tests.sh", "build", "gradlew build", "xcodebuild -scheme App",
	]) {
		test(`check: ${line}`, () => assert.equal(isCheck(words(line)), true));
	}
	for (const line of [
		"npm install", "npm run dev", "npm start", "npm ci", "pnpm install", "yarn add x", "bun install", "bun run dev", "npx prettier --write .", "cargo run", "cargo fmt", "go run .",
		"make install", "make clean", "prettier --write .", "black .", "node server.js", "python script.py", "python -m http.server", "git status", "git commit -m test", "echo test",
		"cat test.log", "grep test", "ls tests", "cd test", "pnpm latest", "uv sync", "uv run python app.py",
	]) {
		test(`not a check: ${line}`, () => assert.equal(isCheck(words(line)), false));
	}
});

describe("refused: a publish a failed check does not stop", () => {
	for (const [command, checks, commands] of [
		[INCIDENT, ["npm run test:unit 2>&1", "npm run lint 2>&1"], ["git commit -m 'fix: x' --only a.ts", "gh pr merge 12 --squash"]],
		["npm test; git commit -m x", ["npm test"], ["git commit -m x"]],
		["npm test\ngit push", ["npm test"], ["git push"]],
		["npm test > log 2>&1; cat log; git commit -m x", ["npm test > log 2>&1"], ["git commit -m x"]],
		["npm test | tail -20; git commit -m x", ["npm test"], ["git commit -m x"]],
		// pipefail fails the pipeline, but `;` still goes on.
		["set -o pipefail; npm test | tail -20; git push", ["npm test"], ["git push"]],
		// Under `set -e` a check whose status is lost, or a non-last part of an `&&` list, does not stop it.
		["set -e; npm test | tail -3; git push", ["npm test"], ["git push"]],
		["set -e; npm test && echo ok; git push", ["npm test"], ["git push"]],
		["set -e; npm test && npm run lint; git push", ["npm test"], ["git push"]],
		["set -e; x=$(npm test | tail -1); git push", ["npm test"], ["git push"]],
		["set -e; echo $(npm test); git push", ["npm test"], ["git push"]],
		// `exit` in a subshell ends only the subshell.
		["(npm test || exit 1); git push", ["npm test"], ["git push"]],
		["(set -e; npm test); git push", ["npm test"], ["git push"]],
		// Handled without stopping: `|| true`, an `||` that goes on, a branch that does not exit.
		["npm test || true; git push", ["npm test"], ["git push"]],
		["npm test || echo failed && git push", ["npm test"], ["git push"]],
		["if npm test; then echo ok; fi; git push", ["npm test"], ["git push"]],
		["if ! npm test; then echo failed; fi\ngit push", ["npm test"], ["git push"]],
		["if npm test; then git push; else git push --force; fi", ["npm test"], ["git push --force"]],
		["if npm test; then :; elif true; then exit 1; fi; git push", ["npm test"], ["git push"]],
		["if ! (npm test | tail -1); then exit 1; fi; git push", ["npm test"], ["git push"]],
		["while ! npm test; do sleep 1; git push; done", ["npm test"], ["git push"]],
		["while npm test; do :; done; git push", ["npm test"], ["git push"]],
		["until npm test | tail -1; do sleep 1; done; git push", ["npm test"], ["git push"]],
		["for d in a b; do (cd $d && npm test); done; git push", ["npm test"], ["git push"]],
		["npm test & git push", ["npm test"], ["git push"]],
		// Later commands inside groups, chains and other shells.
		["npm test; { git add -A && git commit -m x; }", ["npm test"], ["git commit -m x"]],
		["npm test; (git commit -m x)", ["npm test"], ["git commit -m x"]],
		["npm test; bash -c 'git push'", ["npm test"], ["git push"]],
		["bash -c 'npm test; git push'", ["npm test"], ["git push"]],
		["eval 'npm test'; git push", ["npm test"], ["git push"]],
		["bash -ec 'npm test'; git push", ["npm test"], ["git push"]],
		["timeout 600 npm test; nohup git push", ["timeout 600 npm test"], ["nohup git push"]],
		["cargo test; cargo clippy; npm publish", ["cargo test", "cargo clippy"], ["npm publish"]],
		["npm test; gh pr create --fill", ["npm test"], ["gh pr create --fill"]],
		// Two checks, only the first loose.
		["npm test; npm run lint && git commit -m x", ["npm test"], ["git commit -m x"]],
	] as const) {
		test(JSON.stringify(command), () => {
			const found = ungatedPublishes(command);
			assert.deepEqual(found.checks, checks);
			assert.deepEqual(found.commands, commands);
		});
	}
});

describe("allowed", () => {
	for (const command of [
		// The check's own status gates the publish.
		"npm test && git commit -m x",
		"npm test > log 2>&1 && git commit -m x && git push",
		"npm test && npm run lint && npm run build && git commit -m x && gh pr merge 1",
		"if npm test; then git push; fi",
		"if ! npm test; then exit 1; fi; git push",
		"if npm test; then :; else exit 1; fi\ngit push",
		"while npm test; do git push; break; done",
		"until npm test; do sleep 1; done; git push",
		"while ! npm test; do sleep 1; done\ngit push",
		// Failure exits the shell.
		"npm test || exit 1; git push",
		"npm test || { echo 'tests failed' >&2; exit 1; }\ngit push",
		"npm test || return; git push",
		"set -e; npm test; git commit -m x",
		"set -e\nnpm test > log 2>&1\nnpm run lint\ngit push",
		"set -eo pipefail; npm test | tail -20; git push",
		"set -euo pipefail\n(npm test | tail -3)\ngit push",
		"set -e; echo start && npm test; git push",
		"set -e; x=$(npm test); git push",
		"bash -c 'set -e; npm test; git push'",
		"bash -e -c 'npm test; git push'",
		"bash -ec 'npm test' && git push",
		"(npm test) && git push",
		"{ npm test; } && git push",
		"set -o pipefail; (npm test | grep -v warn) && git push",
		// Commands unrelated to checks before `;`.
		"cd repo; git add -A; git commit -m x; git push",
		"git status; git diff --stat; git commit -m x",
		"npm install; git commit -m x",
		"echo 'npm test'; git push",
		"cat test.log; git commit -m test",
		// The check comes after the publish, or there is no publish.
		"git commit -m x; npm test",
		"npm test; echo done",
		"npm test | tail; npm run lint",
		// In text, comments, heredocs and function bodies the check does not run.
		"git commit -m 'npm test; git push'",
		"# npm test; git push\ngit status",
		"cat <<'EOF'\nnpm test; git push\nEOF",
		"f() { npm test; }; git push",
		"",
	]) {
		test(JSON.stringify(command), () => assert.equal(ungatedRefusal(command), undefined));
	}
});

describe("the refusal", () => {
	test("names what is published, the checks, the ungated commands, why, and what to do instead", () => {
		const text = ungatedRefusal(INCIDENT)!;
		assert.match(text, /^Not run: this command runs `git commit`, `gh pr merge` even when a check before it fails:\n- `npm run test:unit 2>&1`\n- `npm run lint 2>&1`\n/);
		assert.match(text, /Not gated: `git commit -m 'fix: x' --only a\.ts`, `gh pr merge 12 --squash`\./);
		assert.match(text, /18 failing tests/);
		assert.match(text, /`check > check\.log 2>&1 && git commit …`/);
		assert.match(text, /run the publish as a command of its own/);
	});
});
