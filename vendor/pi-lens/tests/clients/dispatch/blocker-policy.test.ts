/**
 * What a linter finding may block (clients/dispatch/blocker-policy.ts), driven
 * through the real dispatcher (`runRunner` applies the policy to every runner
 * result) with the real runners' ids, kinds and parsers; only the tool process
 * is a double.
 *
 * Recurrences (2026-11-13, law-formalization):
 * - a 4-line edit to a YAML file stopped the agent on 25 yamllint line-length
 *   (80 columns, yamllint's default config) findings on lines it never
 *   touched; a generated file held ~1900, past the old pre-edit seed's cap;
 * - ruff 0.17 stamps `"severity": "error"` on every rule, so I001, SIM905 and
 *   C401 were 🔴 STOP blockers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyLinterBlockerPolicy,
	isParseError,
	lintRuleMayBlock,
} from "../../../clients/dispatch/blocker-policy.js";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import ruffRunner, {
	parseRuffJson,
} from "../../../clients/dispatch/runners/ruff.js";
import yamllintRunner from "../../../clients/dispatch/runners/yamllint.js";
import {
	BLOCKING_DIAGNOSTICS_FAILURE_KIND,
	type Diagnostic,
	findingsResult,
	type ModifiedRange,
	type RunnerDefinition,
	type RunnerResult,
} from "../../../clients/dispatch/types.js";
import { pinFixtureHome, setupTestEnvironment } from "../test-utils.js";

let tmpDir: string;
let cleanup: () => void;
let restoreHome: () => void;

beforeEach(() => {
	({ tmpDir, cleanup } = setupTestEnvironment("pi-lens-blocker-policy-"));
	({ restore: restoreHome } = pinFixtureHome("blocker-policy"));
});

afterEach(() => {
	restoreHome?.();
	cleanup();
});

/** A real runner shell answering with `diagnostics`, as its own result. */
function answering(
	runner: RunnerDefinition,
	diagnostics: Diagnostic[],
): RunnerDefinition {
	return {
		...runner,
		run: async (): Promise<RunnerResult> => {
			const blocking = diagnostics.some((d) => d.semantic === "blocking");
			return findingsResult(diagnostics, {
				status: blocking ? "failed" : "succeeded",
				semantic: blocking ? "blocking" : "warning",
			});
		},
	};
}

/** yamllint `-f parsable` rows as the runner maps them (`[error]` blocks). */
function yamllintAt(
	file: string,
	rows: Array<[line: number, rule: string]>,
): Diagnostic[] {
	return rows.map(([line, rule]) => ({
		id: `yamllint-${line}-1-${rule}`,
		message: `[${rule}] finding`,
		filePath: file,
		line,
		column: 1,
		severity: "error",
		semantic: "blocking",
		tool: "yamllint",
		rule,
	}));
}

/** Ruff 0.17 JSON through the runner's own parser: every row says `error`. */
function ruffAt(
	file: string,
	rows: Array<[line: number, code: string]>,
): Diagnostic[] {
	return parseRuffJson(
		JSON.stringify(
			rows.map(([row, code]) => ({
				code,
				message: `${code} finding`,
				filename: file,
				location: { row, column: 1 },
				severity: "error",
			})),
		),
		file,
	);
}

async function dispatch(
	file: string,
	runner: RunnerDefinition,
	ranges: ModifiedRange[] | undefined,
) {
	const registry = new RunnerRegistry();
	registry.register(runner);
	let observed: RunnerResult | undefined;
	const result = await dispatchForFile(
		createDispatchContext(
			file,
			tmpDir,
			{ getFlag: () => false },
			new FactStore(),
			true,
			ranges,
		),
		[{ mode: "all", runnerIds: [runner.id] }],
		registry,
		(id, runnerResult) => {
			if (id === runner.id) observed = runnerResult;
		},
	);
	return { result, observed };
}

function yamlFile(lines = 40): string {
	const file = path.join(tmpDir, "stufen.yaml");
	fs.writeFileSync(
		file,
		Array.from({ length: lines }, (_, i) => `key${i}: value`).join("\n"),
	);
	return file;
}

const EDIT: ModifiedRange[] = [{ start: 10, end: 13 }];

describe("yamllint", () => {
	it("never blocks on a line the edit did not change, past any count", async () => {
		const file = yamlFile(2000);
		const rows = Array.from(
			{ length: 1900 },
			(_, i) => [i < 9 ? i + 1 : i + 20, "key-duplicates"] as [number, string],
		);
		fs.writeFileSync(path.join(tmpDir, ".yamllint"), "extends: default\n");
		const { result } = await dispatch(
			file,
			answering(yamllintRunner, yamllintAt(file, rows)),
			EDIT,
		);

		expect(result.blockers).toEqual([]);
		expect(result.stillObserved).toHaveLength(1900);
	});

	it("makes line-length advisory without a project config, on edited lines too", async () => {
		const file = yamlFile();
		const { result, observed } = await dispatch(
			file,
			answering(
				yamllintRunner,
				yamllintAt(file, [
					[2, "line-length"],
					[11, "line-length"],
					[12, "truthy"],
				]),
			),
			EDIT,
		);

		expect(result.blockers).toEqual([]);
		expect(result.warnings.map((d) => [d.rule, d.line])).toEqual([
			["line-length", 11],
			["truthy", 12],
		]);
		// The run is no longer a failed check.
		expect(observed?.status).toBe("succeeded");
		expect(observed?.semantic).toBe("warning");
		expect(observed?.failureKind).toBeUndefined();
	});

	it("keeps line-length advisory under a project config, a layout rule", async () => {
		const file = yamlFile();
		fs.writeFileSync(
			path.join(tmpDir, ".yamllint.yml"),
			"rules:\n  line-length:\n    max: 120\n    level: error\n",
		);
		const { result } = await dispatch(
			file,
			answering(yamllintRunner, yamllintAt(file, [[11, "line-length"]])),
			EDIT,
		);
		expect(result.blockers).toEqual([]);
	});

	it("blocks a duplicate key on an edited line under a project config", async () => {
		const file = yamlFile();
		fs.writeFileSync(path.join(tmpDir, ".yamllint"), "extends: default\n");
		const { result } = await dispatch(
			file,
			answering(yamllintRunner, yamllintAt(file, [[11, "key-duplicates"]])),
			EDIT,
		);
		expect(result.blockers.map((d) => [d.rule, d.line])).toEqual([
			["key-duplicates", 11],
		]);
	});

	it("makes a duplicate key advisory without a project config", async () => {
		const file = yamlFile();
		const { result } = await dispatch(
			file,
			answering(yamllintRunner, yamllintAt(file, [[11, "key-duplicates"]])),
			EDIT,
		);
		expect(result.blockers).toEqual([]);
		expect(result.warnings.map((d) => d.rule)).toEqual(["key-duplicates"]);
	});

	it("blocks a syntax error on an edited line, with or without config", async () => {
		const file = yamlFile();
		const { result } = await dispatch(
			file,
			answering(yamllintRunner, yamllintAt(file, [[12, "syntax"]])),
			EDIT,
		);
		expect(result.blockers.map((d) => [d.rule, d.line])).toEqual([
			["syntax", 12],
		]);
	});

	it("blocks every finding a whole-file write produces that may block", async () => {
		// A `write` records the whole file as changed; no ranges at all (a
		// project scan) means the same.
		const file = yamlFile();
		fs.writeFileSync(path.join(tmpDir, ".yamllint"), "extends: default\n");
		for (const ranges of [[{ start: 1, end: 40 }], undefined]) {
			const { result } = await dispatch(
				file,
				answering(
					yamllintRunner,
					yamllintAt(file, [
						[1, "key-duplicates"],
						[40, "syntax"],
					]),
				),
				ranges,
			);
			expect(result.blockers.map((d) => d.line)).toEqual([1, 40]);
		}
	});
});

describe("ruff", () => {
	function pyFile(): string {
		const file = path.join(tmpDir, "anker.py");
		fs.writeFileSync(
			file,
			Array.from({ length: 40 }, () => "x = 1").join("\n"),
		);
		return file;
	}

	it("makes import order and simplifications advisory, config or not", async () => {
		const file = pyFile();
		for (const config of [false, true]) {
			if (config)
				fs.writeFileSync(path.join(tmpDir, "ruff.toml"), "line-length = 120\n");
			const { result } = await dispatch(
				file,
				answering(
					ruffRunner,
					ruffAt(file, [
						[10, "I001"],
						[11, "SIM905"],
						[12, "C401"],
						[13, "E501"],
					]),
				),
				EDIT,
			);
			expect(result.blockers).toEqual([]);
			expect(result.warnings.map((d) => d.rule)).toEqual([
				"I001",
				"SIM905",
				"C401",
				"E501",
			]);
		}
	});

	it("blocks a syntax error on an edited line without a project config", async () => {
		const file = pyFile();
		const { result } = await dispatch(
			file,
			answering(ruffRunner, ruffAt(file, [[11, "invalid-syntax"]])),
			EDIT,
		);
		expect(result.blockers.map((d) => d.rule)).toEqual(["invalid-syntax"]);
	});

	it("blocks a pyflakes error on an edited line under a project config only", async () => {
		const file = pyFile();
		const without = await dispatch(
			file,
			answering(ruffRunner, ruffAt(file, [[11, "F811"]])),
			EDIT,
		);
		expect(without.result.blockers).toEqual([]);

		fs.writeFileSync(
			path.join(tmpDir, "pyproject.toml"),
			"[tool.ruff]\nline-length = 120\n",
		);
		const withConfig = await dispatch(
			file,
			answering(ruffRunner, ruffAt(file, [[11, "F811"]])),
			EDIT,
		);
		expect(withConfig.result.blockers.map((d) => d.rule)).toEqual(["F811"]);
	});

	it("withholds a pyflakes error on an unchanged line even under a project config", async () => {
		const file = pyFile();
		fs.writeFileSync(path.join(tmpDir, "ruff.toml"), "\n");
		const { result } = await dispatch(
			file,
			answering(ruffRunner, ruffAt(file, [[30, "F811"]])),
			EDIT,
		);
		expect(result.blockers).toEqual([]);
		expect(result.stillObserved?.map((d) => d.rule)).toEqual(["F811"]);
	});
});

describe("applyLinterBlockerPolicy", () => {
	const ctx = { filePath: "/p/a.yaml", cwd: "/p", modifiedRanges: EDIT };
	const blocker = (line: number, rule = "syntax"): Diagnostic => ({
		id: `x-${line}`,
		message: "m",
		filePath: "/p/a.yaml",
		line,
		severity: "error",
		semantic: "blocking",
		tool: "yamllint",
		rule,
	});

	it("leaves a runner that is not a linter alone", () => {
		const result = findingsResult([blocker(1)], {
			status: "failed",
			semantic: "blocking",
		});
		expect(applyLinterBlockerPolicy(result, ctx, "pyright")).toBe(result);
		expect(applyLinterBlockerPolicy(result, ctx, "lsp")).toBe(result);
	});

	it("returns the same result when every blocker stands", () => {
		const result = findingsResult([blocker(11)], {
			status: "failed",
			semantic: "blocking",
		});
		expect(applyLinterBlockerPolicy(result, ctx, "yamllint")).toBe(result);
	});

	it("never touches a runner fault", () => {
		const fault = { ...blocker(1, "line-length"), runnerFault: true as const };
		const result: RunnerResult = {
			status: "failed",
			diagnostics: [fault],
			semantic: "blocking",
			failureKind: "parser_error",
		};
		expect(applyLinterBlockerPolicy(result, ctx, "yamllint")).toBe(result);
	});

	it("keeps a finding on another file and one without a line in scope", () => {
		const other = { ...blocker(1), filePath: "/p/other.yaml" };
		const lineless = { ...blocker(1) };
		delete (lineless as { line?: number }).line;
		const result = findingsResult([other, lineless], {
			status: "failed",
			semantic: "blocking",
		});
		const out = applyLinterBlockerPolicy(result, ctx, "yamllint");
		expect(out.diagnostics).toEqual([other, lineless]);
		expect(out.outOfEditScope).toBeUndefined();
	});

	it("turns a failed check into a success once nothing blocks", () => {
		const result = findingsResult([blocker(1)], {
			status: "failed",
			semantic: "blocking",
		});
		const out = applyLinterBlockerPolicy(result, ctx, "yamllint");
		expect(out).toMatchObject({ status: "succeeded", semantic: "none" });
		expect(out.failureKind).toBeUndefined();
		expect(result.failureKind).toBe(BLOCKING_DIAGNOSTICS_FAILURE_KIND);
		expect(out.outOfEditScope?.map((d) => d.line)).toEqual([1]);
	});
});

describe("isParseError / lintRuleMayBlock", () => {
	it.each([
		[{ rule: "syntax", message: "" }],
		[{ rule: "invalid-syntax", message: "" }],
		[{ rule: "SC1009", message: "" }],
		[{ rule: undefined, message: "Parsing error: Unexpected token" }],
		[{ rule: "ruff", message: "SyntaxError: invalid syntax" }],
	])("reads %j as a parse error", (d) => {
		expect(isParseError(d)).toBe(true);
	});

	it.each([
		[{ rule: "SC2086", message: "Double quote" }],
		[{ rule: "line-length", message: "line too long (syntax)" }],
	])("does not read %j as a parse error", (d) => {
		expect(isParseError(d)).toBe(false);
	});

	it("lets an unlisted tool's configured rule block", () => {
		expect(
			lintRuleMayBlock(
				{ tool: "shellcheck", rule: "SC2086", message: "" },
				true,
			),
		).toBe(true);
	});
});
