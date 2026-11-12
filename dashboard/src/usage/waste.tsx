import type { WasteView as WasteData } from "../api";
import { RankedBars, WASTE_COLOR } from "./charts";
import { useView } from "./filters";
import { count, duration, projectName, share, time, tokens, usd } from "./format";
import { SessionLink } from "./tables";
import { COMPACTION_COLORS, PAUSE_COLORS, PAUSE_LABELS } from "./timeline";
import { Empty, KpiStrip, Panel, QueryState, tableClass } from "./ui";

/** What to do about each cache-rebuild cause (attribution.ts names them). */
const ADVICE: Record<string, string> = {
	"cache expired after idle (5 min TTL)": "More than 5 minutes passed between requests on a 5-minute cache. Pi's one-hour retention and idle warming keep human-paced sessions cached.",
	"cache expired after idle (1 h TTL)": "The session paused for over an hour. For a large context a cold compaction (compaction.coldCache) is cheaper than writing it all again.",
	"model switched": "Switching models starts a new cache. Pick the model once per session.",
	"thinking level changed": "Changing the thinking level mid-session invalidates the cached history.",
	"tool definitions changed": "The initial tool set changed mid-session (an MCP server reconnected, an extension changed). Tools loaded through tool search append instead of rewriting.",
	"system prompt changed": "A prompt section changed and was folded into the leading prompt, which happens for models without mid-conversation system messages.",
	"prompt or tools updated mid-conversation": "The cache read stopped at an appended prompt or tool update. Check that the provider keeps mid-conversation system messages in place.",
	"cache missed without a prompt change": "The prompt was a prefix of the previous one, yet not read from cache: a provider-side eviction or a turn adding more than 20 blocks (cache lookback).",
};

function advice(cause: string): string {
	if (ADVICE[cause]) return ADVICE[cause];
	if (cause.startsWith("earlier ")) return `Content already in the conversation (${cause.slice(8, -8)}) was rewritten, so everything after it had to be cached again.`;
	return "";
}

export function WasteView() {
	const query = useView<WasteData>("waste");
	const data = query.data;
	if (!data) return <QueryState isPending={query.isPending} error={query.error} label="Loading waste…" />;
	const rebuilds = data.rebuilds.filter((c) => c.cause !== "compaction");
	const rebuildCost = rebuilds.reduce((sum, c) => sum + c.waste, 0);
	const cold = data.pauses.find((p) => p.outcome === "cold");
	const warming = data.pauses.reduce((sum, p) => sum + p.warmCost, 0);
	const sideCost = data.sideCalls.reduce((sum, c) => sum + c.cost, 0);
	const total = data.kpis.cost;
	return (
		<div className="space-y-4">
			<p className="max-w-4xl text-sm text-slate-400">
				Money that bought nothing new: writing a cache that already existed, letting it expire over a pause, and context carried longer than it paid off. A rebuild is counted when a
				request read at least 2k fewer cached tokens than its predecessor left; its waste is what it paid over reading them from cache.
			</p>
			<KpiStrip
				items={[
					{ label: "Cache rebuild waste", value: usd(rebuildCost), detail: `${count(rebuilds.reduce((s, c) => s + c.requests, 0))} requests`, tone: rebuildCost > total * 0.05 ? "bad" : "default" },
					{ label: "Cold resumes", value: usd(cold?.resumeCost ?? 0), detail: `${count(cold?.pauses ?? 0)} pauses let the cache expire` },
					{ label: "Warming", value: usd(warming), detail: `${count(data.pauses.reduce((s, p) => s + p.warms, 0))} refreshes kept caches alive` },
					{ label: "Compaction opportunity", value: usd(data.opportunities.total), detail: `best single compaction, ${count(data.opportunities.sessions.length)} sessions` },
					{ label: "Side calls", value: usd(sideCost), detail: `${share(sideCost, total)} of spend` },
					{ label: "Compactions", value: count(data.compactions.reduce((s, c) => s + c.count, 0)), detail: `${usd(data.compactions.reduce((s, c) => s + c.cost, 0))}, not counted as waste` },
				]}
			/>
			<div className="grid gap-4 xl:grid-cols-2">
				<Panel title="Cache rebuilds by cause" aside="each request compared with the one before">
					{rebuilds.length ? (
						<RankedBars
							rows={rebuilds.map((c) => ({ key: c.cause, label: c.cause, segments: [{ key: "waste", label: "Waste", value: c.waste, color: WASTE_COLOR }], note: `${count(c.requests)} requests in ${count(c.sessions)} sessions, ${tokens(c.lostTokens)} tokens written again` }))}
							total={rebuildCost}
							labelWidth={250}
						/>
					) : (
						<Empty>No cache rebuilds in this window.</Empty>
					)}
				</Panel>
				<Panel title="What to change" bodyClassName="p-0">
					<ul className="divide-y divide-slate-800">
						{rebuilds.slice(0, 6).map((c) => (
							<li key={c.cause} className="px-4 py-3">
								<div className="flex items-baseline justify-between gap-3">
									<span className="font-medium text-slate-100">{c.cause}</span>
									<b className="tabular-nums text-rose-300">{usd(c.waste)}</b>
								</div>
								<p className="mt-1 text-sm text-slate-400">{advice(c.cause)}</p>
							</li>
						))}
						{!rebuilds.length ? <li className="px-4 py-6 text-sm text-slate-500">Nothing to change.</li> : null}
					</ul>
				</Panel>
			</div>
			<div className="grid gap-4 xl:grid-cols-2">
				<Panel title="Pauses over 5 minutes" aside="how the session resumed" bodyClassName="p-0">
					{data.pauses.length ? (
						<div className="overflow-x-auto">
							<table className={tableClass}>
								<thead>
									<tr>
										<th>Outcome</th>
										<th className="text-right">Pauses</th>
										<th className="text-right">Avg length</th>
										<th className="text-right">Warming</th>
										<th className="text-right">Avg prompt</th>
										<th className="text-right">Paid on resume</th>
									</tr>
								</thead>
								<tbody>
									{data.pauses.map((p) => (
										<tr key={p.outcome}>
											<td className="whitespace-nowrap text-slate-100">
												<i className="mr-2 inline-block size-2 rounded-sm" style={{ background: PAUSE_COLORS[p.outcome] }} />
												{PAUSE_LABELS[p.outcome] ?? p.outcome}
											</td>
											<td className="text-right tabular-nums">{count(p.pauses)}</td>
											<td className="text-right tabular-nums">{duration(p.avgMinutes * 60_000)}</td>
											<td className="whitespace-nowrap text-right tabular-nums">
												{count(p.warms)} · {usd(p.warmCost)}
											</td>
											<td className="text-right tabular-nums">{tokens(p.avgPromptTokens)}</td>
											<td className="text-right tabular-nums text-slate-100">{usd(p.resumeCost)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : (
						<Empty>No pauses over 5 minutes.</Empty>
					)}
				</Panel>
				<Panel title="Compactions by reason" bodyClassName="p-0">
					{data.compactions.length ? (
						<table className={tableClass}>
							<thead>
								<tr>
									<th>Reason</th>
									<th className="text-right">Times</th>
									<th className="text-right">Avg context before</th>
									<th className="text-right">Cost</th>
								</tr>
							</thead>
							<tbody>
								{data.compactions.map((c) => (
									<tr key={c.reason}>
										<td className="text-slate-100">
											<i className="mr-2 inline-block size-2 rounded-sm" style={{ background: COMPACTION_COLORS[c.reason] ?? "#94a3b8" }} />
											{c.reason}
										</td>
										<td className="text-right tabular-nums">{count(c.count)}</td>
										<td className="text-right tabular-nums">{tokens(c.avgTokensBefore)}</td>
										<td className="text-right tabular-nums text-slate-100">{usd(c.cost)}</td>
									</tr>
								))}
							</tbody>
						</table>
					) : (
						<Empty>No compactions in this window.</Empty>
					)}
				</Panel>
			</div>
			<Panel title="Best single compaction per session" aside="knowing the later requests · keeps the recent context and a summary · quality loss not priced" bodyClassName="p-0">
				{data.opportunities.sessions.length ? (
					<div className="max-h-[30rem] overflow-auto">
						<table className={tableClass}>
							<thead>
								<tr>
									<th>Session</th>
									<th className="text-right">Requests</th>
									<th className="text-right">Peak context</th>
									<th className="text-right">Compact after</th>
									<th className="text-right">Cost</th>
									<th className="text-right">Saving</th>
								</tr>
							</thead>
							<tbody>
								{data.opportunities.sessions.slice(0, 20).map((s) => (
									<tr key={s.session}>
										<td className="max-w-[24rem]">
											<SessionLink id={s.session} className="block truncate text-slate-100 hover:text-sky-300">
												{s.title}
											</SessionLink>
											<span className="block truncate text-xs text-slate-500" title={s.cwd}>
												{projectName(s.cwd)}
											</span>
										</td>
										<td className="text-right tabular-nums">{count(s.requests)}</td>
										<td className="text-right tabular-nums">{tokens(s.peakTokens)}</td>
										<td className="whitespace-nowrap text-right tabular-nums">
											#{s.after} at {tokens(s.tokens)}
										</td>
										<td className="text-right tabular-nums">{usd(s.cost)}</td>
										<td className="text-right tabular-nums text-emerald-300">{usd(s.saving)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<Empty>No session would have gained from a compaction.</Empty>
				)}
			</Panel>
			<div className="grid gap-4 xl:grid-cols-2">
				<Panel title="Cold resumes" aside="the whole context written again after a pause" bodyClassName="p-0">
					{data.coldResumes.length ? (
						<table className={tableClass}>
							<tbody>
								{data.coldResumes.map((r) => (
									<tr key={`${r.session}-${r.start}`}>
										<td className="max-w-[18rem]">
											<SessionLink id={r.session} className="block truncate text-slate-100 hover:text-sky-300">
												{r.title}
											</SessionLink>
											<span className="text-xs text-slate-500">
												{time(r.start, true)} · paused {duration(r.minutes * 60_000)}
											</span>
										</td>
										<td className="text-right tabular-nums">{tokens(r.promptTokens)}</td>
										<td className="text-right tabular-nums text-rose-300">{usd(r.resumeCost)}</td>
									</tr>
								))}
							</tbody>
						</table>
					) : (
						<Empty>No cold resumes.</Empty>
					)}
				</Panel>
				<Panel title="Side calls" aside="Pi's requests besides agent turns" bodyClassName="p-0">
					{data.sideCalls.length ? (
						<table className={tableClass}>
							<thead>
								<tr>
									<th>Kind</th>
									<th>Model</th>
									<th className="text-right">Requests</th>
									<th className="text-right">Avg prompt</th>
									<th className="text-right">Cost</th>
								</tr>
							</thead>
							<tbody>
								{data.sideCalls.map((c) => (
									<tr key={c.kind}>
										<td className="text-slate-100">{c.kind}</td>
										<td className="max-w-[10rem] truncate">{c.model}</td>
										<td className="text-right tabular-nums">{count(c.requests)}</td>
										<td className="text-right tabular-nums">{tokens(c.avgPrompt)}</td>
										<td className="text-right tabular-nums text-slate-100">{usd(c.cost)}</td>
									</tr>
								))}
							</tbody>
						</table>
					) : (
						<Empty>No side calls in this window.</Empty>
					)}
				</Panel>
			</div>
			{data.examples.length ? (
				<Panel title="Largest rebuilds" bodyClassName="p-0">
					<div className="overflow-x-auto">
						<table className={tableClass}>
							<thead>
								<tr>
									<th>Time</th>
									<th>Session</th>
									<th>Cause</th>
									<th className="text-right">Prompt</th>
									<th className="text-right">Waste</th>
								</tr>
							</thead>
							<tbody>
								{data.examples.map((e) => (
									<tr key={`${e.session}-${e.entry}`}>
										<td className="whitespace-nowrap">{time(e.ts, true)}</td>
										<td className="max-w-[20rem] truncate">
											<SessionLink id={e.session} className="hover:text-sky-300">
												{e.title}
											</SessionLink>
										</td>
										<td>{e.cause}</td>
										<td className="text-right tabular-nums">{tokens(e.promptTokens)}</td>
										<td className="text-right tabular-nums text-rose-300">{usd(e.waste)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</Panel>
			) : null}
		</div>
	);
}
