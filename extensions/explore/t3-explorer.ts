// The explorer inside t3: when the calling session runs in t3 (it has t3's delegate_task), each
// explorer is a t3 delegated task, a Pi thread of its own under the calling thread that the user can
// watch, steer and stop, instead of a hidden in-process session (explorer.ts). Same model, prompt
// and tools; it reports through the harness's delegation protocol (workflow/delegation.ts):
// `submit_result` with {answer, ranges, changed}, read back from the delegation's state file, whose
// `wrote` names the files its own tool calls changed.
//
// The pools are the in-process ones' (pool.ts): an idle explorer gets the next question as a new
// message in its thread (workflow/t3.ts T3Child: delegate_task first, t3_thread_send after), so it
// remembers earlier questions. A report with malformed range lines is sent back once, as the
// in-process `report` tool does. An aborted call cancels the task and drops the explorer: its
// thread may hold a half-done run.
//
// Depth: the explorer's spec carries its level (`exploreDepth`); the explore extension in the
// child's Pi reads it (index.ts depthOf), and only an explorer below MAX_DEPTH gets `explore`.
//
// No turn limit is enforced as in-process (t3 runs the child's loop); the prompt asks for a short
// search instead, and the user can stop a runaway thread in t3.

import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import { canonical } from "../lib/workspace.ts";
import { type DelegationSpec, type DelegationState, delegationMessage, delegationsDir, readSpec, readState, removeDelegation, touchSpec, writeSpec } from "../workflow/delegation.ts";
import { type T3, T3Child } from "../workflow/t3.ts";
import { EXPLORER_MODEL, EXPLORER_TOOLS, MAX_TURNS, type Report, reportArguments, systemPrompt } from "./explorer.ts";
import { acquire, type Pool, poolKey, poolOf, release, remove, takePools } from "./pool.ts";
import { parseRangeLines } from "./ranges.ts";

/** How long the child's state file may lag behind the end of its t3 run. */
export const STATE_WAIT_MS = 10_000;

export const T3_SYSTEM = systemPrompt(
	`Keep it short: at most about ${MAX_TURNS} tool turns. Then call \`submit_result\` once, as the only call of its response, and end with one short line:
- changed: only the files your sub-explorers (\`explore\`) reported changing; your own edits are tracked.`,
);

export const REPORT_SCHEMA = {
	type: "object",
	properties: {
		answer: { type: "string", description: "The facts the caller needs, concise, with path:line references." },
		ranges: { type: "string", description: "One range per line, most important first: `path:start-end why` (e.g. `src/a.ts:10-42 the parser`). Paths relative to the working directory or absolute. Empty when no code is needed." },
		changed: { type: "array", items: { type: "string" }, description: "Files your sub-explorers reported changing." },
	},
	// `ranges` optional, as `report`'s: Haiku folds it into `answer` at times (reportArguments recovers it), and a
	// required one failed submit_result's validation on every attempt (2026-11-23, a live t3 explorer).
	required: ["answer"],
} as const;

interface T3Explorer {
	busy: boolean;
	linked: boolean;
	spec: DelegationSpec;
	/** Created on the first run, titled after its question. */
	child?: T3Child;
	runs: number;
}

export interface T3ExplorerEnv {
	t3: T3;
	cwd: string;
	agentDir: string;
	/** The calling session's level: 0 for the agent, n inside an explorer at level n. */
	depth: number;
	/** Whether the explorer gets `explore` of its own. */
	nested: boolean;
	model?: string;
	stateWaitMs?: number;
}

const state = globalThis as { __harnessT3Explorers?: Map<string, Pool<T3Explorer>> };
const pools: Map<string, Pool<T3Explorer>> = (state.__harnessT3Explorers ??= new Map());

const headline = (text: string) => (text.split("\n").find((line) => line.trim()) ?? "").trim();

function newExplorer(sessionId: string, env: T3ExplorerEnv): T3Explorer {
	const spec: DelegationSpec = {
		id: randomUUID(),
		system: T3_SYSTEM,
		tools: [...EXPLORER_TOOLS, ...(env.nested ? ["explore"] : [])],
		schema: REPORT_SCHEMA as unknown as Record<string, unknown>,
		callerSessionId: sessionId,
		exploreDepth: env.depth + 1,
	};
	writeSpec(delegationsDir(env.agentDir), spec);
	return { busy: true, linked: false, spec, runs: 0 };
}

/** The child's state once run `n` is done; undefined when it does not report it in time. */
async function finalState(dir: string, id: string, n: number, waitMs: number, signal: AbortSignal): Promise<DelegationState | undefined> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		const current = readState(dir, id);
		if (current && (current.run > n || (current.run === n && current.done))) return current;
		if (Date.now() >= deadline || signal.aborted) return undefined;
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** Ask a t3 explorer of the calling session one question; resolves like explorer.ts `ask`, `turns` counting the thread's runs. */
export async function askT3(sessionId: string, env: T3ExplorerEnv, question: string, signal: AbortSignal = new AbortController().signal): Promise<{ report: Report; sessionId: string; explorer: string; link: boolean; turns: number }> {
	const dir = delegationsDir(env.agentDir);
	const pool = poolOf(pools, poolKey(sessionId, env.cwd));
	const explorer = await acquire(pool, () => newExplorer(sessionId, env), signal);
	let usable = true;
	const cancel = () => explorer.child?.cancel("the explore call was aborted");
	signal.addEventListener("abort", cancel, { once: true });
	try {
		let turns = 0;
		const run = async (message: string) => {
			const n = ++explorer.runs;
			turns++;
			// The child reads its spec on every run; the sweep of day-old files may have taken it.
			if (readSpec(dir, explorer.spec.id)) touchSpec(dir, explorer.spec.id);
			else writeSpec(dir, explorer.spec);
			explorer.child ??= new T3Child(env.t3, { title: `explore: ${headline(question).slice(0, 60)}`, role: "research", target: { providerInstanceId: "pi", model: env.model ?? EXPLORER_MODEL, options: { thinking: "low" } } });
			await explorer.child.run(delegationMessage(explorer.spec, n, message), `${explorer.spec.id}-run-${n}`, signal, () => undefined);
			const done = await finalState(dir, explorer.spec.id, n, env.stateWaitMs ?? STATE_WAIT_MS, signal);
			signal.throwIfAborted();
			if (!done || done.run !== n) throw new Error(`The explorer reported no end of its run (t3 thread ${explorer.child.link ?? explorer.child.threadId}, status ${explorer.child.status || "unknown"}${explorer.child.summary ? `: ${explorer.child.summary.slice(0, 300)}` : ""})`);
			if (done.error) throw new Error(`The explorer failed: ${done.error}`);
			return done;
		};
		let done = await run(question);
		const result = () => (done.result ?? {}) as { answer?: unknown; ranges?: unknown; changed?: unknown };
		const reported = () => reportArguments(String(result().answer ?? ""), typeof result().ranges === "string" ? (result().ranges as string) : undefined);
		let parsed = parseRangeLines(reported().ranges);
		// A malformed line is sent back once: fixing it costs one run, a lost range costs the caller a read.
		if (parsed.rejected.length) {
			done = await run(`These lines are not ranges (\`path:start-end why\`): ${parsed.rejected.map((r) => JSON.stringify(r)).join(", ")}. Call submit_result again with them fixed or removed.`);
			parsed = parseRangeLines(reported().ranges);
		}
		const base = canonical(env.cwd);
		const own = (done.wrote ?? []).map((path) => relative(base, path) || ".");
		const sub = Array.isArray(result().changed) ? (result().changed as unknown[]).filter((p): p is string => typeof p === "string") : [];
		const link = !explorer.linked;
		explorer.linked = true;
		return {
			report: { answer: reported().answer || "(the explorer gave no answer)", ranges: parsed.ranges, changed: [...new Set([...own, ...sub])] },
			sessionId: done.sessionId,
			explorer: explorer.child!.link ?? explorer.child!.threadId!,
			link,
			turns,
		};
	} catch (error) {
		// An aborted or failed run may leave the thread mid-run: it serves no further question.
		usable = false;
		if (!signal.aborted) explorer.child?.cancel("the explore call failed");
		throw error;
	} finally {
		signal.removeEventListener("abort", cancel);
		if (usable) release(pool, explorer);
		else {
			remove(pool, explorer);
			removeDelegation(dir, explorer.spec.id);
		}
	}
}

/** Drop the calling session's t3 explorers (its session ended): their delegation files go; their threads stay in t3. */
export function disposeT3Explorers(sessionId: string, agentDir: string): void {
	for (const pool of takePools(pools, sessionId))
		for (const e of pool.members) {
			if (e.busy) e.child?.cancel("the calling session ended");
			removeDelegation(delegationsDir(agentDir), e.spec.id);
		}
}
