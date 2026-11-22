// Filters live in the URL (shareable, survive reloads and navigation): range or custom start and
// end, source, project, model and session. Every view sends them to the API.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type IndexStatus, type Options, type Params, type Source } from "../api";
import { cn } from "../lib";
import { projectName, SOURCE_LABELS, time, usd } from "./format";

export const RANGES = {
	"24h": { label: "24 h", hours: 24 },
	"7d": { label: "7 days", hours: 24 * 7 },
	"30d": { label: "30 days", hours: 24 * 30 },
	"90d": { label: "90 days", hours: 24 * 90 },
	all: { label: "All time", hours: null },
} as const;
export type RangeKey = keyof typeof RANGES | "custom";
export const DEFAULT_RANGE = "7d";
const SOURCES: Source[] = ["pi", "agy", "claude-code", "all"];
/** Search params every link inside the dashboard carries along, so drilling down keeps the filters. */
const SHARED_PARAMS = ["range", "start", "end", "source", "project", "model", "session"];
// Relative ranges end "now", rounded so the query key stays stable for a minute.
const ROUND_MS = 60_000;

export interface Filters {
	range: RangeKey;
	source: Source;
	project?: string;
	model?: string;
	session?: string;
	start?: number;
	end?: number;
	/** Query parameters for the API. */
	params: Params;
}

function toLocalInput(ms: number): string {
	const date = new Date(ms);
	return new Date(ms - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function useFilters(): Filters {
	const [search] = useSearchParams();
	const minute = Math.floor(Date.now() / ROUND_MS);
	return useMemo(() => {
		const requested = (search.get("range") ?? DEFAULT_RANGE) as RangeKey;
		const range: RangeKey = requested === "custom" || requested in RANGES ? requested : DEFAULT_RANGE;
		const source = (SOURCES as string[]).includes(search.get("source") ?? "") ? (search.get("source") as Source) : "pi";
		let start: number | undefined;
		let end: number | undefined;
		const customStart = search.get("start");
		const customEnd = search.get("end");
		if (range === "custom" && customStart && customEnd) {
			start = new Date(customStart).getTime();
			end = new Date(customEnd).getTime();
		} else if (range !== "custom") {
			const hours = RANGES[range].hours;
			if (hours !== null) {
				end = (minute + 1) * ROUND_MS;
				start = end - hours * 3_600_000;
			}
		}
		const project = search.get("project") || undefined;
		const model = search.get("model") || undefined;
		const session = search.get("session") || undefined;
		return { range, source, project, model, session, start, end, params: { start, end, source, project, model, session } };
	}, [search, minute]);
}

/** The current filter part of the URL, to append to links inside the dashboard. */
export function useFilterSearch(extra: Record<string, string | undefined> = {}): string {
	const [search] = useSearchParams();
	const next = new URLSearchParams();
	for (const key of SHARED_PARAMS) {
		const value = search.get(key);
		if (value) next.set(key, value);
	}
	for (const [key, value] of Object.entries(extra)) {
		if (value) next.set(key, value);
		else next.delete(key);
	}
	const text = next.toString();
	return text ? `?${text}` : "";
}

export function useSetParams() {
	const [search, setSearch] = useSearchParams();
	return (changes: Record<string, string | null>) => {
		const next = new URLSearchParams(search);
		for (const [key, value] of Object.entries(changes)) {
			if (value) next.set(key, value);
			else next.delete(key);
		}
		next.delete("page");
		setSearch(next, { replace: true });
	};
}

/** Fetch one view for the current filters. */
export function useView<T>(view: string, extra: Params = {}, enabled = true) {
	const filters = useFilters();
	const params = { ...filters.params, ...extra };
	return useQuery({
		queryKey: ["usage", view, params],
		queryFn: ({ signal }) => api.get<T>(view, params, signal),
		enabled,
		placeholderData: (previous) => previous,
		staleTime: 30_000,
	});
}

const STATUS_POLL_MS = 1500;

/** Index status; while an index runs it polls, and refetches every view once it lands. */
export function useIndexStatus() {
	const client = useQueryClient();
	const generation = useRef<number | undefined>(undefined);
	const status = useQuery({
		queryKey: ["status"],
		queryFn: ({ signal }) => api.get<IndexStatus>("status", {}, signal),
		refetchInterval: (query) => (query.state.data?.indexing ? STATUS_POLL_MS : false),
	});
	const current = status.data?.generation;
	useEffect(() => {
		if (current === undefined) return;
		if (generation.current !== undefined && generation.current !== current) void client.invalidateQueries({ queryKey: ["usage"] });
		generation.current = current;
	}, [client, current]);
	return status;
}

export function useRefresh() {
	const client = useQueryClient();
	return async (source: Source) => {
		client.setQueryData(["status"], await api.post<IndexStatus>("refresh", { source }));
	};
}

const selectClass =
	"h-8 min-w-0 max-w-[16rem] flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 sm:flex-none";
const segment = (active: boolean) => cn("h-8 whitespace-nowrap px-2.5 text-sm transition sm:px-3", active ? "bg-sky-500/20 text-sky-200" : "bg-slate-950 text-slate-400 hover:text-slate-100");

function Select({ label, value, options, onChange, format }: { label: string; value?: string; options: { value: string; cost: number }[]; onChange: (value: string | null) => void; format: (value: string) => string }) {
	return (
		<label className="flex min-w-0 basis-[calc(50%-0.25rem)] items-center gap-1.5 text-xs text-slate-500 sm:basis-auto">
			<span className="shrink-0">{label}</span>
			<select aria-label={label} className={cn(selectClass, value && "border-sky-700 text-sky-200")} value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}>
				<option value="">All</option>
				{options.map((option) => (
					<option key={option.value} value={option.value} title={option.value}>
						{format(option.value)} · {usd(option.cost)}
					</option>
				))}
				{value && !options.some((o) => o.value === value) ? <option value={value}>{format(value)}</option> : null}
			</select>
		</label>
	);
}

export function FilterBar({ withSession = true }: { withSession?: boolean }) {
	const filters = useFilters();
	const setParams = useSetParams();
	const status = useIndexStatus();
	const refresh = useRefresh();
	const options = useQuery({
		queryKey: ["usage", "options", filters.start, filters.end, filters.source, filters.project, filters.model],
		queryFn: ({ signal }) => api.get<Options>("options", filters.params, signal),
		staleTime: 60_000,
		placeholderData: (previous) => previous,
	});
	const needsClaude = filters.source === "claude-code" || filters.source === "all";
	const needsAgy = filters.source === "agy" || filters.source === "all";
	const claudeMissing = needsClaude && status.data && !status.data.claudeIndexed;
	const agyMissing = needsAgy && status.data && !status.data.agyIndexed;
	const sourceMissing = Boolean(claudeMissing || agyMissing);
	// Claude Code and Antigravity transcripts are imported when a view first asks for them.
	const requested = useRef<string | null>(null);
	useEffect(() => {
		const key = `${claudeMissing ? "c" : ""}${agyMissing ? "a" : ""}`;
		if (sourceMissing && !status.data?.indexing && requested.current !== key) {
			requested.current = key;
			void refresh(filters.source);
		}
	}, [sourceMissing, claudeMissing, agyMissing, status.data?.indexing, refresh, filters.source]);
	const keys: ("project" | "model" | "session")[] = withSession ? ["project", "model", "session"] : ["project", "model"];
	const active = keys.filter((key) => filters[key]);

	return (
		<div className="sticky top-0 z-20 -mx-4 mb-5 border-b border-slate-800 bg-canvas/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8" role="toolbar" aria-label="Filters">
			<div className="flex flex-wrap items-center gap-2">
				<div className="inline-flex max-w-full overflow-x-auto rounded-md border border-slate-700" role="group" aria-label="Time range">
					{(Object.keys(RANGES) as (keyof typeof RANGES)[]).map((key) => (
						<button key={key} type="button" className={segment(filters.range === key)} aria-pressed={filters.range === key} onClick={() => setParams({ range: key === DEFAULT_RANGE ? null : key, start: null, end: null })}>
							{RANGES[key].label}
						</button>
					))}
					<button
						type="button"
						className={segment(filters.range === "custom")}
						aria-pressed={filters.range === "custom"}
						onClick={() => {
							const end = filters.end ?? Date.now();
							setParams({ range: "custom", start: toLocalInput(filters.start ?? end - 7 * 86_400_000), end: toLocalInput(end) });
						}}
					>
						Custom
					</button>
				</div>
				{filters.range === "custom" && filters.start !== undefined && filters.end !== undefined ? (
					<div className="flex w-full min-w-0 items-center gap-1 text-sm text-slate-400 sm:w-auto">
						<input aria-label="From" type="datetime-local" className={selectClass} value={toLocalInput(filters.start)} onChange={(event) => event.target.value && setParams({ start: event.target.value })} />
						<span>to</span>
						<input aria-label="To" type="datetime-local" className={selectClass} value={toLocalInput(filters.end)} onChange={(event) => event.target.value && setParams({ end: event.target.value })} />
					</div>
				) : null}
				<div className="inline-flex overflow-hidden rounded-md border border-slate-700" role="group" aria-label="Source">
					{SOURCES.map((source) => (
						<button key={source} type="button" className={segment(filters.source === source)} aria-pressed={filters.source === source} onClick={() => setParams({ source: source === "pi" ? null : source })}>
							{SOURCE_LABELS[source]}
						</button>
					))}
				</div>
				<Select label="Project" value={filters.project} options={options.data?.projects ?? []} onChange={(value) => setParams({ project: value })} format={projectName} />
				<Select label="Model" value={filters.model} options={options.data?.models ?? []} onChange={(value) => setParams({ model: value })} format={(v) => v} />
				{withSession && filters.session ? (
					<span className="inline-flex h-8 items-center gap-1 rounded-md border border-sky-700 px-2 text-xs text-sky-200">
						Session {filters.session.split("/").at(-1)?.slice(0, 8)}
						<button type="button" aria-label="Remove the session filter" className="rounded p-0.5 hover:bg-slate-800" onClick={() => setParams({ session: null })}>
							<X className="size-3.5" />
						</button>
					</span>
				) : null}
				{active.length ? (
					<button type="button" className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-slate-100" onClick={() => setParams(Object.fromEntries(active.map((key) => [key, null])))}>
						<X className="size-3.5" /> Clear filters
					</button>
				) : null}
				<span className="flex-1" />
				<div className="flex items-center gap-2 text-xs text-slate-500">
					{status.data?.indexing ? (
						<span className="inline-flex items-center gap-1.5 text-sky-300" role="status">
							<LoaderCircle className="size-3.5 animate-spin" /> {agyMissing && !claudeMissing ? "Importing Antigravity sessions…" : claudeMissing ? "Importing Claude Code sessions…" : "Indexing sessions…"}
						</span>
					) : status.data?.lastIndexed ? (
						<span title={status.data.failed.map((f) => `${f.path}: ${f.error}`).join("\n") || undefined}>
							Indexed {time(status.data.lastIndexed)}
							{status.data.failed.length ? <span className="text-amber-300"> · {status.data.failed.length} files failed</span> : null}
						</span>
					) : null}
					<button
						type="button"
						className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-700 px-2.5 text-sm text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-50"
						disabled={status.data?.indexing}
						onClick={() => void refresh(filters.source)}
					>
						<RefreshCw className="size-3.5" /> Refresh
					</button>
				</div>
			</div>
			{status.data?.error ? <p className="mt-2 text-xs text-rose-300">Indexing failed: {status.data.error}</p> : null}
		</div>
	);
}
