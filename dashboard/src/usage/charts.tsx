// Plain-SVG charts with hover tooltips (from the gateway's Usage area): a split bar, spend over
// time stacked by billing rate, ranked bars, tool bubbles, diverging bars and sparklines.

import { type ReactNode, type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Spend } from "../api";
import { bucketLabel, share, tokens as fmtTokens, usd } from "./format";

/** Cost by billing rate; the order is the categorical palette's validated order. */
export const RATE_COLORS = { read: "#3987e5", write: "#d95926", output: "#199e70", uncached: "#c98500" } as const;
export const RATE_LABELS = { read: "Cache read", write: "Cache write", output: "Output", uncached: "Uncached input" } as const;
export const RATE_KEYS = ["read", "write", "output", "uncached"] as const;
export const WASTE_COLOR = "#fb7185";
export const SIDE_COLOR = "#9085e9";
export const GOOD_COLOR = "#34d399";
export const GRID = "#1e293b";
export const AXIS = "#64748b";

/* ---------- sizing & tooltip ---------- */

export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
	const ref = useRef<T>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		setWidth(el.clientWidth);
		const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.floor(entry.contentRect.width)));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	return [ref, width];
}

interface TipState {
	x: number;
	y: number;
	content: ReactNode;
}

export function useTooltip() {
	const [tip, setTip] = useState<TipState | null>(null);
	const show = useCallback((event: { clientX: number; clientY: number }, content: ReactNode) => setTip({ x: event.clientX, y: event.clientY, content }), []);
	const hide = useCallback(() => setTip(null), []);
	const node = tip
		? createPortal(
				<div
					className="pointer-events-none fixed z-50 max-w-xs rounded-lg border border-slate-700 bg-slate-950/95 px-3 py-2 text-xs text-slate-200 shadow-xl"
					style={{ left: Math.max(4, Math.min(tip.x + 14, window.innerWidth - 300)), top: tip.y + 14 }}
					role="tooltip"
				>
					{tip.content}
				</div>,
				document.body,
			)
		: null;
	return { show, hide, node };
}

export function TipLine({ label, value, color }: { label: ReactNode; value: ReactNode; color?: string }) {
	return (
		<div className="flex items-center justify-between gap-4">
			<span className="flex items-center gap-1.5 text-slate-400">
				{color ? <i className="inline-block size-2 rounded-sm" style={{ background: color }} /> : null}
				{label}
			</span>
			<span className="font-medium tabular-nums text-slate-100">{value}</span>
		</div>
	);
}

export function Legend({ items }: { items: { label: string; color: string; value?: string; dashed?: boolean }[] }) {
	return (
		<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
			{items.map((item) => (
				<span key={item.label} className="inline-flex items-center gap-1.5">
					<i className="inline-block size-2.5 rounded-sm" style={item.dashed ? { border: `1.5px dashed ${item.color}` } : { background: item.color }} />
					{item.label}
					{item.value ? <b className="font-medium tabular-nums text-slate-200">{item.value}</b> : null}
				</span>
			))}
		</div>
	);
}

function niceStep(max: number, count = 4): number {
	if (max <= 0) return 1;
	const raw = max / count;
	const power = 10 ** Math.floor(Math.log10(raw));
	const unit = raw / power;
	return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

export function ticks(max: number, count = 4): number[] {
	const step = niceStep(max, count);
	const top = Math.max(step, Math.ceil(max / step) * step);
	return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}

/** A bar rounded only at its data end (4 px), anchored at the baseline. */
export function barPath(x: number, y: number, w: number, h: number, horizontal: boolean): string {
	if (w <= 0 || h <= 0) return "";
	const r = Math.min(4, horizontal ? w / 2 : h / 2, horizontal ? h / 2 : w / 2);
	if (horizontal) return `M${x},${y} h${w - r} q${r},0 ${r},${r} v${h - 2 * r} q0,${r} -${r},${r} h-${w - r} Z`;
	return `M${x},${y + h} v-${h - r} q0,-${r} ${r},-${r} h${w - 2 * r} q${r},0 ${r},${r} v${h - r} Z`;
}

export interface Segment {
	key: string;
	label: string;
	value: number;
	color: string;
}

/** A spend split into its billing rates. */
export const rateSegments = (spend: Pick<Spend, (typeof RATE_KEYS)[number]>): Segment[] =>
	RATE_KEYS.map((key) => ({ key, label: RATE_LABELS[key], value: spend[key], color: RATE_COLORS[key] }));

/* ---------- split bar ---------- */

export function SplitBar({ segments, height = 14 }: { segments: Segment[]; height?: number }) {
	const tip = useTooltip();
	const total = segments.reduce((sum, s) => sum + s.value, 0);
	const visible = segments.filter((s) => s.value > 0 && s.value / (total || 1) > 0.002);
	return (
		<>
			<div className="flex w-full gap-0.5 overflow-hidden rounded-md bg-slate-950" style={{ height }} role="img" aria-label={segments.map((s) => `${s.label} ${share(s.value, total)}`).join(", ")}>
				{visible.map((segment) => (
					<div
						key={segment.key}
						style={{ flex: segment.value, background: segment.color }}
						onMouseMove={(event) => tip.show(event, <TipLine label={segment.label} value={`${usd(segment.value)} · ${share(segment.value, total)}`} color={segment.color} />)}
						onMouseLeave={tip.hide}
					/>
				))}
			</div>
			{tip.node}
		</>
	);
}

/* ---------- spend over time ---------- */

export interface TimePoint extends Spend {
	t: string;
	waste: number;
	requests: number;
}

/** Spend per bucket stacked by billing rate; the rebuild waste inside it outlined on top. */
export function SpendBars({ points, unit, height = 190 }: { points: TimePoint[]; unit: "hour" | "day"; height?: number }) {
	const [ref, width] = useWidth<HTMLDivElement>();
	const tip = useTooltip();
	const left = 48;
	const bottom = 22;
	const top = 8;
	const max = Math.max(0, ...points.map((p) => p.cost));
	const yTicks = ticks(max);
	const yMax = yTicks.at(-1) || 1;
	const plotW = Math.max(0, width - left);
	const plotH = height - bottom - top;
	const slot = points.length ? plotW / points.length : 0;
	const barW = Math.max(1, Math.min(28, slot - 2));
	const y = (v: number) => top + plotH * (1 - v / yMax);
	const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / 64))));
	return (
		<div ref={ref} className="w-full">
			{width > 0 ? (
				<svg width={width} height={height} role="img" aria-label="Spend over time by billing rate">
					{yTicks.map((v) => (
						<g key={v}>
							<line x1={left} x2={width} y1={y(v)} y2={y(v)} stroke={GRID} />
							<text x={left - 6} y={y(v) + 4} textAnchor="end" fill={AXIS} fontSize={11}>
								{usd(v)}
							</text>
						</g>
					))}
					{points.map((p, i) => {
						const x = left + i * slot + (slot - barW) / 2;
						let base = 0;
						const stacked = RATE_KEYS.filter((key) => p[key] > 0);
						return (
							<g
								key={p.t}
								onMouseMove={(event) =>
									tip.show(
										event,
										<div className="space-y-1">
											<p className="font-medium text-slate-100">{bucketLabel(p.t, unit, true)}</p>
											{RATE_KEYS.map((key) => (
												<TipLine key={key} label={RATE_LABELS[key]} value={usd(p[key])} color={RATE_COLORS[key]} />
											))}
											<TipLine label="Spend" value={usd(p.cost)} />
											{p.waste > 0 ? <TipLine label="of which rebuild waste" value={usd(p.waste)} color={WASTE_COLOR} /> : null}
											<TipLine label="Requests" value={p.requests.toLocaleString("en-US")} />
										</div>,
									)
								}
								onMouseLeave={tip.hide}
							>
								<rect x={left + i * slot} y={top} width={slot} height={plotH} fill="transparent" />
								{stacked.map((key, j) => {
									const h = plotH * (p[key] / yMax);
									const yTop = y(base + p[key]);
									base += p[key];
									return j === stacked.length - 1 ? <path key={key} d={barPath(x, yTop, barW, h, false)} fill={RATE_COLORS[key]} /> : <rect key={key} x={x} y={yTop} width={barW} height={Math.max(0, h - 0.5)} fill={RATE_COLORS[key]} />;
								})}
								{p.waste > 0 && plotH * (p.waste / yMax) > 0.5 ? <rect x={x - 1} y={y(p.cost) - 3} width={barW + 2} height={2} fill={WASTE_COLOR} /> : null}
								{i % labelEvery === 0 ? (
									<text x={x + barW / 2} y={height - 6} textAnchor="middle" fill={AXIS} fontSize={11}>
										{bucketLabel(p.t, unit)}
									</text>
								) : null}
							</g>
						);
					})}
				</svg>
			) : null}
			{tip.node}
		</div>
	);
}

/* ---------- ranked bars ---------- */

export interface BarRow {
	key: string;
	label: string;
	segments: Segment[];
	note?: string;
	title?: string;
}

/**
 * Horizontal bars, one row per item, with the value and its share of `total` at the end. Below
 * 560 px the label moves above the bar (phone width).
 */
export function RankedBars({
	rows,
	total,
	onSelect,
	labelWidth = 230,
	format = usd,
	showShare = true,
}: {
	rows: BarRow[];
	total: number;
	onSelect?: (row: BarRow) => void;
	labelWidth?: number;
	format?: (value: number) => string;
	showShare?: boolean;
}) {
	const [ref, width] = useWidth<HTMLDivElement>();
	const tip = useTooltip();
	const rowH = 28;
	const compact = width < 560;
	const left = compact ? 0 : labelWidth;
	const right = 110;
	const top = compact ? 16 : 0;
	const max = Math.max(0, ...rows.map((r) => r.segments.reduce((s, x) => s + x.value, 0)));
	const scale = max > 0 ? Math.max(0, width - left - right) / max : 0;
	const step = compact ? rowH + 16 : rowH;
	const height = rows.length * step + 8;
	const chars = Math.max(16, Math.floor((compact ? width : labelWidth - 10) / 6.6));
	return (
		<div ref={ref} className="w-full">
			{width > 0 ? (
				<svg width={width} height={height} role="img" aria-label="Ranked breakdown">
					{rows.map((row, i) => {
						const rowTotal = row.segments.reduce((s, x) => s + x.value, 0);
						const y = i * step + top;
						let x = left;
						const visible = row.segments.filter((s) => s.value * scale >= 0.5);
						return (
							<g
								key={row.key}
								className={onSelect ? "cursor-pointer" : undefined}
								onClick={() => onSelect?.(row)}
								onMouseMove={(event) =>
									tip.show(
										event,
										<div className="space-y-1">
											<p className="break-all font-medium text-slate-100">{row.title ?? row.label}</p>
											{row.segments
												.filter((s) => s.value > 0)
												.map((s) => (
													<TipLine key={s.key} label={s.label} value={format(s.value)} color={s.color} />
												))}
											{row.note ? <p className="text-slate-400">{row.note}</p> : null}
										</div>,
									)
								}
								onMouseLeave={tip.hide}
							>
								<rect x={0} y={y - (compact ? 16 : 0)} width={width} height={step} fill="transparent" className={onSelect ? "hover:fill-slate-800/40" : undefined} />
								<text x={compact ? 0 : left - 10} y={compact ? y - 4 : y + 17} textAnchor={compact ? "start" : "end"} fill="#cbd5e1" fontSize={12}>
									{row.label.length > chars ? `${row.label.slice(0, chars - 1)}…` : row.label}
								</text>
								{visible.map((segment, j) => {
									const w = segment.value * scale;
									const last = j === visible.length - 1;
									const d = last ? barPath(x, y + 5, Math.max(1, w), 18, true) : `M${x},${y + 5} h${Math.max(0.5, w - 2)} v18 h-${Math.max(0.5, w - 2)} Z`;
									x += w;
									return <path key={segment.key} d={d} fill={segment.color} />;
								})}
								<text x={left + rowTotal * scale + 8} y={y + 18} fill="#e2e8f0" fontSize={12} className="tabular-nums">
									{format(rowTotal)}
									{showShare ? <tspan fill={AXIS}> {share(rowTotal, total)}</tspan> : null}
								</text>
							</g>
						);
					})}
				</svg>
			) : null}
			{tip.node}
		</div>
	);
}

/* ---------- diverging bars ---------- */

export interface DivergingRow {
	key: string;
	label: string;
	/** Positive goes right (`positive` label), negative left. */
	value: number;
	detail: ReactNode;
}

/** Bars left and right of a center line, such as "new was cheaper" against "resume saves". */
export function DivergingBars({ rows, negative, positive }: { rows: DivergingRow[]; negative: string; positive: string }) {
	const [ref, width] = useWidth<HTMLDivElement>();
	const tip = useTooltip();
	const compact = width < 560;
	const labelW = compact ? 0 : 220;
	const rowH = compact ? 44 : 28;
	const top = 22;
	const plotW = Math.max(0, width - labelW);
	const center = labelW + plotW / 2;
	const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.value)));
	const half = plotW / 2 - 56;
	const height = top + rows.length * rowH + 4;
	return (
		<div ref={ref} className="w-full">
			{width > 0 ? (
				<svg width={width} height={height} role="img" aria-label={`${negative} or ${positive}`}>
					<text x={center - 8} y={12} textAnchor="end" fill={GOOD_COLOR} fontSize={11}>
						← {negative}
					</text>
					<text x={center + 8} y={12} fill={WASTE_COLOR} fontSize={11}>
						{positive} →
					</text>
					<line x1={center} x2={center} y1={top - 4} y2={height} stroke="#334155" />
					{rows.map((row, i) => {
						const y = top + i * rowH + (compact ? 16 : 0);
						const w = (Math.abs(row.value) / max) * half;
						const right = row.value >= 0;
						const x = right ? center : center - w;
						const chars = Math.max(16, Math.floor((compact ? width : labelW - 10) / 6.6));
						return (
							<g key={row.key} onMouseMove={(event) => tip.show(event, row.detail)} onMouseLeave={tip.hide}>
								<rect x={0} y={y - (compact ? 16 : 0)} width={width} height={rowH} fill="transparent" />
								<text x={compact ? 0 : labelW - 10} y={compact ? y - 4 : y + 15} textAnchor={compact ? "start" : "end"} fill="#cbd5e1" fontSize={12}>
									{row.label.length > chars ? `${row.label.slice(0, chars - 1)}…` : row.label}
								</text>
								{w > 0.5 ? <rect x={x} y={y + 3} width={w} height={16} rx={3} fill={right ? WASTE_COLOR : GOOD_COLOR} opacity={0.85} /> : null}
								<text x={right ? center + w + 6 : center - w - 6} y={y + 15} textAnchor={right ? "start" : "end"} fill="#e2e8f0" fontSize={12} className="tabular-nums">
									{usd(Math.abs(row.value))}
								</text>
							</g>
						);
					})}
				</svg>
			) : null}
			{tip.node}
		</div>
	);
}

/* ---------- tool bubbles ---------- */

export interface Bubble {
	key: string;
	label: string;
	/** Tokens per result. */
	x: number;
	/** Requests kept in context. */
	y: number;
	/** Carry cost. */
	value: number;
	detail: ReactNode;
}

export function BubbleChart({ bubbles, height = 300 }: { bubbles: Bubble[]; height?: number }) {
	const [ref, width] = useWidth<HTMLDivElement>();
	const tip = useTooltip();
	const left = 52;
	const bottom = 40;
	const top = 14;
	const right = 24;
	const usable = bubbles.filter((b) => b.x > 0 && b.y > 0);
	const minX = Math.max(10, Math.min(...usable.map((b) => b.x), 100) / 2);
	const maxX = Math.max(1000, ...usable.map((b) => b.x)) * 1.6;
	const maxY = Math.max(10, ...usable.map((b) => b.y)) * 1.15;
	const lx = (v: number) => left + ((Math.log10(v) - Math.log10(minX)) / (Math.log10(maxX) - Math.log10(minX))) * (width - left - right);
	const ly = (v: number) => top + (height - bottom - top) * (1 - v / maxY);
	const maxValue = Math.max(0, ...usable.map((b) => b.value));
	const xTicks = [10, 100, 1000, 10_000, 100_000, 1_000_000].filter((v) => v >= minX && v <= maxX);
	const sorted = [...usable].sort((a, b) => b.value - a.value);
	const maxR = width < 560 ? 16 : 24;
	// Labels for the largest bubbles, skipping any that would overlap one already placed.
	const placed: { x1: number; x2: number; y1: number; y2: number }[] = [];
	const labelled = new Set<string>();
	for (const b of sorted.slice(0, width < 560 ? 4 : 8)) {
		const r = 4 + maxR * Math.sqrt(maxValue ? b.value / maxValue : 0);
		const cx = lx(b.x);
		const w = b.label.length * 6.8;
		const flip = cx > width - 140;
		const box = { x1: flip ? cx - r - 5 - w : cx + r + 5, x2: flip ? cx - r - 5 : cx + r + 5 + w, y1: ly(b.y) - 9, y2: ly(b.y) + 7 };
		if (placed.some((p) => box.x1 < p.x2 && box.x2 > p.x1 && box.y1 < p.y2 && box.y2 > p.y1)) continue;
		placed.push(box);
		labelled.add(b.key);
	}
	return (
		<div ref={ref} className="w-full">
			{width > 0 ? (
				<svg width={width} height={height} role="img" aria-label="Tools by result size and how long results stay in context">
					{xTicks.map((v) => (
						<g key={v}>
							<line x1={lx(v)} x2={lx(v)} y1={top} y2={height - bottom} stroke={GRID} />
							<text x={lx(v)} y={height - bottom + 16} textAnchor="middle" fill={AXIS} fontSize={11}>
								{fmtTokens(v)}
							</text>
						</g>
					))}
					{ticks(maxY)
						.filter((v) => v <= maxY)
						.map((v) => (
						<g key={v}>
							<line x1={left} x2={width - right} y1={ly(v)} y2={ly(v)} stroke={GRID} />
							<text x={left - 8} y={ly(v) + 4} textAnchor="end" fill={AXIS} fontSize={11}>
								{v}
							</text>
						</g>
					))}
					<text x={(width + left) / 2} y={height - 4} textAnchor="middle" fill={AXIS} fontSize={11}>
						tokens per result (log scale)
					</text>
					<text transform={`translate(13 ${(height - bottom) / 2}) rotate(-90)`} textAnchor="middle" fill={AXIS} fontSize={11}>
						requests kept in context
					</text>
					{sorted.map((b, i) => {
						const r = 4 + maxR * Math.sqrt(maxValue ? b.value / maxValue : 0);
						const cx = lx(b.x);
						const cy = ly(b.y);
						const flip = cx > width - 140;
						return (
							<g key={b.key} onMouseMove={(event) => tip.show(event, b.detail)} onMouseLeave={tip.hide}>
								<circle cx={cx} cy={cy} r={r + 4} fill="transparent" />
								<circle cx={cx} cy={cy} r={r} fill={RATE_COLORS.read} fillOpacity={i < 3 ? 0.5 : 0.25} stroke={RATE_COLORS.read} strokeWidth={1.5} />
								{labelled.has(b.key) ? (
									<text x={flip ? cx - r - 5 : cx + r + 5} y={cy + 4} fill="#cbd5e1" fontSize={12} textAnchor={flip ? "end" : "start"}>
										{b.label}
									</text>
								) : null}
							</g>
						);
					})}
				</svg>
			) : null}
			{tip.node}
		</div>
	);
}

/* ---------- sparkline ---------- */

/** Prompt size over a session; the dashed line is `max`. */
export function Sparkline({ values, max = 400_000, width = 84, height = 22 }: { values: number[]; max?: number; width?: number; height?: number }) {
	if (!values.length) return <span className="text-slate-600">—</span>;
	const top = Math.max(max, ...values);
	const n = values.length;
	const points = values.map((v, i) => `${(i / Math.max(1, n - 1)) * (width - 2) + 1},${height - 1 - (v / top) * (height - 2)}`).join(" ");
	return (
		<svg width={width} height={height} aria-hidden="true">
			<line x1={0} x2={width} y1={height - 1 - (max / top) * (height - 2)} y2={height - 1 - (max / top) * (height - 2)} stroke="#334155" strokeDasharray="2 3" />
			<polyline points={points} fill="none" stroke={RATE_COLORS.read} strokeWidth={1.5} />
		</svg>
	);
}
