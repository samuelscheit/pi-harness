// One session over time: prompt size (line) and cost per request (bars), with cache rebuilds,
// side calls, compactions by reason, idle pauses by outcome, subagent starts and user messages
// marked. Pauses longer than GAP_CAP_MS are drawn compressed, so a long break does not squeeze
// the work around it.

import { useNavigate } from "react-router-dom";
import type { SessionDetail, TimelinePoint } from "../api";
import { AXIS, GRID, Legend, RATE_COLORS, SIDE_COLOR, TipLine, useTooltip, useWidth, WASTE_COLOR } from "./charts";
import { useFilterSearch } from "./filters";
import { categoryLabel, duration, time, tokens, usd } from "./format";

const GAP_CAP_MS = 6 * 60_000;
export const COMPACTION_COLORS: Record<string, string> = {
	manual: "#a78bfa",
	threshold: "#fbbf24",
	overflow: "#fb7185",
	cold: "#38bdf8",
	economic: "#34d399",
	auto: "#fbbf24",
	extension: "#94a3b8",
};
export const PAUSE_COLORS: Record<string, string> = { warm: "#34d399", compacted: "#38bdf8", cold: "#fb7185", open: "#64748b" };
export const PAUSE_LABELS: Record<string, string> = { warm: "resumed warm", compacted: "compacted, then resumed", cold: "cache rebuilt on resume", open: "not resumed" };
const USER_COLORS: Record<string, string> = { first: "#e2e8f0", "follow-up": "#94a3b8", steer: "#fbbf24", "after interrupt": "#fb7185", "after error": "#fb7185" };

/** Maps time to a compressed axis: every gap between consecutive events is capped at GAP_CAP_MS. */
export function compressedScale(times: number[]): { at: (ts: number) => number; span: number; from: (offset: number) => number } {
	const sorted = [...new Set(times)].sort((a, b) => a - b);
	const offsets: number[] = [];
	let offset = 0;
	sorted.forEach((t, i) => {
		if (i > 0) offset += Math.min(GAP_CAP_MS, t - sorted[i - 1]!);
		offsets.push(offset);
	});
	const at = (ts: number) => {
		if (sorted.length === 0) return 0;
		if (ts <= sorted[0]!) return 0;
		if (ts >= sorted.at(-1)!) return offset;
		let lo = 0;
		let hi = sorted.length - 1;
		while (hi - lo > 1) {
			const mid = (lo + hi) >> 1;
			if (sorted[mid]! <= ts) lo = mid;
			else hi = mid;
		}
		const gap = sorted[hi]! - sorted[lo]!;
		return offsets[lo]! + ((ts - sorted[lo]!) / gap) * (offsets[hi]! - offsets[lo]!);
	};
	const from = (target: number) => {
		const i = offsets.findIndex((o) => o >= target);
		if (i <= 0) return sorted[0] ?? 0;
		const span = offsets[i]! - offsets[i - 1]!;
		return sorted[i - 1]! + (span ? ((target - offsets[i - 1]!) / span) * (sorted[i]! - sorted[i - 1]!) : 0);
	};
	return { at, span: Math.max(1, offset), from };
}

export function Timeline({ data }: { data: SessionDetail }) {
	const [ref, width] = useWidth<HTMLDivElement>();
	const tip = useTooltip();
	const navigate = useNavigate();
	const search = useFilterSearch();
	const points = data.timeline;
	const height = 300;
	const left = 52;
	const right = 58;
	const top = 26;
	const bottom = 28;
	if (!points.length) return <p className="py-6 text-center text-sm text-slate-500">No requests.</p>;
	const scale = compressedScale([
		...points.map((p) => p.ts),
		...data.compactions.map((c) => c.ts),
		...data.delegations.map((d) => d.ts),
		...data.userMessages.map((u) => u.ts),
		...data.pauses.flatMap((p) => [p.start, p.end ?? data.session.endedAt]),
	]);
	const plotW = Math.max(1, width - left - right);
	const x = (ts: number) => left + (scale.at(ts) / scale.span) * plotW;
	// Requests that failed before an answer have no prompt size: they would drop the line to zero.
	const turns = points.filter((p) => p.kind === "turn" && p.promptTokens > 0);
	const maxPrompt = Math.max(50_000, ...turns.map((p) => p.promptTokens));
	const promptTop = Math.ceil(maxPrompt / 50_000) * 50_000;
	const maxCost = Math.max(0.0001, ...points.map((p) => p.cost));
	const plotH = height - bottom - top;
	const yP = (v: number) => top + plotH * (1 - v / promptTop);
	const yC = (v: number) => top + plotH * (1 - v / maxCost);
	const labels = Math.max(2, Math.floor(plotW / 90));
	const pointTip = (p: TimelinePoint) => (
		<div className="space-y-1">
			<p className="font-medium text-slate-100">
				{p.kind === "turn" ? "request" : p.kind} · {time(p.ts)}
			</p>
			<TipLine label="Prompt" value={tokens(p.promptTokens)} />
			<TipLine label="Read from cache" value={tokens(p.cacheRead)} />
			<TipLine label="Written to cache" value={tokens(p.cacheWrite)} />
			<TipLine label="Output" value={tokens(p.output)} />
			<TipLine label="Cost" value={usd(p.cost)} />
			{p.trigger ? <TipLine label="Answering" value={categoryLabel(p.trigger)} /> : null}
			{p.stopReason === "aborted" ? <p className="text-amber-300">interrupted</p> : null}
			{p.cacheEvent ? (
				<p className="text-rose-300">
					{p.cacheEvent}
					{p.waste ? ` · ${usd(p.waste)} waste` : ""}
				</p>
			) : null}
		</div>
	);
	return (
		<div ref={ref} className="w-full">
			{width > 0 ? (
				<svg width={width} height={height} role="img" aria-label="Prompt size and cost per request over the session">
					{data.pauses.map((p) => {
						const x1 = x(p.start);
						const x2 = x(p.end ?? data.session.endedAt);
						return (
							<g
								key={p.start}
								onMouseMove={(event) =>
									tip.show(
										event,
										<div className="space-y-1">
											<p className="font-medium text-slate-100">Pause of {duration(p.minutes * 60_000)}</p>
											<TipLine label="Outcome" value={PAUSE_LABELS[p.outcome] ?? p.outcome} color={PAUSE_COLORS[p.outcome]} />
											<TipLine label="Warm refreshes" value={`${p.warms} · ${usd(p.warmCost)}`} />
											{p.resumeCost ? <TipLine label="Paid on resume" value={usd(p.resumeCost)} /> : null}
										</div>,
									)
								}
								onMouseLeave={tip.hide}
							>
								<rect x={x1} y={top} width={Math.max(2, x2 - x1)} height={plotH} fill={PAUSE_COLORS[p.outcome] ?? "#64748b"} opacity={0.12} />
								<text x={(x1 + x2) / 2} y={top + plotH - 6} textAnchor="middle" fill={PAUSE_COLORS[p.outcome] ?? AXIS} fontSize={10}>
									{x2 - x1 > 34 ? duration(p.minutes * 60_000) : ""}
								</text>
							</g>
						);
					})}
					{[0, 0.25, 0.5, 0.75, 1].map((f) => (
						<g key={f}>
							<line x1={left} x2={width - right} y1={yP(promptTop * f)} y2={yP(promptTop * f)} stroke={GRID} />
							<text x={left - 6} y={yP(promptTop * f) + 4} textAnchor="end" fill={AXIS} fontSize={11}>
								{tokens(promptTop * f)}
							</text>
						</g>
					))}
					{[0, 0.5, 1].map((f) => (
						<text key={f} x={width - right + 6} y={yC(maxCost * f) + 4} fill={AXIS} fontSize={11}>
							{usd(maxCost * f)}
						</text>
					))}
					{Array.from({ length: labels + 1 }, (_, i) => (i / labels) * scale.span).map((offset, i) => (
						<text key={i} x={left + (offset / scale.span) * plotW} y={height - 8} textAnchor={i === 0 ? "start" : i === labels ? "end" : "middle"} fill={AXIS} fontSize={11}>
							{time(scale.from(offset)).slice(0, 5)}
						</text>
					))}
					{points.map((p) => {
						const color = p.waste > 0 ? WASTE_COLOR : p.kind !== "turn" ? SIDE_COLOR : "rgba(217,89,38,0.6)";
						return (
							<g key={p.entry} onMouseMove={(event) => tip.show(event, pointTip(p))} onMouseLeave={tip.hide}>
								<line x1={x(p.ts)} x2={x(p.ts)} y1={height - bottom} y2={yC(p.cost)} stroke={color} strokeWidth={p.waste > 0 ? 2 : 1} />
								<line x1={x(p.ts)} x2={x(p.ts)} y1={top} y2={height - bottom} stroke="transparent" strokeWidth={6} />
							</g>
						);
					})}
					<polyline points={turns.map((p) => `${x(p.ts)},${yP(p.promptTokens)}`).join(" ")} fill="none" stroke={RATE_COLORS.read} strokeWidth={2} pointerEvents="none" />
					{data.compactions.map((c) => (
						<g
							key={c.ts}
							onMouseMove={(event) =>
								tip.show(
									event,
									<div className="space-y-1">
										<p className="font-medium text-slate-100">Compaction · {time(c.ts)}</p>
										<TipLine label="Reason" value={c.reason} color={COMPACTION_COLORS[c.reason]} />
										<TipLine label="Context before" value={tokens(c.tokensBefore)} />
										<TipLine label="Cost" value={usd(c.cost)} />
									</div>,
								)
							}
							onMouseLeave={tip.hide}
						>
							<line x1={x(c.ts)} x2={x(c.ts)} y1={top - 6} y2={height - bottom} stroke={COMPACTION_COLORS[c.reason] ?? "#94a3b8"} strokeDasharray="4 3" strokeWidth={1.5} />
							<line x1={x(c.ts)} x2={x(c.ts)} y1={top - 6} y2={height - bottom} stroke="transparent" strokeWidth={8} />
						</g>
					))}
					{data.delegations.map((d) => (
						<path
							key={`${d.ts}-${d.child}`}
							d={`M${x(d.ts) - 5},${height - bottom + 9} l5,-8 l5,8 Z`}
							fill={d.kind === "delegate" ? "#e879f9" : "#f0abfc80"}
							className={d.child ? "cursor-pointer" : undefined}
							onClick={() => d.child && d.kind === "delegate" && navigate(`/sessions/${encodeURIComponent(d.child)}${search}`)}
							onMouseMove={(event) =>
								tip.show(
									event,
									<div className="space-y-1">
										<p className="font-medium text-slate-100">{d.kind === "delegate" ? "Subagent started" : "Subagent resumed"} · {time(d.ts)}</p>
										{d.title ? <p className="text-slate-300">{d.title}</p> : null}
										{d.child && d.kind === "delegate" ? <p className="text-slate-500">Click to open it</p> : null}
									</div>,
								)
							}
							onMouseLeave={tip.hide}
						/>
					))}
					{data.userMessages.map((u) => (
						<circle
							key={`${u.ts}-${u.kind}`}
							cx={x(u.ts)}
							cy={top - 14}
							r={4}
							fill={USER_COLORS[u.kind] ?? "#94a3b8"}
							onMouseMove={(event) =>
								tip.show(
									event,
									<div className="space-y-1">
										<p className="font-medium text-slate-100">
											User · {u.kind} · {time(u.ts)}
										</p>
										<p className="text-slate-300">{u.text}</p>
									</div>,
								)
							}
							onMouseLeave={tip.hide}
						/>
					))}
				</svg>
			) : null}
			{tip.node}
		</div>
	);
}

export function TimelineLegend({ data }: { data: SessionDetail }) {
	const reasons = [...new Set(data.compactions.map((c) => c.reason))];
	const outcomes = [...new Set(data.pauses.map((p) => p.outcome))];
	return (
		<Legend
			items={[
				{ label: "Prompt size", color: RATE_COLORS.read },
				{ label: "Cost per request", color: "#d95926" },
				{ label: "Cache rebuilt", color: WASTE_COLOR },
				{ label: "Side call", color: SIDE_COLOR },
				...(data.delegations.length ? [{ label: "Subagent", color: "#e879f9" }] : []),
				...reasons.map((r) => ({ label: `Compaction: ${r}`, color: COMPACTION_COLORS[r] ?? "#94a3b8", dashed: true })),
				...outcomes.map((o) => ({ label: `Pause: ${PAUSE_LABELS[o] ?? o}`, color: PAUSE_COLORS[o] ?? "#64748b" })),
			]}
		/>
	);
}
