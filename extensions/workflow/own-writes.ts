// The files a delegated child's own tool calls changed in a run, so its parent can tell them from
// changes other agents made in the same working tree meanwhile.
//
// fix_loop attributed every file the tree changed during its run to its child and kept sending the
// child rounds to undo files the parent agent edited in parallel; the child spent 4 rounds refusing
// to revert the parent's work (2026-11-16). A tree diff cannot say who wrote a file; the child's own
// tool calls can:
// - `edit` and `write` (also `tool edit` from bash: nested calls pass the same events) changed the
//   path they name, when they succeeded;
// - a `bash` call changed the files that changed between its start and end (a snapshot of the tree
//   on each side) and that the command names: a path, a directory or a glob in it, or the file's name
//   (`cd src && sed -i '' … parse.ts`). Where a command goes (`cd`, `pushd`) names nothing, and
//   neither does the working directory or a parent of it (`git -C /repo …`), so a check run as
//   `cd /repo && npm test` takes no file. A long check run in bash while another agent edits files
//   would otherwise take their files too. A file a command changes without naming it (a code
//   generator) is not counted: it reads as someone else's change, which fix_loop reports to its
//   caller instead of sending it to the child.
// Paths are absolute and canonical (symlinks resolved), as workspace.ts reports them.

import { matchesGlob, relative, resolve } from "node:path";
import { canonical, changedPaths, gitRoot, type Snapshot, snapshot } from "../lib/workspace.ts";

const FILE_TOOLS = new Set(["edit", "write"]);
const GLOB = /[*?[\]{}]/;
/** `cd <dir>` and `pushd <dir>`: where a command goes, not what it changes. */
const CHANGE_DIRECTORY = /(?:^|[\s;&|(])(?:cd|pushd)\s+(?:"[^"]*"|'[^']*'|\S+)/g;

/** Whether `command` names `path` (absolute), with `cwd` the directory relative paths start from. */
export function namesPath(command: string, path: string, cwd: string): boolean {
	const base = canonical(cwd);
	const rel = relative(base, path);
	for (const raw of command.replace(CHANGE_DIRECTORY, " ").split(/[\s"'`;|&<>(),=]+/)) {
		const token = raw.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
		if (!token || token === "." || /^(\.\.\/)*\.\.$/.test(token)) continue;
		if (GLOB.test(token)) {
			if (matchesGlob(rel, token) || matchesGlob(rel, `**/${token}`) || matchesGlob(path, token)) return true;
			continue;
		}
		if (token.startsWith("/")) {
			const absolute = canonical(token);
			const parentOfCwd = base === absolute || base.startsWith(`${absolute === "/" ? "" : absolute}/`);
			if (path === absolute || (!parentOfCwd && path.startsWith(`${absolute}/`))) return true;
		} else if (rel === token || rel.startsWith(`${token}/`) || rel.endsWith(`/${token}`)) return true;
	}
	return false;
}

type Pending = { paths: string[] } | { command: string; cwd: string; before: Snapshot };

/** Tracks one session's calls in flight; `ended` returns the paths a call changed. */
export function ownWrites() {
	const pending = new Map<string, Pending>();
	return {
		async started(callId: string, toolName: string, input: Record<string, unknown>, cwd: string): Promise<void> {
			if (FILE_TOOLS.has(toolName) && typeof input.path === "string") pending.set(callId, { paths: [canonical(resolve(cwd, input.path))] });
			else if (toolName === "bash" && typeof input.command === "string") {
				const root = await gitRoot(cwd);
				if (root) pending.set(callId, { command: input.command, cwd, before: await snapshot(root) });
			}
		},
		async ended(callId: string, failed: boolean): Promise<string[]> {
			const call = pending.get(callId);
			if (!call) return [];
			pending.delete(callId);
			if ("paths" in call) return failed ? [] : call.paths;
			// A failing command may have written files before it failed.
			const changed = await changedPaths(call.before, await snapshot(call.before.root));
			return changed.filter((path) => namesPath(call.command, path, call.cwd));
		},
	};
}
