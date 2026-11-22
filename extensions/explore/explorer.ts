// The explorer: a cheap model (Haiku 5.5) in an in-process Pi session of its own, with full tools,
// that answers one question about the code at a time and reports the answer plus the line
// ranges the caller must see. Each calling session (and working directory) keeps a small pool: an
// idle explorer is reused, so it remembers what it read for earlier questions and its prompt cache
// stays warm; parallel calls get one explorer each, and a call beyond the pool's size waits for one.
// The pools live in process state, so a harness reload (which evaluates extensions anew) keeps them.
//
// Its session file sits next to the caller's and names it as parent. The call that created an
// explorer links its session (details.childSessions): the metrics index counts a linked session's
// whole cost once per link, so follow-ups to the same explorer do not link it again.
//
// Tools: read, grep, find, ls, bash (with a default timeout), edit, write, web_search, web_fetch and,
// below MAX_DEPTH, `explore` itself: an explorer can ask sub-explorers of its own pool. The files a
// run changes (edit, write, and the writes of bash commands per extensions/metrics/shell.ts) are
// reported to the caller. The explorer ends its run with
// `report`, whose result terminates the loop, so no closing turn is paid. An explorer that ends
// with text instead (Haiku wrote its report as a `<report>` text block, 2026-11-22) is asked once to
// call `report`. After `maxTurns` turns it is told to report; after `maxTurns + HARD_EXTRA` it is
// stopped. Without a report, its last text is the answer.

import { relative, resolve } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionFactory, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { shellEffect } from "../metrics/shell.ts";
import web from "../web/index.ts";
import { childSessionManager, createChildSession } from "../workflow/child-session.ts";
import { acquire, type Pool, poolKey, poolOf, release, remove, takePools } from "./pool.ts";
import { parseRangeLines, type Range } from "./ranges.ts";

export const EXPLORER_MODEL = "anthropic/claude-haiku-5-5";
/** Tool-loop turns after which the explorer is told to report what it has. */
export const MAX_TURNS = 24;
/** Turns past MAX_TURNS after which the explorer is stopped. */
const HARD_EXTRA = 6;
const BASH_TIMEOUT_S = 60;
/** The explorer's tools besides `report` (in-process) or `submit_result` (t3) and `explore`. */
export const EXPLORER_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "web_search", "web_fetch"];

export interface Report {
	answer: string;
	ranges: Range[];
	/** The explorer was stopped before it reported. */
	truncated?: boolean;
	/** Files the run changed, relative to the working directory; a bash command whose writes are unknown is listed as `bash: <command>`. */
	changed: string[];
}

/** The explorer's system prompt; `reporting` says how it reports (the in-process `report` tool, or t3's `submit_result`). */
export const systemPrompt = (reporting: string) => `You are a code explorer. Another agent (the caller) is working on a task in this repository and asks you one question at a time. You find the answer and report it.

How to work:
- Search broadly and fast: issue several independent tool calls (grep, find, ls, read, bash) in one response; follow references until you can answer.
- Prefer grep with context and reading whole small files over many small slices.
- You may run commands (tests, builds, scripts), search and fetch the web, change files when the question asks for a change, and ask \`explore\` (when you have it) to hand independent sub-questions to explorers of your own, in parallel. Other agents may work in the same checkout: change only what the question needs. The caller is told which files you changed.
- Answer only what was asked. Later questions may build on earlier ones: you remember what you read.

${reporting}
- answer: the facts the caller needs, concise (at most about 15 lines), with path:line references. Say plainly what you did not find.
- ranges: the code the caller must see verbatim to act (the lines it will change, the definitions and call sites its change depends on), one per line as \`path:start-end why\`, most important first. Tight ranges (a function, a block, 5 to 80 lines; a whole file only when small). The harness reads them and shows them to the caller, so do not copy code into the answer.`;

export const SYSTEM = systemPrompt("Then call `report` once, as the only call of its response:");

interface Explorer {
	session: Promise<AgentSession>;
	busy: boolean;
	/** Whether a call already linked its session (details.childSessions). */
	linked: boolean;
	/** The report of the run in progress (the first `report` call's). */
	report?: Omit<Report, "changed">;
	/** Files the run in progress changed. */
	changed: Set<string>;
}

export interface ExplorerEnv {
	cwd: string;
	agentDir: string;
	runtime: ModelRuntime;
	model: string;
	/** Where the caller's session files live, and the caller's file (the explorer's parent); in memory without. */
	sessionDir?: string;
	parentSessionFile?: string;
	maxTurns?: number;
	/** The `explore` extension for the explorer's own sub-explorers; none at the depth limit. */
	nested?: ExtensionFactory;
}

const state = globalThis as { __harnessExplorers?: Map<string, Pool<Explorer>> };
const pools: Map<string, Pool<Explorer>> = (state.__harnessExplorers ??= new Map());

/**
 * The report's arguments as they arrive. Haiku sometimes writes the `ranges` parameter into the
 * answer string (`…</answer>\n<parameter name="ranges">…`), and the field itself is then missing
 * (2026-11-22, through the gateway): such a tail is cut from the answer and read as the ranges.
 */
export function reportArguments(answer: string, ranges: string | undefined): { answer: string; ranges: string } {
	const leak = /\s*(?:<\/answer>\s*)?<parameter name="ranges">([^]*?)(?:<\/parameter>|<\/answer>|$)/.exec(answer);
	if (!leak) return { answer, ranges: ranges ?? "" };
	return { answer: answer.slice(0, leak.index).replace(/\s*<\/answer>\s*$/, "").trimEnd(), ranges: ranges?.trim() ? ranges : leak[1]!.replace(/<\/?(?:answer|parameter)[^>]*>/g, "").trim() };
}

/** A run's changes from one successful tool call: edit and write paths, the writes of a bash command, a sub-explorer's changes. */
function changesOf(toolName: string, input: Record<string, unknown>, details: unknown, cwd: string): string[] {
	const shown = (path: string) => relative(cwd, path) || ".";
	if (toolName === "explore") return (details as { changed?: string[] } | undefined)?.changed ?? [];
	if ((toolName === "edit" || toolName === "write") && typeof input.path === "string") return [shown(resolve(cwd, input.path))];
	if (toolName !== "bash" || typeof input.command !== "string") return [];
	const effect = shellEffect(input.command, cwd);
	if (!effect.mutates) return [];
	return effect.writes.length ? effect.writes.map(shown) : [`bash: ${input.command.length > 120 ? `${input.command.slice(0, 120)}…` : input.command}`];
}

/** The explorer extension inside the child session: the report tool, change tracking, the bash timeout. */
function explorerExtension(slot: () => Explorer) {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "report",
			label: "report",
			description: "Report the answer to the caller's question and the line ranges it must see. Call it alone, as the only call of its response: it ends your turn.",
			parameters: Type.Object({
				answer: Type.String({ description: "The facts the caller needs, concise, with path:line references." }),
				ranges: Type.Optional(Type.String({ description: "One range per line, most important first: `path:start-end why` (e.g. `src/a.ts:10-42 the parser`). Paths relative to the working directory or absolute. Empty when no code is needed." })),
			}),
			async execute(_id, params) {
				const explorer = slot();
				const done = { content: [{ type: "text" as const, text: "Reported." }], details: undefined, terminate: true };
				// Only the first report of a run counts (a later one in the same run repeats or contradicts it).
				if (explorer.report) return done;
				const args = reportArguments(params.answer, params.ranges);
				const { ranges, rejected } = parseRangeLines(args.ranges);
				// A malformed line is sent back: fixing it costs one turn, a lost range costs the caller a read.
				if (rejected.length) throw new Error(`These lines are not ranges (\`path:start-end why\`): ${rejected.map((r) => JSON.stringify(r)).join(", ")}. Call report again with them fixed or removed.`);
				explorer.report = { answer: args.answer, ranges };
				return done;
			},
		});
		pi.on("tool_call", (event) => {
			if (event.toolName !== "bash") return;
			const input = event.input as { timeout?: unknown };
			if (typeof input.timeout !== "number") input.timeout = BASH_TIMEOUT_S;
		});
		pi.on("tool_result", (event, ctx) => {
			if (event.isError) return;
			for (const path of changesOf(event.toolName, event.input, event.details, ctx.cwd)) slot().changed.add(path);
		});
	};
}

function createExplorer(env: ExplorerEnv, slot: () => Explorer): Promise<AgentSession> {
	return createChildSession({
		cwd: env.cwd,
		agentDir: env.agentDir,
		runtime: env.runtime,
		model: env.model,
		thinking: "low",
		systemPrompt: SYSTEM,
		sessionManager: childSessionManager(env.cwd, env.sessionDir, env.parentSessionFile),
		extensionFactories: [
			{ name: "explorer", factory: explorerExtension(slot) },
			{ name: "web", factory: web },
			...(env.nested ? [{ name: "explore", factory: env.nested }] : []),
		],
		tools: [...EXPLORER_TOOLS, "report", ...(env.nested ? ["explore"] : [])],
	});
}

function newExplorer(pool: Pool<Explorer>, env: ExplorerEnv): Explorer {
	const explorer: Explorer = { busy: true, linked: false, changed: new Set(), session: undefined as unknown as Promise<AgentSession> };
	explorer.session = createExplorer(env, () => explorer);
	// A session that failed to start is not kept.
	explorer.session.catch(() => remove(pool, explorer));
	return explorer;
}

const textOf = (message: { content: unknown }) =>
	Array.isArray(message.content) ? message.content.flatMap((c: { type: string; text?: string }) => (c.type === "text" ? [c.text ?? ""] : [])).join("\n") : "";

/** Ask an explorer of the calling session one question; resolves with its report, its session id and whether this call links it. */
export async function ask(sessionId: string, env: ExplorerEnv, question: string, signal?: AbortSignal): Promise<{ report: Report; sessionId: string; link: boolean; turns: number }> {
	const pool = poolOf(pools, poolKey(sessionId, env.cwd));
	const explorer = await acquire(pool, () => newExplorer(pool, env), signal);
	explorer.report = undefined;
	explorer.changed = new Set();
	try {
		const session = await explorer.session;
		signal?.throwIfAborted();
		const maxTurns = env.maxTurns ?? MAX_TURNS;
		let turns = 0;
		let stopped = false;
		const unsubscribe = session.subscribe((event) => {
			// The turn the abort ends is not counted.
			if (event.type !== "turn_end" || stopped) return;
			turns++;
			if (turns === maxTurns && !explorer.report) void session.steer(`You have used ${maxTurns} turns. Stop exploring and call report now with what you have.`);
			if (turns >= maxTurns + HARD_EXTRA && !explorer.report && !stopped) {
				stopped = true;
				void session.abort();
			}
		});
		const abort = () => void session.abort();
		signal?.addEventListener("abort", abort, { once: true });
		const before = session.messages.length;
		/** The result; the first successful call links the explorer's session. */
		const result = (report: Omit<Report, "changed">) => {
			const link = !explorer.linked;
			explorer.linked = true;
			return { report: { ...report, changed: [...explorer.changed] }, sessionId: session.sessionId, link, turns };
		};
		type Last = { content: unknown; stopReason?: string; errorMessage?: string } | undefined;
		const lastReply = () => session.messages.slice(before).findLast((m) => m.role === "assistant") as Last;
		const failed = (last: Last) => !stopped && (last?.stopReason === "error" || last?.stopReason === "aborted");
		try {
			await session.prompt(question);
			signal?.throwIfAborted();
			if (!explorer.report && !stopped && !failed(lastReply())) {
				await session.prompt("You answered in text. Call the `report` tool now, as the only call of your response, with that answer and the ranges.");
				signal?.throwIfAborted();
			}
			if (explorer.report) return result(explorer.report);
			const last = lastReply();
			if (failed(last)) throw new Error(`The explorer failed: ${last!.errorMessage ?? last!.stopReason}`);
			// Without a report (it answered in text, or was stopped): its last text is the answer, without ranges.
			const text = last ? textOf(last) : "";
			return result({ answer: text || "(the explorer gave no answer)", ranges: [], ...(stopped ? { truncated: true } : {}) });
		} finally {
			unsubscribe();
			signal?.removeEventListener("abort", abort);
			// A steer that arrived after the run's last turn would start the next question.
			session.clearQueue();
		}
	} finally {
		release(pool, explorer);
	}
}

/** Stop and drop the calling session's explorers (its session ended), and their sub-explorers: dispose() emits no session_shutdown. */
export function disposeExplorers(sessionId: string): void {
	for (const pool of takePools(pools, sessionId)) {
		for (const e of pool.members)
			void e.session.then(
				(s) => {
					disposeExplorers(s.sessionId);
					return s.abort().finally(() => s.dispose());
				},
				() => undefined,
			);
	}
}
