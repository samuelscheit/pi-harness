// The harness's biome.json turns biome off for the harness's own files: the harness has no biome
// convention, and `node_modules/.bin/biome` is vendor/pi's, so an agent's
// `biome format --write test/patch-t3.test.ts` reformatted the whole file with biome's defaults,
// another agent's uncommitted edits included. vendor/pi keeps its own config.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { HARNESS_ROOT } from "../extensions/lib/repository.ts";

const BIOME = join(HARNESS_ROOT, "node_modules", ".bin", "biome");
const biome = (cwd: string, args: string[], input?: string) => {
	const run = spawnSync(BIOME, args, { cwd, input, encoding: "utf8" });
	return { status: run.status, output: `${run.stdout}${run.stderr}`, stdout: run.stdout };
};
/** Code biome's formatter would change under any config: spaces, double blank lines, no semicolons. */
const UNFORMATTED = "export function f( a:number ){\n    return a+1\n}\n\n\n\nexport const x = [1,2,\n3]\n";

describe("biome", () => {
	test("does nothing to harness files: format, lint and check with --write leave the file as it is", () => {
		const dir = mkdtempSync(join(HARNESS_ROOT, "test", ".biome-probe-"));
		try {
			const file = join(dir, "probe.ts");
			writeFileSync(file, UNFORMATTED);
			for (const command of ["format", "lint", "check"]) {
				const run = biome(HARNESS_ROOT, [command, "--write", file]);
				assert.equal(readFileSync(file, "utf8"), UNFORMATTED, `${command} --write changed the file:\n${run.output}`);
				assert.match(run.output, /No files were processed/, command);
			}
			const stdin = biome(HARNESS_ROOT, ["format", `--stdin-file-path=${join(dir, "other.ts")}`], UNFORMATTED);
			assert.equal(stdin.stdout, UNFORMATTED, "an editor's format-on-save (stdin) returns the code as it is");
			assert.match(stdin.output, /the formatter is currently disabled/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("vendor/pi keeps its own config: tabs at width 3, run from vendor/pi", () => {
		const run = biome(join(HARNESS_ROOT, "vendor", "pi"), ["format", "--stdin-file-path=packages/agent/src/probe.ts"], UNFORMATTED);
		assert.equal(run.status, 0, run.output);
		assert.equal(run.stdout, "export function f(a: number) {\n\treturn a + 1;\n}\n\nexport const x = [1, 2, 3];\n");
	});

	test("vendor/pi checks its files clean with its own config", () => {
		const run = biome(join(HARNESS_ROOT, "vendor", "pi"), ["check", "--error-on-warnings", "packages/agent/src/agent.ts", "biome.json"]);
		assert.equal(run.status, 0, run.output);
	});
});
