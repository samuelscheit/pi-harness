import { useNavigate, useSearchParams } from "react-router-dom";
import type { Breakdown, BreakdownRow, Group } from "../api";
import { type BarRow, Legend, RankedBars, RATE_COLORS, RATE_KEYS, RATE_LABELS, rateSegments } from "./charts";
import { useFilterSearch, useSetParams, useView } from "./filters";
import { categoryLabel, count, projectName, SOURCE_LABELS, share, tokens, toolName, usd } from "./format";
import { CoverageNote, Empty, Panel, QueryState, Segmented, tableClass } from "./ui";

const GROUPS: { value: Group; label: string; hint: string }[] = [
	{ value: "content", label: "Prompt content", hint: "What the prompts contained, priced at the rate each part was billed at. Output is what the model wrote." },
	{ value: "tool", label: "Tool", hint: "Each tool's definition, its calls and its results, including what the results cost while kept in context." },
	{ value: "model", label: "Model", hint: "The model each request went to. Side calls without a recorded model are named by their kind." },
	{ value: "project", label: "Project", hint: "The directory each session started in." },
	{ value: "source", label: "Source", hint: "Pi sessions, and Claude Code sessions imported for analysis." },
	{ value: "context", label: "Context size", hint: "Prompt size when the request was sent. Every request re-reads its whole context." },
	{ value: "kind", label: "Request kind", hint: "Agent turns, and Pi's side calls: compactions, cache warming, tools' own model calls." },
	{ value: "day", label: "Day", hint: "Spend per local day." },
];

// Clicking a row narrows the whole dashboard to it where a filter exists.
const FILTER_FOR: Partial<Record<Group, string>> = { model: "model", project: "project", source: "source" };
const CONTENT_GROUPS: Group[] = ["content", "tool"];

function label(group: Group, key: string): string {
	if (group === "content") return categoryLabel(key);
	if (group === "tool") return toolName(key);
	if (group === "project") return projectName(key);
	if (group === "source") return SOURCE_LABELS[key] ?? key;
	return key;
}

function note(group: Group, row: BreakdownRow): string {
	if (group === "tool" && row.parts) return `definition ${usd(row.parts.definition)} · calls ${usd(row.parts.call)} · results ${usd(row.parts.result)}`;
	if (CONTENT_GROUPS.includes(group)) return `${tokens(row.tokens)} tokens in prompts`;
	return `${count(row.requests)} requests in ${count(row.sessions)} sessions`;
}

export function DriversView() {
	const [search, setSearch] = useSearchParams();
	const navigate = useNavigate();
	const setParams = useSetParams();
	const contextSearch = useFilterSearch();
	const group = (GROUPS.some((g) => g.value === search.get("group")) ? search.get("group") : "content") as Group;
	const query = useView<Breakdown>("breakdown", { group });
	const info = GROUPS.find((g) => g.value === group) ?? GROUPS[0]!;
	const rows = query.data?.group === group ? query.data.rows : [];
	const total = rows.reduce((sum, r) => sum + r.cost, 0);
	const contentLike = CONTENT_GROUPS.includes(group);
	const shown = group === "day" || group === "context" ? rows : rows.slice(0, 30);

	const select = (row: BarRow) => {
		const filter = FILTER_FOR[group];
		if (filter && !row.key.endsWith("(model not recorded)")) setParams({ [filter]: filter === "source" && row.key === "pi" ? null : row.key, group });
		else if (group === "tool") navigate(`/context${contextSearch}`);
	};

	return (
		<div className="space-y-4">
			<Segmented
				label="Group spend by"
				value={group}
				options={GROUPS.map(({ value, label }) => ({ value, label }))}
				onChange={(value) => {
					const next = new URLSearchParams(search);
					next.set("group", value);
					setSearch(next, { replace: true });
				}}
			/>
			<Panel title={`Spend by ${info.label.toLowerCase()}`} aside={<Legend items={RATE_KEYS.filter((key) => rows.some((r) => r[key] > 0)).map((key) => ({ label: RATE_LABELS[key], color: RATE_COLORS[key] }))} />}>
				<p className="mb-3 text-sm text-slate-400">
					{info.hint}
					{FILTER_FOR[group] ? " Click a row to filter the dashboard by it." : ""}
				</p>
				{query.data?.group === group ? (
					shown.length ? (
						<RankedBars
							rows={shown.map((row) => ({ key: row.key, label: label(group, row.key), title: row.key, segments: rateSegments(row), note: note(group, row) }))}
							total={total}
							onSelect={FILTER_FOR[group] || group === "tool" ? select : undefined}
						/>
					) : (
						<Empty>{contentLike ? "No analyzed prompt content in this window." : "No requests in this window."}</Empty>
					)
				) : (
					<QueryState isPending error={query.error} label="Loading breakdown…" />
				)}
			</Panel>
			{shown.length ? (
				<Panel title="Details" bodyClassName="p-0">
					<div className="overflow-x-auto">
						<table className={tableClass}>
							<thead>
								<tr>
									<th>{info.label}</th>
									{contentLike ? (
										<>
											<th className="text-right">Tokens in prompts</th>
											<th className="text-right">New</th>
										</>
									) : (
										<>
											<th className="text-right">Requests</th>
											<th className="text-right">Prompt tokens</th>
											<th className="text-right">Per request</th>
											<th className="text-right">Rebuild waste</th>
										</>
									)}
									<th className="text-right">Cache read</th>
									<th className="text-right">Cache write</th>
									<th className="text-right">Output</th>
									<th className="text-right">Cost</th>
								</tr>
							</thead>
							<tbody>
								{shown.map((row) => (
									<tr key={row.key}>
										<td className="max-w-[22rem] truncate text-slate-100" title={row.key}>
											{label(group, row.key)}
										</td>
										{contentLike ? (
											<>
												<td className="text-right tabular-nums">{tokens(row.tokens)}</td>
												<td className="text-right tabular-nums">{row.newTokens ? tokens(row.newTokens) : "—"}</td>
											</>
										) : (
											<>
												<td className="text-right tabular-nums">{count(row.requests)}</td>
												<td className="text-right tabular-nums">{tokens(row.tokens)}</td>
												<td className="text-right tabular-nums">{usd(row.requests ? row.cost / row.requests : 0)}</td>
												<td className="text-right tabular-nums">{row.waste ? usd(row.waste) : "—"}</td>
											</>
										)}
										<td className="text-right tabular-nums">{usd(row.read)}</td>
										<td className="text-right tabular-nums">{usd(row.write)}</td>
										<td className="text-right tabular-nums">{usd(row.output)}</td>
										<td className="whitespace-nowrap text-right">
											<b className="tabular-nums text-slate-100">{usd(row.cost)}</b> <span className="text-xs text-slate-500">{share(row.cost, total)}</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</Panel>
			) : null}
			{contentLike ? <CoverageNote coverage={query.data?.coverage} /> : null}
		</div>
	);
}
