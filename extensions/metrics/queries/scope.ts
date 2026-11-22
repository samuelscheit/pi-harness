// The filters every metrics query shares, compiled to SQL once.
//
// Session-level filters (source, project, session, and the model for tables without one) select
// session ids; the time window applies to each table's own timestamp, so a long session counts
// only with what happened inside the window. Parameters are named, so every query passes the same
// parameter object whatever subset it uses.

import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";

export type Source = "pi" | "agy" | "claude-code" | "all";
export const SOURCES: readonly Source[] = ["pi", "agy", "claude-code", "all"];

export interface Filters {
	/** Window start in ms (inclusive); all time when undefined. */
	start?: number;
	/** Window end in ms (exclusive); open-ended when undefined. */
	end?: number;
	/** Only sessions started in this directory. */
	project?: string;
	/** Pi's sessions (default), Antigravity (`agy`), imported Claude Code ones (analysis only), or all. */
	source?: Source;
	/** Only requests of this model; tables without a model keep the sessions that used it. */
	model?: string;
	/** Only this session. */
	session?: string;
}

export type Row = Record<string, unknown>;

const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

function prepare(db: DatabaseSync, sql: string): StatementSync {
	let cache = statements.get(db);
	if (!cache) statements.set(db, (cache = new Map()));
	let statement = cache.get(sql);
	if (!statement) {
		statement = db.prepare(sql);
		statement.setAllowUnknownNamedParameters(true);
		cache.set(sql, statement);
	}
	return statement;
}

export class Scope {
	readonly db: DatabaseSync;
	readonly filters: Filters;
	readonly params: Record<string, SQLInputValue>;
	/** Conditions on the sessions table (alias `s`), without the time window. */
	readonly sessionConditions: string[];

	constructor(db: DatabaseSync, filters: Filters) {
		this.db = db;
		this.filters = filters;
		const source = filters.source ?? "pi";
		this.params = {
			$start: filters.start ?? null,
			$end: filters.end ?? null,
			$project: filters.project ?? null,
			$source: source,
			$model: filters.model ?? null,
			$session: filters.session ?? null,
		};
		this.sessionConditions = [
			...(source === "all" ? [] : ["s.source = $source"]),
			...(filters.project === undefined ? [] : ["s.cwd = $project"]),
			...(filters.session === undefined ? [] : ["s.id = $session"]),
		];
	}

	get source(): Source {
		return this.filters.source ?? "pi";
	}

	/** SQL selecting the ids of the sessions in scope; `model` keeps only sessions that used the model filter's model. */
	sessionIds(model = true): string {
		const conditions = [...this.sessionConditions, ...(model && this.filters.model !== undefined ? [MODEL_USED] : [])];
		return `SELECT s.id FROM sessions s${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}`;
	}

	/**
	 * Conditions for rows of table `alias` in scope: its session, `ts` (a column of the table) in
	 * the window, and the model filter on the table's own `model` column when `hasModel`.
	 */
	where(alias: string, ts: string | undefined, hasModel = false): string {
		const conditions: string[] = [];
		const modelOnSession = !hasModel && this.filters.model !== undefined;
		if (this.sessionConditions.length || modelOnSession) conditions.push(`${alias}.session_id IN (${this.sessionIds(modelOnSession)})`);
		if (hasModel && this.filters.model !== undefined) conditions.push(`${alias}.model = $model`);
		if (ts !== undefined) conditions.push(this.window(`${alias}.${ts}`));
		return conditions.join(" AND ") || "1";
	}

	/** The time window on a column, alone (`1` when the window is open). */
	window(column: string): string {
		const conditions = [
			...(this.filters.start === undefined ? [] : [`${column} >= $start`]),
			...(this.filters.end === undefined ? [] : [`${column} < $end`]),
		];
		return conditions.join(" AND ") || "1";
	}

	all<T = Row>(sql: string, extra: Record<string, SQLInputValue> = {}): T[] {
		return prepare(this.db, sql).all({ ...this.params, ...extra }) as T[];
	}

	get<T = Row>(sql: string, extra: Record<string, SQLInputValue> = {}): T {
		return prepare(this.db, sql).get({ ...this.params, ...extra }) as T;
	}

	/** The same scope with some filters replaced (`undefined` removes one). */
	with(changes: Partial<Filters>): Scope {
		return new Scope(this.db, { ...this.filters, ...changes });
	}

	/** The window of the same length right before this one, when this one has a start. */
	previous(now = Date.now()): Scope | undefined {
		if (this.filters.start === undefined) return undefined;
		const end = this.filters.end ?? now;
		return this.with({ start: this.filters.start - (end - this.filters.start), end: this.filters.start });
	}
}

const MODEL_USED = "EXISTS (SELECT 1 FROM requests m WHERE m.session_id = s.id AND m.model = $model)";

/** Cost by billing rate over requests aliased `r`: cost, uncached input, output, cache read, cache write. */
export const SPEND = "COALESCE(SUM(r.cost), 0) cost, COALESCE(SUM(r.cost_input), 0) uncached, COALESCE(SUM(r.cost_output), 0) output, COALESCE(SUM(r.cost_read), 0) read, COALESCE(SUM(r.cost_write), 0) write";

export interface Spend {
	cost: number;
	read: number;
	write: number;
	uncached: number;
	output: number;
}

export const spendOf = (row: Row): Spend => ({
	cost: Number(row.cost ?? 0),
	read: Number(row.read ?? 0),
	write: Number(row.write ?? 0),
	uncached: Number(row.uncached ?? 0),
	output: Number(row.output ?? 0),
});

/**
 * A readable title for the session aliased `alias`: its name, else the title its delegating parent
 * gave it, else its first user message. Shortened by {@link titleOf}.
 */
export const titleSql = (alias = "s") => `COALESCE(${alias}.name,
	(SELECT d.title FROM delegations d WHERE ${alias}.prompt_digest IS NOT NULL AND d.task_digest = ${alias}.prompt_digest AND d.title IS NOT NULL LIMIT 1),
	(SELECT u.text FROM user_messages u WHERE u.session_id = ${alias}.id ORDER BY u.ts LIMIT 1))`;

const TITLE_LENGTH = 90;

/** The first line of a title, cut at a sentence end or `TITLE_LENGTH`. */
export function titleOf(text: unknown, id: string): string {
	const line = String(text ?? "")
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	if (!line) return `Session ${id.split("/").at(-1)!.slice(0, 8)}`;
	const sentence = /^(.{12,}?[.!?])(\s|$)/.exec(line)?.[1] ?? line;
	return sentence.length > TITLE_LENGTH ? `${sentence.slice(0, TITLE_LENGTH - 1)}…` : sentence;
}

export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}
