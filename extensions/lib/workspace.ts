// The working tree of a git repository before and after an agent worked in it: which files it
// changed, putting back the ones it was not allowed to change, and the diff of the others.
//
// A snapshot holds every path `git status` lists (modified, deleted, untracked; ignored files are
// not tracked) with a hash of its content and the content itself for restoring. A path not in a
// snapshot has its HEAD content (or does not exist when HEAD lacks it). Comparing two snapshots
// therefore finds every change to a tracked or untracked file, also one that undid an earlier
// uncommitted change. Only working-tree content counts: what is staged is left as it is.
// Paths are canonical (symlinks resolved), as git reports them.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createTwoFilesPatch } from "diff";

const exec = promisify(execFile);
const git = async (root: string, args: string[]) => (await exec("git", args, { cwd: root, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" })).stdout;

/** Larger uncommitted files are hashed but not kept, so a change to one can be found but not undone. */
const MAX_KEPT_BYTES = 16 * 1024 * 1024;

/** A file's state: absent, or present with a content hash (and the content, when small enough to keep). */
export type FileState = { exists: false } | { exists: true; hash: string; content?: Buffer };

export interface Snapshot {
	root: string;
	/** HEAD's commit, or undefined in a repository without commits. */
	head?: string;
	/** Absolute path → state, for every path git status lists. */
	files: Map<string, FileState>;
}

/** The repository root of `cwd`, or undefined outside a git repository. */
export async function gitRoot(cwd: string): Promise<string | undefined> {
	try {
		return (await git(cwd, ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
	} catch {
		return undefined;
	}
}

const hash = (content: Buffer) => createHash("sha256").update(content).digest("hex");

function readState(path: string): FileState {
	if (!existsSync(path)) return { exists: false };
	try {
		const content = readFileSync(path);
		return { exists: true, hash: hash(content), ...(content.length <= MAX_KEPT_BYTES ? { content } : {}) };
	} catch {
		// A directory (submodule) or unreadable: compare by name only.
		return { exists: true, hash: "unreadable" };
	}
}

/** The working tree's uncommitted state. */
export async function snapshot(root: string): Promise<Snapshot> {
	let head: string | undefined;
	try {
		head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"])).toString("utf8").trim() || undefined;
	} catch {
		head = undefined;
	}
	// -z: NUL-separated, paths unquoted; a rename or copy entry is followed by its source path.
	const fields = (await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"])).toString("utf8").split("\0");
	const files = new Map<string, FileState>();
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i]!;
		if (field.length < 4) continue;
		const status = field.slice(0, 2);
		const path = join(root, field.slice(3));
		files.set(path, readState(path));
		if (status.includes("R") || status.includes("C")) {
			const source = join(root, fields[++i]!);
			files.set(source, readState(source));
		}
	}
	return { root, head, files };
}

/** HEAD's content of `path`, or undefined when HEAD lacks it. */
async function headContent(snap: Snapshot, path: string): Promise<Buffer | undefined> {
	if (!snap.head) return undefined;
	try {
		return await git(snap.root, ["show", `${snap.head}:${relative(snap.root, path).split(sep).join("/")}`]);
	} catch {
		return undefined;
	}
}

const sameState = (a: FileState, b: FileState) => a.exists === b.exists && (!a.exists || (b.exists && a.hash === b.hash));

/** A path's state in a snapshot: listed, else its content at the snapshot's HEAD. */
async function stateIn(snap: Snapshot, path: string): Promise<FileState> {
	const listed = snap.files.get(path);
	if (listed) return listed;
	const content = await headContent(snap, path);
	return content === undefined ? { exists: false } : { exists: true, hash: hash(content) };
}

/** The paths whose working-tree content differs between two snapshots of the same tree, sorted. */
export async function changedPaths(before: Snapshot, after: Snapshot): Promise<string[]> {
	const changed: string[] = [];
	for (const path of new Set([...before.files.keys(), ...after.files.keys()])) {
		if (!sameState(await stateIn(before, path), await stateIn(after, path))) changed.push(path);
	}
	return changed.sort();
}

/** Whether `path` (absolute) is one of `allowed` (absolute files or directories) or inside one of them. */
export const isAllowed = (path: string, allowed: readonly string[]) => allowed.some((entry) => path === entry || path.startsWith(entry.endsWith(sep) ? entry : entry + sep));

/** A path with symlinks resolved in its longest existing part, so it compares with git's paths. */
export function canonical(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch {
		const parent = dirname(absolute);
		return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
	}
}

/** Paths as given to a tool (relative to `cwd` or absolute), made absolute and canonical. */
export const absolutePaths = (paths: readonly string[], cwd: string) => paths.map((p) => canonical(isAbsolute(p) ? p : resolve(cwd, p)));

/**
 * Put `paths` back to their state in `before`: kept content is written back, files absent then are
 * removed, files with their HEAD content then get it again. Returns the paths it could not restore
 * (uncommitted content too large to keep).
 */
export async function restore(before: Snapshot, paths: readonly string[]): Promise<string[]> {
	const failed: string[] = [];
	for (const path of paths) {
		const state = before.files.get(path);
		const content = state === undefined ? await headContent(before, path) : state.exists ? state.content : undefined;
		if (state?.exists && content === undefined) {
			failed.push(path);
			continue;
		}
		if (content === undefined) {
			rmSync(path, { force: true, recursive: true });
		} else {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
	}
	return failed;
}

/** A unified diff of `paths` from their state in `before` to the working tree now. */
export async function diffSince(before: Snapshot, paths: readonly string[]): Promise<string> {
	const patches: string[] = [];
	for (const path of paths) {
		const state = before.files.get(path);
		const old = state === undefined ? await headContent(before, path) : state.exists ? state.content : undefined;
		const now = existsSync(path) ? readFileSync(path) : undefined;
		const name = relative(before.root, path).split(sep).join("/");
		if (state?.exists && old === undefined) {
			patches.push(`--- a/${name}\n+++ b/${name}\n(changed; its earlier content was too large to keep)\n`);
			continue;
		}
		if ((old && old.includes(0)) || (now && now.includes(0))) {
			patches.push(`Binary file ${name} ${old === undefined ? "created" : now === undefined ? "deleted" : "changed"}\n`);
			continue;
		}
		patches.push(
			createTwoFilesPatch(old === undefined ? "/dev/null" : `a/${name}`, now === undefined ? "/dev/null" : `b/${name}`, old?.toString("utf8") ?? "", now?.toString("utf8") ?? "", undefined, undefined, { context: 3 })
				.split("\n")
				.slice(1)
				.join("\n"),
		);
	}
	return patches.join("");
}
