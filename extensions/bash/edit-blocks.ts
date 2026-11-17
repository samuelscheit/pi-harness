// `tool edit - <<'EOF'`: edits of several files as SEARCH/REPLACE blocks on stdin, from a bash command.
//
// Agents changed files with inline Python far more often than with `edit` (2026-11-12/13: 813
// Python heredocs against 451 edit calls). 63% of those scripts ran a build or test right after
// the edit, 37% changed several files, and 56% asserted that each old text occurs once — the
// edit tool's own check, rebuilt by hand. A single `edit` call takes one file and cannot be
// followed by a check in the same response (tool calls of one response run in parallel), and
// `tool edit` with JSON arguments means escaping code by hand. This format needs no escaping in
// a quoted heredoc and is the one models already know (aider's SEARCH/REPLACE blocks).
//
// Every file is checked with Pi's own matching (computeEditsDiff) before any is written, so a
// block that does not match changes nothing. Then each file is one `edit` call through the
// session's tool pipeline: pi-lens checks it and the metrics count it as an edit.
//
// A relative path the shell's directory does not hold is looked up from the repository root:
// agents `cd` into a subdirectory for the check that follows and still write the path as git
// shows it (2026-11-16, one thread, twice: `cd repo/tools/kernel && tool edit -` with
// `tools/kernel/dead_refs.py`; each refusal cost a turn over the whole context, and the check
// after it ran on the old code).
//
// An empty REPLACE part deletes the SEARCH lines with their line breaks, as `edit` does when its
// newText leaves out the newline. The parts are lines without their breaks, so an empty REPLACE
// used to become newText "" for oldText "line" and left a blank line (2026-11-16, twice: a deleted
// `"test_copied_conditions.py": 19,` entry of a Python dict stayed as an empty line). REPLACE with
// one empty line is told apart: it leaves one blank line in place of the SEARCH lines.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { computeEditsDiff, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { ToolResponse } from "./bridge.ts";

export interface Edit {
	oldText: string;
	newText: string;
}

/** A block; `deleteLines` when its REPLACE part is empty: whole SEARCH lines go with their line breaks. */
export interface Block extends Edit {
	deleteLines?: true;
}

export interface FileEdits {
	path: string;
	edits: Block[];
}

export class EditBlocksError extends Error {}

const SEARCH = /^<{7} SEARCH\s*$/;
const DIVIDER = /^={7}\s*$/;
const REPLACE = /^>{7} REPLACE\s*$/;
/**
 * A line git writes as a conflict marker, which the block delimiters are made of. Inside a block
 * only its own three delimiters may look like this: git's `=======` ended a SEARCH part early, so a
 * conflict hunk to resolve was cut in two, its first half matched, and the file kept its markers
 * (2026-11-15, tools/kernel/land.py, committed by `git rebase --continue`).
 */
const CONFLICT_START = /^<{7}(?:\s|$)/;
const CONFLICT_END = /^>{7}(?:\s|$)/;
const isMarker = (line: string) => CONFLICT_START.test(line) || DIVIDER.test(line) || CONFLICT_END.test(line);

export const EDIT_BLOCKS_HELP = `Several files from stdin: \`tool edit - <<'EOF'\`, then for each file its path on a line of its own and one or more blocks:
  path/to/file.ts
  <<<<<<< SEARCH
  exact text to replace (unique in the file)
  =======
  new text
  >>>>>>> REPLACE
An empty REPLACE part (\`=======\` directly followed by \`>>>>>>> REPLACE\`) deletes the SEARCH text; when SEARCH is whole lines, their line breaks go too, so no blank line is left. A REPLACE of one empty line leaves one blank line in their place. A SEARCH that is part of a line deletes only that part.
Relative paths resolve against the shell's current directory, or, when it holds no such file, the git repository's root. Every file is checked before any is written: if a block does not match, nothing changes. Quote the delimiter ('EOF') so the shell leaves $ and backticks alone.
Inside a block no other line may be \`=======\` or start with \`<<<<<<<\`/\`>>>>>>>\`: such text (git conflict hunks, a 7-character === underline) is ambiguous and refused; change it with --path and --edits instead. A file that still holds a git conflict (\`<<<<<<<\` … \`=======\` … \`>>>>>>>\`) after the edit, when the edit added it or git lists the file as unmerged, exits 1.`;

/**
 * The path a path line names. Models often write it the way diffs and Markdown do: `--- a/x.py`,
 * `+++ b/x.py`, `*** x.py`, `## x.py`, `File: x.py`, `` `x.py` ``, `x.py:` (2026-11-14: `--- tools/kernel/mutation.py`
 * was taken as the path, nothing was edited, and the check after it ran on the old code).
 */
export function pathOf(line: string): string {
	let path = line.trim();
	const diff = /^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+)$/.exec(path);
	if (diff) path = diff[1]!;
	path = path.replace(/^(?:\*\*\*|#{1,6})\s+/, "").replace(/^(?:file|path):\s*/i, "");
	path = path.replace(/^(["'`])(.*)\1$/, "$2").replace(/:$/, "");
	return path.trim();
}

/** The files and their edits, in the order the paths first appear; blocks of a repeated path join it. */
export function parseEditBlocks(text: string): FileEdits[] {
	const files = new Map<string, FileEdits>();
	let path: string | undefined;
	let blocksOfPath = 0;
	const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
	const endPath = () => {
		if (path !== undefined && blocksOfPath === 0) throw new EditBlocksError(`${path}: no SEARCH/REPLACE block follows the path`);
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (SEARCH.test(line)) {
			if (path === undefined) throw new EditBlocksError(`line ${i + 1}: a block before any path; put the file's path on the line above \`<<<<<<< SEARCH\``);
			const start = i + 1;
			const search: string[] = [];
			const replace: string[] = [];
			let part = search;
			for (i += 1; ; i++) {
				if (i >= lines.length) throw new EditBlocksError(`${path}: the block at line ${start} has no \`${part === search ? "=======" : ">>>>>>> REPLACE"}\` line`);
				const inner = lines[i]!;
				if (part === search && DIVIDER.test(inner)) part = replace;
				else if (part === replace && REPLACE.test(inner)) break;
				else if (isMarker(inner)) {
					throw new EditBlocksError(
						`${path}: line ${i + 1} \`${inner.trim()}\` inside the block at line ${start} looks like a conflict marker, so where the block's parts end is ambiguous; nothing changed. Change text with such lines through \`tool edit --path … --edits '[{"oldText": …, "newText": …}]'\` (JSON)`,
					);
				} else part.push(inner);
			}
			if (search.length === 0 || search.join("").trim() === "") {
				throw new EditBlocksError(`${path}: the block at line ${start} has an empty SEARCH part; create files with \`tool write\``);
			}
			const file = files.get(path) ?? files.set(path, { path, edits: [] }).get(path)!;
			file.edits.push({ oldText: search.join("\n"), newText: replace.join("\n"), ...(replace.length === 0 && { deleteLines: true as const }) });
			blocksOfPath += 1;
		} else if (isMarker(line)) {
			throw new EditBlocksError(`line ${i + 1}: \`${line.trim()}\` outside a block`);
		} else if (line.trim() !== "" && !line.startsWith("```")) {
			endPath();
			path = pathOf(line);
			blocksOfPath = 0;
		}
	}
	endPath();
	if (files.size === 0) throw new EditBlocksError(`no blocks on stdin\n\n${EDIT_BLOCKS_HELP}`);
	return [...files.values()];
}

const occurrences = (text: string, part: string) => text.split(part).length - 1;

/**
 * The edit of a block in a file with this content: a deletion of SEARCH text that is whole lines
 * there takes the line break after it, or, on the last line without one, the line break before
 * it, as the file's own text. Lines compare without trailing whitespace, as Pi's edit matching
 * does. Anything else, an ambiguous SEARCH included, stays as written for `edit` to apply or refuse.
 */
export function editOf(content: string, block: Block): Edit {
	const { oldText, newText } = block;
	if (!block.deleteLines) return { oldText, newText };
	const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const lines = text.split("\n");
	const search = oldText.split("\n").map((line) => line.trimEnd());
	const starts = lines.flatMap((_, start) =>
		start + search.length <= lines.length && search.every((line, offset) => lines[start + offset]!.trimEnd() === line) ? [start] : [],
	);
	if (starts.length !== 1 || occurrences(text, oldText) > 1) return { oldText, newText };
	const start = starts[0]!;
	const end = start + search.length;
	const matched = lines.slice(start, end).join("\n");
	const whole = end < lines.length ? `${matched}\n` : start > 0 ? `\n${matched}` : matched;
	return occurrences(text, whole) === 1 ? { oldText: whole, newText } : { oldText, newText };
}

const textOf = (content: readonly { type: string; text?: string }[] | undefined) =>
	(content ?? []).flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("\n");

const withNewline = (text: string) => (text === "" || text.endsWith("\n") ? text : `${text}\n`);

/** The 1-based lines starting a complete git conflict: `<<<<<<<`, then `=======`, then `>>>>>>>`, each at line start. */
export function conflictLines(text: string): number[] {
	const starts: number[] = [];
	let start: number | undefined;
	let divided = false;
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		if (CONFLICT_START.test(line)) [start, divided] = [index + 1, false];
		else if (start !== undefined && DIVIDER.test(line)) divided = true;
		else if (start !== undefined && divided && CONFLICT_END.test(line)) {
			starts.push(start);
			start = undefined;
		}
	}
	return starts;
}

const execFileAsync = promisify(execFile);

/** Whether git lists the file as unmerged; false outside a repository. */
async function unmerged(path: string): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync("git", ["ls-files", "--unmerged", "--", path], { cwd: dirname(path) });
		return stdout.trim() !== "";
	} catch {
		return false;
	}
}

/** A warning when an edited file still holds a conflict the edit added, or one of a file git has not merged. */
async function conflictWarning(path: string, before: string): Promise<string | undefined> {
	const after = conflictLines(readFileSync(path, "utf8"));
	if (after.length === 0) return undefined;
	if (after.length <= conflictLines(before).length && !(await unmerged(path))) return undefined;
	return `${path}: changed, but it still holds git conflict markers (conflicts starting at line ${after.join(", ")}); resolve them before staging it`;
}

/** The root of the git repository holding `cwd`; undefined outside one. */
async function repositoryRoot(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Where each relative path points: against `cwd`, or, when `cwd` holds no such file but the
 * repository root does, against the root. A path that exists under neither stays against `cwd`.
 */
export async function resolvePaths(paths: readonly string[], cwd: string): Promise<string[]> {
	let root: Promise<string | undefined> | undefined;
	return Promise.all(
		paths.map(async (path) => {
			if (isAbsolute(path)) return path;
			const local = resolve(cwd, path);
			if (existsSync(local)) return local;
			const top = await (root ??= repositoryRoot(cwd));
			const fromRoot = top === undefined ? undefined : resolve(top, path);
			return fromRoot !== undefined && existsSync(fromRoot) ? fromRoot : local;
		}),
	);
}

/** Check every file's blocks, then apply them file by file as `edit` calls. */
export async function runEditBlocks(
	ctx: Pick<ExtensionToolContext, "executeTool">,
	stdin: string,
	cwd: string,
	signal: AbortSignal,
): Promise<ToolResponse> {
	let parsed: FileEdits[];
	try {
		parsed = parseEditBlocks(stdin);
	} catch (error) {
		if (!(error instanceof EditBlocksError)) throw error;
		return { stdout: "", stderr: `tool edit: ${error.message}\n`, code: 2 };
	}
	const paths = await resolvePaths(
		parsed.map((file) => file.path),
		cwd,
	);
	const files = parsed.map((file, index) => {
		const path = paths[index]!;
		const content = existsSync(path) ? readFileSync(path, "utf8") : "";
		return { path, before: content, edits: file.edits.map((block) => editOf(content, block)) };
	});
	const checks = await Promise.all(files.map((file) => computeEditsDiff(file.path, file.edits, cwd)));
	const failures = checks.flatMap((check, index) => {
		if (!("error" in check)) return [];
		const path = files[index]!.path;
		const missing = !existsSync(path) ? " (no such file: a path line holds only the file's path, relative to the shell's current directory or the repository root)" : "";
		return [`${path}: ${check.error}${missing}`];
	});
	if (failures.length > 0) {
		return { stdout: "", stderr: `tool edit: nothing changed, ${failures.length} of ${files.length} files do not match:\n${failures.join("\n")}\n`, code: 1 };
	}
	const out: string[] = [];
	const warnings: string[] = [];
	for (const [index, file] of files.entries()) {
		const outcome = await ctx.executeTool("edit", { path: file.path, edits: file.edits }, { signal });
		const text = textOf(outcome.result.content as { type: string; text?: string }[]);
		if (outcome.isError) {
			// Only a change made between the check and the write (another writer) gets here.
			const rest = files.slice(index + 1).map((f) => f.path);
			const done = files.slice(0, index).map((f) => f.path);
			return {
				stdout: withNewline(out.join("\n")),
				stderr: `tool edit: ${file.path}: ${text}\nchanged: ${done.join(", ") || "none"}; not attempted: ${rest.join(", ") || "none"}\n`,
				code: 1,
			};
		}
		out.push(text);
		const warning = await conflictWarning(file.path, file.before);
		if (warning) warnings.push(warning);
	}
	if (warnings.length > 0) return { stdout: withNewline(out.join("\n")), stderr: `tool edit: ${warnings.join("\n")}\n`, code: 1 };
	return { stdout: withNewline(out.join("\n")), stderr: "", code: 0 };
}
