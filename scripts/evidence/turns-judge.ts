// Judges a random sample of serial explore turns (an explore-only turn right after another; see
// turns.ts) to estimate how many of them a model could have saved.
//
// For each pair the judge sees the first turn's calls with their results (truncated), the second
// turn's reasoning and calls, and answers:
//   independent  the second turn's calls did not need the first turn's results: same response
//   wider        they needed them, but one wider first call would have covered both (the next
//                slice of the same file, the same grep with more context, a listing then reading
//                every listed file the agent obviously wanted)
//   dependent    the second calls were decided by what the first returned
// plus what the second turn did, so the report can say which tool change would remove it.
// Answers are cached next to the sample file, so a re-run only judges new pairs.
//
// Usage: node scripts/evidence/turns-judge.ts <pairs.json from turns.ts --samples> [--model claude-sonnet-5-5]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { askJson } from "../lib/labels.ts";
import { readEntries } from "./thinking-billing.ts";

const VERDICTS = ["independent", "wider", "dependent"] as const;
const ACTIVITIES = ["next slice of same file", "follow a reference", "broaden or refine a search", "inspect another file or area", "run or query something", "web research", "other"] as const;
type Verdict = { verdict: (typeof VERDICTS)[number]; activity: (typeof ACTIVITIES)[number]; reason: string };
interface PairRef { session: string; file: string; first: string[]; second: string[]; overhead: number; child: boolean }

const SYSTEM = `You audit coding-agent transcripts. An agent works in a tool loop: each turn is one model request that emits tool calls; their results come back before the next turn. Every turn re-reads the whole context, so a turn that could have been avoided costs money.

You get turn 1 (its tool calls and their results) and turn 2 (its reasoning and tool calls) that came right after it. Decide whether turn 2 was necessary as a separate turn:
- "independent": turn 2's calls did not use anything from turn 1's results; the agent could have issued them in the same response as turn 1 (parallel tool calls or one chained command).
- "wider": turn 2 used turn 1's results, but a single wider call in turn 1 would have covered both and was foreseeable (reading the next lines of the same file, re-running a search with more context or more files, reading the files a listing returned when the intent was obvious).
- "dependent": what turn 2 does was decided by turn 1's results and could not reasonably be foreseen.
Also name turn 2's activity: ${ACTIVITIES.map((a) => `"${a}"`).join(", ")}.
Reply with only JSON: {"verdict": "...", "activity": "...", "reason": "<one sentence>"}`;

type Part = { type: string; id?: string; name?: string; arguments?: unknown; text?: string; thinking?: string };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[${s.length - n} more chars]` : s);

function render(ref: PairRef): string | undefined {
	const entries = readEntries(ref.file) as unknown as { type: string; message?: { role: string; content: Part[] | string; toolCallId?: string } }[];
	const calls = new Map<string, Part>(), results = new Map<string, string>(), turnOf = new Map<string, Part[]>();
	for (const e of entries) {
		const m = e.message;
		if (!m) continue;
		if (m.role === "assistant" && Array.isArray(m.content))
			for (const p of m.content) if (p.type === "toolCall" && p.id) (calls.set(p.id, p), turnOf.set(p.id, m.content));
		if (m.role === "toolResult" && m.toolCallId)
			results.set(m.toolCallId, typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? `[${p.type}]`).join("\n"));
	}
	if (![...ref.first, ...ref.second].every((id) => calls.has(id))) return undefined;
	const call = (id: string) => `${calls.get(id)!.name}(${clip(JSON.stringify(calls.get(id)!.arguments), 1500)})`;
	const second = turnOf.get(ref.second[0])!;
	const reasoning = second.filter((p) => p.type === "thinking" || p.type === "text").map((p) => p.thinking ?? p.text ?? "").join("\n").trim();
	return [
		"## Turn 1",
		...ref.first.map((id) => `### Call\n${call(id)}\n### Result\n${clip(results.get(id) ?? "(no result)", 2500)}`),
		"## Turn 2",
		reasoning ? `### Reasoning\n${clip(reasoning, 1500)}` : "### Reasoning\n(none shown)",
		...ref.second.map((id) => `### Call\n${call(id)}`),
	].join("\n\n");
}

const validate = (v: unknown): Verdict => {
	const o = v as Verdict;
	if (!VERDICTS.includes(o?.verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(", ")}`);
	if (!ACTIVITIES.includes(o.activity)) throw new Error(`activity must be one of ${ACTIVITIES.join(", ")}`);
	return { verdict: o.verdict, activity: o.activity, reason: String(o.reason ?? "") };
};

async function main(): Promise<void> {
	const file = process.argv[2];
	if (!file) throw new Error("usage: turns-judge.ts <pairs.json> [--model <id>]");
	const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1]! : "claude-sonnet-5-5";
	const cacheFile = file.replace(/\.json$/, `.verdicts.${model}.json`);
	const cache: Record<string, Verdict | null> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
	const pairs = JSON.parse(readFileSync(file, "utf8")) as PairRef[];
	const key = (p: PairRef) => `${p.session} ${p.second.join(",")}`;
	const todo = pairs.filter((p) => !(key(p) in cache));
	let next = 0;
	await Promise.all(Array.from({ length: 8 }, async () => {
		while (next < todo.length) {
			const p = todo[next++];
			const prompt = render(p);
			cache[key(p)] = prompt ? await askJson(model, SYSTEM, prompt, validate, 400).catch(() => null) : null;
			writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
		}
	}));

	const judged = pairs.flatMap((p) => (cache[key(p)] ? [{ p, v: cache[key(p)]! }] : []));
	const n = judged.length;
	const pct = (k: number) => `${((100 * k) / n).toFixed(0)}%`;
	// 95% interval of a share (Wilson).
	const ci = (k: number) => {
		const z = 1.96, ph = k / n, d = 1 + z * z / n, c = ph + z * z / (2 * n), w = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n));
		return `${((100 * (c - w)) / d).toFixed(0)}–${((100 * (c + w)) / d).toFixed(0)}%`;
	};
	console.log(`Judged ${n} of ${pairs.length} pairs with ${model} (${pairs.length - n} unreadable or failed).\n`);
	console.log("| verdict | pairs | share | 95% CI |\n|---|---:|---:|---:|");
	for (const v of VERDICTS) {
		const k = judged.filter((j) => j.v.verdict === v).length;
		console.log(`| ${v} | ${k} | ${pct(k)} | ${ci(k)} |`);
	}
	console.log("\n| activity of turn 2 | pairs | independent | wider | dependent |\n|---|---:|---:|---:|---:|");
	for (const a of ACTIVITIES) {
		const js = judged.filter((j) => j.v.activity === a);
		if (!js.length) continue;
		const c = (v: string) => js.filter((j) => j.v.verdict === v).length;
		console.log(`| ${a} | ${js.length} | ${c("independent")} | ${c("wider")} | ${c("dependent")} |`);
	}
	console.log("\nExamples:");
	for (const v of VERDICTS) for (const j of judged.filter((x) => x.v.verdict === v).slice(0, 3)) console.log(`- ${v} / ${j.v.activity}: ${j.v.reason}`);
}

if (import.meta.main) await main();
