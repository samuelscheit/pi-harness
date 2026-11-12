// Resume-versus-new for every subagent started in scope (economics in ../efficiency.ts).

import { type AgentState, cacheWarm, type Child, resumeCost } from "../efficiency.ts";
import { type Row, type Scope, titleSql, titleOf } from "./scope.ts";

// A subagent with a request this soon after a delegation was still working, so it could not take it.
const BUSY_MS = 2 * 60_000;
// A child session starts at most this long before the parent's call is recorded (the call's
// timestamp is the assistant message that made it).
const START_SLACK_MS = 60_000;

/**
 * The session a delegation (alias `d`) started: the first session with its task that began after
 * it (the same task can run twice).
 */
export const DELEGATED_CHILD = `(SELECT c.id FROM sessions c WHERE c.prompt_digest = d.task_digest AND c.started_at >= d.ts - ${START_SLACK_MS} ORDER BY c.started_at LIMIT 1)`;

export interface Alternative {
	child: string;
	title: string;
	contextTokens: number;
	idleMs: number;
	warm: boolean;
	/** Estimated cost of doing the work in that earlier subagent instead. */
	cost: number;
}

export interface SubagentRow {
	child: string;
	parent: string;
	title: string;
	ts: number;
	requests: number;
	cost: number;
	wallMs: number;
	/** What its first request paid to write its base prompt, tools and brief. */
	startupCost: number;
	/** Calls whose files the parent or an earlier subagent had already touched. */
	rediscovered: { calls: number; tokens: number; cost: number };
	/** The cheapest idle earlier subagent of the same parent, when there was one. */
	alternative: Alternative | null;
	/** New cost minus resume cost: positive when resuming would have saved. */
	difference: number;
}

export interface Subagents {
	started: number;
	cost: number;
	/** Earlier subagents messaged again (t3_thread_send, SendMessage). */
	resumes: number;
	rediscoveryCost: number;
	/** Delegations where an idle earlier subagent existed. */
	compared: number;
	resumeWins: number;
	/** Cost had each delegation taken the cheaper choice. */
	bestCost: number;
	rows: SubagentRow[];
}

interface TurnRow {
	ts: number;
	prompt: number;
	write: number;
	input: number;
	inputRate: number;
	readRate: number;
	writeRate: number;
	long: boolean;
}

export function subagents(scope: Scope): Subagents {
	const delegations = scope.all(
		`SELECT d.session_id parent, d.ts, d.title, c.id child, c.started_at, c.ended_at, c.cost, ${titleSql("c")} child_title
		FROM delegations d JOIN sessions c ON c.id = ${DELEGATED_CHILD}
		WHERE d.kind = 'delegate' AND ${scope.where("d", "ts")} ORDER BY d.ts`,
	);
	const resumes = Number(scope.get(`SELECT COUNT(*) n FROM delegations d WHERE d.kind = 'send' AND ${scope.where("d", "ts")}`).n);
	const result: Subagents = { started: 0, cost: 0, resumes, rediscoveryCost: 0, compared: 0, resumeWins: 0, bestCost: 0, rows: [] };
	if (delegations.length === 0) return result;

	// Each session's turns and touched files are loaded once.
	const turnCache = new Map<string, TurnRow[]>();
	const turnsOf = (session: string) => {
		let turns = turnCache.get(session);
		if (!turns) {
			turns = scope
				.all(
					`SELECT ts, prompt_tokens, cache_write, input, input_rate, read_rate, write_rate, long_retention FROM requests
					WHERE session_id = $id AND kind = 'turn' ORDER BY ts`,
					{ $id: session },
				)
				.map((t) => ({
					ts: Number(t.ts),
					prompt: Number(t.prompt_tokens),
					write: Number(t.cache_write),
					input: Number(t.input),
					inputRate: Number(t.input_rate),
					readRate: Number(t.read_rate),
					writeRate: Number(t.write_rate),
					long: Number(t.long_retention) === 1,
				}));
			turnCache.set(session, turns);
		}
		return turns;
	};
	const fileCache = new Map<string, { ts: number; file: string }[]>();
	const filesOf = (session: string) => {
		let files = fileCache.get(session);
		if (!files) {
			files = scope.all("SELECT ts, file FROM tool_files WHERE session_id = $id", { $id: session }).map((f) => ({ ts: Number(f.ts), file: String(f.file) }));
			fileCache.set(session, files);
		}
		return files;
	};

	const earlier = new Map<string, { title: string; child: string }[]>();
	const seen = new Set<string>();
	for (const d of delegations) {
		const child = String(d.child);
		if (seen.has(child)) continue;
		seen.add(child);
		const turns = turnsOf(child);
		if (turns.length === 0) continue;
		const first = turns[0]!;
		const parent = String(d.parent);
		const title = d.title ? String(d.title) : titleOf(d.child_title, child);
		const siblings = earlier.get(parent) ?? [];
		earlier.set(parent, [...siblings, { title, child }]);

		const start = Number(d.started_at);
		const known = new Set<string>();
		for (const session of [parent, ...siblings.map((s) => s.child)]) {
			for (const f of filesOf(session)) if (f.ts < start) known.add(f.file);
		}
		const rediscovered = { calls: 0, tokens: 0, cost: 0 };
		for (const call of scope.all<Row>(
			`SELECT r.tokens, r.lifetime_cost, GROUP_CONCAT(f.file, char(10)) files FROM tool_results r
			JOIN tool_files f ON f.session_id = r.session_id AND f.call_id = r.call_id WHERE r.session_id = $id GROUP BY r.call_id`,
			{ $id: child },
		)) {
			if (!String(call.files).split("\n").every((file) => known.has(file))) continue;
			rediscovered.calls += 1;
			rediscovered.tokens += Number(call.tokens);
			rediscovered.cost += Number(call.lifetime_cost);
		}
		const spec: Child = {
			cost: Number(d.cost),
			requests: turns.length,
			baseTokens: first.prompt,
			startupCost: first.write * first.writeRate + first.input * first.inputRate,
			rediscoveryCost: rediscovered.cost,
			readRate: first.readRate,
			writeRate: first.writeRate,
		};

		// The cheapest earlier subagent of the same parent to have resumed instead.
		const at = Number(d.ts);
		let alternative: Alternative | null = null;
		for (const sibling of siblings) {
			const siblingTurns = turnsOf(sibling.child);
			const last = siblingTurns.findLast((t) => t.ts <= at);
			// A sibling still working at that moment could not have taken the task.
			if (!last || siblingTurns.some((t) => t.ts > at && t.ts <= at + BUSY_MS)) continue;
			const agent: AgentState = { contextTokens: last.prompt, lastTs: last.ts, longRetention: last.long };
			const cost = resumeCost(spec, agent, at);
			if (!alternative || cost < alternative.cost) {
				alternative = { child: sibling.child, title: sibling.title, contextTokens: last.prompt, idleMs: at - last.ts, warm: cacheWarm(agent, at), cost };
			}
		}
		result.started += 1;
		result.cost += spec.cost;
		result.bestCost += Math.min(spec.cost, alternative?.cost ?? Infinity);
		result.rediscoveryCost += rediscovered.cost;
		if (alternative) result.compared += 1;
		if (alternative && alternative.cost < spec.cost) result.resumeWins += 1;
		result.rows.push({
			child,
			parent,
			title,
			ts: at,
			requests: turns.length,
			cost: spec.cost,
			wallMs: Number(d.ended_at) - start,
			startupCost: spec.startupCost,
			rediscovered,
			alternative,
			difference: alternative ? spec.cost - alternative.cost : 0,
		});
	}
	return result;
}
