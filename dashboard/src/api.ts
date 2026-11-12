// The dashboard server's JSON API (dashboard/server/api.ts); response types come from the query layer.

export type {
	Breakdown,
	BreakdownRow,
	Change,
	CompactionOpportunity,
	DiffLine,
	Finding,
	Group,
	Options,
	Overview,
	SessionDetail,
	SessionNode,
	SessionPage,
	SessionRow,
	SessionSort,
	Source,
	Spend,
	SubagentRow,
	Subagents,
	TimelinePoint,
	ToolResult,
	Totals,
	VersionDiff,
	VersionRow,
	View,
} from "../../extensions/metrics/queries/index.ts";
export type { ContextView, VersionsView, WasteView } from "../server/api.ts";
export type { IndexStatus } from "../server/server.ts";

export type Params = Record<string, string | number | undefined>;

export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function url(path: string, params: Params = {}): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") search.set(key, String(value));
	const query = search.toString();
	return `/api/${path}${query ? `?${query}` : ""}`;
}

async function request<T>(method: "GET" | "POST", path: string, params?: Params, signal?: AbortSignal): Promise<T> {
	const response = await fetch(url(path, params), { method, signal });
	const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
	if (!response.ok) throw new ApiError(response.status, (body as { error?: string }).error ?? `HTTP ${response.status}`);
	return body as T;
}

export const api = {
	get: <T>(path: string, params?: Params, signal?: AbortSignal) => request<T>("GET", path, params, signal),
	post: <T>(path: string, params?: Params) => request<T>("POST", path, params),
};
