// Measures how many prompt tokens Anthropic actually bills for the thinking blocks Pi replays in
// history, to check the metrics' estimate (blocks.ts sizes a thinking block as text/4 plus
// signature length × 0.75 / 4, i.e. the base64 signature decoded, then scaled to the real prompt).
//
// Method: for two consecutive Pi requests of one session, n and n+1, where only tool results lie
// between them (no user message, system update, compaction, model or thinking-level change), the
// prompt grows by exactly what request n produced plus its tool results:
//   prompt(n+1) − prompt(n) = replayed(assistant n) + tool results + framing
// Assistant n's replayed size is its text and tool calls plus whatever its thinking costs as input.
// Non-thinking content is calibrated on pairs without thinking (tokens per char); the residual is
// then compared with the thinking summary text, the signature, and the model's own reported
// thinking tokens (usage.reasoning, Anthropic's output_tokens_details.thinking_tokens).
//
// Usage: node scripts/evidence/thinking-billing.ts [sessions dir]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Part = { type: string; text?: string; thinking?: string; thinkingSignature?: string; redacted?: boolean; arguments?: unknown; name?: string };
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number };
type Entry = { type: string; id: string; parentId: string | null; message?: { role: string; content: Part[] | string; usage?: Usage; model?: string; thinkingLevel?: string; stopReason?: string } };

export function sessionFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...sessionFiles(path));
		else if (name.endsWith(".jsonl")) out.push(path);
	}
	return out;
}

export const readEntries = (file: string): Entry[] =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Entry);

const promptOf = (u: Usage) => u.input + u.cacheRead + u.cacheWrite;
const chars = (content: Part[] | string): number =>
	typeof content === "string" ? content.length : content.reduce((sum, p) => sum + (p.text?.length ?? 0) + (p.type === "toolCall" ? JSON.stringify(p.arguments ?? {}).length + (p.name?.length ?? 0) : 0), 0);

export interface Pair {
	file: string;
	delta: number;
	/** Characters of assistant n's text and tool calls plus its tool results. */
	otherChars: number;
	thinkingChars: number;
	signatureChars: number;
	reasoning: number;
	output: number;
	blocks: number;
	redacted: number;
	stop?: string;
	/** "tool": only tool results between the two requests; "user": a user message as well (a new turn). */
	boundary: "tool" | "user";
}

export function pairs(files: string[]): Pair[] {
	const out: Pair[] = [];
	for (const file of files) {
		const entries = readEntries(file);
		const byId = new Map(entries.map((e) => [e.id, e]));
		for (const next of entries) {
			if (next.message?.role !== "assistant" || !next.message.usage) continue;
			// Walk back over tool results to the previous assistant message.
			const results: Entry[] = [];
			let cursor = next.parentId ? byId.get(next.parentId) : undefined;
			while (cursor && cursor.type === "message" && (cursor.message?.role === "toolResult" || cursor.message?.role === "user")) {
				results.push(cursor);
				cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
			}
			const prev = cursor;
			if (results.length === 0 || prev?.type !== "message" || prev.message?.role !== "assistant" || !prev.message.usage) continue;
			if (prev.message.model !== next.message.model || prev.message.thinkingLevel !== next.message.thinkingLevel) continue;
			const pu = prev.message.usage;
			const nu = next.message.usage;
			if (promptOf(pu) === 0 || promptOf(nu) === 0) continue;
			const parts = prev.message.content as Part[];
			const thinking = parts.filter((p) => p.type === "thinking");
			out.push({
				file,
				delta: promptOf(nu) - promptOf(pu),
				otherChars: chars(parts.filter((p) => p.type !== "thinking")) + results.reduce((sum, r) => sum + chars(r.message!.content), 0),
				thinkingChars: thinking.reduce((sum, p) => sum + (p.redacted ? 0 : (p.thinking?.length ?? 0)), 0),
				signatureChars: thinking.reduce((sum, p) => sum + (p.thinkingSignature?.length ?? 0), 0),
				reasoning: pu.reasoning ?? 0,
				output: pu.output,
				blocks: thinking.length,
				redacted: thinking.filter((p) => p.redacted).length,
				stop: prev.message.stopReason,
				boundary: results.some((r) => r.message!.role === "user") ? "user" : "tool",
			});
		}
	}
	return out;
}

/** Ordinary least squares without intercept; returns the coefficients. */
export function ols(rows: number[][], y: number[]): number[] {
	const k = rows[0]!.length;
	const xtx = Array.from({ length: k }, () => new Array<number>(k).fill(0));
	const xty = new Array<number>(k).fill(0);
	rows.forEach((row, i) => {
		for (let a = 0; a < k; a++) {
			xty[a]! += row[a]! * y[i]!;
			for (let b = 0; b < k; b++) xtx[a]![b]! += row[a]! * row[b]!;
		}
	});
	// Gaussian elimination.
	const m = xtx.map((row, i) => [...row, xty[i]!]);
	for (let c = 0; c < k; c++) {
		const p = m.reduce((best, row, r) => (r >= c && Math.abs(row[c]!) > Math.abs(m[best]![c]!) ? r : best), c);
		[m[c], m[p]] = [m[p]!, m[c]!];
		for (let r = 0; r < k; r++) {
			if (r === c) continue;
			const f = m[r]![c]! / m[c]![c]!;
			for (let j = c; j <= k; j++) m[r]![j]! -= f * m[c]![j]!;
		}
	}
	return m.map((row, i) => row[k]! / row[i]!);
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};

if (import.meta.main) {
	const dir = process.argv[2] ?? join(homedir(), ".pi", "agent", "sessions");
	// Prompt growth can be negative only when something left the context (stripped thinking at a new
	// turn would show so); |growth| ≥ 200k is a compaction or branch switch the walk did not catch.
	const found = pairs(sessionFiles(dir)).filter((p) => Math.abs(p.delta) < 200_000);
	const plain = found.filter((p) => p.blocks === 0 && p.boundary === "tool");
	// Calibrate tokens per char of ordinary content (plus a per-pair framing constant) on tool-loop pairs without thinking.
	const [perChar, framing] = ols(plain.map((p) => [p.otherChars, 1]), plain.map((p) => p.delta));
	console.log(`calibration on ${plain.length} tool-loop pairs without thinking: ${perChar!.toFixed(4)} tokens/char (${(1 / perChar!).toFixed(2)} chars/token), framing ${framing!.toFixed(1)} tokens`);
	for (const boundary of ["tool", "user"] as const) {
		const all = found.filter((p) => p.boundary === boundary);
		console.log(`\n## ${boundary === "tool" ? "Within a tool loop (only tool results between the requests)" : "Across a user message (a new turn starts)"}`);
		console.log(`pairs: ${all.length} (with thinking ${all.filter((p) => p.blocks > 0).length}, with redacted ${all.filter((p) => p.redacted > 0).length}, negative growth ${all.filter((p) => p.delta < 0).length})`);
		reportPairs(all.filter((p) => p.blocks > 0 && p.redacted === 0), perChar!, framing!);
	}
}

function reportPairs(withThinking: Pair[], perChar: number, framing: number): void {
	const residual = withThinking.map((p) => p.delta - perChar * p.otherChars - framing);
	const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
	const totals = {
		residual: sum(residual),
		reasoning: sum(withThinking.map((p) => p.reasoning)),
		textEstimate: sum(withThinking.map((p) => p.thinkingChars / 4)),
		signatureEstimate: sum(withThinking.map((p) => (p.signatureChars * 0.75) / 4)),
	};
	console.log("\nSums over pairs with thinking (tokens):");
	console.log(`  measured residual (prompt growth not explained by text, tool calls, results): ${Math.round(totals.residual)}`);
	console.log(`  reported thinking tokens (usage.reasoning, what was generated):                ${totals.reasoning}`);
	console.log(`  metrics estimate, summary text/4:                                              ${Math.round(totals.textEstimate)}`);
	console.log(`  metrics estimate, signature bytes/4:                                           ${Math.round(totals.signatureEstimate)}`);
	console.log(`  metrics estimate, total (text + signature):                                    ${Math.round(totals.textEstimate + totals.signatureEstimate)}`);
	const coef = ols(
		withThinking.map((p) => [p.thinkingChars, p.signatureChars, p.reasoning, 1]),
		residual,
	);
	if (withThinking.length < 5) return;
	console.log(`\nregression residual ~ a·thinkingChars + b·signatureChars + c·reasoning + d: a=${coef[0]!.toFixed(4)} b=${coef[1]!.toFixed(4)} c=${coef[2]!.toFixed(4)} d=${coef[3]!.toFixed(1)}`);
	const ratio = (f: (p: Pair) => number) => median(withThinking.map((p, i) => residual[i]! / Math.max(1, f(p))));
	console.log(`median residual / reasoning: ${ratio((p) => p.reasoning).toFixed(2)}; / (text/4): ${ratio((p) => p.thinkingChars / 4).toFixed(2)}; / (sig bytes/4): ${ratio((p) => (p.signatureChars * 0.75) / 4).toFixed(2)}`);
	// The clearest cases: large thinking, small everything else.
	const clear = withThinking.map((p, i) => ({ p, r: residual[i]! })).filter(({ p }) => p.reasoning >= 1500 && p.otherChars < 4000).sort((a, b) => b.p.reasoning - a.p.reasoning);
	console.log(`\nclear cases (reasoning ≥ 1500 tokens, other content < 4k chars): ${clear.length}`);
	console.log("| prompt growth | other content est. | residual | reported thinking | summary text/4 | signature bytes/4 |");
	console.log("|---|---|---|---|---|---|");
	for (const { p, r } of clear.slice(0, 15)) {
		console.log(`| ${p.delta} | ${Math.round(perChar * p.otherChars + framing)} | ${Math.round(r)} | ${p.reasoning} | ${Math.round(p.thinkingChars / 4)} | ${Math.round((p.signatureChars * 0.75) / 4)} |`);
	}
	console.log(`\nclear-case sums: residual ${Math.round(sum(clear.map((c) => c.r)))}, reasoning ${sum(clear.map((c) => c.p.reasoning))}, text/4 ${Math.round(sum(clear.map((c) => c.p.thinkingChars / 4)))}, sig/4 ${Math.round(sum(clear.map((c) => (c.p.signatureChars * 0.75) / 4)))}`);
}
