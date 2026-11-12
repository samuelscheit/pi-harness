// Measures what replaying earlier thinking blocks costs in Pi sessions, and what the policy "drop
// thinking of earlier turns only when the prompt cache is lost anyway" would save.
//
// The metrics index sizes a thinking block from its summary text plus its signature (blocks.ts)
// and scales every block to the real prompt size. thinking-billing.ts shows Anthropic bills a
// replayed block at the thinking tokens the model reported generating (usage.reasoning), so here
// every request is re-attributed with each thinking block at its message's reported thinking
// tokens and every other block scaled to the rest of the real prompt. The walk over the cache
// prefix is the one in extensions/metrics/attribution.ts.
//
// Policy simulation: a cache-loss moment is a request the index flags with a cache_event (any
// cause: compaction, expiry after idle, prompt or tool change, unexplained miss) or the first
// request after a compaction. At such a moment the thinking blocks of turns before the latest user
// message are dropped; they stay dropped. The saving is what those blocks cost (as attributed) in
// that request (its rewrite) and in every later request until the session ends. Dropping them
// again at the next loss changes nothing, so the per-loss sums do not double count. The current
// turn's thinking stays: Anthropic requires it in a tool-use loop.
//
// Usage: node scripts/evidence/thinking-replay.ts [metrics.db] [sessions dir]

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildSessionContext, migrateSessionEntries, parseSessionEntries, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { ratesOf, type Rates, type Usage } from "../../extensions/metrics/attribution.ts";
import { digest, parsePrompt } from "../../extensions/metrics/blocks.ts";
import { metricsPath } from "../../extensions/metrics/stats.ts";
import { sessionFiles } from "./thinking-billing.ts";

type Thinking = { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean };
type AssistantLike = { role: "assistant"; content: { type: string }[]; usage?: Usage & { reasoning?: number } };

interface Totals {
	requests: number;
	cost: number;
	metricsRead: number;
	metricsWrite: number;
	read: number;
	write: number;
	uncached: number;
	/** The part of read/write paid for thinking of earlier turns (before the latest user message). */
	earlierRead: number;
	earlierWrite: number;
	losses: number;
	lossesWithThinking: number;
	savedRead: number;
	savedWrite: number;
	thinkingTokensCarried: number;
	metricsTokensCarried: number;
	missingReasoning: number;
	/** Thinking cost attributed in requests at or after the session's first API-reported thinking drop. */
	afterApiDrop: number;
}

const zero = (): Totals => ({ requests: 0, cost: 0, metricsRead: 0, metricsWrite: 0, read: 0, write: 0, uncached: 0, earlierRead: 0, earlierWrite: 0, losses: 0, lossesWithThinking: 0, savedRead: 0, savedWrite: 0, thinkingTokensCarried: 0, metricsTokensCarried: 0, missingReasoning: 0, afterApiDrop: 0 });

const estimate = (part: Thinking) => part.thinking.length / 4 + ((part.thinkingSignature ?? "").length * 0.75) / 4;

export function analyse(dbPath: string, dir: string) {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	// Pi sessions and the last request the index holds for each: session files keep growing, so the
	// replay stops where the index stopped and both sides cover the same requests.
	const pi = new Map((db.prepare("SELECT s.id, MAX(r.ts) last FROM sessions s JOIN requests r ON r.session_id = s.id WHERE s.source = 'pi' GROUP BY s.id").all() as { id: string; last: number }[]).map((r) => [r.id, r.last]));
	const events = new Map((db.prepare("SELECT session_id || ' ' || entry_id k, cache_event e FROM requests WHERE cache_event IS NOT NULL").all() as { k: string; e: string }[]).map((r) => [r.k, r.e]));
	const metricsCost = db.prepare("SELECT read_cost r, write_cost w, tokens t FROM request_costs WHERE session_id = ? AND entry_id = ? AND category = 'thinking'");
	const totals = zero();
	const byCause = new Map<string, { losses: number; saved: number }>();
	const sessions: { id: string; cost: number; thinking: number; saved: number }[] = [];
	// The cause of the latest cache loss per session.
	const currentCause = new Map<string, string>();

	for (const file of sessionFiles(dir)) {
		const fileEntries = parseSessionEntries(readFileSync(file, "utf8"));
		migrateSessionEntries(fileEntries);
		const header = fileEntries.find((e): e is SessionHeader => e.type === "session");
		if (!header || !pi.has(header.id)) continue;
		const entries = fileEntries.filter((e): e is SessionEntry => e.type !== "session");
		const byId = new Map(entries.map((e) => [e.id, e]));
		const dropped = new Set<string>();
		let afterCompaction = false;
		// Set once the API reported dropping thinking blocks (prefix binding mismatch): from then on the
		// session replays blocks Anthropic does not bill, so their attributed cost is an overestimate.
		let apiDropped = false;
		let previousRates: Rates | undefined;
		const session = { id: header.id, cost: 0, thinking: 0, saved: 0 };
		for (const entry of entries) {
			if (entry.type === "compaction") afterCompaction = true;
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			if (Date.parse(entry.timestamp) > pi.get(header.id)!) break;
			const usage = entry.message.usage as Usage;
			const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			if (promptTokens === 0) continue;
			// SAFETY: Pi stores provider diagnostics on the assistant message (anthropic-messages.ts appendAssistantMessageDiagnostic).
			const diagnostics = (entry.message as unknown as { diagnostics?: { type: string }[] }).diagnostics ?? [];
			if (diagnostics.some((d) => d.type === "anthropic_input_transformations")) apiDropped = true;
			const messages = buildSessionContext(entries, entry.parentId, byId).messages;
			const prompt = parsePrompt(messages);
			// Real tokens per thinking block (by digest), and which blocks belong to earlier turns.
			const real = new Map<string, number>();
			const earlier = new Set<string>();
			const lastUser = messages.findLastIndex((m) => m.role === "user");
			messages.forEach((message, index) => {
				if (message.role !== "assistant") return;
				// SAFETY: role "assistant" is Pi's AssistantMessage; usage.reasoning is set by anthropic-messages.ts from output_tokens_details.
				const assistant = message as unknown as AssistantLike;
				const parts = assistant.content.filter((p): p is Thinking => p.type === "thinking");
				if (parts.length === 0) return;
				const reasoning = assistant.usage?.reasoning;
				const weights = parts.map(estimate);
				const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
				parts.forEach((part, i) => {
					const key = digest(`t\0${part.thinking}\0${part.thinkingSignature ?? ""}`);
					if (reasoning === undefined || reasoning === 0) totals.missingReasoning += 1;
					real.set(key, reasoning ? (reasoning * weights[i]!) / weightSum : weights[i]!);
					if (index < lastUser) earlier.add(key);
				});
			});
			const thinkingReal = prompt.blocks.reduce((sum, b) => sum + (b.category === "thinking" ? (real.get(b.digest) ?? 0) : 0), 0);
			const others = prompt.blocks.reduce((sum, b) => sum + (b.category === "thinking" ? 0 : b.tokens), 0) || 1;
			const scale = Math.max(0, promptTokens - thinkingReal) / others;
			const rates = ratesOf(usage, previousRates);
			previousRates = rates;
			const key = `${header.id} ${entry.id}`;
			const lost = events.get(key) ?? (afterCompaction ? "compaction (first request after)" : undefined);
			afterCompaction = false;
			if (lost) {
				totals.losses += 1;
				let any = false;
				for (const b of prompt.blocks) {
					if (b.category === "thinking" && earlier.has(b.digest) && !dropped.has(b.digest)) {
						dropped.add(b.digest);
						any = true;
					}
				}
				if (any) totals.lossesWithThinking += 1;
			}
			// Walk the cache prefix: reads first, then writes, then uncached input.
			let position = 0;
			const readEnd = usage.cacheRead;
			const writeEnd = readEnd + usage.cacheWrite;
			let saved = 0;
			for (const b of prompt.blocks) {
				const tokens = b.category === "thinking" ? (real.get(b.digest) ?? b.tokens * scale) : b.tokens * scale;
				const start = position;
				position += tokens;
				if (b.category !== "thinking") continue;
				const read = Math.max(0, Math.min(position, readEnd) - start) * rates.read;
				const write = Math.max(0, Math.min(position, writeEnd) - Math.max(start, readEnd)) * rates.write;
				const uncached = Math.max(0, position - Math.max(start, writeEnd)) * rates.input;
				totals.read += read;
				totals.write += write;
				totals.uncached += uncached;
				totals.thinkingTokensCarried += tokens;
				if (apiDropped) totals.afterApiDrop += read + write + uncached;
				if (earlier.has(b.digest)) {
					totals.earlierRead += read;
					totals.earlierWrite += write;
				}
				if (dropped.has(b.digest)) {
					totals.savedRead += read;
					totals.savedWrite += write + uncached;
					saved += read + write + uncached;
				}
				session.thinking += read + write + uncached;
			}
			// A saving is credited to the cause of the latest loss in the session (this request's or an earlier one's).
			const lostCause = lost ?? currentCause.get(header.id);
			if (lost) currentCause.set(header.id, lost);
			if (lostCause && saved > 0) {
				const cause = byCause.get(lostCause) ?? { losses: 0, saved: 0 };
				cause.saved += saved;
				byCause.set(lostCause, cause);
			}
			if (lost) {
				const cause = byCause.get(lost) ?? { losses: 0, saved: 0 };
				cause.losses += 1;
				byCause.set(lost, cause);
			}
			session.saved += saved;
			const metrics = metricsCost.get(header.id, entry.id) as { r: number; w: number; t: number } | undefined;
			totals.metricsRead += metrics?.r ?? 0;
			totals.metricsWrite += metrics?.w ?? 0;
			totals.metricsTokensCarried += metrics?.t ?? 0;
			totals.requests += 1;
			totals.cost += usage.cost.total;
			session.cost += usage.cost.total;
		}
		sessions.push(session);
	}
	return { totals, byCause, sessions };
}

if (import.meta.main) {
	const dbPath = process.argv[2] ?? metricsPath();
	const dir = process.argv[3] ?? join(homedir(), ".pi", "agent", "sessions");
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const spend = (db.prepare("SELECT SUM(r.cost) c FROM requests r JOIN sessions s ON s.id = r.session_id WHERE s.source = 'pi'").get() as { c: number }).c;
	const { totals: t, byCause, sessions } = analyse(dbPath, dir);
	const usd = (v: number) => `$${v.toFixed(2)}`;
	const pct = (v: number) => `${((100 * v) / spend).toFixed(1)}%`;
	console.log(`Pi spend (all requests incl. side calls): ${usd(spend)}; turns re-attributed: ${t.requests} (${usd(t.cost)})`);
	console.log(`thinking blocks without reported thinking tokens (sized by the metrics estimate): ${t.missingReasoning}`);
	console.log(`\n| sizing | thinking tokens carried | cache read | cache write | total | share of Pi spend |`);
	console.log(`|---|---|---|---|---|---|`);
	console.log(`| metrics index (summary text + signature, scaled) | ${(t.metricsTokensCarried / 1e6).toFixed(1)}M | ${usd(t.metricsRead)} | ${usd(t.metricsWrite)} | ${usd(t.metricsRead + t.metricsWrite)} | ${pct(t.metricsRead + t.metricsWrite)} |`);
	console.log(`| reported thinking tokens (measured billing) | ${(t.thinkingTokensCarried / 1e6).toFixed(1)}M | ${usd(t.read)} | ${usd(t.write)} | ${usd(t.read + t.write + t.uncached)} | ${pct(t.read + t.write + t.uncached)} |`);
	console.log(`| … of which earlier turns (before the latest user message) | | ${usd(t.earlierRead)} | ${usd(t.earlierWrite)} | ${usd(t.earlierRead + t.earlierWrite)} | ${pct(t.earlierRead + t.earlierWrite)} |`);
	console.log(`… of which in requests at or after the session's first API-reported thinking drop (partly unbilled): ${usd(t.afterApiDrop)} (${pct(t.afterApiDrop)})`);
	console.log(`\nPolicy: drop earlier-turn thinking at cache-loss moments`);
	console.log(`cache-loss moments: ${t.losses}, with earlier-turn thinking to drop: ${t.lossesWithThinking}`);
	console.log(`saving: ${usd(t.savedRead)} reads + ${usd(t.savedWrite)} avoided rewrites = ${usd(t.savedRead + t.savedWrite)} (${pct(t.savedRead + t.savedWrite)} of Pi spend)`);
	console.log(`\n| cache-loss cause | moments | saving (that request and the ones after it until the next loss) |`);
	console.log(`|---|---|---|`);
	for (const [cause, v] of [...byCause].sort((a, b) => b[1].saved - a[1].saved)) console.log(`| ${cause} | ${v.losses} | ${usd(v.saved)} |`);
	console.log(`\nTop sessions by saving:`);
	console.log(`| session | cost | thinking cost | saving |`);
	console.log(`|---|---|---|---|`);
	for (const s of sessions.sort((a, b) => b.saved - a.saved).slice(0, 8)) console.log(`| ${s.id.slice(0, 13)} | ${usd(s.cost)} | ${usd(s.thinking)} | ${usd(s.saved)} |`);
}
