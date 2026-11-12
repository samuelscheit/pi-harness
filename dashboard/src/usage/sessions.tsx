import { Link, useParams, useSearchParams } from "react-router-dom";
import type { SessionDetail, SessionNode, SessionPage, SessionSort } from "../api";
import { RankedBars, rateSegments } from "./charts";
import { useFilterSearch, useView } from "./filters";
import { categoryLabel, count, duration, projectName, SOURCE_LABELS, share, time, tokens, usd } from "./format";
import { SessionLink, ResultTable, SessionTable } from "./tables";
import { Timeline, TimelineLegend } from "./timeline";
import { CoverageNote, Empty, KpiStrip, Pager, Panel, QueryState, Segmented, Tag, tableClass } from "./ui";

const SORTS: { value: SessionSort; label: string }[] = [
	{ value: "cost", label: "Cost" },
	{ value: "waste", label: "Cache waste" },
	{ value: "peak", label: "Peak context" },
	{ value: "duration", label: "Duration" },
	{ value: "requests", label: "Requests" },
	{ value: "recent", label: "Recent" },
];

export function SessionsView() {
	const [search, setSearch] = useSearchParams();
	const sort = (SORTS.some((s) => s.value === search.get("sort")) ? search.get("sort") : "cost") as SessionSort;
	const page = Number(search.get("page") ?? 1) || 1;
	const query = useView<SessionPage>("sessions", { sort, page, pageSize: 25 });
	const update = (changes: Record<string, string | null>) => {
		const next = new URLSearchParams(search);
		for (const [key, value] of Object.entries(changes)) {
			if (value) next.set(key, value);
			else next.delete(key);
		}
		setSearch(next, { replace: true });
	};
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="max-w-3xl text-sm text-slate-400">
					One row per Pi session or subagent, with what it spent in this window. The title is the session's name, the task its parent gave it, or its first message.
				</p>
				<Segmented label="Sort sessions by" value={sort} options={SORTS} onChange={(value) => update({ sort: value, page: null })} />
			</div>
			<Panel title="Sessions" aside={query.data ? `${count(query.data.total)} in this window` : undefined} bodyClassName="p-0">
				{query.data ? (
					<>
						{query.data.rows.length ? <SessionTable rows={query.data.rows} full /> : <Empty>No sessions in this window.</Empty>}
						<Pager page={page} pageSize={query.data.pageSize} total={query.data.total} onPage={(next) => update({ page: next > 1 ? String(next) : null })} />
					</>
				) : (
					<QueryState isPending={query.isPending} error={query.error} label="Loading sessions…" />
				)}
			</Panel>
		</div>
	);
}

function Tree({ nodes, depth = 0 }: { nodes: SessionNode[]; depth?: number }) {
	return (
		<ul className={depth ? "ml-4 border-l border-slate-800 pl-3" : ""}>
			{nodes.map((node) => (
				<li key={node.id} className="py-1">
					<div className="flex items-baseline justify-between gap-3 text-sm">
						<SessionLink id={node.id} className="min-w-0 truncate text-slate-200 hover:text-sky-300">
							{node.title}
						</SessionLink>
						<span className="shrink-0 text-xs tabular-nums text-slate-500">
							{count(node.requests)} req · <b className="text-slate-200">{usd(node.cost)}</b>
						</span>
					</div>
					{node.children.length ? <Tree nodes={node.children} depth={depth + 1} /> : null}
				</li>
			))}
		</ul>
	);
}

const treeCost = (nodes: SessionNode[]): number => nodes.reduce((sum, n) => sum + n.cost + treeCost(n.children), 0);

export function SessionDetailView() {
	const id = useParams()["*"] ?? "";
	const query = useView<SessionDetail>(`sessions/${encodeURIComponent(id)}`);
	const search = useFilterSearch();
	const data = query.data?.session.id === id ? query.data : undefined;
	if (!data) return <QueryState isPending={!query.error} error={query.error} label="Loading session…" />;
	const s = data.session;
	const t = data.totals;
	const compositionTotal = data.composition.reduce((sum, r) => sum + r.cost, 0);
	const corrections = data.userMessages.filter((u) => u.kind === "steer" || u.kind === "after interrupt").length;
	const subagentCost = treeCost(data.children);
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<h2 className="text-lg font-semibold text-white">{s.title}</h2>
					<p className="mt-1 text-sm text-slate-400">
						<span title={s.cwd}>{projectName(s.cwd)}</span> · {SOURCE_LABELS[s.source] ?? s.source} · {s.models.join(", ") || "no model"} · {time(s.startedAt, true)} – {time(s.endedAt, true)}
					</p>
					{s.parent ? (
						<p className="mt-1 text-sm text-slate-400">
							Subagent of{" "}
							<SessionLink id={s.parent.id} className="text-sky-300 hover:text-sky-200">
								{s.parent.title}
							</SessionLink>
						</p>
					) : null}
				</div>
				<div className="flex flex-wrap gap-1.5">
					{t.waste ? <Tag tone="bad">{usd(t.waste)} cache waste</Tag> : null}
					{data.compactions.length ? <Tag>{data.compactions.length} compactions</Tag> : null}
					{t.sideCost ? <Tag tone="warn">{usd(t.sideCost)} in side calls</Tag> : null}
					{corrections ? <Tag tone="warn">{corrections} corrections</Tag> : null}
					{s.reportedCost !== null ? <Tag title="What Claude Code itself reported">client says {usd(s.reportedCost)}</Tag> : null}
					<Link to={`/drivers${search}${search ? "&" : "?"}session=${encodeURIComponent(s.id)}`} className="text-xs text-sky-300 hover:text-sky-200">
						Cost drivers of this session →
					</Link>
				</div>
			</div>
			<KpiStrip
				items={[
					{ label: "Cost", value: usd(t.cost), detail: `${usd(t.requests ? (t.cost - t.sideCost) / t.requests : 0)} per request` },
					{ label: "Requests", value: count(t.requests), detail: t.aborted ? `${t.aborted} interrupted` : undefined },
					{ label: "Peak context", value: tokens(data.peakTokens), detail: "tokens in one prompt" },
					{ label: "Duration", value: duration(s.endedAt - s.startedAt) },
					{ label: "Subagents", value: count(data.delegations.filter((d) => d.kind === "delegate").length), detail: subagentCost ? `${usd(subagentCost)} more` : undefined },
					{ label: "Cache waste", value: usd(t.waste), detail: `${share(t.waste, t.cost)} of cost`, tone: t.waste > t.cost * 0.1 ? "bad" : "default" },
				]}
			/>
			<Panel title="Timeline" aside={<TimelineLegend data={data} />}>
				<Timeline data={data} />
				<p className="mt-2 text-xs text-slate-500">
					Pauses over {6} minutes are drawn compressed. Dots on top are user messages (amber: steer, rose: after an interrupt); triangles below start subagents.
				</p>
			</Panel>
			<div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
				<Panel title="What this session paid for" aside="prompt content, by billing rate">
					{data.composition.length ? (
						<RankedBars
							rows={data.composition.slice(0, 14).map((row) => ({ key: row.key, label: categoryLabel(row.key), segments: rateSegments(row), note: `${tokens(row.tokens)} tokens in prompts` }))}
							total={compositionTotal}
							labelWidth={200}
						/>
					) : (
						<Empty>Imported sessions have totals only.</Empty>
					)}
					<CoverageNote coverage={data.coverage} />
				</Panel>
				<div className="grid min-w-0 content-start gap-4">
					<Panel title="Subagents" aside={data.children.length ? `${usd(subagentCost)} in total` : undefined}>
						{data.children.length ? <Tree nodes={data.children} /> : <p className="text-sm text-slate-500">This session started no subagents.</p>}
					</Panel>
					{data.rebuilds.length ? (
						<Panel title="Cache events" bodyClassName="p-0">
							<table className={tableClass}>
								<tbody>
									{data.rebuilds.map((e) => (
										<tr key={e.cause}>
											<td className="text-slate-100">{e.cause}</td>
											<td className="text-right tabular-nums">{count(e.requests)}</td>
											<td className="text-right tabular-nums text-rose-300">{e.waste ? usd(e.waste) : "—"}</td>
										</tr>
									))}
								</tbody>
							</table>
						</Panel>
					) : null}
					{data.bestCompaction ? (
						<Panel title="Best single compaction">
							<p className="text-sm text-slate-300">
								Compacting after request #{data.bestCompaction.after} ({tokens(data.bestCompaction.tokens)} tokens, {time(data.bestCompaction.ts, true)}) would have saved up to{" "}
								<b className="text-emerald-300">{usd(data.bestCompaction.saving)}</b>, knowing what came after. Quality loss not priced.
							</p>
						</Panel>
					) : null}
				</div>
			</div>
			<Panel title="Largest tool results in this session" bodyClassName="p-0">
				<ResultTable rows={data.results} showSession={false} />
			</Panel>
		</div>
	);
}
