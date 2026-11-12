// Harness versions (Pi sessions only): per version what a request cost, how much of the prompt
// came from cache, tool errors, interrupts and corrections, and what changed from the previous
// version of the same project. This is where the self-improvement loop is judged.

import type { DatabaseSync } from "node:sqlite";
import type { Scope } from "./scope.ts";

interface VersionState {
	sections: Record<string, string>;
	tools: Record<string, string>;
}

export interface Change {
	kind: "section" | "tool";
	name: string;
	change: "added" | "removed" | "changed";
}

/** Sections and tools that differ between two versions, sections first, each by name. */
export function changes(before: VersionState, after: VersionState): Change[] {
	const diff = (a: Record<string, string>, b: Record<string, string>, kind: Change["kind"]): Change[] =>
		[...new Set([...Object.keys(a), ...Object.keys(b)])]
			.filter((name) => a[name] !== b[name])
			.sort()
			.map((name) => ({ kind, name, change: a[name] === undefined ? "added" : b[name] === undefined ? "removed" : "changed" }));
	return [...diff(before.sections, after.sections, "section"), ...diff(before.tools, after.tools, "tool")];
}

/** Changes in one line: names of up to four changed sections or tools (+added, -removed), else their number. */
export function changeSummary(list: Change[]): string {
	const line = (kind: Change["kind"], label: string) => {
		const of = list.filter((c) => c.kind === kind);
		if (of.length === 0) return [];
		return [of.length > 4 ? `${of.length} ${label}` : of.map((c) => (c.change === "added" ? `+${c.name}` : c.change === "removed" ? `-${c.name}` : c.name)).join(" ")];
	};
	return [...line("section", "sections"), ...line("tool", "tools")].join("; ") || "same";
}

export interface VersionRow {
	id: string;
	project: string;
	firstSeen: number;
	lastSeen: number;
	sessions: number;
	requests: number;
	cost: number;
	costPerRequest: number;
	/** Share of prompt tokens read from cache. */
	cacheShare: number;
	toolCalls: number;
	toolErrors: number;
	/** Turns the user interrupted. */
	interrupts: number;
	/** User messages answered by this version, by kind (first, follow-up, steer, after interrupt, after error). */
	userMessages: Record<string, number>;
	/** Steers and messages after an interrupt: raw signals of a correction. */
	corrections: number;
	/** The previous version of the same project, and what changed since. */
	previous: string | null;
	changes: Change[];
}

const stateOf = (db: DatabaseSync, id: string): VersionState => {
	const row = db.prepare("SELECT sections, tools FROM versions WHERE id = ?").get(id) as { sections: string; tools: string } | undefined;
	return row ? { sections: JSON.parse(row.sections), tools: JSON.parse(row.tools) } : { sections: {}, tools: {} };
};

/** Versions with turns in scope, by project and first use. */
export function versions(input: Scope): VersionRow[] {
	const scope = input.with({ source: "pi" });
	// The order of versions per project comes from all their requests, not just the window.
	const history = scope.with({ start: undefined, end: undefined, model: undefined }).all<{ version: string; cwd: string; first: number }>(
		`SELECT r.version, MIN(s.cwd) cwd, MIN(r.ts) first FROM requests r JOIN sessions s ON s.id = r.session_id
		WHERE r.kind = 'turn' AND r.version IS NOT NULL AND s.source = 'pi' ${scope.filters.project === undefined ? "" : "AND s.cwd = $project"}
		GROUP BY r.version ORDER BY cwd, first`,
	);
	const previousOf = new Map<string, string | null>();
	history.forEach((v, i) => previousOf.set(v.version, i > 0 && history[i - 1]!.cwd === v.cwd ? history[i - 1]!.version : null));

	const metrics = scope.all(
		`SELECT r.version, MIN(s.cwd) cwd, MIN(r.ts) first, MAX(r.ts) last, COUNT(DISTINCT r.session_id) sessions, COUNT(*) turns, SUM(r.cost) cost,
		SUM(r.cache_read) read, SUM(r.prompt_tokens) prompt, SUM(r.stop_reason = 'aborted') aborted
		FROM requests r JOIN sessions s ON s.id = r.session_id
		WHERE r.kind = 'turn' AND r.version IS NOT NULL AND ${scope.where("r", "ts", true)} GROUP BY r.version`,
	);
	const tools = new Map(
		scope
			.all(`SELECT t.version, COUNT(*) calls, SUM(t.is_error) errors FROM tool_results t WHERE t.version IS NOT NULL AND ${scope.where("t", "ts")} GROUP BY t.version`)
			.map((r) => [String(r.version), { calls: Number(r.calls), errors: Number(r.errors) }]),
	);
	// A user message counts for the version of the turn that answered it.
	const messages = new Map<string, Record<string, number>>();
	for (const row of scope.all(
		`SELECT (SELECT r.version FROM requests r WHERE r.session_id = u.session_id AND r.kind = 'turn' AND r.ts >= u.ts ORDER BY r.ts LIMIT 1) version,
		u.kind, COUNT(*) n FROM user_messages u WHERE ${scope.where("u", "ts")} GROUP BY 1, 2`,
	)) {
		if (row.version === null) continue;
		const kinds = messages.get(String(row.version)) ?? {};
		kinds[String(row.kind)] = Number(row.n);
		messages.set(String(row.version), kinds);
	}
	const order = new Map(history.map((v, i) => [v.version, i]));
	return metrics
		.map((m) => {
			const id = String(m.version);
			const previous = previousOf.get(id) ?? null;
			const kinds = messages.get(id) ?? {};
			const tool = tools.get(id) ?? { calls: 0, errors: 0 };
			return {
				id,
				project: String(m.cwd),
				firstSeen: Number(m.first),
				lastSeen: Number(m.last),
				sessions: Number(m.sessions),
				requests: Number(m.turns),
				cost: Number(m.cost),
				costPerRequest: Number(m.cost) / Number(m.turns),
				cacheShare: Number(m.read) / Math.max(1, Number(m.prompt)),
				toolCalls: tool.calls,
				toolErrors: tool.errors,
				interrupts: Number(m.aborted),
				userMessages: kinds,
				corrections: (kinds.steer ?? 0) + (kinds["after interrupt"] ?? 0),
				previous,
				changes: previous ? changes(stateOf(scope.db, previous), stateOf(scope.db, id)) : [],
			};
		})
		.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export interface DiffLine {
	op: "same" | "add" | "del";
	text: string;
}

// Above this many line pairs a changed text is shown as removed and added whole.
const MAX_DIFF_CELLS = 4_000_000;

/** A line diff (longest common subsequence) from `before` to `after`. */
export function lineDiff(before: string, after: string): DiffLine[] {
	const a = before === "" ? [] : before.split("\n");
	const b = after === "" ? [] : after.split("\n");
	if (a.length * b.length > MAX_DIFF_CELLS) return [...a.map((text) => ({ op: "del" as const, text })), ...b.map((text) => ({ op: "add" as const, text }))];
	// lcs[i][j]: common lines of a[i..] and b[j..].
	const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
	}
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push({ op: "same", text: a[i]! });
			i++;
			j++;
		} else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: "del", text: a[i++]! });
		else out.push({ op: "add", text: b[j++]! });
	}
	while (i < a.length) out.push({ op: "del", text: a[i++]! });
	while (j < b.length) out.push({ op: "add", text: b[j++]! });
	return out;
}

export interface VersionDiff {
	from: string;
	to: string;
	items: (Change & { lines: DiffLine[] })[];
}

/** What changed from version `from` to `to`, with a line diff of each section and tool. */
export function versionDiff(db: DatabaseSync, from: string, to: string): VersionDiff {
	const before = stateOf(db, from);
	const after = stateOf(db, to);
	const blob = db.prepare("SELECT text FROM blobs WHERE hash = ?");
	const text = (hash: string | undefined) => (hash === undefined ? "" : ((blob.get(hash) as { text: string } | undefined)?.text ?? ""));
	// Tool definitions are stored as one line of JSON: indented, a changed parameter is its own line.
	const readable = (kind: Change["kind"], value: string) => {
		if (kind !== "tool" || value === "") return value;
		try {
			return JSON.stringify(JSON.parse(value), null, 2);
		} catch {
			return value;
		}
	};
	return {
		from,
		to,
		items: changes(before, after).map((c) => {
			const map = c.kind === "section" ? "sections" : "tools";
			return { ...c, lines: lineDiff(readable(c.kind, text(before[map][c.name])), readable(c.kind, text(after[map][c.name]))) };
		}),
	};
}
