// Tables several views share: sessions with their context sparkline, and tool results.

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { SessionRow, ToolResult } from "../api";
import { Sparkline } from "./charts";
import { useFilterSearch } from "./filters";
import { count, duration, projectName, SOURCE_LABELS, time, tokens, toolName, usd } from "./format";
import { tableClass, Tag } from "./ui";

export function SessionLink({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
	const search = useFilterSearch();
	return (
		<Link className={className} to={`/sessions/${encodeURIComponent(id)}${search}`}>
			{children}
		</Link>
	);
}

export function SessionTable({ rows, full = false }: { rows: SessionRow[]; full?: boolean }) {
	const max = Math.max(0, ...rows.map((r) => r.cost));
	return (
		<div className="overflow-x-auto">
			<table className={tableClass}>
				<thead>
					<tr>
						<th>Session</th>
						<th className="text-right">Requests</th>
						<th className="hidden sm:table-cell">Context</th>
						{full ? (
							<>
								<th className="text-right">Duration</th>
								<th className="text-right">Compactions</th>
								<th className="text-right">Subagents</th>
								<th className="text-right">Side calls</th>
								<th className="text-right">Cache waste</th>
							</>
						) : null}
						<th className="text-right">Cost</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.id}>
							<td className="w-full max-w-0">
								<SessionLink id={row.id} className="block truncate font-medium text-slate-100 hover:text-sky-300">
									{row.title}
								</SessionLink>
								<span className="block truncate text-xs text-slate-500" title={row.cwd}>
									{projectName(row.cwd)}
									{row.source !== "pi" ? ` · ${SOURCE_LABELS[row.source] ?? row.source}` : ""} · {time(row.first, true)}
								</span>
							</td>
							<td className="text-right tabular-nums">{count(row.requests)}</td>
							<td className="hidden sm:table-cell" title={`Peak ${tokens(row.peakTokens)} tokens`}>
								<Sparkline values={row.spark} />
							</td>
							{full ? (
								<>
									<td className="whitespace-nowrap text-right tabular-nums">{duration(row.last - row.first)}</td>
									<td className="text-right tabular-nums">{row.compactions || "—"}</td>
									<td className="text-right tabular-nums">{row.subagents || "—"}</td>
									<td className="text-right tabular-nums">{row.sideCost ? usd(row.sideCost) : "—"}</td>
									<td className={`text-right tabular-nums ${row.waste > row.cost * 0.1 ? "text-rose-300" : ""}`}>{row.waste ? usd(row.waste) : "—"}</td>
								</>
							) : null}
							<td className="text-right">
								<div className="flex items-center justify-end gap-2">
									<span className="hidden h-1.5 rounded-full bg-[#3987e5] sm:block" style={{ width: `${max ? (row.cost / max) * 48 : 0}px` }} />
									<b className="tabular-nums text-slate-100">{usd(row.cost)}</b>
								</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/** What a tool call worked on: its files (shortened), else its input summary. */
function callTarget(row: ToolResult): { text: string; title: string } {
	if (row.files.length) {
		const short = row.files.map((f) => f.split("/").slice(-2).join("/"));
		return { text: short.length > 2 ? `${short.slice(0, 2).join(", ")} +${short.length - 2}` : short.join(", "), title: `${row.summary}\n${row.files.join("\n")}` };
	}
	return { text: row.summary || "—", title: row.summary };
}

export function ResultTable({ rows, showSession = true }: { rows: ToolResult[]; showSession?: boolean }) {
	if (!rows.length) return <p className="px-4 py-6 text-sm text-slate-500">No tool results in this window.</p>;
	return (
		<div className="overflow-x-auto">
			<table className={tableClass}>
				<thead>
					<tr>
						<th>Tool call</th>
						{showSession ? <th>Session</th> : null}
						<th className="text-right">Tokens</th>
						<th className="text-right">Requests kept</th>
						<th>Used later</th>
						<th className="text-right">Carry cost</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => {
						const target = callTarget(row);
						return (
							<tr key={`${row.session}-${row.call}`}>
								<td className="max-w-[26rem]">
									<span className="mr-2 rounded border border-slate-700 px-1.5 py-px text-[11px] text-slate-400">{toolName(row.tool)}</span>
									<span className="break-all font-mono text-xs text-slate-200" title={target.title}>
										{target.text.length > 90 ? `${target.text.slice(0, 89)}…` : target.text}
									</span>
									<span className="block text-[11px] text-slate-500">
										{time(row.ts, true)}
										{row.isError ? <span className="text-rose-300"> · error</span> : null}
									</span>
								</td>
								{showSession ? (
									<td className="max-w-[16rem] truncate text-xs">
										<SessionLink id={row.session} className="hover:text-sky-300">
											{row.title}
										</SessionLink>
									</td>
								) : null}
								<td className="text-right tabular-nums">{tokens(row.tokens)}</td>
								<td className="text-right tabular-nums">{count(row.requestsKept)}</td>
								<td>{row.referencedLater === null ? <span className="text-slate-600">—</span> : row.referencedLater ? <Tag tone="good">yes</Tag> : <Tag tone="warn">never</Tag>}</td>
								<td className="text-right">
									<b className="tabular-nums text-slate-100">{usd(row.carryCost)}</b>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
