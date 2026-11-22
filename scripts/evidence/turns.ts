// How many model turns our sessions take, what a turn costs, and which turns a harness could avoid.
//
// A turn is one model request of kind 'turn' (every step of the tool loop, not one user prompt). A
// package is everything from one user prompt to the next (the turn whose trigger is 'user prompt'
// starts it). Tool results are assigned to the turn that issued them: the index stamps a request
// when its response ends, so a result belongs to the latest turn at or before its own timestamp
// (the match rate against requests.tool_calls is printed).
//
// Each call gets a kind from its tool and, for bash, its command text (extensions/lib/call-kind.ts).
// A turn's kind is the most significant kind among its calls.
//
// Avoidable-turn patterns (upper bounds; the judged sample in turns-judge.ts narrows the first):
//   serial explore  an explore-only turn right after another explore-only turn of the same package
//   edit → check    a check-only turn right after an edit turn: `tool edit - … && <check>` is one turn
//   wait            turns whose calls only wait or poll, and turns the harness started for a wake-up
//   reread          a read of a file the session read before with no write to it in between
//   after error     the turn right after a failed call, by the failing tool
// Saving per avoided turn: what the turn paid for everything but its output (cache read, cache
// write, uncached input). Merging two turns keeps the output, so this is the saving, not its cost.
//
// Usage: node scripts/evidence/turns.ts [--samples <file.json> <n>]
//   --samples writes n random serial-explore pairs (with the session file and call ids) for turns-judge.ts.

import { writeFileSync } from "node:fs";
import { type CallKind as Kind, callKind } from "../../extensions/lib/call-kind.ts";
import { openIndex } from "./shared.ts";

const PRIORITY: Kind[] = ["edit+check", "edit", "check", "vcs", "delegate", "wait", "interact", "explore", "other"];

interface Turn {
	session: string;
	entry: string;
	ts: number;
	cost: number;
	overhead: number; // everything but output
	read: number;
	prompt: number;
	toolCalls: number;
	trigger: string;
	child: boolean;
	calls: Call[];
	modelMs?: number;
}
interface Call {
	id: string;
	ts: number;
	tool: string;
	summary: string;
	error: boolean;
	mutates: boolean;
	kind: Kind;
	durationMs: number | null;
	tokens: number;
	lifetime: number; // what the result cost while it stayed in context (tool_results.lifetime_cost)
}

const turnKind = (t: Turn): Kind | "text" => {
	if (!t.calls.length) return "text";
	const kinds = new Set(t.calls.map((c) => c.kind));
	if (kinds.has("edit") && kinds.has("check")) return "edit+check";
	return PRIORITY.find((k) => kinds.has(k)) ?? "other";
};

// ---------- load ----------

const db = openIndex();
const MIN_TS = Date.UTC(2026, 0, 1);
const sessions = new Map<string, { child: boolean; file: string }>();
for (const s of db.prepare("SELECT id, file, prompt_digest IS NOT NULL OR parent_session IS NOT NULL AS child FROM sessions WHERE source = 'pi'").all() as { id: string; file: string; child: number }[])
	sessions.set(s.id, { child: !!s.child, file: s.file });

const bySession = new Map<string, Turn[]>();
for (const r of db
	.prepare(
		`SELECT session_id, entry_id, ts, cost, cost_read, cost_write, cost_input, prompt_tokens, tool_calls, trigger
		 FROM requests WHERE kind = 'turn' AND ts >= ? AND session_id IN (SELECT id FROM sessions WHERE source = 'pi') ORDER BY session_id, ts`,
	)
	.iterate(MIN_TS) as Iterable<Record<string, any>>) {
	const list = bySession.get(r.session_id) ?? [];
	list.push({
		session: r.session_id, entry: r.entry_id, ts: r.ts, cost: r.cost, overhead: r.cost_read + r.cost_write + r.cost_input, read: r.cost_read,
		prompt: r.prompt_tokens, toolCalls: r.tool_calls ?? 0, trigger: r.trigger ?? "", child: sessions.get(r.session_id)!.child, calls: [],
	});
	bySession.set(r.session_id, list);
}

let assigned = 0;
for (const c of db
	.prepare("SELECT session_id, call_id, ts, tool, summary, is_error, mutates, duration_ms, tokens, lifetime_cost FROM tool_results WHERE session_id IN (SELECT id FROM sessions WHERE source = 'pi') ORDER BY session_id, ts")
	.iterate() as Iterable<Record<string, any>>) {
	const turns = bySession.get(c.session_id);
	if (!turns) continue;
	let lo = 0, hi = turns.length - 1, at = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (turns[mid].ts <= c.ts) (at = mid), (lo = mid + 1);
		else hi = mid - 1;
	}
	if (at < 0) continue;
	turns[at].calls.push({ id: c.call_id, ts: c.ts, tool: c.tool, summary: c.summary, error: !!c.is_error, mutates: !!c.mutates, kind: callKind(c.tool, c.summary, !!c.mutates), durationMs: c.duration_ms, tokens: c.tokens, lifetime: c.lifetime_cost });
	assigned++;
}

const reads = new Map<string, string[]>(); // call id → files it read (read tool) or wrote
const writes = new Map<string, string[]>();
for (const f of db.prepare("SELECT session_id, call_id, file, write FROM tool_files WHERE session_id IN (SELECT id FROM sessions WHERE source = 'pi')").iterate() as Iterable<Record<string, any>>) {
	const map = f.write ? writes : reads;
	const key = `${f.session_id} ${f.call_id}`;
	map.set(key, [...(map.get(key) ?? []), f.file]);
}

const all = [...bySession.values()].flat();
// Model time of a turn: from the previous turn's last tool result (or the previous turn) to its end.
for (const turns of bySession.values())
	for (let i = 1; i < turns.length; i++) {
		if (turns[i].trigger === "user prompt" || turns[i].trigger.startsWith("custom:")) continue;
		const prev = turns[i - 1];
		const start = Math.max(prev.ts, ...prev.calls.map((c) => c.ts));
		const ms = turns[i].ts - start;
		if (ms > 0 && ms < 10 * 60_000) turns[i].modelMs = ms;
	}

// ---------- helpers ----------

const usd = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(n >= 1 ? 2 : 3)}`);
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");
const int = (n: number) => Math.round(n).toLocaleString("en-US");
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const quantile = (xs: number[], q: number) => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
function table(head: string[], rows: (string | number)[][]) {
	console.log(`| ${head.join(" | ")} |`);
	console.log(`|${head.map((_, i) => (i ? "---:" : "---")).join("|")}|`);
	for (const r of rows) console.log(`| ${r.join(" | ")} |`);
	console.log();
}
const totalCost = sum(all.map((t) => t.cost));
const totalOverhead = sum(all.map((t) => t.overhead));

// ---------- 1. overview ----------

console.log(`## Data\n`);
console.log(`Pi sessions: ${int(bySession.size)} (${int([...bySession.keys()].filter((s) => sessions.get(s)!.child).length)} child sessions), ${int(all.length)} turns, ${usd(totalCost)}. ` +
	`Tool results assigned to a turn: ${int(assigned)} of ${int(sum(all.map((t) => t.toolCalls)))} counted calls; ` +
	`turns whose assigned calls equal requests.tool_calls: ${pct(all.filter((t) => t.calls.length === t.toolCalls).length, all.length)}.\n`);

console.log(`## 1. Turns per package and what they cost\n`);
interface Pkg { child: boolean; turns: Turn[] }
const packages: Pkg[] = [];
for (const turns of bySession.values()) {
	let cur: Pkg | undefined;
	for (const t of turns) {
		if (!cur || t.trigger === "user prompt") packages.push((cur = { child: t.child, turns: [] }));
		cur.turns.push(t);
	}
}
const pkgRows = (label: string, ps: Pkg[]) => {
	const n = ps.map((p) => p.turns.length);
	const c = ps.map((p) => sum(p.turns.map((t) => t.cost)));
	return [label, int(ps.length), quantile(n, 0.5), quantile(n, 0.9), (sum(n) / ps.length).toFixed(1), usd(quantile(c, 0.5)), usd(sum(c) / ps.length), usd(sum(c))];
};
table(["sessions", "packages", "median turns", "p90 turns", "mean turns", "median cost", "mean cost", "total"], [
	pkgRows("main", packages.filter((p) => !p.child)),
	pkgRows("child (delegated)", packages.filter((p) => p.child)),
	pkgRows("all", packages),
]);

const buckets: [string, number, number][] = [["1–5", 1, 5], ["6–20", 6, 20], ["21–50", 21, 50], ["51–100", 51, 100], ["101–200", 101, 200], [">200", 201, Infinity]];
table(["turns in package", "packages", "share of turns", "share of cost", "mean context", "cost per turn"], buckets.map(([label, lo, hi]) => {
	const ps = packages.filter((p) => p.turns.length >= lo && p.turns.length <= hi);
	const ts = ps.flatMap((p) => p.turns);
	const cost = sum(ts.map((t) => t.cost));
	return [label, int(ps.length), pct(ts.length, all.length), pct(cost, totalCost), `${int(sum(ts.map((t) => t.prompt)) / ts.length / 1000)}k`, usd(cost / ts.length)];
}));

const modelMs = all.flatMap((t) => (t.modelMs ? [t.modelMs] : []));
const toolMs = all.flatMap((t) => t.calls.flatMap((c) => (c.durationMs != null ? [c.durationMs] : [])));
console.log(`Cost of one turn: mean ${usd(totalCost / all.length)}, of which ${pct(totalOverhead, totalCost)} is re-reading and writing the context (the part merging turns saves). ` +
	`Model time per tool-loop turn: median ${(quantile(modelMs, 0.5) / 1000).toFixed(1)} s, mean ${(sum(modelMs) / modelMs.length / 1000).toFixed(1)} s, ` +
	`sum ${int(sum(modelMs) / 3_600_000)} h; tool time: median ${(quantile(toolMs, 0.5) / 1000).toFixed(1)} s, sum ${int(sum(toolMs) / 3_600_000)} h.\n`);

// ---------- 2. calls per turn ----------

console.log(`## 2. Tool calls per turn\n`);
const callRows = (label: string, ts: Turn[]) => {
	const tool = ts.filter((t) => t.toolCalls > 0);
	return [label, int(ts.length), pct(ts.filter((t) => t.toolCalls === 0).length, ts.length), pct(tool.filter((t) => t.toolCalls === 1).length, tool.length), pct(tool.filter((t) => t.toolCalls >= 2).length, tool.length), (sum(tool.map((t) => t.toolCalls)) / tool.length).toFixed(2)];
};
const days = [...new Set(all.map((t) => new Date(t.ts).toISOString().slice(0, 10)))].sort();
table(["slice", "turns", "no tool call", "1 call (of tool turns)", "2+ calls", "calls per tool turn"], [
	callRows("main sessions", all.filter((t) => !t.child)),
	callRows("child sessions", all.filter((t) => t.child)),
	...days.map((d) => callRows(d, all.filter((t) => new Date(t.ts).toISOString().startsWith(d)))),
	callRows("all", all),
]);

// Claude Code baseline: imported turns have no tool_calls, so assign results the same way.
{
	const cc = db.prepare(
		`WITH t AS (SELECT r.session_id, r.ts, LEAD(r.ts) OVER (PARTITION BY r.session_id ORDER BY r.ts) AS next FROM requests r JOIN sessions s ON s.id = r.session_id WHERE s.source = 'claude-code' AND r.kind = 'turn')
		 SELECT n, COUNT(*) AS turns FROM (SELECT t.session_id, t.ts, (SELECT COUNT(*) FROM tool_results x WHERE x.session_id = t.session_id AND x.ts >= t.ts AND (t.next IS NULL OR x.ts < t.next)) AS n FROM t) GROUP BY MIN(n, 3)`,
	).all() as { n: number; turns: number }[];
	const tot = sum(cc.map((r) => r.turns));
	const toolTurns = sum(cc.filter((r) => r.n > 0).map((r) => r.turns));
	console.log(`Claude Code baseline (same user, imported transcripts): ${int(tot)} turns; no call ${pct(cc.find((r) => r.n === 0)?.turns ?? 0, tot)}, ` +
		`1 call ${pct(cc.find((r) => r.n === 1)?.turns ?? 0, toolTurns)} of tool turns, 2+ calls ${pct(sum(cc.filter((r) => r.n >= 2).map((r) => r.turns)), toolTurns)}.\n`);
}

// ---------- 3. what turns do ----------

console.log(`## 3. What turns do\n`);
const kinds = new Map<string, Turn[]>();
for (const t of all) kinds.set(turnKind(t), [...(kinds.get(turnKind(t)) ?? []), t]);
table(["turn kind", "turns", "share", "cost", "share of cost", "1-call share", "median output-free cost"], [...kinds.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, ts]) => [
	k, int(ts.length), pct(ts.length, all.length), usd(sum(ts.map((t) => t.cost))), pct(sum(ts.map((t) => t.cost)), totalCost), pct(ts.filter((t) => t.calls.length === 1).length, ts.length), usd(quantile(ts.map((t) => t.overhead), 0.5)),
]));

const triggers = new Map<string, Turn[]>();
for (const t of all) {
	const key = t.trigger.startsWith("custom:") ? t.trigger : t.trigger === "user prompt" ? "user prompt" : "tool result";
	triggers.set(key, [...(triggers.get(key) ?? []), t]);
}
table(["what started the turn", "turns", "share", "cost"], [...triggers.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8).map(([k, ts]) => [k, int(ts.length), pct(ts.length, all.length), usd(sum(ts.map((t) => t.cost)))]));

// ---------- 4. avoidable turns ----------

console.log(`## 4. Avoidable-turn patterns (upper bounds)\n`);
const patterns: { name: string; turns: Turn[]; note: string }[] = [];
const serial: [Turn, Turn][] = [];
const editCheck: Turn[] = [];
const afterError = new Map<string, Turn[]>();
const rereadTurns: Turn[] = [];
const duplicateTurns: Turn[] = [];
let rereadCalls = 0, readCalls = 0, duplicateCalls = 0, duplicateChecks = 0, checkCalls = 0;
for (const turns of bySession.values()) {
	const lastRead = new Map<string, number>(); // file → index of the turn that last read it
	const lastWrite = new Map<string, number>();
	const lastRun = new Map<string, number>(); // exact read-only command or call → turn index
	let lastMutation = -1;
	for (let i = 0; i < turns.length; i++) {
		const t = turns[i], prev = turns[i - 1];
		const k = turnKind(t);
		if (prev && t.trigger !== "user prompt") {
			const pk = turnKind(prev);
			if (k === "explore" && pk === "explore") serial.push([prev, t]);
			if (k === "check" && (pk === "edit")) editCheck.push(t);
			const failed = prev.calls.find((c) => c.error);
			if (failed) {
				const key = failed.tool === "bash" ? `bash (${failed.kind})` : failed.tool;
				afterError.set(key, [...(afterError.get(key) ?? []), t]);
			}
		}
		let reread = false;
		for (const c of t.calls) {
			const key = `${t.session} ${c.id}`;
			if (c.tool === "read")
				for (const f of reads.get(key) ?? []) {
					readCalls++;
					const r = lastRead.get(f);
					if (r !== undefined && (lastWrite.get(f) ?? -1) < r) (rereadCalls++, (reread = true));
					lastRead.set(f, i);
				}
			for (const f of writes.get(key) ?? []) lastWrite.set(f, i);
		}
		if (reread && t.calls.every((c) => c.tool === "read")) rereadTurns.push(t);
		// The same read-only call (same tool, same arguments summary) again, with no file-changing call
		// anywhere in the session since: its result cannot have changed (unless time or the network did).
		let duplicates = 0;
		for (const c of t.calls) {
			if (c.kind === "check") checkCalls++;
			if (c.kind !== "explore" && c.kind !== "check") continue;
			const key = `${c.tool} ${c.summary}`;
			const before = lastRun.get(key);
			if (before !== undefined && before > lastMutation && c.summary.length > 0) (duplicates++, duplicateCalls++, c.kind === "check" && duplicateChecks++);
			lastRun.set(key, i);
		}
		if (duplicates && duplicates === t.calls.length) duplicateTurns.push(t);
		if (t.calls.some((c) => c.mutates)) lastMutation = i;
	}
}
const waitTurns = all.filter((t) => turnKind(t) === "wait" || t.trigger.startsWith("custom:"));
patterns.push(
	{ name: "serial explore (explore turn after explore turn)", turns: serial.map(([, t]) => t), note: "judged sample below" },
	{ name: "edit → separate check turn", turns: editCheck, note: "`tool edit - … && check` makes it one" },
	{ name: "wait / poll / harness wake-up", turns: waitTurns, note: "goal, task_status, sleep loops, background-job and goal nudges" },
	{ name: "reread-only turn (file unchanged since last read)", turns: rereadTurns, note: `${int(rereadCalls)} of ${int(readCalls)} read-tool file reads are rereads` },
	{ name: "identical read-only call, nothing changed since", turns: duplicateTurns, note: `${int(duplicateCalls)} calls; ${int(duplicateChecks)} of ${int(checkCalls)} check runs` },
	{ name: "turn after a failed call", turns: [...afterError.values()].flat(), note: "partly unavoidable (failing tests are information)" },
);
table(["pattern", "turns", "share of turns", "saving if removed", "share of spend", "note"], patterns.map((p) => {
	const save = sum(p.turns.map((t) => t.overhead));
	return [p.name, int(p.turns.length), pct(p.turns.length, all.length), usd(save), pct(save, totalCost), p.note];
}));

{
	const edits = all.flatMap((t) => t.calls).filter((c) => c.tool === "edit" || /tool\s+edit\s+-/.test(c.summary));
	const viaTool = edits.filter((c) => c.tool === "edit");
	const viaBash = edits.filter((c) => c.tool === "bash" && c.kind === "edit");
	console.log(`Edit failures: \`edit\` tool ${pct(viaTool.filter((c) => c.error).length, viaTool.length)} of ${int(viaTool.length)} calls; ` +
		`\`tool edit -\` in bash without a chained check ${pct(viaBash.filter((c) => c.error).length, viaBash.length)} of ${int(viaBash.length)}.\n`);
}

table(["failed call before the turn", "turns", "saving if removed"], [...afterError.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10).map(([k, ts]) => [k, int(ts.length), usd(sum(ts.map((t) => t.overhead)))]));

// Serial explore runs: how long they get.
{
	const runs: number[] = [];
	for (const turns of bySession.values()) {
		let n = 0;
		for (const t of turns) {
			if (turnKind(t) === "explore" && t.trigger !== "user prompt") n++;
			else {
				if (n) runs.push(n);
				n = turnKind(t) === "explore" ? 1 : 0;
			}
		}
		if (n) runs.push(n);
	}
	table(["explore run length", "runs", "turns in them"], [[1, 1], [2, 3], [4, 7], [8, 15], [16, Infinity]].map(([lo, hi]) => {
		const rs = runs.filter((r) => r >= lo && r <= hi);
		return [hi === Infinity ? `${lo}+` : lo === hi ? `${lo}` : `${lo}–${hi}`, int(rs.length), int(sum(rs))];
	}));
}

// ---------- 5. batching tools in use ----------

console.log(`## 5. How often the batching tools are used\n`);
const toolCalls = all.flatMap((t) => t.calls);
const bash = toolCalls.filter((c) => c.tool === "bash");
table(["mechanism", "calls", "share"], [
	["bash calls using `tool <name>`", int(bash.filter((c) => /(?:^|[\s;&|(])tool\s+[a-z_]/.test(c.summary)).length), pct(bash.filter((c) => /(?:^|[\s;&|(])tool\s+[a-z_]/.test(c.summary)).length, bash.length)],
	["bash calls using `tool edit -`", int(bash.filter((c) => /tool\s+edit\s+-/.test(c.summary)).length), pct(bash.filter((c) => /tool\s+edit\s+-/.test(c.summary)).length, bash.length)],
	["bash edit+check in one call", int(bash.filter((c) => c.kind === "edit+check").length), pct(bash.filter((c) => c.kind === "edit+check").length, bash.length)],
	["workflow calls", int(toolCalls.filter((c) => c.tool === "workflow").length), pct(all.filter((t) => t.calls.some((c) => c.tool === "workflow")).length, all.length) + " of turns"],
	["fix_loop calls", int(toolCalls.filter((c) => c.tool === "fix_loop").length), pct(all.filter((t) => t.calls.some((c) => c.tool === "fix_loop")).length, all.length) + " of turns"],
	["codemode calls", int(toolCalls.filter((c) => c.tool === "codemode").length), pct(all.filter((t) => t.calls.some((c) => c.tool === "codemode")).length, all.length) + " of turns"],
]);

// ---------- 6. explore runs handed to a cheap subagent ----------

// Simulation: every explore run of a package (consecutive explore-only turns) becomes one call to a
// fresh Haiku subagent. The main model keeps one turn per run (the call) and saves the re-read of
// the others. Haiku pays per turn for its own small context: a fixed prompt plus the results it has
// gathered so far, at Haiku 5.5's cache rates, plus ~300 output tokens per turn. "Opening" runs come
// before the package's first file change (orientation, the part a brief can name up front); "mid-task"
// runs come after one. Carrying the results costs the main model what tool_results.lifetime_cost
// says; returning a digest instead of raw results saves part of that.
{
	const HAIKU = { read: 0.01e-6, write: 0.13e-6, output: 0.5e-6, prompt: 15_000, outputTokens: 300 };
	console.log(`## 6. Explore runs as subagent candidates\n`);
	type Run = { opening: boolean; turns: Turn[] };
	const runs: Run[] = [];
	for (const p of packages) {
		let edited = false, cur: Run | undefined;
		for (const t of p.turns) {
			const k = turnKind(t);
			if (k === "explore") (cur ??= (runs.push({ opening: !edited, turns: [] }), runs[runs.length - 1])).turns.push(t);
			else cur = undefined;
			if (t.calls.some((c) => c.mutates)) edited = true;
		}
	}
	const haikuCost = (r: Run) => {
		let gathered = 0, cost = 0;
		for (const t of r.turns) {
			const got = sum(t.calls.map((c) => c.tokens));
			cost += (HAIKU.prompt + gathered) * HAIKU.read + got * HAIKU.write + HAIKU.outputTokens * HAIKU.output;
			gathered += got;
		}
		return cost;
	};
	const rows: (string | number)[][] = [];
	for (const opening of [true, false])
		for (const [label, lo, hi] of [["1", 1, 1], ["2–3", 2, 3], ["4–7", 4, 7], ["8+", 8, Infinity]] as const) {
			const rs = runs.filter((r) => r.opening === opening && r.turns.length >= lo && r.turns.length <= hi);
			const saved = sum(rs.map((r) => sum(r.turns.slice(1).map((t) => t.overhead))));
			const haiku = sum(rs.map(haikuCost));
			const carry = sum(rs.flatMap((r) => r.turns.flatMap((t) => t.calls.map((c) => c.lifetime))));
			const tokens = rs.map((r) => sum(r.turns.flatMap((t) => t.calls.map((c) => c.tokens))));
			rows.push([opening ? "opening" : "mid-task", label, int(rs.length), int(sum(rs.map((r) => r.turns.length))), usd(saved), usd(haiku), usd(saved - haiku), `${int(quantile(tokens, 0.5) / 1000)}k`, usd(carry)]);
		}
	table(["position", "run length", "runs", "turns", "main-model saving", "Haiku cost", "net", "median result tokens", "cost of carrying results"], rows);
	const all2 = runs.filter((r) => r.turns.length >= 2);
	const net = sum(all2.map((r) => sum(r.turns.slice(1).map((t) => t.overhead)) - haikuCost(r)));
	console.log(`Runs of 2+ turns: net ${usd(net)} (${pct(net, totalCost)} of spend) before any digest; carrying their raw results costs ${usd(sum(all2.flatMap((r) => r.turns.flatMap((t) => t.calls.map((c) => c.lifetime)))))}.\n`);
}

// ---------- samples for the judge ----------

const at = process.argv.indexOf("--samples");
if (at > 0) {
	const [file, n] = [process.argv[at + 1], Number(process.argv[at + 2] ?? 200)];
	let seed = 7;
	const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
	const pool = serial.filter(([a, b]) => a.calls.length && b.calls.length);
	const picked = new Set<number>();
	while (picked.size < Math.min(n, pool.length)) picked.add(Math.floor(rand() * pool.length));
	writeFileSync(file, JSON.stringify([...picked].map((i) => {
		const [a, b] = pool[i];
		return { session: a.session, file: sessions.get(a.session)!.file, first: a.calls.map((c) => c.id), second: b.calls.map((c) => c.id), overhead: b.overhead, child: a.child };
	}), null, 1));
	console.log(`Wrote ${picked.size} serial-explore pairs to ${file} (of ${int(pool.length)}).`);
}
