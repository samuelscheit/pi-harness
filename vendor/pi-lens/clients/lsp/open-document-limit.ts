/**
 * How many documents a language-server client keeps open, and which ones it
 * closes when it holds more.
 *
 * pi-lens opens a document to read the server's diagnostics for it. Before
 * this bound a document stayed open for the client's whole life, and some
 * servers pay per open document: `lake serve` starts one `lean --worker`
 * process per open `.lean` file, measured at 576-708 MB each on a Lake project
 * with batteries (Lean 4.34.1, 2026-11-14). Six parallel agents that each
 * touched a few dozen files held about 50 GB. A `didClose` ends that worker
 * within 500 ms (measured the same day), so the bound is the fix: every
 * client keeps at most its server's limit of documents open, closing the
 * least recently sent ones first.
 *
 * A document is closed only once its caller is done with it:
 *  - never while a send for it is queued or running, or a diagnostics wait
 *    for it is running (`busy`);
 *  - once a wait read it, after {@link READ_DOCUMENT_HOLD_MS}, which leaves
 *    the touch that read it room for its follow-up reads (a second wait, a
 *    pull retry, a cascade read) before the document goes away;
 *  - never read, after {@link UNREAD_DOCUMENT_GRACE_MS}: a pre-opened sweep
 *    file whose wait has not started yet keeps its open that long; after it,
 *    an open no caller came back for is closed like a read one.
 */

/** The open documents a client keeps when its server's strategy names no limit. */
export const DEFAULT_OPEN_DOCUMENT_LIMIT = 16;

/** How long a document stays open after a diagnostics wait last read it. */
export const READ_DOCUMENT_HOLD_MS = 5_000;

/** How long a document no wait has read since its last send stays open. */
export const UNREAD_DOCUMENT_GRACE_MS = 60_000;

/** When the client last sent a document's content, and when a wait last read it. */
export interface OpenDocumentUse {
	sentAt: number;
	readAt?: number;
}

export interface OpenDocumentEvictionInput {
	/** Normalized paths of the documents the server holds open. */
	readonly open: ReadonlySet<string>;
	readonly use: ReadonlyMap<string, OpenDocumentUse>;
	readonly limit: number;
	/** A send or a diagnostics wait for the path is queued or running. */
	readonly busy: (path: string) => boolean;
	readonly now: number;
}

export interface OpenDocumentEvictions {
	/** Least recently sent first. */
	readonly evict: string[];
	/**
	 * When the client still holds more than its limit after `evict`: the
	 * earliest time a held document becomes closable. Undefined when the
	 * evictions reach the limit, or only busy documents remain (their own
	 * send or wait ends with another check).
	 */
	readonly retryAt?: number;
}

/** When a document becomes closable: the end of its read hold or its unread grace. */
function closableAt(use: OpenDocumentUse | undefined): number {
	if (use === undefined) return 0;
	return use.readAt !== undefined && use.readAt >= use.sentAt
		? use.readAt + READ_DOCUMENT_HOLD_MS
		: use.sentAt + UNREAD_DOCUMENT_GRACE_MS;
}

/** The documents to close now to bring the client back to its limit. */
export function selectOpenDocumentEvictions(
	input: OpenDocumentEvictionInput,
): OpenDocumentEvictions {
	const excess = input.open.size - Math.max(0, input.limit);
	if (excess <= 0) return { evict: [] };
	const byRecency = [...input.open].sort(
		(a, b) => (input.use.get(a)?.sentAt ?? 0) - (input.use.get(b)?.sentAt ?? 0),
	);
	const evict: string[] = [];
	let retryAt: number | undefined;
	for (const path of byRecency) {
		if (evict.length === excess) break;
		if (input.busy(path)) continue;
		const at = closableAt(input.use.get(path));
		if (at <= input.now) evict.push(path);
		else retryAt = Math.min(retryAt ?? at, at);
	}
	return evict.length === excess || retryAt === undefined
		? { evict }
		: { evict, retryAt };
}
