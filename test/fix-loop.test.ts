// fix_loop's check (workflows/fix_loop.ts): green is the exit code of the whole check, never the
// exit code of a filter at the end of a pipeline.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { checkCommand } from "../workflows/fix_loop.ts";

/** The exit code of a check as fix_loop runs it (shell() runs `bash -c`). */
const exitOf = (check: string) => spawnSync("bash", ["-c", checkCommand(check)]).status;

describe("fix_loop's check", () => {
	test("a failing command piped into a filter fails (2026-11-16: `pytest … | tail -1` read as green before any round)", () => {
		assert.equal(exitOf("false | tail -1"), 1);
		assert.equal(exitOf("(echo '1 failed'; exit 1) 2>&1 | tail -1 | cat"), 1);
		assert.equal(exitOf("true | tail -1"), 0);
	});

	test("lists, && chains, a cd and multi-line checks keep their own exit codes", () => {
		assert.equal(exitOf("cd / && true"), 0);
		assert.equal(exitOf("true && false"), 1);
		assert.equal(exitOf("false || true"), 0);
		assert.equal(exitOf("echo a\nexit 3"), 3);
		assert.equal(exitOf("set +o pipefail; false | true"), 0, "a check that opts out explicitly still can");
	});
});
