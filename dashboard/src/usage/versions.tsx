// Harness versions (Pi sessions only): what each version cost per request, its cache share,
// tool errors, interrupts and corrections, and what changed from the previous version.

import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, type DiffLine, type VersionDiff, type VersionRow, type VersionsView as VersionsData } from "../api";
import { cn } from "../lib";
import { RankedBars, RATE_COLORS } from "./charts";
import { useFilters, useSetParams, useView } from "./filters";
import { count, projectName, share, time, usd } from "./format";
import { Empty, Panel, QueryState, tableClass, Tag } from "./ui";

// Unchanged lines kept around each change in a diff.
const CONTEXT_LINES = 2;

const short = (id: string) => id.slice(0, 8);
const per100 = (n: number, requests: number) => (requests ? ((n / requests) * 100).toFixed(1) : "—");

/** Diff lines with long unchanged runs folded to `CONTEXT_LINES` around each change. */
export function foldDiff(lines: DiffLine[]): (DiffLine | { op: "fold"; count: number })[] {
	const keep = lines.map((line, i) => line.op !== "same" || lines.slice(Math.max(0, i - CONTEXT_LINES), i + CONTEXT_LINES + 1).some((l) => l.op !== "same"));
	const out: (DiffLine | { op: "fold"; count: number })[] = [];
	lines.forEach((line, i) => {
		if (keep[i]) out.push(line);
		else {
			const last = out.at(-1);
			if (last?.op === "fold") last.count += 1;
			else out.push({ op: "fold", count: 1 });
		}
	});
	return out;
}

function Diff({ from, to }: { from: string; to: string }) {
	const query = useQuery({ queryKey: ["usage", "diff", from, to], queryFn: ({ signal }) => api.get<VersionDiff>("versions/diff", { from, to }, signal) });
	if (!query.data) return <QueryState isPending={query.isPending} error={query.error} label="Loading the diff…" />;
	if (!query.data.items.length) return <Empty>Same prompt sections and tools.</Empty>;
	return (
		<div className="space-y-3">
			{query.data.items.map((item) => (
				<details key={`${item.kind}-${item.name}`} open={query.data.items.length <= 3} className="rounded-lg border border-slate-800">
					<summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-slate-200">
						<Tag tone={item.change === "added" ? "good" : item.change === "removed" ? "bad" : "info"}>{item.change}</Tag>
						{item.kind} <b className="font-mono font-medium">{item.name}</b>
						<span className="ml-auto text-xs text-slate-500">
							+{item.lines.filter((l) => l.op === "add").length} −{item.lines.filter((l) => l.op === "del").length}
						</span>
					</summary>
					<pre className="max-h-[28rem] overflow-auto border-t border-slate-800 py-2 font-mono text-xs leading-5">
						{foldDiff(item.lines).map((line, i) =>
							line.op === "fold" ? (
								<div key={i} className="px-3 text-slate-600">
									⋯ {line.count} unchanged lines
								</div>
							) : (
								<div key={i} className={cn("whitespace-pre-wrap break-words px-3", line.op === "add" && "bg-emerald-950/50 text-emerald-200", line.op === "del" && "bg-rose-950/50 text-rose-200", line.op === "same" && "text-slate-400")}>
									{line.op === "add" ? "+ " : line.op === "del" ? "− " : "  "}
									{line.text}
								</div>
							),
						)}
					</pre>
				</details>
			))}
		</div>
	);
}

function changeText(v: VersionRow): string {
	if (!v.previous) return "first version";
	if (!v.changes.length) return "same";
	const names = v.changes.map((c) => `${c.change === "added" ? "+" : c.change === "removed" ? "−" : ""}${c.name}`);
	return names.length > 4 ? `${names.slice(0, 4).join(", ")} +${names.length - 4}` : names.join(", ");
}

export function VersionsView() {
	const query = useView<VersionsData>("versions");
	const filters = useFilters();
	const [search, setSearch] = useSearchParams();
	const setParams = useSetParams();
	const all = query.data?.rows;
	if (!all) return <QueryState isPending={query.isPending} error={query.error} label="Loading versions…" />;
	// Versions are per project: one project at a time, the project filter's or the busiest.
	const projects = [...Map.groupBy(all, (v) => v.project)].map(([project, list]) => ({ project, requests: list.reduce((s, v) => s + v.requests, 0) })).sort((a, b) => b.requests - a.requests);
	const project = filters.project ?? projects[0]?.project;
	const rows = all.filter((v) => v.project === project);
	const selected = rows.find((v) => v.id === search.get("version")) ?? [...rows].reverse().find((v) => v.previous);
	const label = (v: VersionRow) => short(v.id);
	const select = (id: string) => {
		const next = new URLSearchParams(search);
		next.set("version", id);
		setSearch(next, { replace: true });
	};
	return (
		<div className="space-y-4">
			<p className="max-w-4xl text-sm text-slate-400">
				A harness version is the set of prompt sections and initial tools a request ran with; versions are per project, since the project's context and skills are sections. This
				is where prompt and tool changes are judged: per version, from Pi sessions only{filters.source !== "pi" ? " (the source filter does not apply here)" : ""}.
			</p>
			{projects.length > 1 || filters.project ? (
				<label className="flex items-center gap-2 text-sm text-slate-400">
					Project
					<select
						aria-label="Versions of project"
						className="h-8 min-w-0 max-w-full rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-200"
						value={project}
						onChange={(event) => setParams({ project: event.target.value, version: null })}
					>
						{projects.map((p) => (
							<option key={p.project} value={p.project}>
								{projectName(p.project)} · {count(p.requests)} requests
							</option>
						))}
					</select>
				</label>
			) : null}
			{rows.length ? (
				<>
					<Panel title="Cost per request by version" aside="in the order each version first ran">
						<RankedBars
							labelWidth={120}
							rows={rows.map((v) => ({
								key: v.id,
								label: label(v),
								segments: [{ key: "cost", label: "Per request", value: v.costPerRequest, color: RATE_COLORS.read }],
								note: `${count(v.requests)} requests · ${share(v.cacheShare, 1)} from cache · ${changeText(v)}`,
							}))}
							total={0}
							showShare={false}
							onSelect={(row) => select(row.key)}
						/>
					</Panel>
					<Panel title="Versions" bodyClassName="p-0">
						<div className="overflow-x-auto">
							<table className={tableClass}>
								<thead>
									<tr>
										<th>Version</th>
										<th>First used</th>
										<th className="text-right">Sessions</th>
										<th className="text-right">Requests</th>
										<th className="text-right">Per request</th>
										<th className="text-right">From cache</th>
										<th className="text-right">Tool errors</th>
										<th className="text-right" title="Interrupted turns per 100 requests">Interrupts /100</th>
										<th className="text-right" title="Steers and messages after an interrupt, per 100 requests">Corrections /100</th>
										<th>Changed</th>
									</tr>
								</thead>
								<tbody>
									{rows.map((v) => (
										<tr key={v.id} className={cn("cursor-pointer", selected?.id === v.id && "bg-sky-500/10")} onClick={() => select(v.id)}>
											<td className="whitespace-nowrap font-mono text-xs text-slate-100" title={`${v.id}\n${v.project}`}>
												{short(v.id)}
											</td>
											<td className="whitespace-nowrap">{time(v.firstSeen, true)}</td>
											<td className="text-right tabular-nums">{count(v.sessions)}</td>
											<td className="text-right tabular-nums">{count(v.requests)}</td>
											<td className="text-right tabular-nums text-slate-100">{usd(v.costPerRequest)}</td>
											<td className="text-right tabular-nums">{share(v.cacheShare, 1)}</td>
											<td className="text-right tabular-nums" title={`${v.toolErrors} of ${v.toolCalls} calls`}>
												{v.toolCalls ? share(v.toolErrors, v.toolCalls) : "—"}
											</td>
											<td className="text-right tabular-nums">{per100(v.interrupts, v.requests)}</td>
											<td className="text-right tabular-nums" title={Object.entries(v.userMessages).map(([k, n]) => `${n} ${k}`).join(", ")}>
												{per100(v.corrections, v.requests)}
											</td>
											<td className="max-w-[18rem] truncate text-xs" title={v.changes.map((c) => `${c.change} ${c.kind} ${c.name}`).join("\n")}>
												{changeText(v)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</Panel>
					{selected?.previous ? (
						<Panel title={`What changed in ${short(selected.id)}`} aside={`from ${short(selected.previous)} · ${selected.changes.length} sections and tools`}>
							<Diff from={selected.previous} to={selected.id} />
						</Panel>
					) : selected ? (
						<Panel title={`Version ${short(selected.id)}`}>
							<p className="text-sm text-slate-400">The first version of {projectName(selected.project)}: nothing to compare.</p>
						</Panel>
					) : null}
				</>
			) : (
				<Empty>No Pi requests with a harness version in this window.</Empty>
			)}
		</div>
	);
}
