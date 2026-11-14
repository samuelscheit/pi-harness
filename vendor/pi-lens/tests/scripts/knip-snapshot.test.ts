// flake-shape: real-process-spawn — real `git` calls against a throwaway
// fixture repo; which files git lists as tracked, untracked or ignored is
// the mechanism under test, which no mock reproduces faithfully.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createKnipSnapshot,
	removeKnipSnapshot,
} from "../../scripts/lib/knip-snapshot.mjs";
import { execFileSync } from "../support/git-fixture-env.js";

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Every file under `root` (links not followed), relative and sorted. */
function tree(root: string, rel = ""): string[] {
	return fs
		.readdirSync(path.join(root, rel), { withFileTypes: true })
		.flatMap((entry) => {
			const child = rel ? `${rel}/${entry.name}` : entry.name;
			return entry.isDirectory() ? tree(root, child) : [child];
		})
		.sort();
}

/**
 * A built checkout shared by other agents: tracked sources with compiled
 * twins, a modified and a deleted tracked file, a new untracked source with
 * its own compiled twin, ignored state, and node_modules.
 */
function builtCheckout(): string {
	const root = tempDir("pi-lens-knip-snapshot-repo-");
	git(root, ["init", "--quiet"]);
	git(root, ["config", "user.email", "test@example.com"]);
	git(root, ["config", "user.name", "Test"]);
	const write = (rel: string, content: string) => {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), content);
	};
	write(".gitignore", "*.js\n!tracked.js\nnode_modules\ngrammars/\n");
	write("clients/a.ts", 'import { b } from "./b.js";\nexport const a = b;\n');
	write("clients/b.ts", "export const b = 1;\n");
	write("clients/gone.ts", "export const gone = 1;\n");
	write("tracked.js", "// checked in on purpose\n");
	git(root, ["add", "."]);
	git(root, ["commit", "--quiet", "-m", "init"]);
	// Working-tree state.
	write("clients/b.ts", "export const b = 2;\n");
	fs.rmSync(path.join(root, "clients/gone.ts"));
	write("clients/new.ts", "export const fresh = 1;\n");
	// Build output and ignored state.
	for (const rel of ["clients/a", "clients/b", "clients/new"])
		write(`${rel}.js`, "// tsc output\n");
	write("grammars/x.wasm", "wasm");
	write("node_modules/dep/package.json", '{"name":"dep"}');
	return root;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

describe("createKnipSnapshot", () => {
	it("copies the working tree without build output and never touches the checkout", () => {
		const root = builtCheckout();
		const before = tree(root);
		const tmpRoot = tempDir("pi-lens-knip-snapshot-tmp-");

		const { dir, files } = createKnipSnapshot(root, { tmpRoot });

		expect(tree(root)).toEqual(before);
		expect(fs.readFileSync(path.join(root, "clients/b.js"), "utf8")).toBe(
			"// tsc output\n",
		);
		// Tracked (as modified), untracked-not-ignored, and a tracked .js; no
		// compiled twin, no deleted file, no ignored state.
		expect(tree(dir)).toEqual([
			".gitignore",
			"clients/a.ts",
			"clients/b.ts",
			"clients/new.ts",
			"node_modules",
			"tracked.js",
		]);
		expect(files).toBe(5);
		expect(fs.readFileSync(path.join(dir, "clients/b.ts"), "utf8")).toBe(
			"export const b = 2;\n",
		);
		// node_modules is the checkout's own, linked.
		expect(fs.lstatSync(path.join(dir, "node_modules")).isSymbolicLink()).toBe(
			true,
		);
		expect(fs.existsSync(path.join(dir, "node_modules/dep/package.json"))).toBe(
			true,
		);

		removeKnipSnapshot(dir);
		expect(fs.existsSync(dir)).toBe(false);
		// Removing the link never removes what it points at.
		expect(tree(root)).toEqual(before);
	});

	it("links no node_modules when the checkout has none", () => {
		const root = builtCheckout();
		fs.rmSync(path.join(root, "node_modules"), { recursive: true });
		const { dir } = createKnipSnapshot(root, {
			tmpRoot: tempDir("pi-lens-knip-snapshot-tmp-"),
		});
		expect(tree(dir)).not.toContain("node_modules");
	});

	it("throws, leaving no copy behind, when git cannot list the tree", () => {
		const root = tempDir("pi-lens-knip-snapshot-nogit-");
		const tmpRoot = tempDir("pi-lens-knip-snapshot-tmp-");
		expect(() =>
			createKnipSnapshot(root, {
				tmpRoot,
				git: () => {
					throw new Error("not a git repository");
				},
			}),
		).toThrow("not a git repository");
		expect(fs.readdirSync(tmpRoot)).toEqual([]);
	});

	it("removes a partial copy when copying fails", () => {
		const root = builtCheckout();
		const tmpRoot = tempDir("pi-lens-knip-snapshot-tmp-");
		expect(() =>
			createKnipSnapshot(root, {
				tmpRoot,
				// A listed directory where a file is expected fails the copy.
				git: () => "clients/a.ts\0clients\0",
			}),
		).toThrow();
		expect(fs.readdirSync(tmpRoot)).toEqual([]);
	});
});
