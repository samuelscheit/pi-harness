// The dashboard's JSON API over the metrics query layer. Every view takes the same filters as
// search parameters: start and end (ms or ISO), project, source, model, session.

import type { DatabaseSync } from "node:sqlite";
import {
	type Breakdown,
	breakdown,
	type ColdResume,
	type CompactionOpportunities,
	type CompactionReason,
	type ContextSizes,
	type Options,
	type Overview,
	type PauseOutcome,
	type RebuildCause,
	type RebuildExample,
	type SessionDetail,
	type SessionPage,
	type SideCall,
	type Subagents,
	type ToolResult,
	type ToolStats,
	type Totals,
	type VersionDiff,
	type VersionRow,
	coldResumes,
	compactionOpportunities,
	compactions,
	contextSizes,
	type Filters,
	GROUPS,
	type Group,
	largestRebuilds,
	largestResults,
	options,
	overview,
	pauses,
	rebuilds,
	Scope,
	SESSION_SORTS,
	type SessionSort,
	SOURCES,
	type Source,
	sessionDetail,
	sessionList,
	sideCalls,
	subagents,
	tools,
	totals,
	versionDiff,
	versions,
} from "../../extensions/metrics/queries/index.ts";

export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function time(name: string, value: string | null): number | undefined {
	if (value === null || value === "") return undefined;
	const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
	if (Number.isNaN(ms)) throw new ApiError(400, `${name}: not a time: ${value}`);
	return ms;
}

const text = (value: string | null) => (value === null || value === "" ? undefined : value);

export function parseFilters(params: URLSearchParams): Filters {
	const source = params.get("source") ?? "pi";
	if (!SOURCES.includes(source as Source)) throw new ApiError(400, `source: one of ${SOURCES.join(", ")}`);
	const start = time("start", params.get("start"));
	const end = time("end", params.get("end"));
	if (start !== undefined && end !== undefined && start >= end) throw new ApiError(400, "start must be before end");
	return { start, end, source: source as Source, project: text(params.get("project")), model: text(params.get("model")), session: text(params.get("session")) };
}

function positive(name: string, value: string | null, fallback: number, max: number): number {
	if (value === null) return fallback;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1 || n > max) throw new ApiError(400, `${name}: a whole number from 1 to ${max}`);
	return n;
}

function oneOf<T extends string>(name: string, value: string | null, allowed: readonly T[], fallback: T): T {
	if (value === null) return fallback;
	if (!allowed.includes(value as T)) throw new ApiError(400, `${name}: one of ${allowed.join(", ")}`);
	return value as T;
}

export interface ContextView {
	kpis: Totals;
	tools: ToolStats[];
	toolCosts: Breakdown;
	results: ToolResult[];
	sizes: ContextSizes;
}

export interface WasteView {
	kpis: Totals;
	rebuilds: RebuildCause[];
	examples: RebuildExample[];
	pauses: PauseOutcome[];
	coldResumes: ColdResume[];
	compactions: CompactionReason[];
	opportunities: CompactionOpportunities;
	sideCalls: SideCall[];
}

export interface VersionsView {
	rows: VersionRow[];
}

export type ApiResponse = Options | Overview | Breakdown | ContextView | SessionPage | SessionDetail | WasteView | Subagents | VersionsView | VersionDiff;

/** The response of a GET to `/api/<path>`; throws ApiError for bad input or an unknown path. */
export function route(db: DatabaseSync, path: string, params: URLSearchParams, now = Date.now()): ApiResponse {
	const scope = new Scope(db, parseFilters(params));
	const session = /^sessions\/(.+)$/.exec(path);
	if (session) {
		const detail = sessionDetail(db, decodeURIComponent(session[1]!));
		if (!detail) throw new ApiError(404, "no such session");
		return detail;
	}
	switch (path) {
		case "options":
			return options(scope);
		case "overview":
			return overview(scope, now);
		case "breakdown":
			return breakdown(scope, oneOf<Group>("group", params.get("group"), GROUPS, "content"));
		case "context":
			return {
				kpis: totals(scope),
				tools: tools(scope),
				toolCosts: breakdown(scope, "tool"),
				results: largestResults(scope, positive("limit", params.get("limit"), 25, 200)),
				sizes: contextSizes(scope),
			};
		case "sessions":
			return sessionList(scope, {
				sort: oneOf<SessionSort>("sort", params.get("sort"), SESSION_SORTS, "cost"),
				page: positive("page", params.get("page"), 1, 1_000_000),
				pageSize: positive("pageSize", params.get("pageSize"), 25, 200),
			});
		case "waste":
			return {
				kpis: totals(scope),
				rebuilds: rebuilds(scope),
				examples: largestRebuilds(scope),
				pauses: pauses(scope),
				coldResumes: coldResumes(scope),
				compactions: compactions(scope),
				opportunities: compactionOpportunities(scope),
				sideCalls: sideCalls(scope),
			};
		case "subagents":
			return subagents(scope);
		case "versions":
			return { rows: versions(scope) };
		case "versions/diff": {
			const from = params.get("from");
			const to = params.get("to");
			if (!from || !to) throw new ApiError(400, "from and to: version ids");
			const known = db.prepare("SELECT COUNT(*) n FROM versions WHERE id IN (?, ?)").get(from, to) as { n: number };
			if (known.n !== (from === to ? 1 : 2)) throw new ApiError(404, "no such version");
			return versionDiff(db, from, to);
		}
		default:
			throw new ApiError(404, `no such view: ${path}`);
	}
}
