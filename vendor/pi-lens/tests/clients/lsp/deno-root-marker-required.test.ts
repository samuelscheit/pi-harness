/**
 * Deno starts only inside a project its `deno.json(c)` names.
 *
 * Recurrence (Myrodex, 2026-11-14): in one session the TypeScript server of a
 * Node/TypeScript monorepo (no `deno.json` anywhere) was latched broken, so
 * primary selection fell through to its `fallbackFor` alternate, Deno.
 * `DenoServer.root` found no marker and answered `undefined`, and
 * `resolveLspServerCwd` replaced that answer with the file's own directory,
 * the fallback every marker-less server gets. Each folder an edit touched was
 * a new root, so `deno lsp` started 85 times, once per folder, and the
 * per-root server cap could not catch it because every root differed.
 *
 * The real `DenoServer` and `TypeScriptServer` rows drive these cases: their
 * root functions, marker tables and traits are the subject. Only `spawn()`,
 * the language-server process, is doubled. The marker-less double the #2525
 * test used (`root: async () => undefined` with no `rootMarkers`) never
 * reached the file-directory fallback, which is how this stayed green.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBoundedTelemetry } from "../../../clients/bounded-telemetry.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { _setServersForFileForTests } from "../../../clients/lsp/config.js";
import { LSPService } from "../../../clients/lsp/index.js";
import {
	createRootDetector,
	DenoServer,
	type LspRootFallback,
	type LSPServerInfo,
	resetDirectLspCommandAvailability,
	resolveLspServerCwd,
	TypeScriptServer,
} from "../../../clients/lsp/server.js";
import {
	registerSessionRoot,
	resetSessionRootsForTests,
} from "../../../clients/lsp/session-roots.js";
import { removeTempDirSync } from "../test-utils.js";

process.env.PI_LENS_TEST_MODE = "1";

const dirs: string[] = [];

/**
 * A project inside the checkout: the LSP root ceiling is `process.cwd()`, so a
 * fixture at the tmp root would be clamped or refused before Deno's own root
 * logic ran. The git-ignored `.probe-home` is the shared place for such roots
 * (`client-registry-direct.test.ts`). A `.git` directory bounds every walk at
 * the fixture.
 */
function project(prefix: string, files: Record<string, string>): string {
	fs.mkdirSync(path.join(process.cwd(), ".probe-home"), { recursive: true });
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(process.cwd(), ".probe-home", `deno-${prefix}-`)),
	);
	dirs.push(root);
	fs.mkdirSync(path.join(root, ".git"));
	fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	for (const [rel, content] of Object.entries(files)) {
		const file = path.join(root, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
	return root;
}

/** Six sibling and nested folders, the shape of an app router tree. */
const NESTED_FILES = [
	"app/(dashboard)/users/Users.tsx",
	"app/(dashboard)/roles/Roles.tsx",
	"app/(dashboard)/(admin)/orgs/Orgs.tsx",
	"components/crm/columns.tsx",
	"components/lists/counts.ts",
	"lib/util.ts",
];

function nestedProject(prefix: string, extra: Record<string, string> = {}) {
	return project(prefix, {
		...Object.fromEntries(NESTED_FILES.map((f) => [f, "export {};\n"])),
		...extra,
	});
}

function declinedRows(): string[] {
	return (
		getDegradationSummary()
			.find((g) => g.kind === "lsp-root-declined")
			?.latestReasons.filter((r) => r.subject === "deno")
			.map((r) => r.reason) ?? []
	);
}

beforeEach(() => {
	resetSessionRootsForTests();
	resetDegradationLedger();
	resetBoundedTelemetry();
	resetDirectLspCommandAvailability();
});

afterEach(() => {
	_setServersForFileForTests(undefined);
	resetSessionRootsForTests();
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("Deno root resolution at resolveLspServerCwd", () => {
	it("declines every folder of a tree with no deno.json, instead of rooting at each folder", async () => {
		const root = nestedProject("nested", {
			"package.json": "{}\n",
			"tsconfig.json": "{}\n",
		});
		const fallbacks: LspRootFallback[] = [];
		for (const rel of NESTED_FILES) {
			const cwd = await resolveLspServerCwd(
				DenoServer,
				path.join(root, rel),
				root,
				undefined,
				(f) => fallbacks.push(f),
			);
			expect(cwd, rel).toBeUndefined();
		}
		// Every caller learns the verdict, worded as "no project root".
		expect(fallbacks).toHaveLength(NESTED_FILES.length);
		expect(new Set(fallbacks.map((f) => f.cause))).toEqual(new Set(["none"]));
		// One policy row for the server, not one per file.
		const rows = declinedRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("no deno.json / deno.jsonc above the file");
		expect(
			getDegradationSummary()
				.find((g) => g.kind === "tool-cwd-resolution")
				?.latestReasons.some((r) => r.subject === "deno") ?? false,
		).toBe(false);
	});

	it.each(["deno.json", "deno.jsonc"])(
		"roots every nested file at the directory holding %s",
		async (marker) => {
			const root = nestedProject(`config-${marker}`, { [marker]: "{}\n" });
			for (const rel of NESTED_FILES) {
				expect(
					await resolveLspServerCwd(DenoServer, path.join(root, rel), root),
					rel,
				).toBe(root);
			}
			expect(declinedRows()).toEqual([]);
		},
	);

	it("roots a file beside its deno.json at that directory, not at the project above", async () => {
		const root = project("beside", {
			"package.json": "{}\n",
			"edge/deno.json": "{}\n",
			"edge/handler.ts": "export {};\n",
			"edge/sub/deep.ts": "export {};\n",
			"web/page.ts": "export {};\n",
		});
		const edge = path.join(root, "edge");
		expect(
			await resolveLspServerCwd(
				DenoServer,
				path.join(edge, "handler.ts"),
				root,
			),
		).toBe(edge);
		expect(
			await resolveLspServerCwd(
				DenoServer,
				path.join(edge, "sub/deep.ts"),
				root,
			),
		).toBe(edge);
		// A sibling outside the Deno package is not Deno's file.
		expect(
			await resolveLspServerCwd(
				DenoServer,
				path.join(root, "web/page.ts"),
				root,
			),
		).toBeUndefined();
	});

	it("the decline is the only difference: the same markers without it root at each folder", async () => {
		// The pre-fix Deno row: the same marker detector, no `unrootedDecline`.
		// The shared fallback still hosts every other marker-less server at the
		// file's directory, which is the per-folder spread Deno had.
		const root = nestedProject("control", { "package.json": "{}\n" });
		const undeclined: LSPServerInfo = {
			...DenoServer,
			id: "deno-undeclined",
			root: createRootDetector(["deno.json", "deno.jsonc"]),
		};
		const roots = new Set<string | undefined>();
		for (const rel of NESTED_FILES) {
			const file = path.join(root, rel);
			const cwd = await resolveLspServerCwd(undeclined, file, root);
			expect(cwd, rel).toBe(path.dirname(file));
			roots.add(cwd);
		}
		expect(roots.size).toBe(NESTED_FILES.length);
	});

	it("starts no TypeScript server inside a Deno project, from any of its folders", async () => {
		// The mirror of the Deno case: DenoExcludeRoot answers no root for a
		// Deno project's files, and the same fallback used to host TypeScript
		// at each folder anyway, next to the Deno server it yields to.
		const root = nestedProject("ts-in-deno", {
			"deno.json": "{}\n",
			"package.json": "{}\n",
		});
		for (const rel of NESTED_FILES) {
			expect(
				await resolveLspServerCwd(TypeScriptServer, path.join(root, rel), root),
				rel,
			).toBeUndefined();
		}
		const rows =
			getDegradationSummary()
				.find((g) => g.kind === "lsp-root-declined")
				?.latestReasons.filter((r) => r.subject === "typescript") ?? [];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.reason).toContain(`the Deno project at ${root}`);
	});
});

describe("Deno as TypeScript's fallback through LSPService.getClientForFile", () => {
	/**
	 * The real rows with only `spawn()` replaced. TypeScript's spawn fails (no
	 * process), which is what sends the sequential trial on to Deno, the
	 * Myrodex state. Deno's spawn records the root it was asked to start at.
	 */
	function rows() {
		const tsSpawn = vi.fn(async () => undefined);
		const denoRoots: string[] = [];
		const denoSpawn = vi.fn(async (root: string) => {
			denoRoots.push(root);
			return undefined;
		});
		const servers: LSPServerInfo[] = [
			{ ...TypeScriptServer, spawn: tsSpawn },
			{ ...DenoServer, spawn: denoSpawn },
		];
		_setServersForFileForTests(() => servers);
		return { tsSpawn, denoSpawn, denoRoots };
	}

	it("a Node project with tsconfig never starts Deno, from any of its folders", async () => {
		const root = nestedProject("node", {
			"package.json": "{}\n",
			"tsconfig.json": "{}\n",
		});
		registerSessionRoot(root);
		const { tsSpawn, denoSpawn } = rows();
		const service = new LSPService();
		for (const rel of NESTED_FILES) {
			expect(
				await service.getClientForFile(path.join(root, rel), 2_000),
			).toBeUndefined();
		}
		// TypeScript was tried (the fallback condition held) and Deno never was.
		expect(tsSpawn).toHaveBeenCalled();
		expect(denoSpawn).not.toHaveBeenCalled();
	});

	it("a Deno project tries Deno once per root, at its deno.json directory", async () => {
		const root = nestedProject("deno", { "deno.json": "{}\n" });
		registerSessionRoot(root);
		const { tsSpawn, denoRoots } = rows();
		const service = new LSPService();
		for (const rel of NESTED_FILES) {
			await service.getClientForFile(path.join(root, rel), 2_000);
		}
		expect(denoRoots.length).toBeGreaterThanOrEqual(1);
		// Every attempt names the one config root, never a file's folder.
		expect(new Set(denoRoots)).toEqual(new Set([root]));
		// TypeScript yields to Deno inside a Deno project (DenoExcludeRoot).
		expect(tsSpawn).not.toHaveBeenCalled();
	});
});
