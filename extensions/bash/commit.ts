// A commit that would take changes this session's edit and write tools did not make is refused
// before it runs.
//
// In a shared checkout, `git commit --only a b` committed another agent's uncommitted edits to
// those files: the other agent changed them between this agent's `git diff` and its commit
// (2026-11-14). A rule to check the diff right before committing leaves that gap open; the tool can
// close most of it, because it sees every change the session makes with `edit` and `write` (also
// `tool edit` from bash: nested calls pass the same tool_call and tool_result events).
//
// For each file the session changes, it keeps the content (as a git blob id) its last edit or write
// left, and whether the file stayed the session's own: each change must start from the content the
// one before left, and the first from the committed content (HEAD). A change that starts from
// HEAD starts a new record, so files committed earlier, or discarded by their owner, start over.
// Before a bash command runs `git commit`, the content each committed path would get (the working
// tree for `-a`, `--only`/`-i` and pathspecs, the index for a plain commit; a `git add` earlier in
// the same command counts as the working tree) must be the content the session's last change left,
// and that record must be clean. Otherwise the commit is refused, with each path and why. Changes the
// session made with a command (a formatter, `sed`, a generator) or a child agent made for it look the
// same as another agent's, so after `git diff` shows they are its own, `PI_COMMIT_CHECKED=1 git
// commit …` runs it.
//
// Limits: a change in the milliseconds between this check and git's own read still goes in; the
// records live in the process (a reload keeps them, a restart of the harness does not); content is
// compared as written, so a file under a git clean filter (LFS, `text=auto` on CRLF) is reported.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { commandsIn, type GitCommand, gitCommand, refusalText } from "./commands.ts";

/** The variable that runs a refused commit after its changes were checked. */
export const COMMIT_CHECKED = "PI_COMMIT_CHECKED";

/** What the session did to one file. */
interface FileRecord {
	/** The blob id of the content the session's last change left; null: the file did not exist. */
	last: string | null;
	/** Why the file is not only the session's own since its last commit, if so. */
	foreign?: string;
	/** Counts the session's completed changes, to tell its own parallel changes from another agent's. */
	changes: number;
}

/** A change in progress: what it started from. */
interface Pending {
	path: string;
	before: string | null;
	/** The file's content in HEAD equals `before`. */
	clean: boolean;
	/** `changes` of the record when it started. */
	changes: number | undefined;
}

interface SessionFiles {
	files: Map<string, FileRecord>;
	pending: Map<string, Pending>;
}

// Process state, so a reload of the extension keeps the records.
const state = globalThis as { __harnessFileRecords?: Map<string, SessionFiles> };
export function sessionFiles(sessionId: string): SessionFiles {
	state.__harnessFileRecords ??= new Map();
	let files = state.__harnessFileRecords.get(sessionId);
	if (!files) state.__harnessFileRecords.set(sessionId, (files = { files: new Map(), pending: new Map() }));
	return files;
}
export const dropSessionFiles = (sessionId: string) => state.__harnessFileRecords?.delete(sessionId);

/** Git's blob id of `content`. */
const blobId = (content: Buffer) => createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

/** The blob id of a file's content, null when it does not exist. */
export function fileBlob(path: string): string | null {
	try {
		return blobId(readFileSync(path));
	} catch {
		return null;
	}
}

/** The path with symlinks resolved (macOS: /tmp is /private/tmp), also for a file that does not exist yet. */
export function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const parent = dirname(path);
		return parent === path ? path : join(canonical(parent), basename(path));
	}
}

/** Runs git; undefined when it fails. */
function git(dir: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
	} catch {
		return undefined;
	}
}
const nulList = (output: string | undefined) => (output ?? "").split("\0").filter(Boolean);

/** The blob id of a file in HEAD; null when HEAD does not have it (or there is no repository). */
function headBlob(path: string): string | null {
	return git(dirname(path), ["rev-parse", "-q", "--verify", `HEAD:./${basename(path)}`])?.trim() || null;
}

/** An edit or write of `path` (absolute) starts: what it starts from. */
export function changeStarts(files: SessionFiles, callId: string, path: string): void {
	const key = canonical(path);
	const before = fileBlob(key);
	files.pending.set(callId, { path: key, before, clean: before === headBlob(key), changes: files.files.get(key)?.changes });
}

/** The edit or write `callId` ended: its result is the session's, and whether it started from the session's own content says whether the file still is. */
export function changeEnds(files: SessionFiles, callId: string, failed: boolean): void {
	const pending = files.pending.get(callId);
	if (!pending) return;
	files.pending.delete(callId);
	const record = files.files.get(pending.path);
	if (failed && !record) return;
	const last = fileBlob(pending.path);
	if (pending.clean) {
		files.files.set(pending.path, { last, changes: (record?.changes ?? 0) + 1 });
		return;
	}
	let foreign = record?.foreign;
	if (!record) foreign = "had uncommitted changes before your first edit";
	// Another change of the session's own ended meanwhile (parallel calls): no comparison possible.
	else if (record.changes === pending.changes && pending.before !== record.last) foreign ??= "changed by someone else between your edits";
	files.files.set(pending.path, { last, foreign, changes: (record?.changes ?? 0) + 1 });
}

/** Options of `git commit` that take the next word as their value (long ones also as `--opt=value`). */
const COMMIT_VALUED_LONG = new Set(["--message", "--file", "--reuse-message", "--reedit-message", "--author", "--date", "--fixup", "--squash", "--template", "--cleanup", "--trailer", "--pathspec-from-file"]);
const COMMIT_VALUED_SHORT = new Set(["m", "F", "C", "c", "t"]);

interface CommitOptions {
	flags: Set<string>;
	pathspecs: string[];
}

/** A `git commit`'s or `git add`'s flags (short ones by letter, long ones as written) and pathspecs. */
function options(args: readonly string[], valuedLong: ReadonlySet<string>, valuedShort: ReadonlySet<string>): CommitOptions {
	const flags = new Set<string>();
	const pathspecs: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") {
			pathspecs.push(...args.slice(i + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const name = arg.replace(/=.*$/s, "");
			flags.add(name);
			if (valuedLong.has(name) && !arg.includes("=")) i += 1;
		} else if (arg.startsWith("-") && arg.length > 1) {
			for (let j = 1; j < arg.length; j++) {
				flags.add(arg[j]!);
				if (valuedShort.has(arg[j]!)) {
					if (j === arg.length - 1) i += 1;
					break;
				}
			}
		} else pathspecs.push(arg);
	}
	return { flags, pathspecs };
}

/** A `git add` before the commit in the same command: its pathspecs, and whether it adds untracked files (not `-u`). */
interface Added {
	pathspecs: string[];
	untracked: boolean;
}

/** A path a commit takes, and where its content comes from. */
type Source = "worktree" | "index";

/** One refused path: relative to the repository, and why. */
export interface Problem {
	path: string;
	why: string;
}

/** The paths (relative to the top) with working-tree changes against HEAD under `pathspecs`, untracked ones too when `untracked`. */
function changedPaths(dir: string, pathspecs: readonly string[], untracked: boolean): string[] {
	const head = git(dir, ["rev-parse", "-q", "--verify", "HEAD"]) ? "HEAD" : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
	const tracked = nulList(git(dir, ["diff", "--name-only", "--no-relative", "-z", "--no-renames", head, "--", ...pathspecs]));
	if (!untracked) return tracked;
	return [...tracked, ...nulList(git(dir, ["ls-files", "-z", "--full-name", "--others", "--exclude-standard", "--", ...pathspecs]))];
}

/** What one `git commit` would take: each path, relative to the repository's top, and its content's source. */
function committed(dir: string, commit: GitCommand, added: readonly Added[]): Map<string, Source> {
	const { flags, pathspecs } = options(commit.args, COMMIT_VALUED_LONG, COMMIT_VALUED_SHORT);
	const paths = new Map<string, Source>();
	const staged = () => {
		for (const path of nulList(git(dir, ["diff", "--cached", "--name-only", "--no-relative", "-z", "--no-renames"]))) paths.set(path, "index");
		// A `git add` earlier in the same command has not run yet: its paths go in from the working tree.
		for (const add of added) for (const path of changedPaths(dir, add.pathspecs, add.untracked)) paths.set(path, "worktree");
	};
	if (pathspecs.length > 0) {
		if (flags.has("i") || flags.has("--include")) staged();
		for (const path of changedPaths(dir, pathspecs, false)) paths.set(path, "worktree");
	} else {
		staged();
		if (flags.has("a") || flags.has("--all")) for (const path of changedPaths(dir, [], false)) paths.set(path, "worktree");
	}
	return paths;
}

/** The blob ids the index holds for `paths` (absent: deleted from the index). */
function indexBlobs(top: string, paths: readonly string[]): Map<string, string> {
	const blobs = new Map<string, string>();
	if (paths.length === 0) return blobs;
	for (const line of nulList(git(top, ["--literal-pathspecs", "ls-files", "-s", "-z", "--", ...paths]))) {
		const match = /^\d+ ([0-9a-f]+) \d\t(.*)$/s.exec(line);
		if (match) blobs.set(match[2]!, match[1]!);
	}
	return blobs;
}

/** Why the paths one commit in `dir` would take are not only the session's own; empty when they are. */
export function commitProblems(files: SessionFiles, dir: string, commit: GitCommand, added: readonly Added[] = []): Problem[] {
	const top = git(dir, ["rev-parse", "--show-toplevel"])?.trim();
	if (!top || options(commit.args, COMMIT_VALUED_LONG, COMMIT_VALUED_SHORT).flags.has("--dry-run")) return [];
	const paths = committed(dir, commit, added);
	const index = indexBlobs(top, [...paths].flatMap(([path, source]) => (source === "index" ? [path] : [])));
	const problems: Problem[] = [];
	for (const [path, source] of paths) {
		const absolute = canonical(join(top, path));
		const record = files.files.get(absolute);
		const content = source === "index" ? (index.get(path) ?? null) : fileBlob(absolute);
		const why = !record
			? "not changed by your edit or write tools in this session"
			: record.foreign
				? record.foreign
				: record.last !== content
					? "changed since your last edit (by another agent or a command)"
					: undefined;
		if (why) problems.push({ path, why });
	}
	return problems;
}

const expandHome = (path: string) => (path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
/** The file an edit or write call's `path` names, as Pi's tools resolve it (a leading `@` dropped, `~` expanded). */
export const toolPath = (path: string, cwd: string) => resolve(cwd, expandHome(path.replace(/^@/, "")));

/**
 * Why `source`, run in `cwd`, is refused because a commit in it takes changes the session's edit
 * and write tools did not make; undefined otherwise. A literal `cd` before a commit moves where it
 * runs; a `git add` before it adds its pathspecs.
 */
export function commitRefusal(files: SessionFiles, source: string, cwd: string): string | undefined {
	let dir = cwd;
	const added: Added[] = [];
	const refused: { text: string; problems: Problem[] }[] = [];
	for (const command of commandsIn(source)) {
		if (command.name === "cd" && command.args.length === 1 && !command.args[0]!.includes("$")) dir = resolve(dir, expandHome(command.args[0]!));
		const git = gitCommand(command);
		if (!git) continue;
		const at = resolve(dir, ...git.dirs.map(expandHome));
		if (git.subcommand === "add") {
			const { flags, pathspecs } = options(git.args, new Set(["--pathspec-from-file", "--chmod"]), new Set());
			const update = flags.has("u") || flags.has("--update");
			// Relative to where the commit runs: absolute, except pathspecs with magic (`:/src`).
			if (pathspecs.length || update || flags.has("A") || flags.has("--all"))
				added.push({ pathspecs: pathspecs.length ? pathspecs.map((p) => (p.startsWith(":") ? p : resolve(at, p))) : [":/"], untracked: !update });
		}
		if (git.subcommand !== "commit" || command.env[COMMIT_CHECKED]) continue;
		const problems = commitProblems(files, at, git, added);
		if (problems.length) refused.push({ text: command.text, problems });
	}
	if (refused.length === 0) return undefined;
	const problems = refused.flatMap((r) => r.problems);
	const LIMIT = 20;
	const shown = problems.slice(0, LIMIT).map(({ path, why }) => `- \`${path}\`: ${why}`);
	if (problems.length > LIMIT) shown.push(`- … and ${problems.length - LIMIT} more`);
	return refusalText(
		"commits changes your edit and write tools did not make",
		refused.map((r) => r.text),
		"Paths:",
		...shown,
		"Other agents may be working in this checkout, so these changes may be theirs: committing them takes their unfinished work into your commit. Check each with `git diff HEAD -- <path>` and leave out what is not yours.",
		`If every change in them is yours (made with a command such as a formatter, or by a child agent you delegated to), run the commit again as \`${COMMIT_CHECKED}=1 git commit …\`.`,
	);
}
