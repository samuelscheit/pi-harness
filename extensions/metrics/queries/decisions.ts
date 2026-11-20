// The compaction decider's decisions (extensions/context-limit/decider.ts) by framing: how each
// framing answers, how often two framings asked at the same moment disagree (a framing that flips
// the decision means the wording decides, not the evidence), and what followed each decision:
//
// - after "compact": the files of the summarized part the session touched again within
//   REREAD_TURNS turns (it needed them after all), and the result tokens those calls brought back;
// - after "keep": what carrying the context cost until the next decision or compaction, beyond
//   what a compacted context would have carried (an upper bound of what compacting would have saved,
//   re-reads not counted).

import { FRAMINGS } from "../../context-limit/decider.ts";
import type { Scope } from "./scope.ts";

export const REREAD_TURNS = 50;
/** What a compacted context is assumed to carry: the kept recent tokens and the summary. */
const COMPACTED_TOKENS = 23_000;

interface StoredAnswer {
	framing: string;
	decision: "compact" | "keep" | null;
}

export interface FramingAnswers {
	framing: string;
	asked: number;
	/** Answers that were valid. */
	answered: number;
	/** Valid answers that said compact. */
	compact: number;
}

export interface FramingOutcomes {
	framing: string;
	/** Decisions this framing made (it acted). */
	decisions: number;
	compacted: number;
	/** Compactions after which a summarized file was touched again, and the result tokens of those calls. */
	reread: number;
	rereadTokens: number;
	/** Dollars carrying the full context cost after its "keep" decisions. */
	keepCost: number;
}

export interface FramingPair {
	pair: [string, string];
	/** What differs between the two: the option order, whether costs are shown, or both. */
	differs: "order" | "costs" | "both";
	/** Moments both answered validly, and those where they disagreed. */
	both: number;
	disagree: number;
}

export interface DecisionStats {
	decisions: number;
	answers: FramingAnswers[];
	outcomes: FramingOutcomes[];
	pairs: FramingPair[];
}

/** Whether two paths name the same file: tool calls name files relative or absolute. */
const sameFile = (a: string, b: string) => a === b || a.endsWith(`/${b.replace(/^\.\//, "")}`) || b.endsWith(`/${a.replace(/^\.\//, "")}`);

const factor = (framing: string) => ({ costs: framing.startsWith("costs"), first: framing.endsWith("compact-first") ? "compact" : "keep" });

export function compactionDecisions(scope: Scope): DecisionStats {
	const rows = scope.all<{ session_id: string; entry_id: string; ts: number; acting: string | null; decision: string; answers: string; files: string }>(
		`SELECT d.session_id, d.entry_id, d.ts, d.acting, d.decision, d.answers, d.files FROM compaction_decisions d WHERE ${scope.where("d", "ts")} ORDER BY d.session_id, d.ts`,
	);
	const answers = new Map(FRAMINGS.map((f) => [f as string, { framing: f as string, asked: 0, answered: 0, compact: 0 }]));
	const outcomes = new Map(FRAMINGS.map((f) => [f as string, { framing: f as string, decisions: 0, compacted: 0, reread: 0, rereadTokens: 0, keepCost: 0 }]));
	const pairs = new Map<string, FramingPair>();

	const turnsOf = scope.db.prepare("SELECT ts, prompt_tokens, read_rate FROM requests WHERE session_id = ? AND kind = 'turn' AND ts > ? ORDER BY ts");
	const boundary = scope.db.prepare(
		`SELECT MIN(ts) ts FROM (SELECT ts FROM compactions WHERE session_id = $s AND ts > $t UNION ALL SELECT ts FROM compaction_decisions WHERE session_id = $s AND ts > $t)`,
	);
	const touched = scope.db.prepare(
		`SELECT f.file, t.tokens FROM tool_files f JOIN tool_results t ON t.session_id = f.session_id AND t.call_id = f.call_id
		WHERE f.session_id = ? AND f.ts > ? AND f.ts <= ?`,
	);

	for (const row of rows) {
		const asked = JSON.parse(row.answers) as StoredAnswer[];
		for (const a of asked) {
			const stats = answers.get(a.framing);
			if (!stats) continue;
			stats.asked++;
			if (a.decision) stats.answered++;
			if (a.decision === "compact") stats.compact++;
		}
		const valid = asked.filter((a) => a.decision);
		if (valid.length === 2) {
			const [x, y] = [valid[0]!.framing, valid[1]!.framing].sort() as [string, string];
			const fx = factor(x);
			const fy = factor(y);
			const differs = fx.costs !== fy.costs && fx.first !== fy.first ? "both" : fx.costs !== fy.costs ? "costs" : "order";
			const pair = pairs.get(`${x}\0${y}`) ?? pairs.set(`${x}\0${y}`, { pair: [x, y], differs, both: 0, disagree: 0 }).get(`${x}\0${y}`)!;
			pair.both++;
			if (valid[0]!.decision !== valid[1]!.decision) pair.disagree++;
		}

		const outcome = row.acting ? outcomes.get(row.acting) : undefined;
		if (!outcome) continue;
		outcome.decisions++;
		const turns = turnsOf.all(row.session_id, row.ts) as { ts: number; prompt_tokens: number; read_rate: number | null }[];
		if (row.decision === "compact") {
			outcome.compacted++;
			const files = JSON.parse(row.files) as string[];
			const end = turns[Math.min(turns.length, REREAD_TURNS) - 1]?.ts ?? row.ts;
			const again = (touched.all(row.session_id, row.ts, end) as { file: string; tokens: number }[]).filter((t) => files.some((f) => sameFile(t.file, f)));
			if (again.length) outcome.reread++;
			outcome.rereadTokens += again.reduce((sum, t) => sum + t.tokens, 0);
		} else {
			const until = (boundary.get({ $s: row.session_id, $t: row.ts }) as { ts: number | null }).ts ?? Number.POSITIVE_INFINITY;
			for (const turn of turns) {
				if (turn.ts >= until) break;
				outcome.keepCost += Math.max(0, turn.prompt_tokens - COMPACTED_TOKENS) * (turn.read_rate ?? 0);
			}
		}
	}
	return { decisions: rows.length, answers: [...answers.values()], outcomes: [...outcomes.values()], pairs: [...pairs.values()].sort((a, b) => b.both - a.both) };
}
