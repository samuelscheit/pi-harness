// Plain-text report over the metrics store, for `/harness stats` and the CLI. It renders the
// query layer (queries/), the same results the dashboard shows.

import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { count, duration, minutes, money, percent, table } from "./format.ts";
import {
	categoryGroup,
	changeSummary,
	compactionOpportunities,
	compactions,
	contentCosts,
	contextSizes,
	droppedThinking,
	type Filters,
	KEEP_TOKENS,
	PAUSE_OUTCOMES,
	pauses,
	rebuilds,
	Scope,
	sideCalls,
	subagents,
	tools,
	totals,
	userMessages,
	versions,
} from "./queries/index.ts";

const MAX_ROWS = 12;
const cut = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

export function report(db: DatabaseSync, filters: Filters = {}): string {
	const scope = new Scope(db, filters);
	const t = totals(scope);
	if (t.sessions === 0) return "No sessions recorded for this scope yet.";
	const side = sideCalls(scope);
	const users = userMessages(scope);
	const compactionRows = compactions(scope);
	const out: string[] = [
		[
			`${t.sessions} sessions, ${t.requests} model requests, ${money(t.cost)} (${money(t.cost / t.sessions)} per session, ${money((t.cost - t.sideCost) / Math.max(1, t.requests))} per request)`,
			`cache: ${percent(t.cacheReadTokens / Math.max(1, t.promptTokens))} of prompt tokens read from cache`,
			`runs: ${t.aborted} interrupted, ${t.errors} failed, ${compactionRows.reduce((s, c) => s + c.count, 0)} compactions`,
			`user messages: ${users.map((u) => `${u.count} ${u.kind}`).join(", ") || "none"}`,
			...(side.length ? [`side calls: ${side.map((s) => `${s.requests} ${s.kind} ${money(s.cost)}`).join(", ")}`] : []),
		].join("\n"),
	];

	const categories = new Map<string, { tokens: number; read: number; write: number; uncached: number }>();
	for (const c of contentCosts(scope)) {
		const group = categoryGroup(c.category);
		const entry = categories.get(group) ?? { tokens: 0, read: 0, write: 0, uncached: 0 };
		entry.tokens += c.tokens;
		entry.read += c.read;
		entry.write += c.write;
		entry.uncached += c.uncached;
		categories.set(group, entry);
	}
	const byCost = [...categories].map(([name, c]) => ({ name, ...c, total: c.read + c.write + c.uncached })).sort((a, b) => b.total - a.total);
	if (byCost.length) {
		const analyzed = byCost.reduce((sum, c) => sum + c.total, 0) || 1;
		out.push(
			`Where the cost goes\n${table(
				["content", "share", "cost", "tokens", "cache read", "cache write", "uncached"],
				byCost.slice(0, 14).map((c) => [c.name, percent(c.total / analyzed), money(c.total), count(c.tokens), money(c.read), money(c.write), money(c.uncached)]),
			)}`,
		);
	}

	const causes = rebuilds(scope);
	if (causes.length) {
		out.push(`Cache rebuilds\n${table(["cause", "times", "tokens lost", "extra cost"], causes.map((r) => [r.cause, String(r.requests), count(r.lostTokens), money(r.waste)]))}`);
	}
	const dropped = droppedThinking(scope);
	if (dropped.blocks) {
		out.push(
			`Thinking dropped by the API (an earlier message, prompt or tool changed under it; not billed, the model lost that reasoning): ${dropped.blocks} blocks in ${dropped.requests} requests of ${dropped.sessions} sessions`,
		);
	}

	const pauseRows = pauses(scope);
	if (pauseRows.length) {
		out.push(
			`Pauses over 5 min (warming keeps the cache; a cold cache is compacted or rebuilt)\n${table(
				["outcome", "pauses", "avg length", "warm refreshes", "warming cost", "avg prompt", "paid on resume"],
				pauseRows.map((p) => [
					PAUSE_OUTCOMES[p.outcome] ?? p.outcome,
					String(p.pauses),
					`${Math.round(p.avgMinutes)}m`,
					String(p.warms),
					money(p.warmCost),
					count(p.avgPromptTokens),
					money(p.resumeCost),
				]),
			)}`,
		);
	}

	if (compactionRows.length) {
		out.push(
			`Compactions\n${table(["reason", "times", "avg tokens before", "cost"], compactionRows.map((c) => [c.reason, String(c.count), count(c.avgTokensBefore), money(c.cost)]))}`,
		);
	}

	const toolRows = tools(scope);
	if (toolRows.length) {
		out.push(
			`Tools (cost: what their results cost in every request that carried them)\n${table(
				["tool", "calls", "errors", "p50", "p95", "result tokens", "requests kept", "cost"],
				toolRows
					.slice(0, 15)
					.map((x) => [
						x.tool,
						String(x.calls),
						percent(x.errors / x.calls),
						x.p50Ms === null ? "-" : duration(x.p50Ms),
						x.p95Ms === null ? "-" : duration(x.p95Ms),
						count(x.tokensPerResult),
						x.requestsKept.toFixed(1),
						money(x.carryCost),
					]),
			)}`,
		);
	}

	const versionRows = versions(scope);
	if (versionRows.length) {
		const multipleProjects = new Set(versionRows.map((v) => v.project)).size > 1;
		out.push(
			`Harness versions (prompt sections and initial tools)\n${table(
				["version", ...(multipleProjects ? ["project"] : []), "first seen", "sessions", "requests", "per request", "cache", "tool errors", "interrupted", "corrections", "changed"],
				versionRows.map((v) => [
					v.id.slice(0, 8),
					...(multipleProjects ? [basename(v.project)] : []),
					new Date(v.firstSeen).toISOString().slice(0, 16).replace("T", " "),
					String(v.sessions),
					String(v.requests),
					money(v.costPerRequest),
					percent(v.cacheShare),
					percent(v.toolErrors / Math.max(1, v.toolCalls)),
					String(v.interrupts),
					String(v.corrections),
					cut(v.previous ? changeSummary(v.changes) : "first", 70),
				]),
			)}`,
		);
	}

	const agents = subagents(scope);
	if (agents.rows.length) {
		const shown = agents.rows.length > MAX_ROWS ? [...agents.rows].sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference)).slice(0, MAX_ROWS) : agents.rows;
		out.push(
			[
				`Subagents: ${agents.started} started, ${money(agents.cost)}; ${agents.resumes} resumes by message. Rediscovery (results the parent or an earlier subagent already had): ${money(agents.rediscoveryCost)}.`,
				`Resuming an idle earlier subagent instead was possible ${agents.compared} times and cheaper ${agents.resumeWins} times; the cheaper choice each time: ${money(agents.bestCost)} (${percent(1 - agents.bestCost / Math.max(agents.cost, 1e-9))} less).`,
				`${agents.rows.length > MAX_ROWS ? `The ${MAX_ROWS} largest differences` : "Per subagent"} (rediscovered = calls / tokens / cost):`,
				table(
					["subagent", "requests", "cost", "wall", "startup", "rediscovered", "resume instead (context, idle)", "est. resume", "verdict"],
					shown.map((r) => [
						cut(r.title, 36),
						String(r.requests),
						money(r.cost),
						minutes(r.wallMs),
						money(r.startupCost),
						r.rediscovered.calls ? `${r.rediscovered.calls} / ${count(r.rediscovered.tokens)} / ${money(r.rediscovered.cost)}` : "none",
						r.alternative ? `${cut(r.alternative.title, 24)} (${count(r.alternative.contextTokens)}, idle ${minutes(r.alternative.idleMs)}, ${r.alternative.warm ? "warm" : "cold"})` : "none",
						r.alternative ? money(r.alternative.cost) : "",
						r.alternative ? (r.difference > 0 ? `resume saves ${money(r.difference)}` : `new saved ${money(-r.difference)}`) : "",
					]),
				),
			].join("\n"),
		);
	}

	const sizes = contextSizes(scope);
	if (sizes.requests > 0) {
		const lines = [`Context per request: median ${count(sizes.median)}, p90 ${count(sizes.p90)}, max ${count(sizes.max)} tokens`];
		const unused = toolRows.filter((x) => x.withFiles > 0).sort((a, b) => b.unreferencedCost - a.unreferencedCost);
		if (unused.length) {
			lines.push(
				`Tool results with files never referenced again (no later call on the same file, file never named again: an upper bound for unused context)\n${table(
					["tool", "results", "not referenced", "carried cost", "of which not referenced"],
					unused.slice(0, 8).map((u) => [u.tool, String(u.withFiles), percent(u.unreferenced / u.withFiles), money(u.carryCost), money(u.unreferencedCost)]),
				)}`,
			);
		}
		const opportunities = compactionOpportunities(scope);
		if (opportunities.sessions.length) {
			lines.push(
				`Best single compaction per session (knowing the later requests; keeps ${count(KEEP_TOKENS)} + summary, quality loss not priced): ${money(opportunities.total)} over ${opportunities.sessions.length} sessions\n${table(
					["session", "requests", "cost", "peak context", "compact after", "at context", "saving"],
					opportunities.sessions.slice(0, 8).map((s) => [cut(s.title, 36), String(s.requests), money(s.cost), count(s.peakTokens), `#${s.after}`, count(s.tokens), money(s.saving)]),
				)}`,
			);
		}
		out.push(lines.join("\n\n"));
	}
	return out.join("\n\n");
}
