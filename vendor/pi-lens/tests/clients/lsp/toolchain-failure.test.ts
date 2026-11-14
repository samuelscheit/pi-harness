/**
 * Toolchain and filesystem failures a language server reports as a row are
 * no verdict about the code (clients/lsp/toolchain-failure.ts). The per-edit
 * runner drops them (runner-status-semantics.test.ts); every other route that
 * reads the server's rows demotes them with a label through
 * `demoteLanguageServerRows`.
 */

import { describe, expect, it } from "vitest";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import { demoteLanguageServerRows } from "../../../clients/lsp/inferred-project.js";
import {
	isToolchainEnvironmentFailure,
	TOOLCHAIN_FAILURE_NOTICE,
	toolchainFailureCause,
} from "../../../clients/lsp/toolchain-failure.js";

const setupFile = (stderr: string) =>
	`\`/Users/u/.elan/toolchains/leanprover--lean4---v4.34.1/bin/lake setup-file /repo/src/A.lean -\` failed:\n\nstderr:\n${stderr}`;

describe("isToolchainEnvironmentFailure", () => {
	it.each([
		[
			"EACCES",
			"error: failed to write '/repo/.lake/build/lib/lean/A.ilean': permission denied (error code: 13)",
		],
		["EPERM", "error: operation not permitted (error code: 1)"],
		["EROFS", "error: read-only file system (error code: 30)"],
		["ENOSPC", "error: no space left on device (error code: 28)"],
		[
			"missing toolchain",
			"error: toolchain 'leanprover/lean4:v4.35.0' is not installed",
		],
	])("admits a setup-file failure on %s", (_label, stderr) => {
		expect(isToolchainEnvironmentFailure(setupFile(stderr))).toBe(true);
	});

	it.each([
		[
			"a missing source file (a bad import)",
			"error: no such file or directory (error code: 2)\n  file: /repo/src/B.lean\nerror: src/A.lean: bad import 'B'",
		],
		[
			"a dependency that does not compile",
			"✖ [3/9] Building Library.B\nerror: Library/B.lean:4:2: unknown identifier 'foo'",
		],
		[
			"an error code that is not an environment errno",
			"error: (error code: 130)",
		],
	])("refuses a setup-file failure caused by %s", (_label, stderr) => {
		expect(isToolchainEnvironmentFailure(setupFile(stderr))).toBe(false);
	});

	it("refuses a code diagnostic that only mentions a permission", () => {
		expect(
			isToolchainEnvironmentFailure(
				"unknown constant 'permission denied (error code: 13)'",
			),
		).toBe(false);
	});

	it("names the failing line as the cause", () => {
		expect(
			toolchainFailureCause(
				setupFile(
					"✖ [81/83] Building Library.Inertia\nerror: permission denied (error code: 13)",
				),
			),
		).toBe("error: permission denied (error code: 13)");
	});
});

describe("demoteLanguageServerRows", () => {
	const row = (message: string): LSPDiagnostic => ({
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		message,
		severity: 1,
		source: "Lean 4",
	});

	it("demotes a toolchain failure with its label and keeps a code error", async () => {
		const failure = row(setupFile("error: permission denied (error code: 13)"));
		const codeError = row("unknown identifier 'foo'");
		const { rows } = await demoteLanguageServerRows([failure, codeError], {
			filePath: "/repo/src/A.lean",
			cwd: "/repo",
		});
		expect(rows.map((d) => d.severity)).toEqual([2, 1]);
		expect(rows[0]?.message).toContain(TOOLCHAIN_FAILURE_NOTICE);
		expect(rows[1]).toBe(codeError);
	});
});
