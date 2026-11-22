// Number, time and label formatting for every view (from the gateway's Usage area).

export function usd(value: number | null | undefined): string {
	const v = value ?? 0;
	if (v < 0) return `−${usd(-v)}`;
	if (v >= 10_000) return `$${(v / 1000).toFixed(1)}k`;
	if (v >= 1000) return `$${(v / 1000).toFixed(2)}k`;
	if (v >= 100) return `$${v.toFixed(0)}`;
	if (v >= 1) return `$${v.toFixed(2)}`;
	if (v === 0) return "$0";
	return `$${v.toFixed(v >= 0.01 ? 3 : 4)}`;
}

export function tokens(value: number | null | undefined): string {
	const v = value ?? 0;
	if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
	if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
	if (v >= 1e4) return `${(v / 1e3).toFixed(0)}k`;
	if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
	return `${Math.round(v)}`;
}

export function count(value: number | null | undefined): string {
	return Math.round(value ?? 0).toLocaleString("en-US");
}

export function share(part: number, whole: number): string {
	if (!whole) return "0%";
	const ratio = part / whole;
	return `${(ratio * 100).toFixed(ratio < 0.1 && ratio > 0 ? 1 : 0)}%`;
}

/** Signed change from `previous` to `current` ("+12%"), or null when there is nothing to compare. */
export function delta(current: number, previous: number | null | undefined): string | null {
	if (!previous) return null;
	const change = (current - previous) / previous;
	if (Math.abs(change) < 0.005) return "±0%";
	return `${change > 0 ? "+" : "−"}${Math.abs(change * 100).toFixed(0)}%`;
}

export function duration(ms: number): string {
	const minutes = ms / 60_000;
	if (minutes < 1) return "<1 min";
	if (minutes < 90) return `${Math.round(minutes)} min`;
	if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)} h`;
	return `${(minutes / 1440).toFixed(1)} d`;
}

export function milliseconds(ms: number | null): string {
	if (ms === null) return "—";
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

export function time(ms: number, withDate = false): string {
	const date = new Date(ms);
	return withDate
		? date.toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
		: date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Axis label for a time bucket (local time, `2026-11-12` or `2026-11-12T14:00:00`); hours name the day at midnight. */
export function bucketLabel(bucket: string, unit: "hour" | "day", long = false): string {
	const date = new Date(bucket.length === 10 ? `${bucket}T00:00:00` : bucket);
	if (unit === "day") return date.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
	const hour = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
	return long || date.getHours() === 0 ? `${date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" })} ${hour}` : hour;
}

export function toolName(name: string): string {
	return name.replace(/^mcp__t3-code__/, "t3 · ").replace(/^mcp__([^_]+)__/, "$1 · ");
}

export function categoryLabel(category: string): string {
	const tool = category.match(/^tool (result|call|definition): (.+)$/);
	return tool ? `tool ${tool[1]}: ${toolName(tool[2]!)}` : category;
}

/** A project directory by its last two segments (the full path goes in a title). */
export function projectName(cwd: string): string {
	const parts = cwd.replace(/\/+$/, "").split("/").filter(Boolean);
	return parts.length > 1 ? parts.slice(-2).join("/") : cwd || "—";
}

export const SOURCE_LABELS: Record<string, string> = { pi: "Pi", agy: "Antigravity", "claude-code": "Claude Code", all: "All" };
