// Layout primitives of every view (from the gateway's Usage area): panels, a KPI strip, ranked
// findings, query states, a pager, segmented controls and tags.

import { AlertCircle, ChevronLeft, ChevronRight, Info, LoaderCircle } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Finding, View } from "../api";
import { cn } from "../lib";
import { useFilterSearch } from "./filters";
import { share, usd } from "./format";

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
	return <section className={cn("rounded-xl border border-slate-800 bg-slate-900/75 shadow-panel", className)} {...props} />;
}

export function Panel({ title, aside, children, className, bodyClassName }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
	return (
		<Card className={cn("min-w-0", className)}>
			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
				<h2 className="text-sm font-semibold text-white">{title}</h2>
				{aside ? <div className="text-xs text-slate-500">{aside}</div> : null}
			</div>
			<div className={cn("p-4", bodyClassName)}>{children}</div>
		</Card>
	);
}

export interface Kpi {
	label: string;
	value: string;
	detail?: ReactNode;
	tone?: "default" | "bad" | "good";
}

export function KpiStrip({ items }: { items: Kpi[] }) {
	return (
		<div className="grid grid-cols-2 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/75 sm:grid-cols-3 xl:grid-cols-6">
			{items.map((item) => (
				<div key={item.label} className="min-w-0 border-b border-r border-slate-800/70 px-4 py-3">
					<p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{item.label}</p>
					<p className={cn("mt-1 truncate text-xl font-semibold tabular-nums tracking-tight text-white", item.tone === "bad" && "text-rose-300", item.tone === "good" && "text-emerald-300")}>{item.value}</p>
					{item.detail ? <p className="mt-0.5 truncate text-xs text-slate-500">{item.detail}</p> : null}
				</div>
			))}
		</div>
	);
}

export function Delta({ text, higherIsWorse = true }: { text: string | null; higherIsWorse?: boolean }) {
	if (!text) return <span>no earlier data</span>;
	const up = text.startsWith("+");
	const flat = text.startsWith("±");
	return (
		<span className={cn(!flat && (up === higherIsWorse ? "text-rose-300" : "text-emerald-300"))}>
			{text} <span className="text-slate-500">vs previous period</span>
		</span>
	);
}

const SEVERITY: Record<Finding["severity"], { stripe: string; label: string }> = {
	critical: { stripe: "bg-rose-400", label: "Critical" },
	warning: { stripe: "bg-amber-400", label: "Warning" },
	info: { stripe: "bg-sky-400", label: "Note" },
};

export const VIEW_PATHS: Record<View, string> = {
	drivers: "/drivers",
	context: "/context",
	sessions: "/sessions",
	waste: "/waste",
	subagents: "/subagents",
	versions: "/versions",
};

function FindingLink({ finding, children }: { finding: Finding; children: ReactNode }) {
	const search = useFilterSearch(finding.params);
	return (
		<Link to={`${VIEW_PATHS[finding.view]}${search}`} className="grid grid-cols-[4px_minmax(0,1fr)_auto] gap-3 px-4 py-3 transition hover:bg-slate-800/40">
			{children}
		</Link>
	);
}

export function FindingList({ findings, empty }: { findings: Finding[]; empty: string }) {
	if (!findings.length) return <p className="px-4 py-6 text-sm text-slate-500">{empty}</p>;
	return (
		<ul className="divide-y divide-slate-800">
			{findings.map((finding) => (
				<li key={finding.id}>
					<FindingLink finding={finding}>
						<span className={cn("rounded-sm", SEVERITY[finding.severity].stripe)} aria-label={SEVERITY[finding.severity].label} />
						<div className="min-w-0">
							<p className="font-medium text-slate-100">{finding.title}</p>
							<p className="mt-0.5 text-sm text-slate-400">{finding.detail}</p>
						</div>
						<div className="text-right">
							<p className="font-semibold tabular-nums text-white">{usd(finding.cost)}</p>
							<p className="text-xs text-slate-500">{share(finding.share, 1)} of spend</p>
						</div>
					</FindingLink>
				</li>
			))}
		</ul>
	);
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
	return (
		<div className="flex min-h-28 items-center justify-center gap-2 text-sm text-slate-400">
			<LoaderCircle className="size-4 animate-spin" />
			{label}
		</div>
	);
}

export function ErrorState({ message }: { message: string }) {
	return (
		<div className="flex items-start gap-2 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200" role="alert">
			<AlertCircle className="mt-0.5 size-4 shrink-0" />
			<span>{message}</span>
		</div>
	);
}

export function QueryState({ isPending, error, label }: { isPending: boolean; error: Error | null; label: string }) {
	if (error) return <ErrorState message={error.message} />;
	if (isPending) return <LoadingState label={label} />;
	return null;
}

export function Empty({ children }: { children: ReactNode }) {
	return <p className="py-6 text-center text-sm text-slate-500">{children}</p>;
}

/** Imported Claude Code sessions have totals only: say how much of the spend a content view covers. */
export function CoverageNote({ coverage }: { coverage: number | undefined }) {
	if (coverage === undefined || coverage >= 0.98) return null;
	return (
		<p className="flex items-start gap-2 text-xs text-slate-500">
			<Info className="mt-0.5 size-3.5 shrink-0" />
			Prompt-content analysis covers {share(coverage, 1)} of this window's spend: Pi sessions are analyzed per request, imported Claude Code sessions have totals only.
		</p>
	);
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
	const pages = Math.max(1, Math.ceil(total / pageSize));
	return (
		<div className="flex items-center justify-between gap-3 border-t border-slate-800 px-4 py-2 text-xs text-slate-500">
			<span>{total ? `${((page - 1) * pageSize + 1).toLocaleString("en-US")}–${Math.min(total, page * pageSize).toLocaleString("en-US")} of ${total.toLocaleString("en-US")}` : "No rows"}</span>
			<div className="flex items-center gap-1">
				<button type="button" className="rounded p-1 hover:bg-slate-800 disabled:opacity-40" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
					<ChevronLeft className="size-4" />
				</button>
				<span className="tabular-nums">
					{page} / {pages}
				</span>
				<button type="button" className="rounded p-1 hover:bg-slate-800 disabled:opacity-40" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
					<ChevronRight className="size-4" />
				</button>
			</div>
		</div>
	);
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void; label: string }) {
	return (
		<div className="inline-flex flex-wrap overflow-hidden rounded-md border border-slate-700" role="group" aria-label={label}>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					aria-pressed={value === option.value}
					className={cn("h-8 whitespace-nowrap px-2.5 text-sm transition sm:px-3", value === option.value ? "bg-sky-500/20 text-sky-200" : "bg-slate-950 text-slate-400 hover:text-slate-100")}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

export const tableClass = "data-table";

export function Tag({ children, tone = "default", title }: { children: ReactNode; tone?: "default" | "bad" | "warn" | "info" | "good"; title?: string }) {
	return (
		<span
			title={title}
			className={cn(
				"inline-flex items-center whitespace-nowrap rounded-full border px-2 py-px text-[11px]",
				tone === "default" && "border-slate-700 text-slate-400",
				tone === "bad" && "border-rose-800 bg-rose-950/40 text-rose-300",
				tone === "warn" && "border-amber-800 bg-amber-950/40 text-amber-300",
				tone === "info" && "border-sky-800 bg-sky-950/40 text-sky-300",
				tone === "good" && "border-emerald-800 bg-emerald-950/40 text-emerald-300",
			)}
		>
			{children}
		</span>
	);
}
