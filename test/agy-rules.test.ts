// Tests for Antigravity rule compilation (agy/rules.ts): consolidation, target filtering,
// 24 KB byte cap, and per-section diffing for live mid-session rule propagation.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { compileAgyRules, diffRuleSections, MAX_AGY_RULE_BYTES } from "../agy/rules.ts";
import { HARNESS_ROOT } from "../extensions/lib/repository.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agy-rules-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("compileAgyRules", () => {
	test("compiles the real pi-harness prompt and rules comfortably under agy's 24 KB limit", () => {
		const compiled = compileAgyRules(HARNESS_ROOT);
		assert.ok(compiled.bytes > 1000, "should include real prompt content");
		assert.ok(compiled.bytes <= MAX_AGY_RULE_BYTES, `expected <= ${MAX_AGY_RULE_BYTES} bytes, got ${compiled.bytes}`);
		assert.equal(compiled.truncated.length, 0, "real harness rules should fit without truncation");
		assert.ok(compiled.sections.some((s) => s.name === "working-rules"));
		assert.ok(compiled.sections.some((s) => s.name === "pi-harness-tools"));
		assert.match(compiled.content, /pi-harness/i);
	});

	test("honors targets/harnesses frontmatter and skips pi-only rules", () => {
		mkdirSync(join(dir, "prompt", "rules"), { recursive: true });
		writeFileSync(join(dir, "prompt", "AGENTS.md"), "# Base\nAlways verify.\n");
		writeFileSync(
			join(dir, "prompt", "rules", "pi-only.md"),
			"---\nname: pi-only\ntargets: [pi]\n---\nOnly for Pi.\n",
		);
		writeFileSync(
			join(dir, "prompt", "rules", "shared.md"),
			"---\nname: shared\n---\nApplies everywhere.\n",
		);
		writeFileSync(
			join(dir, "prompt", "rules", "agy-only.md"),
			"---\nname: agy-only\nharnesses: [agy]\n---\nSpecific to agy.\n",
		);

		const compiled = compileAgyRules(dir);
		assert.deepEqual(
			compiled.skipped.map((s) => s.name),
			["pi-only"],
		);
		assert.ok(!compiled.content.includes("Only for Pi."));
		assert.ok(compiled.content.includes("Applies everywhere."));
		assert.ok(compiled.content.includes("Specific to agy."));
	});

	test("enforces the byte budget and records truncated sections", () => {
		mkdirSync(join(dir, "prompt", "rules"), { recursive: true });
		writeFileSync(join(dir, "prompt", "AGENTS.md"), "# Base\nShort.\n");
		writeFileSync(join(dir, "prompt", "rules", "a-small.md"), "---\nname: a-small\n---\nSmall rule.\n");
		writeFileSync(join(dir, "prompt", "rules", "z-huge.md"), `---\nname: z-huge\n---\n${"x".repeat(25_000)}\n`);

		const compiled = compileAgyRules(dir);
		assert.ok(compiled.bytes <= MAX_AGY_RULE_BYTES);
		assert.ok(compiled.content.includes("Small rule."));
		assert.deepEqual(compiled.truncated, ["z-huge"]);
	});

	test("diffRuleSections reports only added or modified sections", () => {
		mkdirSync(join(dir, "prompt", "rules"), { recursive: true });
		writeFileSync(join(dir, "prompt", "AGENTS.md"), "# Base\nInitial.\n");
		writeFileSync(join(dir, "prompt", "rules", "one.md"), "---\nname: one\n---\nRule one.\n");

		const first = compileAgyRules(dir);
		const seen = Object.fromEntries(first.sections.map((s) => [s.name, s.hash]));
		assert.deepEqual(diffRuleSections(first, seen), []);

		writeFileSync(join(dir, "prompt", "rules", "two.md"), "---\nname: two\n---\nRule two.\n");
		writeFileSync(join(dir, "prompt", "rules", "one.md"), "---\nname: one\n---\nRule one updated.\n");
		const second = compileAgyRules(dir);
		const changed = diffRuleSections(second, seen);
		assert.deepEqual(
			changed.map((s) => s.name).sort(),
			["one", "two"],
		);
	});
});
