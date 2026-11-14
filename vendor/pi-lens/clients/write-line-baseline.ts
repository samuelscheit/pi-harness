/**
 * The lines a whole-file write changed.
 *
 * A write replaces a file's bytes, so its `tool_result` carries no diff. Every
 * write of an existing file used to dispatch with every line in edit scope:
 * the host's `write` tool, and each file a bash command wrote that pi-lens
 * recognized (`sed -i`, a heredoc script; replayed as a synthetic `write`).
 * Every edit-scoped gate (tree-sitter's blocking tier, the linter policy in
 * `dispatch/blocker-policy.ts`) then blocked on findings the write never
 * touched: on 2026-11-12 a `sed -i` that changed line 15 of a file stopped the
 * agent on two `sql-injection` matches at lines 144 and 171 that predated the
 * session.
 *
 * `tool_call` records each target's per-line hashes before the call runs
 * ({@link recordPreWriteLines}); `tool_result` aligns them to the bytes after
 * it ({@link takeWriteChangedRanges}). Without a baseline (a new file, a call
 * without an id, a file past the caps, a rewrite past the alignment's edit
 * bound) the write keeps the whole file in scope.
 *
 * Bounded: at most {@link MAX_BASELINE_TARGETS_PER_CALL} files per call, each
 * at most {@link MAX_BASELINE_FILE_BYTES}, and {@link MAX_BASELINES} entries
 * in all, oldest evicted first (a blocked call never takes its entry).
 */
import * as nodeFs from "node:fs";
import { BoundedFifoMap } from "./bounded-cache.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { changedLineRanges, MAX_ALIGNMENT_LINES } from "./line-alignment.js";
import { normalizeMapKey } from "./path-utils.js";

/** The inline blocker baseline's own byte cap. */
export const MAX_BASELINE_FILE_BYTES = 2 * 1024 * 1024;
/** Files one call may baseline; a command naming more keeps the rest whole. */
export const MAX_BASELINE_TARGETS_PER_CALL = 16;
/** Baselines kept across calls (4 bytes per line, at most 400 KB each). */
export const MAX_BASELINES = 64;

const baselines = new BoundedFifoMap<string, Uint32Array>(MAX_BASELINES);

const keyOf = (toolCallId: string, filePath: string) =>
	`${toolCallId}\u0000${normalizeMapKey(filePath)}`;

/**
 * Exact per-line hashes (32-bit FNV-1a over the UTF-16 code units). Exact,
 * not the read guard's whitespace-stripped hash: re-indenting a Python or YAML
 * line changes what it means. Undefined past {@link MAX_ALIGNMENT_LINES}.
 */
export function exactLineHashes(text: string): Uint32Array | undefined {
	const lines = text.split(/\r?\n/);
	if (lines.length > MAX_ALIGNMENT_LINES) return undefined;
	return Uint32Array.from(lines, (line) => {
		let hash = 0x811c9dc5;
		for (let i = 0; i < line.length; i += 1) {
			hash ^= line.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193);
		}
		return hash >>> 0;
	});
}

/**
 * Record the line hashes of each existing target before a call writes it.
 * A missing, unreadable or oversized file records nothing.
 */
export function recordPreWriteLines(
	toolCallId: string | undefined,
	filePaths: readonly string[],
): void {
	if (toolCallId === undefined) return;
	for (const filePath of filePaths.slice(0, MAX_BASELINE_TARGETS_PER_CALL)) {
		const key = keyOf(toolCallId, filePath);
		baselines.delete(key);
		// No file yet (a create) or past the cap: the write keeps the whole file.
		const stat = nodeFs.statSync(filePath, { throwIfNoEntry: false });
		if (!stat?.isFile() || stat.size > MAX_BASELINE_FILE_BYTES) continue;
		let content: string;
		try {
			content = nodeFs.readFileSync(filePath, "utf-8");
		} catch (err) {
			recordDegradationOnce({
				kind: "write-line-baseline-unreadable",
				subject: normalizeMapKey(filePath),
				reason: `the bytes before a write could not be read, so the write keeps the whole file in edit scope (${(err as Error).message})`,
			});
			continue;
		}
		const hashes = exactLineHashes(content);
		if (hashes) baselines.set(key, hashes);
	}
}

/**
 * The lines the call's write changed in `content` (the bytes after it), and
 * the baseline is consumed. Undefined without a usable baseline, and when no
 * line changed: then nothing narrows the scope, as before.
 */
export function takeWriteChangedRanges(
	toolCallId: string | undefined,
	filePath: string,
	content: string,
): { start: number; end: number }[] | undefined {
	if (toolCallId === undefined) return undefined;
	const key = keyOf(toolCallId, filePath);
	const before = baselines.get(key);
	if (before === undefined) return undefined;
	baselines.delete(key);
	const after = exactLineHashes(content);
	if (after === undefined) return undefined;
	const ranges = changedLineRanges(before, after);
	return ranges && ranges.length > 0 ? ranges : undefined;
}

/** Test seam: forget every baseline. */
export function _resetWriteLineBaselinesForTests(): void {
	baselines.clear();
}
