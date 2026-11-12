// Formatting shared by the report sections.

export type Row = Record<string, unknown>;

export const money = (value: number): string =>
	value < 0 ? `-${money(-value)}` : value >= 100 ? `$${value.toFixed(0)}` : value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`;
export const percent = (value: number) => `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`;
export const count = (value: number) =>
	value >= 10_000 ? `${(value / 1000).toFixed(0)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${Math.round(value)}`;
export const minutes = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${Math.round(ms / 60_000)}m`);

export function table(headers: string[], rows: string[][]): string {
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
	// Numbers align right, text left.
	const numeric = headers.map((_, i) => rows.length > 0 && rows.every((r) => /^-?[$\d][\d.,]*(%|k|ms|s|m|h)?$/.test(r[i]!)));
	const line = (cells: string[]) => cells.map((c, i) => (numeric[i] ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join("  ").trimEnd();
	return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}
