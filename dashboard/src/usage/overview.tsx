import { Link } from "react-router-dom";
import type { Overview } from "../api";
import { Legend, RATE_COLORS, RATE_KEYS, RATE_LABELS, rateSegments, SpendBars, SplitBar, WASTE_COLOR } from "./charts";
import { useFilterSearch, useView } from "./filters";
import { count, delta, share, tokens, usd } from "./format";
import { SessionTable } from "./tables";
import { CoverageNote, Delta, Empty, FindingList, KpiStrip, Panel, QueryState } from "./ui";

export function OverviewView() {
	const query = useView<Overview>("overview");
	const sessionsSearch = useFilterSearch();
	const data = query.data;
	if (!data) return <QueryState isPending={query.isPending} error={query.error} label="Loading usage…" />;
	const k = data.kpis;
	const p = data.previous;
	const segments = rateSegments(k);
	const promptShare = k.cost ? (k.read + k.write + k.uncached) / k.cost : 0;
	if (k.sessions === 0) return <Empty>No requests in this window. Pick a longer range or another source.</Empty>;
	return (
		<div className="space-y-4">
			<KpiStrip
				items={[
					{ label: "Spend", value: usd(k.cost), detail: <Delta text={delta(k.cost, p?.cost)} /> },
					{ label: "Requests", value: count(k.requests), detail: <Delta text={delta(k.requests, p?.requests)} /> },
					{ label: "Sessions", value: count(k.sessions), detail: `${usd(k.cost / k.sessions)} per session` },
					{ label: "Per request", value: usd(k.requests ? (k.cost - k.sideCost) / k.requests : 0), detail: <Delta text={p?.requests ? delta((k.cost - k.sideCost) / Math.max(1, k.requests), (p.cost - p.sideCost) / p.requests) : null} /> },
					{ label: "From cache", value: share(k.cacheReadTokens, k.promptTokens), detail: `${tokens(k.requests ? k.promptTokens / k.requests : 0)} prompt tokens per request` },
					{ label: "Cache rebuild waste", value: usd(k.waste), detail: `${share(k.waste, k.cost)} of spend`, tone: k.waste / (k.cost || 1) > 0.05 ? "bad" : "default" },
				]}
			/>
			<div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
				<Panel title="What drove spend" aside="ranked by dollars" bodyClassName="p-0">
					<FindingList findings={data.findings} empty="Nothing stands out in this window." />
				</Panel>
				<div className="grid min-w-0 content-start gap-4">
					<Panel title="Where each dollar went" aside="by billing rate">
						<div className="space-y-3">
							<SplitBar segments={segments} />
							<Legend items={segments.map((s) => ({ label: s.label, color: s.color, value: `${usd(s.value)} · ${share(s.value, k.cost)}` }))} />
							<p className="text-xs text-slate-500">
								{share(promptShare, 1)} of spend is the prompt being read or written; {share(k.output, k.cost)} is what the models wrote.
							</p>
						</div>
					</Panel>
					<Panel title="Spend over time" aside={<Legend items={[...RATE_KEYS.map((key) => ({ label: RATE_LABELS[key], color: RATE_COLORS[key] })), { label: "Rebuild waste", color: WASTE_COLOR }]} />}>
						<SpendBars points={data.series.points} unit={data.series.unit} />
					</Panel>
				</div>
			</div>
			<Panel
				title="Most expensive sessions"
				aside={
					<Link className="text-sky-300 hover:text-sky-200" to={`/sessions${sessionsSearch}`}>
						All {count(k.sessions)} sessions →
					</Link>
				}
				bodyClassName="p-0"
			>
				<SessionTable rows={data.topSessions} />
			</Panel>
			<CoverageNote coverage={data.coverage} />
		</div>
	);
}
