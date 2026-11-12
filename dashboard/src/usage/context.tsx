import type { ContextView as ContextData } from "../api";
import { BubbleChart, RankedBars, RATE_COLORS, TipLine } from "./charts";
import { useView } from "./filters";
import { count, milliseconds, share, tokens, toolName, usd } from "./format";
import { ResultTable } from "./tables";
import { CoverageNote, Empty, KpiStrip, Panel, QueryState, tableClass } from "./ui";

export function ContextView() {
	const query = useView<ContextData>("context");
	const data = query.data;
	if (!data) return <QueryState isPending={query.isPending} error={query.error} label="Loading context analysis…" />;
	const carry = data.tools.reduce((sum, t) => sum + t.carryCost, 0);
	const withFiles = data.tools.reduce((sum, t) => sum + t.withFiles, 0);
	const unreferenced = data.tools.reduce((sum, t) => sum + t.unreferenced, 0);
	const unreferencedCost = data.tools.reduce((sum, t) => sum + t.unreferencedCost, 0);
	const heaviest = [...data.tools].sort((a, b) => b.tokensPerResult - a.tokensPerResult)[0];
	const definitions = data.toolCosts.rows.reduce((sum, r) => sum + (r.parts?.definition ?? 0), 0);
	const sizes = data.sizes;
	return (
		<div className="space-y-4">
			<p className="max-w-4xl text-sm text-slate-400">
				A tool result is paid for again in every later request until the session compacts. <b className="text-slate-200">Carry cost</b> is what a result cost while it stayed in
				context: its size times the requests that re-read it, at the rate each paid. A result that touched files counts as <b className="text-slate-200">used later</b> when a later
				call worked on one of its files or the agent named one.
			</p>
			<KpiStrip
				items={[
					{ label: "Tool results carried", value: usd(carry), detail: `${share(carry, data.kpis.cost)} of spend, ${count(data.tools.reduce((s, t) => s + t.calls, 0))} results` },
					{ label: "Never used again", value: share(unreferenced, withFiles), detail: `${usd(unreferencedCost)} of results with files`, tone: unreferencedCost > carry * 0.3 ? "bad" : "default" },
					{ label: "Tool definitions", value: usd(definitions), detail: "sent with every request" },
					{ label: "Median context", value: tokens(sizes.median), detail: `p90 ${tokens(sizes.p90)}, max ${tokens(sizes.max)}` },
					{ label: "Heaviest results", value: heaviest ? toolName(heaviest.tool) : "—", detail: heaviest ? `${tokens(heaviest.tokensPerResult)} tokens each` : undefined },
					{ label: "Most expensive result", value: usd(data.results[0]?.carryCost ?? 0), detail: data.results[0] ? toolName(data.results[0].tool) : undefined },
				]}
			/>
			<Panel title="Carry cost by tool" aside="size of one result vs. how long it stays in context · bubble area = carry cost">
				{data.tools.some((t) => t.carryCost > 0) ? (
					<>
						<BubbleChart
							bubbles={data.tools.map((t) => ({
								key: t.tool,
								label: toolName(t.tool),
								x: t.tokensPerResult,
								y: t.requestsKept,
								value: t.carryCost,
								detail: (
									<div className="space-y-1">
										<p className="font-medium text-slate-100">{toolName(t.tool)}</p>
										<TipLine label="Carry cost" value={usd(t.carryCost)} />
										<TipLine label="Results" value={count(t.calls)} />
										<TipLine label="Tokens each" value={tokens(t.tokensPerResult)} />
										<TipLine label="Requests kept" value={t.requestsKept.toFixed(1)} />
										{t.withFiles ? <TipLine label="Never used again" value={share(t.unreferenced, t.withFiles)} /> : null}
									</div>
								),
							}))}
						/>
						<p className="mt-2 text-xs text-slate-500">Top right costs the most: large results kept for many requests.</p>
					</>
				) : (
					<Empty>No tool results in this window.</Empty>
				)}
			</Panel>
			<div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
				<Panel title="Tools" aside="sorted by carry cost" bodyClassName="p-0">
					<div className="max-h-[30rem] overflow-auto">
						<table className={tableClass}>
							<thead>
								<tr>
									<th>Tool</th>
									<th className="text-right">Calls</th>
									<th className="text-right">Errors</th>
									<th className="text-right">p50 · p95</th>
									<th className="text-right">Tokens each</th>
									<th className="text-right">Kept</th>
									<th className="text-right">Never used</th>
									<th className="text-right">Carry cost</th>
								</tr>
							</thead>
							<tbody>
								{data.tools.map((t) => (
									<tr key={t.tool}>
										<td className="max-w-[14rem] truncate text-slate-100" title={t.tool}>
											{toolName(t.tool)}
										</td>
										<td className="text-right tabular-nums">{count(t.calls)}</td>
										<td className={`text-right tabular-nums ${t.errors / t.calls > 0.1 ? "text-rose-300" : ""}`}>{t.errors ? share(t.errors, t.calls) : "—"}</td>
										<td className="whitespace-nowrap text-right tabular-nums">
											{t.p50Ms === null ? "—" : `${milliseconds(t.p50Ms)} · ${milliseconds(t.p95Ms)}`}
										</td>
										<td className="text-right tabular-nums">{tokens(t.tokensPerResult)}</td>
										<td className="text-right tabular-nums">{t.requestsKept.toFixed(1)}</td>
										<td className="text-right tabular-nums" title={t.withFiles ? `${usd(t.unreferencedCost)} carried` : "no files"}>
											{t.withFiles ? share(t.unreferenced, t.withFiles) : "—"}
										</td>
										<td className="text-right">
											<b className="tabular-nums text-slate-100">{usd(t.carryCost)}</b>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</Panel>
				<Panel title="Context size per request" aside={`${count(sizes.requests)} requests · cost by size`}>
					{sizes.requests ? (
						<RankedBars
							labelWidth={110}
							rows={sizes.bands.map((b) => ({ key: b.band, label: b.band, segments: [{ key: "cost", label: "Cost", value: b.cost, color: RATE_COLORS.read }], note: `${count(b.requests)} requests (${share(b.requests, sizes.requests)})` }))}
							total={sizes.bands.reduce((s, b) => s + b.cost, 0)}
						/>
					) : (
						<Empty>No requests in this window.</Empty>
					)}
					<p className="mt-2 text-xs text-slate-500">
						Median {tokens(sizes.median)}, p90 {tokens(sizes.p90)}, largest {tokens(sizes.max)} tokens.
					</p>
				</Panel>
			</div>
			<Panel title="Most expensive single results" aside="with the file or command each call worked on" bodyClassName="p-0">
				<div className="max-h-[36rem] overflow-auto">
					<ResultTable rows={data.results} />
				</div>
			</Panel>
			<CoverageNote coverage={data.toolCosts.coverage} />
		</div>
	);
}
