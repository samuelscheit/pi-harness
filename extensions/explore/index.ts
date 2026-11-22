// `explore`: the caller asks a cheap explorer model (explorer.ts) one question about the code; the
// explorer works in its own small context (with full tools, sub-explorers included, up to
// MAX_DEPTH levels) and reports an answer plus the line ranges the caller
// must see, which the harness reads and returns verbatim under a token budget (ranges.ts). The
// caller pays one turn for what was a run of read-only turns, each re-reading its whole context.
// Motivation and simulation: docs/research/context-engineering/10-turns-in-our-sessions.md §7.
//
// Inactive by default: the `explore` experiment (prompt/experiments/explore.md) switches it on for
// arm B. While it is active, the result of a call reading code in a turn right after a turn that
// only read code gets a one-line hint to ask `explore` instead, once per stretch of such turns (§2
// there: a prompt rule alone did not change how the model reads). The hint is appended when the
// result is recorded, so it is part of the cached prefix like any result.
//
// Its calls stay in the foreground (extensions/background WAITING_TOOLS): its result is what the
// caller needs next, and only a result recorded as the call's own keeps the dedupe and the link to
// the explorer's session.

import { type ExtensionAPI, type ExtensionContext, getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { callKind } from "../lib/call-kind.ts";
import { shellEffect } from "../metrics/shell.ts";
import { delegationsDir, parseMarker, readSpec } from "../workflow/delegation.ts";
import { contextT3 } from "../workflow/t3.ts";
import { ask, disposeExplorers, EXPLORER_MODEL } from "./explorer.ts";
import { renderSelection, type Shown, selectRanges } from "./ranges.ts";
import { askT3, disposeT3Explorers } from "./t3-explorer.ts";

export const EXPLORE_TOOL = "explore";
export const DEFAULT_BUDGET = 12_000;
/** Explorer levels below the calling agent: an explorer at this depth has no `explore` of its own. */
export const MAX_DEPTH = 3;
export const HINT = `Hint: this is another turn reading code right after one. If more reading follows, ask \`${EXPLORE_TOOL}\` one question instead: a cheap model searches in its own context and returns the answer with the exact code ranges, for one turn of yours.`;

export interface ExploreOptions {
	modelRuntime?: () => Promise<ModelRuntime>;
	agentDir?: string;
	model?: string;
	/** Explorer turns before it is told to report (tests). */
	maxTurns?: number;
	/** Explorer levels above the session this extension runs in: 0 in the calling agent; without, a t3 explorer child's spec says. */
	depth?: number;
}

export interface ExploreDetails {
	shown: Shown[];
	/** The explorer's session, on the first call it answered only: the index counts a linked session's whole cost per link. */
	childSessions: string[];
	/** The explorer's session id, or in t3 its thread's link. */
	explorer: string;
	/** Its tool-loop turns; in t3 the runs (messages) of its thread. */
	turns: number;
	/** Files the explorer changed. */
	changed: string[];
}

// Process state, so a reload (which evaluates the extension anew) keeps the runtime.
const processState = globalThis as { __harnessExploreRuntime?: Promise<ModelRuntime> };

/** Ranges earlier explore calls returned that are still in the caller's context (after its last compaction). */
function seenRanges(ctx: ExtensionContext): Shown[] {
	const branch = ctx.sessionManager.getBranch();
	const since = branch.findLastIndex((e) => e.type === "compaction");
	const seen: Shown[] = [];
	for (const entry of branch.slice(since + 1)) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role: string; toolName?: string; details?: Partial<ExploreDetails> };
		if (message.role === "toolResult" && message.toolName === EXPLORE_TOOL) seen.push(...(message.details?.shown ?? []));
	}
	return seen;
}

const CODE_TOOLS = new Set(["read", "grep", "find", "ls"]);
const NOT_CODE = /https?:\/\/|\b(?:curl|wget|gh)\s/;

/** A call that reads code, what `explore` can do instead (not web research, GitHub or other read-only calls). */
const readingCode = (name: string, input: Record<string, unknown>, cwd: string) => {
	if (CODE_TOOLS.has(name)) return true;
	if (name !== "bash" || typeof input.command !== "string") return false;
	const command = input.command;
	return !NOT_CODE.test(command) && callKind(name, command, shellEffect(command, cwd).mutates) === "explore";
};

export default function explore(pi: ExtensionAPI, options: ExploreOptions = {}) {
	const runtime = options.modelRuntime ?? (() => (processState.__harnessExploreRuntime ??= ModelRuntime.create()));
	const agentDir = options.agentDir ?? getAgentDir();
	const model = options.model ?? EXPLORER_MODEL;
	/** The session's level: the option (in-process explorers), else the delegation spec of a t3 explorer child (its first-run marker). */
	const depths = new Map<string, number>();
	const depthOf = (ctx: ExtensionContext): number => {
		if (options.depth !== undefined) return options.depth;
		const id = ctx.sessionManager.getSessionId();
		const known = depths.get(id);
		if (known !== undefined) return known;
		let depth = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const content = entry.message.content;
			const text = typeof content === "string" ? content : content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
			const marker = parseMarker(text);
			if (marker?.run === 1) depth = readSpec(delegationsDir(agentDir), marker.id)?.exploreDepth ?? depth;
		}
		depths.set(id, depth);
		return depth;
	};

	pi.registerTool({
		name: EXPLORE_TOOL,
		label: "Explore",
		defaultActive: false,
		description: [
			"Ask a cheap explorer model one question about the code (where something is, how it works, what a change must touch).",
			"It works in its own context and returns a concise answer plus the exact code ranges you need, read verbatim from the files, under a token budget.",
			"It has full tools: it can run commands (tests, builds), search the web, change files when you ask for a change (the result lists the files it changed), and ask sub-explorers.",
			"It remembers earlier questions of this session, so follow-ups are cheap; independent questions can run in parallel.",
		].join(" "),
		promptSnippet: "Ask a cheap explorer model a question about the code; get the answer and the exact code ranges",
		promptGuidelines: [
			`Before reading code yourself, ask \`${EXPLORE_TOOL}\` when finding or understanding it would take more than one read or search: locating code, tracing calls and references, collecting what a change must touch. One specific question per call; ask follow-ups instead of reading on yourself. Read yourself only a single range you already know.`,
			`The ranges \`${EXPLORE_TOOL}\` returns are the files' exact current text: edit from them directly, without reading them again.`,
		],
		parameters: Type.Object({
			question: Type.String({ description: "One specific question, with what you need it for (e.g. 'Where is the session's cost computed and which callers pass it to the UI? I need to add a currency field.')." }),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Files or directories to start from, if you know them." })),
			budget_tokens: Type.Optional(Type.Integer({ minimum: 500, maximum: 60_000, description: `Most tokens of code ranges to return, default ${DEFAULT_BUDGET}.` })),
		}),
		async execute(_callId, params, signal, _onUpdate, ctx) {
			const session = ctx.sessionManager;
			const parentSessionFile = session.getSessionFile();
			const question = params.paths?.length ? `${params.question}\n\nStart from: ${params.paths.join(", ")}` : params.question;
			const depth = depthOf(ctx);
			const nestedAllowed = depth + 1 < MAX_DEPTH;
			// Inside t3 the explorer is a t3 child thread the user can watch; else an in-process session.
			const t3 = contextT3(ctx, agentDir);
			const asked = t3
				? await askT3(session.getSessionId(), { t3, cwd: ctx.cwd, agentDir, depth, nested: nestedAllowed, ...(options.model ? { model } : {}) }, question, signal)
				: await (async () => {
						const modelRuntime = await runtime();
						signal?.throwIfAborted();
						const nested = nestedAllowed ? (child: ExtensionAPI) => explore(child, { ...options, depth: depth + 1 }) : undefined;
						const result = await ask(
							session.getSessionId(),
							{
								cwd: ctx.cwd,
								agentDir,
								runtime: modelRuntime,
								model,
								...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
								...(nested ? { nested } : {}),
								...(parentSessionFile ? { sessionDir: session.getSessionDir(), parentSessionFile } : {}),
							},
							question,
							signal,
						);
						return { ...result, explorer: result.sessionId };
					})();
			const { report, sessionId, link, turns } = asked;
			const selection = selectRanges(ctx.cwd, report.ranges, params.budget_tokens ?? DEFAULT_BUDGET, seenRanges(ctx));
			const details: ExploreDetails = { shown: selection.shown.map(({ path, start, end, hash }) => ({ path, start, end, hash })), childSessions: link ? [sessionId] : [], explorer: asked.explorer, turns, changed: report.changed };
			const answer = [
				...(report.truncated ? [`[The explorer was stopped after ${turns} turns without a report; its last words:]`] : []),
				report.answer,
				...(report.changed.length ? [`\n[The explorer changed: ${report.changed.join(", ")}]`] : []),
			].join("\n");
			return { content: [{ type: "text", text: renderSelection(answer, selection) }], details };
		},
	});

	// The hint, once per stretch of turns that only read code. It never touches a `goal` result (not
	// reading code), whose `terminate` a content change would keep anyway (afterToolCall merges fields).
	const stretches = new Map<string, { previous: boolean; hinted: boolean }>();
	const stretchOf = (id: string) => stretches.get(id) ?? stretches.set(id, { previous: false, hinted: false }).get(id)!;
	pi.on("tool_result", (event, ctx) => {
		// Explorers get no hint: delegating their reading again costs more than reading.
		if (depthOf(ctx) > 0 || event.parentToolCallId !== undefined || event.isError || event.toolName === EXPLORE_TOOL) return;
		if (!pi.getActiveTools().includes(EXPLORE_TOOL)) return;
		const stretch = stretchOf(ctx.sessionManager.getSessionId());
		if (!stretch.previous || stretch.hinted || !readingCode(event.toolName, event.input, ctx.cwd)) return;
		stretch.hinted = true;
		return { content: [...event.content, { type: "text", text: `\n\n${HINT}` }] };
	});
	pi.on("turn_end", (event, ctx) => {
		const stretch = stretchOf(ctx.sessionManager.getSessionId());
		const calls = event.message.role === "assistant" ? event.message.content.filter((c) => c.type === "toolCall") : [];
		stretch.previous = calls.length > 0 && calls.every((c) => readingCode(c.name, c.arguments as Record<string, unknown>, ctx.cwd));
		if (!stretch.previous) stretch.hinted = false;
	});
	pi.on("session_shutdown", (event, ctx) => {
		if (event.reason === "reload") return;
		const id = ctx.sessionManager.getSessionId();
		stretches.delete(id);
		depths.delete(id);
		disposeExplorers(id);
		disposeT3Explorers(id, agentDir);
	});
}
