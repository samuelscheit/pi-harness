import type { Subagents } from "../api";
import { DivergingBars, TipLine } from "./charts";
import { useView } from "./filters";
import { count, duration, share, tokens, usd } from "./format";
import { SessionLink } from "./tables";
import { Empty, KpiStrip, Panel, QueryState, Tag, tableClass } from "./ui";

const SHOWN = 20;

export function SubagentsView() {
	const query = useView<Subagents>("subagents");
	const data = query.data;
	if (!data) return <QueryState isPending={query.isPending} error={query.error} label="Loading subagents…" />;
	if (!data.started) return <Empty>No subagents started in this window.</Empty>;
	const compared = data.rows.filter((r) => r.alternative);
	const largest = [...compared].sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference)).slice(0, SHOWN);
	const saving = data.cost - data.bestCost;
	return (
		<div className="space-y-4">
			<p className="max-w-4xl text-sm text-slate-400">
				A new subagent writes its base prompt and tools once and fetches again what its parent already had (<b className="text-slate-200">rediscovery</b>). Resuming an idle
				earlier subagent of the same parent instead carries that agent's whole context in every request, and writes it again if its cache expired. Each new subagent is priced
				against the cheapest idle sibling.
			</p>
			<KpiStrip
				items={[
					{ label: "Subagents started", value: count(data.started), detail: `${usd(data.cost)} in total` },
					{ label: "Resumed by message", value: count(data.resumes), detail: "earlier subagents messaged again" },
					{ label: "Rediscovery", value: usd(data.rediscoveryCost), detail: `${share(data.rediscoveryCost, data.cost)} of subagent spend` },
					{ label: "Could resume", value: count(data.compared), detail: "an idle sibling existed" },
					{ label: "Resume was cheaper", value: count(data.resumeWins), detail: `of ${count(data.compared)} comparisons`, tone: data.resumeWins > data.compared / 2 ? "bad" : "default" },
					{ label: "Cheaper choice saves", value: usd(saving), detail: `${share(saving, data.cost)} less`, tone: saving > 0 ? "bad" : "good" },
				]}
			/>
			<Panel title="New or resume, per subagent" aside={`the ${Math.min(SHOWN, largest.length)} largest differences`}>
				{largest.length ? (
					<DivergingBars
						negative="new was cheaper"
						positive="resuming would save"
						rows={largest.map((r) => ({
							key: r.child,
							label: r.title,
							value: r.difference,
							detail: (
								<div className="space-y-1">
									<p className="font-medium text-slate-100">{r.title}</p>
									<TipLine label="New subagent" value={usd(r.cost)} />
									<TipLine label={`Resume ${r.alternative!.title.slice(0, 24)}`} value={usd(r.alternative!.cost)} />
									<TipLine label="Its context" value={`${tokens(r.alternative!.contextTokens)}, ${r.alternative!.warm ? "warm" : "cold"}`} />
									<TipLine label="Idle for" value={duration(r.alternative!.idleMs)} />
									<TipLine label="Rediscovered" value={usd(r.rediscovered.cost)} />
								</div>
							),
						}))}
					/>
				) : (
					<Empty>No new subagent had an idle sibling to resume instead.</Empty>
				)}
			</Panel>
			<Panel title="All subagents" aside="in the order they started" bodyClassName="p-0">
				<div className="max-h-[36rem] overflow-auto">
					<table className={tableClass}>
						<thead>
							<tr>
								<th>Subagent</th>
								<th className="text-right">Requests</th>
								<th className="text-right">Wall</th>
								<th className="text-right">Startup</th>
								<th className="text-right">Rediscovered</th>
								<th>Resume instead</th>
								<th className="text-right">Est. resume</th>
								<th className="text-right">Cost</th>
							</tr>
						</thead>
						<tbody>
							{data.rows.map((r) => (
								<tr key={r.child}>
									<td className="max-w-[20rem]">
										<SessionLink id={r.child} className="block truncate text-slate-100 hover:text-sky-300">
											{r.title}
										</SessionLink>
										<SessionLink id={r.parent} className="block truncate text-xs text-slate-500 hover:text-sky-300">
											parent session
										</SessionLink>
									</td>
									<td className="text-right tabular-nums">{count(r.requests)}</td>
									<td className="whitespace-nowrap text-right tabular-nums">{duration(r.wallMs)}</td>
									<td className="text-right tabular-nums">{usd(r.startupCost)}</td>
									<td className="whitespace-nowrap text-right tabular-nums" title={`${r.rediscovered.calls} calls, ${tokens(r.rediscovered.tokens)} tokens`}>
										{r.rediscovered.calls ? usd(r.rediscovered.cost) : "—"}
									</td>
									<td className="max-w-[16rem] text-xs">
										{r.alternative ? (
											<>
												<span className="block truncate text-slate-300">{r.alternative.title}</span>
												<span className="text-slate-500">
													{tokens(r.alternative.contextTokens)} · idle {duration(r.alternative.idleMs)} · {r.alternative.warm ? "warm" : "cold"}
												</span>
											</>
										) : (
											<span className="text-slate-600">none idle</span>
										)}
									</td>
									<td className="whitespace-nowrap text-right">
										{r.alternative ? (
											<>
												<span className="tabular-nums">{usd(r.alternative.cost)}</span>{" "}
												{r.difference > 0 ? <Tag tone="bad">saves {usd(r.difference)}</Tag> : <Tag tone="good">new −{usd(-r.difference)}</Tag>}
											</>
										) : (
											"—"
										)}
									</td>
									<td className="text-right">
										<b className="tabular-nums text-slate-100">{usd(r.cost)}</b>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</Panel>
		</div>
	);
}
