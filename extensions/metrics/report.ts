// Plain-text report over the metrics store: totals, where the cost goes, cache rebuilds, tools
// and harness versions. Shared by `/harness stats` and the CLI.

import { basename } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { contextReport, subagentReport } from "./efficiency.ts";
import { count, money, percent, percentile, type Row, table } from "./format.ts";

export interface Scope {
	/** Only sessions started in this directory; all sessions when undefined. */
	cwd?: string;
	/** Only sessions started at or after this time (ms). */
	since?: number;
}


/** Group a cost category for the overview: one row per tool's definitions and calls. */
export function categoryGroup(category: string): string {
	if (category.startsWith("tool definition: ")) return "tool definitions";
	if (category.startsWith("tool call: ")) return "tool calls";
	return category;
}

export function report(db: DatabaseSync, scope: Scope = {}): string {
	const where: string[] = [];
	const params: SQLInputValue[] = [];
	if (scope.cwd !== undefined) {
		where.push("s.cwd = ?");
		params.push(scope.cwd);
	}
	if (scope.since !== undefined) {
		where.push("s.started_at >= ?");
		params.push(scope.since);
	}
	const sessionFilter = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const all = (sql: string) => db.prepare(sql).all(...params) as Row[];
	const scoped = `SELECT id FROM sessions s ${sessionFilter}`;

	const totals = all(
		`SELECT COUNT(*) sessions, COALESCE(SUM(cost), 0) cost, COALESCE(SUM(aborted), 0) aborted, COALESCE(SUM(errors), 0) errors,
		COALESCE(SUM(compactions), 0) compactions FROM sessions s ${sessionFilter}`,
	)[0]!;
	const sessions = Number(totals.sessions);
	if (sessions === 0) return "No Pi sessions recorded for this scope yet.";
	const turns = all(
		`SELECT COUNT(*) turns, COALESCE(SUM(cost), 0) cost, COALESCE(SUM(cache_read), 0) read, COALESCE(SUM(prompt_tokens), 0) prompt
		FROM requests WHERE kind = 'turn' AND session_id IN (${scoped})`,
	)[0]!;
	const side = all(`SELECT kind, COUNT(*) n, SUM(cost) cost FROM requests WHERE kind != 'turn' AND session_id IN (${scoped}) GROUP BY kind`);
	const users = all(`SELECT kind, COUNT(*) n FROM user_messages WHERE session_id IN (${scoped}) GROUP BY kind`);
	const cost = Number(totals.cost);
	const turnCount = Number(turns.turns);

	const out: string[] = [];
	out.push(
		[
			`${sessions} sessions, ${turnCount} model requests, ${money(cost)} (${money(cost / sessions)} per session, ${money(Number(turns.cost) / Math.max(1, turnCount))} per request)`,
			`cache: ${percent(Number(turns.read) / Math.max(1, Number(turns.prompt)))} of prompt tokens read from cache`,
			`runs: ${totals.aborted} interrupted, ${totals.errors} failed, ${totals.compactions} compactions`,
			`user messages: ${users.map((u) => `${u.n} ${u.kind}`).join(", ") || "none"}`,
			...(side.length ? [`side calls: ${side.map((s) => `${s.n} ${s.kind} ${money(Number(s.cost))}`).join(", ")}`] : []),
		].join("\n"),
	);

	const categories = new Map<string, { tokens: number; read: number; write: number; uncached: number }>();
	for (const row of all(
		`SELECT category, SUM(tokens) tokens, SUM(read_cost) read, SUM(write_cost) write, SUM(uncached_cost) uncached
		FROM request_costs WHERE session_id IN (${scoped}) GROUP BY category`,
	)) {
		const group = categoryGroup(String(row.category));
		const entry = categories.get(group) ?? { tokens: 0, read: 0, write: 0, uncached: 0 };
		entry.tokens += Number(row.tokens);
		entry.read += Number(row.read);
		entry.write += Number(row.write);
		entry.uncached += Number(row.uncached);
		categories.set(group, entry);
	}
	const byCost = [...categories].map(([name, c]) => ({ name, ...c, total: c.read + c.write + c.uncached })).sort((a, b) => b.total - a.total);
	const turnCost = byCost.reduce((sum, c) => sum + c.total, 0) || 1;
	out.push(
		`Where the cost goes\n${table(
			["content", "share", "cost", "tokens", "cache read", "cache write", "uncached"],
			byCost.slice(0, 14).map((c) => [c.name, percent(c.total / turnCost), money(c.total), count(c.tokens), money(c.read), money(c.write), money(c.uncached)]),
		)}`,
	);

	const rebuilds = all(
		`SELECT cache_event cause, COUNT(*) n, SUM(cache_lost) lost, SUM(cache_waste) waste FROM requests
		WHERE cache_event IS NOT NULL AND session_id IN (${scoped}) GROUP BY cache_event ORDER BY waste DESC`,
	);
	if (rebuilds.length) {
		out.push(
			`Cache rebuilds\n${table(
				["cause", "times", "tokens lost", "extra cost"],
				rebuilds.map((r) => [String(r.cause), String(r.n), count(Number(r.lost)), money(Number(r.waste))]),
			)}`,
		);
	}

	const pauses = all(
		`SELECT outcome, COUNT(*) n, AVG(minutes) minutes, SUM(warms) warms, SUM(warm_cost) warm_cost,
		AVG(prompt_tokens) tokens, SUM(resume_write_cost) write_cost FROM idle_pauses
		WHERE session_id IN (${scoped}) GROUP BY outcome ORDER BY n DESC`,
	);
	if (pauses.length) {
		const label: Record<string, string> = {
			warm: "resumed, cache warm",
			compacted: "resumed, compacted (cold)",
			cold: "resumed, cache rebuilt",
			open: "not resumed yet",
		};
		out.push(
			`Pauses over 5 min (warming keeps the cache; a cold cache is compacted or rebuilt)\n${table(
				["outcome", "pauses", "avg length", "warm refreshes", "warming cost", "avg prompt", "cache write on resume"],
				pauses.map((p) => [
					label[String(p.outcome)] ?? String(p.outcome),
					String(p.n),
					`${Math.round(Number(p.minutes))}m`,
					String(p.warms),
					money(Number(p.warm_cost)),
					count(Number(p.tokens)),
					money(Number(p.write_cost)),
				]),
			)}`,
		);
	}

	const compactions = all(
		`SELECT COALESCE(reason, 'extension') reason, COUNT(*) n, AVG(tokens_before) tokens, SUM(cost) cost FROM compactions
		WHERE session_id IN (${scoped}) GROUP BY 1 ORDER BY n DESC`,
	);
	if (compactions.length) {
		out.push(
			`Compactions\n${table(
				["reason", "times", "avg tokens before", "cost"],
				compactions.map((c) => [String(c.reason), String(c.n), count(Number(c.tokens)), money(Number(c.cost))]),
			)}`,
		);
	}

	const tools = new Map<string, { durations: number[]; calls: number; errors: number; tokens: number; turns: number; cost: number }>();
	for (const row of all(`SELECT tool, is_error, duration_ms, tokens, requests_in_context, lifetime_cost FROM tool_results WHERE session_id IN (${scoped})`)) {
		const entry = tools.get(String(row.tool)) ?? { durations: [], calls: 0, errors: 0, tokens: 0, turns: 0, cost: 0 };
		entry.calls += 1;
		entry.errors += Number(row.is_error);
		entry.tokens += Number(row.tokens);
		entry.turns += Number(row.requests_in_context);
		entry.cost += Number(row.lifetime_cost);
		if (row.duration_ms !== null) entry.durations.push(Number(row.duration_ms));
		tools.set(String(row.tool), entry);
	}
	if (tools.size) {
		const rows = [...tools].sort((a, b) => b[1].cost - a[1].cost);
		out.push(
			`Tools (cost: what their results cost in every request that carried them)\n${table(
				["tool", "calls", "errors", "p50", "p95", "result tokens", "requests kept", "cost"],
				rows.slice(0, 15).map(([name, t]) => {
					const sorted = t.durations.sort((a, b) => a - b);
					const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
					return [name, String(t.calls), percent(t.errors / t.calls), ms(percentile(sorted, 0.5)), ms(percentile(sorted, 0.95)), count(t.tokens / t.calls), (t.turns / t.calls).toFixed(1), money(t.cost)];
				}),
			)}`,
		);
	}

	const versions = all(
		`SELECT r.version, MIN(s.cwd) cwd, MIN(r.ts) first, COUNT(DISTINCT r.session_id) sessions, COUNT(*) turns, SUM(r.cost) cost,
		SUM(r.cache_read) read, SUM(r.prompt_tokens) prompt, SUM(r.stop_reason = 'aborted') aborted
		FROM requests r JOIN sessions s ON s.id = r.session_id
		WHERE r.kind = 'turn' AND r.session_id IN (${scoped}) GROUP BY r.version ORDER BY cwd, first`,
	);
	const toolErrors = new Map(
		all(`SELECT version, AVG(is_error) rate FROM tool_results WHERE session_id IN (${scoped}) GROUP BY version`).map((r) => [r.version, Number(r.rate)]),
	);
	const sectionsOf = db.prepare("SELECT sections, tools FROM versions WHERE id = ?");
	// Project sections (cwd, project_context, skills) differ by project, so a version is compared
	// with the previous version of the same project.
	const previousOf = new Map<string, { sections: Record<string, string>; tools: Record<string, string> }>();
	const multipleProjects = new Set(versions.map((v) => v.cwd)).size > 1;
	const versionRows = versions.map((v) => {
		const row = sectionsOf.get(String(v.version)) as { sections: string; tools: string };
		const state = { sections: JSON.parse(row.sections) as Record<string, string>, tools: JSON.parse(row.tools) as Record<string, string> };
		const previous = previousOf.get(String(v.cwd));
		const changed = previous ? diffState(previous, state) : "first";
		previousOf.set(String(v.cwd), state);
		return [
			String(v.version).slice(0, 8),
			...(multipleProjects ? [basename(String(v.cwd))] : []),
			new Date(Number(v.first)).toISOString().slice(0, 16).replace("T", " "),
			String(v.sessions),
			String(v.turns),
			money(Number(v.cost) / Number(v.turns)),
			percent(Number(v.read) / Math.max(1, Number(v.prompt))),
			percent(toolErrors.get(v.version) ?? 0),
			String(v.aborted),
			changed.length > 70 ? `${changed.slice(0, 69)}…` : changed,
		];
	});
	out.push(`Harness versions (prompt sections and initial tools)\n${table(["version", ...(multipleProjects ? ["project"] : []), "first seen", "sessions", "requests", "per request", "cache", "tool errors", "interrupted", "changed"], versionRows)}`);

	for (const section of [subagentReport(db, all, scoped), contextReport(db, all, scoped)]) if (section) out.push(section);

	return out.join("\n\n");
}

/** Which sections and tools differ between two harness versions. */
export function diffState(
	before: { sections: Record<string, string>; tools: Record<string, string> },
	after: { sections: Record<string, string>; tools: Record<string, string> },
): string {
	const diff = (a: Record<string, string>, b: Record<string, string>, label: string) => {
		const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((n) => a[n] !== b[n]).sort();
		if (names.length === 0) return [];
		return [names.length > 4 ? `${names.length} ${label}` : names.map((n) => (a[n] === undefined ? `+${n}` : b[n] === undefined ? `-${n}` : n)).join(" ")];
	};
	return [...diff(before.sections, after.sections, "sections"), ...diff(before.tools, after.tools, "tools")].join("; ") || "same";
}
