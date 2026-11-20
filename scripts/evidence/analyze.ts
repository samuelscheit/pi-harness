// Measures, on the user's own sessions in the metrics index, how much each candidate harness
// feature from docs/research/context-engineering would change cost or quality. Prints Markdown.
//
// Inputs: ~/.pi/agent/metrics.db (Pi sessions and imported Claude Code transcripts) and the
// message labels from classify-messages.ts. Every figure is reproducible from these two files.
//
// Usage: node scripts/evidence/analyze.ts

import { existsSync, readFileSync } from "node:fs";
import { NEGATIVE } from "../../extensions/metrics/labels.ts";
import { LABELS_FILE, type Labels, openIndex } from "./shared.ts";

type Request = { ts: number; prompt: number; read: number; write: number; input: number; cost: number };
type Tool = { ts: number; tool: string; summary: string; tokens: number; carried: number; carryCost: number; error: number; referenced: number | null; mutates: number };
type Message = { ts: number; kind: string; label?: string; ordinal: number };
type FileUse = { ts: number; file: string };
type Session = { id: string; source: string; requests: Request[]; tools: Tool[]; compactions: number[]; messages: Message[]; files: FileUse[] };

// Anthropic prices output at 5x the input rate; used for simulated summary calls.
const OUTPUT_PER_INPUT = 5;
const BUCKETS = [50_000, 100_000, 200_000, 400_000, Infinity];
const bucketName = (i: number) => (i === 0 ? "<50k" : BUCKETS[i] === Infinity ? `≥${BUCKETS[i - 1] / 1000}k` : `${BUCKETS[i - 1] / 1000}–${BUCKETS[i] / 1000}k`);
const bucketOf = (tokens: number) => BUCKETS.findIndex((limit) => tokens < limit);
const usd = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;
const pct = (part: number, whole: number) => (whole === 0 ? "–" : `${((100 * part) / whole).toFixed(1)}%`);

/** 95% Wilson interval of a proportion, as "a–b%". */
function wilson(k: number, n: number): string {
	if (n === 0) return "–";
	const z = 1.96;
	const p = k / n;
	const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
	const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
	return `${(100 * Math.max(0, centre - half)).toFixed(1)}–${(100 * Math.min(1, centre + half)).toFixed(1)}%`;
}

function table(header: string[], rows: (string | number)[][]): string {
	return [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

function load(): Session[] {
	const db = openIndex();
	const labels: Labels = existsSync(LABELS_FILE) ? JSON.parse(readFileSync(LABELS_FILE, "utf8")) : {};
	const sessions = new Map<string, Session>();
	for (const s of db.prepare("SELECT id, source FROM sessions").all() as { id: string; source: string }[])
		sessions.set(s.id, { id: s.id, source: s.source, requests: [], tools: [], compactions: [], messages: [], files: [] });
	for (const r of db
		.prepare("SELECT session_id s, ts, prompt_tokens prompt, read_rate read, write_rate write, input_rate input, cost FROM requests WHERE kind = 'turn' AND read_rate > 0 ORDER BY ts")
		.iterate() as Iterable<Request & { s: string }>)
		sessions.get(r.s)?.requests.push(r);
	for (const t of db
		.prepare(
			"SELECT session_id s, ts, tool, summary, tokens, requests_in_context carried, lifetime_cost carryCost, is_error error, referenced_later referenced, mutates FROM tool_results ORDER BY ts",
		)
		.iterate() as Iterable<Tool & { s: string }>)
		sessions.get(t.s)?.tools.push(t);
	for (const c of db.prepare("SELECT session_id s, ts FROM compactions ORDER BY ts").iterate() as Iterable<{ s: string; ts: number }>) sessions.get(c.s)?.compactions.push(c.ts);
	for (const f of db.prepare("SELECT session_id s, ts, file FROM tool_files ORDER BY ts").iterate() as Iterable<FileUse & { s: string }>) sessions.get(f.s)?.files.push(f);
	const ordinals = new Map<string, number>();
	for (const m of db.prepare("SELECT session_id s, entry_id e, ts, kind FROM user_messages ORDER BY ts").iterate() as Iterable<{ s: string; e: string; ts: number; kind: string }>) {
		const ordinal = (ordinals.get(m.s) ?? 0) + 1;
		ordinals.set(m.s, ordinal);
		sessions.get(m.s)?.messages.push({ ts: m.ts, kind: m.kind, label: labels[`${m.s} ${m.e}`]?.label, ordinal });
	}
	return [...sessions.values()].filter((s) => s.requests.length > 0);
}

/** The prompt size of the last request at or before `ts` (0 before the first). */
function contextAt(requests: Request[], ts: number): number {
	let lo = 0;
	let hi = requests.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (requests[mid].ts <= ts) {
			found = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return found < 0 ? 0 : requests[found].prompt;
}

const isNegative = (label: string | undefined) => label !== undefined && (NEGATIVE as readonly string[]).includes(label);

function spendByContext(sessions: Session[]): string {
	const rows = BUCKETS.map(() => ({ requests: 0, cost: 0 }));
	let total = 0;
	for (const s of sessions)
		for (const r of s.requests) {
			const row = rows[bucketOf(r.prompt)];
			row.requests++;
			row.cost += r.cost;
			total += r.cost;
		}
	return table(
		["context at request", "requests", "spend", "share of spend"],
		rows.map((row, i) => [bucketName(i), row.requests.toLocaleString("en-US"), usd(row.cost), pct(row.cost, total)]),
	);
}

function qualityByContext(sessions: Session[]): string {
	const rows = BUCKETS.map(() => ({ n: 0, negative: 0, forgot: 0, failure: 0, tools: 0, errors: 0 }));
	// The same split by message position, to separate "long context" from "late in a session".
	const positions = [3, 10, Infinity];
	const byPosition = positions.map(() => BUCKETS.map(() => ({ n: 0, negative: 0 })));
	// Within-session comparison: sessions with labelled messages both below 100k and at 400k or more.
	let paired = 0;
	let higher = 0;
	let lower = 0;
	let lowSum = 0;
	let highSum = 0;
	for (const s of sessions) {
		const low = { n: 0, negative: 0 };
		const high = { n: 0, negative: 0 };
		for (const m of s.messages) {
			if (!m.label) continue;
			const context = contextAt(s.requests, m.ts);
			const b = bucketOf(context);
			const negative = isNegative(m.label) ? 1 : 0;
			rows[b].n++;
			rows[b].negative += negative;
			rows[b].forgot += m.label === "forgot_context" ? 1 : 0;
			rows[b].failure += m.label === "failure_report" ? 1 : 0;
			const cell = byPosition[positions.findIndex((limit) => m.ordinal <= limit)][b];
			cell.n++;
			cell.negative += negative;
			const side = context < 100_000 ? low : context >= 400_000 ? high : undefined;
			if (side) {
				side.n++;
				side.negative += negative;
			}
		}
		for (const t of s.tools) {
			const row = rows[bucketOf(contextAt(s.requests, t.ts))];
			row.tools++;
			row.errors += t.error;
		}
		if (low.n > 0 && high.n > 0) {
			paired++;
			const lowRate = low.negative / low.n;
			const highRate = high.negative / high.n;
			lowSum += lowRate;
			highSum += highRate;
			if (highRate > lowRate) higher++;
			else if (highRate < lowRate) lower++;
		}
	}
	const main = table(
		["context when the user replied", "labelled messages", "negative (95% CI)", "forgot_context", "failure_report", "tool calls", "tool error rate"],
		rows.map((row, i) => [
			bucketName(i),
			row.n,
			`${pct(row.negative, row.n)} (${wilson(row.negative, row.n)})`,
			pct(row.forgot, row.n),
			pct(row.failure, row.n),
			row.tools.toLocaleString("en-US"),
			pct(row.errors, row.tools),
		]),
	);
	const stratified = table(
		["message position", ...BUCKETS.map((_, i) => bucketName(i))],
		byPosition.map((cells, p) => [p === 0 ? "1st–3rd" : p === 1 ? "4th–10th" : "11th+", ...cells.map((c) => (c.n < 20 ? `(n=${c.n})` : `${pct(c.negative, c.n)} (n=${c.n})`))]),
	);
	// Two-sided sign test on sessions where the rate differs.
	const sign = signTest(higher, lower);
	return `${main}\n\nNegative rate by message position (rows) and context size (columns):\n\n${stratified}\n\nWithin-session: ${paired} sessions have labelled messages both below 100k and at 400k or more. Mean negative rate below 100k: ${pct(lowSum, paired)}; at 400k+: ${pct(highSum, paired)}. Higher at 400k+ in ${higher} sessions, lower in ${lower} (sign test p = ${sign.toFixed(3)}).`;
}

/** Two-sided exact binomial sign test. */
function signTest(a: number, b: number): number {
	const n = a + b;
	const k = Math.min(a, b);
	let tail = 0;
	let coefficient = 1;
	for (let i = 0; i <= k; i++) {
		if (i > 0) coefficient = (coefficient * (n - i + 1)) / i;
		tail += coefficient * 0.5 ** n;
	}
	return Math.min(1, 2 * tail);
}

type MaskPolicy = { keep: number; batch: number };

/**
 * Simulates masking old tool results: before each request, results older than the newest `keep`
 * tool-result tokens are replaced by a placeholder once at least `batch` such tokens are pending.
 * Savings: masked tokens no longer read from cache on later requests. Costs: each masking rewrites
 * the cache from the earliest masked result (bounded above by the whole prompt), and, pessimistically,
 * every masked result the agent touched again is re-read once at the cache-write rate.
 */
function simulateMasking(sessions: Session[], policy: MaskPolicy) {
	const PLACEHOLDER = 30;
	let saved = 0;
	let rewrite = 0;
	let reread = 0;
	let events = 0;
	for (const s of sessions) {
		let live: { tool: Tool; masked: boolean }[] = [];
		let ti = 0;
		let ci = 0;
		for (const r of s.requests) {
			while (ci < s.compactions.length && s.compactions[ci] <= r.ts) {
				live = [];
				ci++;
			}
			while (ti < s.tools.length && s.tools[ti].ts <= r.ts) live.push({ tool: s.tools[ti++], masked: false });
			let newest = 0;
			let pending = 0;
			for (let i = live.length - 1; i >= 0; i--) {
				if (newest < policy.keep) newest += live[i].tool.tokens;
				else if (!live[i].masked) pending += live[i].tool.tokens;
			}
			if (pending >= policy.batch) {
				events++;
				rewrite += r.prompt * (r.write - r.read);
				let newestAgain = 0;
				for (let i = live.length - 1; i >= 0; i--) {
					if (newestAgain < policy.keep) newestAgain += live[i].tool.tokens;
					else if (!live[i].masked) {
						live[i].masked = true;
						if (live[i].tool.referenced === 1) reread += live[i].tool.tokens * r.write;
					}
				}
			}
			for (const entry of live) if (entry.masked) saved += Math.max(0, entry.tool.tokens - PLACEHOLDER) * r.read;
		}
	}
	return { saved, rewrite, reread, events };
}

/**
 * Simulates compacting whenever the context exceeds `cap`, down to `after` tokens. The simulated
 * context follows the observed growth from that point; a real compaction in the data that went
 * lower resets the simulation. Each simulated compaction costs a summary request over the cached
 * context, an 8k-token summary, and writing the new prefix.
 */
function simulateCap(sessions: Session[], cap: number, after = 40_000) {
	let saved = 0;
	let cost = 0;
	let compactions = 0;
	let requestsAbove = 0;
	for (const s of sessions) {
		let shift = 0;
		for (const r of s.requests) {
			if (r.prompt - shift < after) shift = Math.max(0, r.prompt - after);
			if (r.prompt >= cap) requestsAbove++;
			if (r.prompt - shift > cap) {
				compactions++;
				cost += (r.prompt - shift) * r.read + 8_000 * r.input * OUTPUT_PER_INPUT + after * r.write;
				shift = r.prompt - after;
			}
			saved += shift * r.read;
		}
	}
	return { saved, cost, compactions, requestsAbove };
}

function largeOutputs(sessions: Session[], totalCarry: number): string {
	const PREVIEW = 1_000;
	return table(
		["spill outputs above", "results", "their carry cost", "saved if spilled (1k preview)", "re-read penalty (pessimistic)", "net"],
		[5_000, 10_000, 20_000].map((threshold) => {
			let n = 0;
			let carry = 0;
			let saved = 0;
			let penalty = 0;
			for (const s of sessions)
				for (const t of s.tools) {
					if (t.tokens <= threshold) continue;
					const rate = t.carried > 0 ? t.carryCost / (t.carried * t.tokens) : 0;
					n++;
					carry += t.carryCost;
					saved += t.carryCost * ((t.tokens - PREVIEW) / t.tokens);
					// A spilled output the agent needed again: it reads a 5k-token slice, written to cache at
					// 12.5x the read rate (Anthropic 5-minute writes), then carries it as long as the original.
					if (t.referenced === 1) penalty += 5_000 * rate * (12.5 + t.carried);
				}
			return [`${threshold / 1000}k tokens`, n, `${usd(carry)} (${pct(carry, totalCarry)} of all carry)`, usd(saved), usd(penalty), usd(saved - penalty)];
		}),
	);
}

const CHECK = /\b(test|tests|vitest|jest|pytest|tsc|typecheck|type-check|lint|eslint|biome|check|build|cargo|go vet|lake|lean|playwright|ruff|mypy)\b/i;

function verifyGap(sessions: Session[]): string {
	const groups = { none: { n: 0, negative: 0, failure: 0 }, verified: { n: 0, negative: 0, failure: 0 }, unverified: { n: 0, negative: 0, failure: 0 } };
	let turnsWithEdits = 0;
	let unverifiedTurns = 0;
	for (const s of sessions) {
		let ti = 0;
		let previous = -Infinity;
		for (const m of s.messages) {
			const turn: Tool[] = [];
			while (ti < s.tools.length && s.tools[ti].ts < m.ts) {
				if (s.tools[ti].ts > previous) turn.push(s.tools[ti]);
				ti++;
			}
			previous = m.ts;
			const lastMutation = turn.findLastIndex((t) => t.mutates === 1 && !CHECK.test(t.summary));
			const group = lastMutation < 0 ? "none" : turn.slice(lastMutation + 1).some((t) => CHECK.test(t.summary) && !t.mutates) ? "verified" : "unverified";
			if (lastMutation >= 0) {
				turnsWithEdits++;
				if (group === "unverified") unverifiedTurns++;
			}
			if (!m.label) continue;
			groups[group].n++;
			groups[group].negative += isNegative(m.label) ? 1 : 0;
			groups[group].failure += m.label === "failure_report" ? 1 : 0;
		}
	}
	const name = { none: "turn changed no files", verified: "changed files, ran a check after the last change", unverified: "changed files, no check after the last change" };
	return `${table(
		["agent turn before the user's reply", "labelled replies", "negative (95% CI)", "failure_report (95% CI)"],
		(Object.keys(groups) as (keyof typeof groups)[]).map((g) => [
			name[g],
			groups[g].n,
			`${pct(groups[g].negative, groups[g].n)} (${wilson(groups[g].negative, groups[g].n)})`,
			`${pct(groups[g].failure, groups[g].n)} (${wilson(groups[g].failure, groups[g].n)})`,
		]),
	)}\n\n${unverifiedTurns} of ${turnsWithEdits} turns that changed files (${pct(unverifiedTurns, turnsWithEdits)}) ended without a check after the last change.`;
}

/**
 * What a real compaction did: the negative rate of the user's next 3 labelled replies against the 3
 * before it, and how often the next WINDOW file accesses return to a file touched before the
 * compaction, against the WINDOW accesses that led up to it (returning to files before them).
 */
function compactionAftermath(sessions: Session[]): string {
	const WINDOW = 30;
	const before = { n: 0, negative: 0 };
	const after = { n: 0, negative: 0 };
	const reread = { before: 0, after: 0, n: 0 };
	let count = 0;
	for (const s of sessions)
		for (const c of s.compactions) {
			count++;
			const labelled = s.messages.filter((m) => m.label);
			for (const m of labelled.filter((m) => m.ts < c).slice(-3)) {
				before.n++;
				before.negative += isNegative(m.label) ? 1 : 0;
			}
			for (const m of labelled.filter((m) => m.ts > c).slice(0, 3)) {
				after.n++;
				after.negative += isNegative(m.label) ? 1 : 0;
			}
			const split = s.files.findIndex((f) => f.ts > c);
			if (split < 2 * WINDOW || s.files.length - split < WINDOW) continue;
			const seen = (end: number) => new Set(s.files.slice(0, end).map((f) => f.file));
			const returning = (from: number, known: Set<string>) => s.files.slice(from, from + WINDOW).filter((f) => known.has(f.file)).length / WINDOW;
			reread.n++;
			reread.before += returning(split - WINDOW, seen(split - WINDOW));
			reread.after += returning(split, seen(split));
		}
	return `${count} compactions. User replies: negative ${pct(before.negative, before.n)} (${wilson(before.negative, before.n)}, n=${before.n}) in the 3 before, ${pct(after.negative, after.n)} (${wilson(after.negative, after.n)}, n=${after.n}) in the 3 after. File accesses returning to an already-touched file (${reread.n} compactions with enough activity): ${pct(reread.before, reread.n)} of the ${WINDOW} before, ${pct(reread.after, reread.n)} of the ${WINDOW} after.`;
}

const READ_ONLY = /^(Read|Grep|Glob|LS|WebFetch|WebSearch|web_fetch|web_search|read|mcp__firecrawl|mcp__t3-code__t3_thread_read|mcp__t3-code__task_status|ToolSearch|symbol_search|module_report|read_symbol)/;

function exploration(sessions: Session[], totalCarry: number): string {
	let readOnly = 0;
	let unreferenced = 0;
	let bashRead = 0;
	let agentSessions = 0;
	for (const s of sessions) {
		if (s.id.includes("/")) agentSessions++;
		for (const t of s.tools) {
			if (t.mutates) continue;
			if (READ_ONLY.test(t.tool)) readOnly += t.carryCost;
			else if (/^bash$/i.test(t.tool)) bashRead += t.carryCost;
			if (t.referenced === 0) unreferenced += t.carryCost;
		}
	}
	return `Carry cost of results that changed nothing: read-only tools ${usd(readOnly)} (${pct(readOnly, totalCarry)} of all tool-result carry), non-writing shell commands ${usd(bashRead)} (${pct(bashRead, totalCarry)}). Results never touched again: ${usd(unreferenced)}. Subagent transcripts in the data: ${agentSessions}.`;
}

function fixedCosts(): string {
	const db = openIndex();
	const total = (db.prepare("SELECT sum(r.cost) c FROM requests r JOIN sessions s ON s.id = r.session_id WHERE s.source = 'pi'").get() as { c: number }).c;
	const rows = db
		.prepare(
			`SELECT CASE WHEN category LIKE 'tool definition:%' THEN 'tool definitions' WHEN category LIKE 'system:%' THEN category WHEN category LIKE 'tool result:%' THEN 'tool results' ELSE category END name,
			sum(read_cost + write_cost + uncached_cost) cost FROM request_costs GROUP BY name ORDER BY cost DESC`,
		)
		.all() as { name: string; cost: number }[];
	const waste = db.prepare("SELECT cache_event e, count(*) n, sum(cache_waste) w FROM requests WHERE cache_event IS NOT NULL GROUP BY e ORDER BY w DESC").all() as { e: string; n: number; w: number }[];
	return `${table(
		["context part (Pi sessions)", "cost", "share"],
		rows.slice(0, 12).map((r) => [r.name, usd(r.cost), pct(r.cost, total)]),
	)}\n\n${table(
		["cache event (Pi sessions)", "requests", "wasted"],
		waste.map((w) => [w.e, w.n, `$${w.w.toFixed(2)}`]),
	)}`;
}

function main(): void {
	const sessions = load();
	const claude = sessions.filter((s) => s.source === "claude-code");
	const total = sessions.reduce((sum, s) => sum + s.requests.reduce((a, r) => a + r.cost, 0), 0);
	const totalCarry = sessions.reduce((sum, s) => sum + s.tools.reduce((a, t) => a + t.carryCost, 0), 0);
	const out: string[] = [];
	out.push(`# Context evidence\n\n${sessions.length} sessions (${claude.length} Claude Code), ${sessions.reduce((a, s) => a + s.requests.length, 0).toLocaleString("en-US")} requests, ${usd(total)} spend; tool results carried in context cost ${usd(totalCarry)}.`);
	out.push(`## Spend by context size\n\n${spendByContext(sessions)}`);
	out.push(`## Quality by context size\n\n${qualityByContext(sessions)}`);
	out.push(
		`## Masking old tool results\n\n${table(
			["keep newest", "batch", "maskings", "carry saved", "cache rewrites", "re-read penalty (pessimistic)", "net", "net share of spend"],
			[
				{ keep: 20_000, batch: 20_000 },
				{ keep: 50_000, batch: 30_000 },
				{ keep: 100_000, batch: 50_000 },
			].map((p) => {
				const r = simulateMasking(sessions, p);
				const net = r.saved - r.rewrite - r.reread;
				return [`${p.keep / 1000}k`, `${p.batch / 1000}k`, r.events, usd(r.saved), usd(r.rewrite), usd(r.reread), usd(net), pct(net, total)];
			}),
		)}`,
	);
	out.push(
		`## Compaction cap\n\n${table(
			["compact above", "context after", "simulated compactions", "requests above cap today", "read cost saved", "compaction cost", "net", "net share of spend"],
			[150_000, 200_000, 300_000, 400_000].flatMap((cap) => [40_000, 80_000, 120_000].map((after) => ({ cap, after }))).map(({ cap, after }) => {
				const r = simulateCap(sessions, cap, after);
				return [`${cap / 1000}k`, `${after / 1000}k`, r.compactions, r.requestsAbove.toLocaleString("en-US"), usd(r.saved), usd(r.cost), usd(r.saved - r.cost), pct(r.saved - r.cost, total)];
			}),
		)}`,
	);
	out.push(`## What real compactions did\n\n${compactionAftermath(sessions)}`);
	out.push(`## Spilling large tool outputs\n\n${largeOutputs(sessions, totalCarry)}`);
	out.push(`## Verification before ending a turn\n\n${verifyGap(sessions)}`);
	out.push(`## Exploration in the main context\n\n${exploration(sessions, totalCarry)}`);
	out.push(`## Fixed context costs\n\n${fixedCosts()}`);
	console.log(out.join("\n\n"));
}

main();
