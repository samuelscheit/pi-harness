/**
 * Pyright import-resolution findings in a Python file that extends `sys.path`
 * at runtime are advisory (clients/python-runtime-path.ts), on both Pyright
 * lanes: the language server's rows (`demoteLanguageServerRows`, the seam the
 * per-edit runner and every `lsp_diagnostics` route use) and the `pyright` CLI
 * runner (`parsePyrightOutput`).
 *
 * Recurrence (2026-11-13): study scripts that ran
 * `sys.path.insert(0, "tools/kernel")` and imported from there got
 * `Import "syntax" could not be resolved` and `"load" is not a known attribute
 * of module "klammer"` as 🔴 STOP blockers on every edit.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePyrightOutput } from "../../clients/dispatch/runners/pyright.js";
import type { LSPDiagnostic } from "../../clients/lsp/client.js";
import { demoteLanguageServerRows } from "../../clients/lsp/inferred-project.js";
import {
	modifiesSysPath,
	RUNTIME_PATH_NOTICE,
} from "../../clients/python-runtime-path.js";

const RUNTIME_PATH_SCRIPT = [
	"import sys",
	"from pathlib import Path",
	'sys.path.insert(0, str(Path(__file__).parent / "tools" / "kernel"))',
	"import syntax  # noqa: E402",
	"import klammer  # noqa: E402",
	"tree = klammer.load('.')",
	"",
].join("\n");

const PLAIN_SCRIPT = "import syntax\nimport klammer\n";

describe("modifiesSysPath", () => {
	it.each([
		'sys.path.insert(0, "tools/kernel")',
		"sys.path.append(str(ROOT))",
		"sys.path.extend([a, b])",
		"sys.path = [ROOT] + sys.path",
		"sys.path[0:0] = [ROOT]",
		"sys.path += [ROOT]",
		"site.addsitedir(ROOT)",
		"sys.path .insert(0, ROOT)",
	])("admits %s", (line) => {
		expect(modifiesSysPath(`import sys\n${line}\n`)).toBe(true);
	});

	it.each([
		"print(sys.path)",
		"if sys.path == saved:\n    pass",
		"paths = list(sys.path)",
		"x = sys.path[0]",
		"sys.pathfinder.insert(0, x)",
	])("refuses %s", (line) => {
		expect(modifiesSysPath(`import sys\n${line}\n`)).toBe(false);
	});
});

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-runtime-path-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, content);
	return file;
}

function row(
	code: string,
	message: string,
	options: { source?: string; severity?: 1 | 2; line?: number } = {},
): LSPDiagnostic {
	const line = options.line ?? 3;
	return {
		range: {
			start: { line, character: 7 },
			end: { line, character: 13 },
		},
		message,
		severity: options.severity ?? 1,
		code,
		source: options.source ?? "basedpyright",
	};
}

const UNRESOLVED = () =>
	row("reportMissingImports", 'Import "syntax" could not be resolved');
const MODULE_ATTRIBUTE = () =>
	row(
		"reportAttributeAccessIssue",
		'"load" is not a known attribute of module "klammer"',
		{ line: 5 },
	);

async function rows(file: string, diagnostics: LSPDiagnostic[]) {
	return (
		await demoteLanguageServerRows(diagnostics, { filePath: file, cwd: dir })
	).rows;
}

describe("the language server's rows", () => {
	it("demotes an unresolved import and a module attribute in a file that extends sys.path", async () => {
		const file = write("anker.py", RUNTIME_PATH_SCRIPT);
		const out = await rows(file, [UNRESOLVED(), MODULE_ATTRIBUTE()]);
		expect(out.map((d) => d.severity)).toEqual([2, 2]);
		for (const d of out) expect(d.message).toContain(RUNTIME_PATH_NOTICE);
		// The finding keeps its code and line: it is still reported.
		expect(out.map((d) => [d.code, d.range.start.line])).toEqual([
			["reportMissingImports", 3],
			["reportAttributeAccessIssue", 5],
		]);
	});

	it("keeps an unresolved import blocking in a file that does not touch sys.path", async () => {
		const file = write("plain.py", PLAIN_SCRIPT);
		const input = [UNRESOLVED(), MODULE_ATTRIBUTE()];
		const out = await rows(file, input);
		expect(out).toBe(input);
		expect(out.map((d) => d.severity)).toEqual([1, 1]);
	});

	it("keeps a type error blocking in a file that extends sys.path", async () => {
		const file = write("anker.py", RUNTIME_PATH_SCRIPT);
		const out = await rows(file, [
			row(
				"reportAttributeAccessIssue",
				'Cannot access attribute "lod" for class "Tree"',
			),
			row(
				"reportAttributeAccessIssue",
				'"lod" is not a known attribute of class "Tree"',
			),
			row("reportArgumentType", 'Argument of type "int" is not assignable'),
			row("reportUndefinedVariable", '"undefined_name" is not defined'),
		]);
		expect(out.map((d) => d.severity)).toEqual([1, 1, 1, 1]);
	});

	it("leaves another server's finding and a syntax error alone", async () => {
		const file = write("anker.py", RUNTIME_PATH_SCRIPT);
		const out = await rows(file, [
			row("reportMissingImports", 'Import "x" could not be resolved', {
				source: "Ruff",
			}),
			row("", "Expected expression", { source: "basedpyright" }),
		]);
		expect(out.map((d) => d.severity)).toEqual([1, 1]);
	});

	it("keeps the severity when the file cannot be read", async () => {
		const out = await rows(path.join(dir, "missing.py"), [UNRESOLVED()]);
		expect(out.map((d) => d.severity)).toEqual([1]);
	});
});

describe("the pyright CLI runner", () => {
	function report(file: string) {
		return {
			generalDiagnostics: [
				{
					file,
					severity: "error",
					message: 'Import "syntax" could not be resolved',
					rule: "reportMissingImports",
					range: { start: { line: 3, character: 7 } },
				},
				{
					file,
					severity: "error",
					message: 'Type "int" is not assignable to declared type "str"',
					rule: "reportAssignmentType",
					range: { start: { line: 6, character: 0 } },
				},
			],
		};
	}

	it("reports an unresolved import as a warning in a file that extends sys.path", () => {
		const file = write("anker.py", RUNTIME_PATH_SCRIPT);
		const out = parsePyrightOutput(report(file), file);
		expect(out.map((d) => [d.rule, d.semantic])).toEqual([
			["reportMissingImports", "warning"],
			["reportAssignmentType", "blocking"],
		]);
		expect(out[0]?.message).toContain(RUNTIME_PATH_NOTICE);
	});

	it("keeps it blocking in a file that does not touch sys.path", () => {
		const file = write("plain.py", PLAIN_SCRIPT);
		const out = parsePyrightOutput(report(file), file);
		expect(out.map((d) => d.semantic)).toEqual(["blocking", "blocking"]);
		expect(out[0]?.message).not.toContain(RUNTIME_PATH_NOTICE);
	});

	it("reads each reported file once", () => {
		const file = write("anker.py", RUNTIME_PATH_SCRIPT);
		const reads: string[] = [];
		parsePyrightOutput(report(file), file, (p) => {
			reads.push(p);
			return fs.readFileSync(p, "utf8");
		});
		expect(reads).toEqual([file]);
	});
});
