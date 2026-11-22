// Atomic multi-file SEARCH/REPLACE editing for Antigravity (`agy`), reusing pi-harness's
// `edit-blocks.ts` parser, Pi's `computeEditsDiff` matcher, and `commit.ts` own-writes tracking.
//
// Used by both `agy/bin/tool.ts` (`tool edit - <<'EOF'`) and the `edit_blocks` MCP tool.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { computeEditsDiff } from "@earendil-works/pi-coding-agent";
import { changeEnds, changeStarts } from "../extensions/bash/commit.ts";
import {
	conflictLines,
	EditBlocksError,
	editOf,
	type FileEdits,
	parseEditBlocks,
	resolvePaths,
} from "../extensions/bash/edit-blocks.ts";
import { loadOwnWrites, pluginDataDir, saveOwnWrites } from "./state.ts";

const execFileAsync = promisify(execFile);

async function unmerged(path: string): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync("git", ["ls-files", "--unmerged", "--", path], { cwd: dirname(path) });
		return stdout.trim() !== "";
	} catch {
		return false;
	}
}

async function conflictWarning(path: string, before: string): Promise<string | undefined> {
	const after = conflictLines(readFileSync(path, "utf8"));
	if (after.length === 0) return undefined;
	if (after.length <= conflictLines(before).length && !(await unmerged(path))) return undefined;
	return `${path}: changed, but it still holds git conflict markers (conflicts starting at line ${after.join(", ")}); resolve them before staging it`;
}

/**
 * Apply Pi's validated `edits` to `content`, preserving CRLF and BOM conventions.
 * Matches only after `computeEditsDiff` already verified exact/fuzzy uniqueness.
 */
function applyEditsToContent(raw: string, edits: { oldText: string; newText: string }[]): string {
	const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
	const body = bom ? raw.slice(1) : raw;
	const crlf = body.includes("\r\n");
	let normalized = body.replace(/\r\n/g, "\n");
	for (const edit of edits) {
		const oldNorm = edit.oldText.replace(/\r\n/g, "\n");
		const newNorm = edit.newText.replace(/\r\n/g, "\n");
		const exactIndex = normalized.indexOf(oldNorm);
		if (exactIndex !== -1 && normalized.indexOf(oldNorm, exactIndex + 1) === -1) {
			normalized = normalized.slice(0, exactIndex) + newNorm + normalized.slice(exactIndex + oldNorm.length);
			continue;
		}
		// Trailing-whitespace fuzzy line match (mirrors Pi's fuzzy edit matching).
		const lines = normalized.split("\n");
		const target = oldNorm.split("\n").map((l) => l.trimEnd());
		const matches: number[] = [];
		for (let i = 0; i + target.length <= lines.length; i++) {
			if (target.every((t, off) => lines[i + off]!.trimEnd() === t)) matches.push(i);
		}
		if (matches.length !== 1) {
			throw new Error(`could not uniquely locate SEARCH block (${matches.length} matches)`);
		}
		const start = matches[0]!;
		const replacement = newNorm === "" && oldNorm.endsWith("\n") ? [] : newNorm.split("\n");
		lines.splice(start, target.length, ...replacement);
		normalized = lines.join("\n");
	}
	const restored = crlf ? normalized.replace(/\n/g, "\r\n") : normalized;
	return `${bom}${restored}`;
}

export interface ApplyBlocksOptions {
	cwd: string;
	conversationId?: string;
	dataDir?: string;
}

export interface ApplyBlocksResult {
	stdout: string;
	stderr: string;
	code: number;
	changed: string[];
}

const withNewline = (text: string) => (text === "" || text.endsWith("\n") ? text : `${text}\n`);

/** Validate every file's SEARCH/REPLACE blocks with Pi's matcher, then apply them and record own-writes. */
export async function applyEditBlocks(input: string, options: ApplyBlocksOptions): Promise<ApplyBlocksResult> {
	let parsed: FileEdits[];
	try {
		parsed = parseEditBlocks(input);
	} catch (error) {
		if (!(error instanceof EditBlocksError)) throw error;
		return { stdout: "", stderr: `tool edit: ${error.message}\n`, code: 2, changed: [] };
	}

	const paths = await resolvePaths(
		parsed.map((f) => f.path),
		options.cwd,
	);
	const files = parsed.map((file, index) => {
		const path = paths[index]!;
		const content = existsSync(path) ? readFileSync(path, "utf8") : "";
		return { path, before: content, edits: file.edits.map((block) => editOf(content, block)) };
	});

	const checks = await Promise.all(files.map((file) => computeEditsDiff(file.path, file.edits, options.cwd)));
	const failures = checks.flatMap((check, index) => {
		if (!("error" in check)) return [];
		const path = files[index]!.path;
		const missing = !existsSync(path) ? " (no such file: a path line holds only the file's path, relative to the shell's current directory or the repository root)" : "";
		return [`${path}: ${check.error}${missing}`];
	});
	if (failures.length > 0) {
		return {
			stdout: "",
			stderr: `tool edit: nothing changed, ${failures.length} of ${files.length} files do not match:\n${failures.join("\n")}\n`,
			code: 1,
			changed: [],
		};
	}

	const dataDir = options.dataDir ?? pluginDataDir();
	const ownWrites = options.conversationId ? loadOwnWrites(options.conversationId, dataDir) : undefined;
	const out: string[] = [];
	const warnings: string[] = [];
	const changed: string[] = [];

	for (const [index, file] of files.entries()) {
		const callId = `edit-blocks-${randomUUID()}`;
		try {
			if (ownWrites) changeStarts(ownWrites, callId, file.path);
			const nextContent = applyEditsToContent(file.before, file.edits);
			writeFileSync(file.path, nextContent);
			if (ownWrites) changeEnds(ownWrites, callId, false);
			changed.push(file.path);
			out.push(`Successfully edited ${file.path} (${file.edits.length} block${file.edits.length === 1 ? "" : "s"}).`);
			const warning = await conflictWarning(file.path, file.before);
			if (warning) warnings.push(warning);
		} catch (error) {
			if (ownWrites) changeEnds(ownWrites, callId, true);
			if (options.conversationId && ownWrites) saveOwnWrites(options.conversationId, ownWrites, dataDir);
			const rest = files.slice(index + 1).map((f) => f.path);
			return {
				stdout: withNewline(out.join("\n")),
				stderr: `tool edit: ${file.path}: ${error instanceof Error ? error.message : String(error)}\nchanged: ${changed.join(", ") || "none"}; not attempted: ${rest.join(", ") || "none"}\n`,
				code: 1,
				changed,
			};
		}
	}

	if (options.conversationId && ownWrites) saveOwnWrites(options.conversationId, ownWrites, dataDir);
	if (warnings.length > 0) {
		return { stdout: withNewline(out.join("\n")), stderr: `tool edit: ${warnings.join("\n")}\n`, code: 1, changed };
	}
	return { stdout: withNewline(out.join("\n")), stderr: "", code: 0, changed };
}
