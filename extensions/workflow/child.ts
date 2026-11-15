// The child side of a harness delegation (see delegation.ts for the protocol): in a session whose
// user messages carry a first-run delegation marker whose spec exists (the latest one counts: a
// forked child carries its source's too), this
// - replaces the base prompt with the spec's system prompt and makes its tools the active set
//   (activating inactive ones), each only when the spec has it; a tool name the session does not
//   have fails the run before any request;
// - with a schema, offers `submit_result`, whose parameters are the schema, so Pi validates the
//   result like any tool call and a wrong shape goes back to the child as an error; a run may not
//   settle without a submitted result: `agent_before_settle` sends a reminder and continues, at most
//   MAX_REMINDERS times, then the run fails. Each run needs its own result. The run's final message
//   ends with the result as JSON (RESULT_HEADING), so it reaches whoever reads the task's result
//   (t3's summary, the parent's wake message); a submitted result releases the session's background
//   jobs (../background/work.ts `releaseWork`), so t3 delivers it without waiting for them, and the
//   next run (by the parent or the user) holds them again until it submits;
// - reports its state (session, cost, the run's text, result or error, compactions) to the parent.
//
// The workflow extension wires this into every harness session (a t3 delegated child is one), and
// delegate() into its in-process children. Everything is derived from the session and the state
// file, so it survives a harness reload and a restart of the child's Pi.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { sessionJobs } from "../background/jobs.ts";
import { releaseWork } from "../background/work.ts";
import { TOOL_GUIDELINES_SECTION, toolGuidelinesSection } from "../prompt/index.ts";
import { type DelegationSpec, type DelegationState, parseMarker, readSpec, readState, SUBMIT_TOOL, writeState } from "./delegation.ts";

export const REMINDER_TYPE = "delegation-result";
/** Starts the result a run's final message ends with; the run's text is what comes before it. */
export const RESULT_HEADING = `\n\nResult (${SUBMIT_TOOL}):\n\`\`\`json\n`;
/** A run's error when it was stopped (cancelled) before it finished. */
export const RUN_STOPPED = "the run was stopped";
/** Reminders to submit the result before a run without one fails. */
export const MAX_REMINDERS = 2;

interface Child {
	spec: DelegationSpec;
	state: DelegationState;
	/** `submit_result` is registered with this spec's schema. */
	submitRegistered: boolean;
}

type Content = string | readonly { type: string; text?: string }[];

const textOf = (content: Content): string =>
	typeof content === "string" ? content : content.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");

export const reminderText = (attempt: number) =>
	`This run's result is missing: call ${SUBMIT_TOOL} with an object matching its parameters, then finish with a brief summary. (Reminder ${attempt} of ${MAX_REMINDERS}; without a result the run fails.)`;

export interface DelegatedChild {
	/** Whether the session is a delegated child with its own tools: nothing else may switch them. */
	active(ctx: ExtensionContext): boolean;
	/** The session's delegation spec, if it is a delegated child. */
	spec(ctx: ExtensionContext): DelegationSpec | undefined;
}

export function delegatedChild(pi: ExtensionAPI, dir: string): DelegatedChild {
	/** Per session: the child, or null for a session that is not one. */
	const children = new Map<string, Child | null>();

	const userTexts = (ctx: ExtensionContext) =>
		ctx.sessionManager.getEntries().flatMap((entry) => (entry.type === "message" && entry.message.role === "user" ? [textOf(entry.message.content)] : []));

	/** A first-run marker whose spec exists: the start of a delegation. */
	const delegationStart = (text: string) => {
		const marker = parseMarker(text);
		return marker?.run === 1 ? readSpec(dir, marker.id) : undefined;
	};

	/** The session's child: its latest first-run marker in the user messages (and the prompt about to become one). */
	const resolve = (ctx: ExtensionContext, prompt?: string): Child | undefined => {
		const sessionId = ctx.sessionManager.getSessionId();
		const known = children.get(sessionId);
		const promptSpec = prompt === undefined ? undefined : delegationStart(prompt);
		// A new delegation (a fork's first message) replaces the one the session knew.
		if (known !== undefined && !(promptSpec && promptSpec.id !== known?.spec.id)) return known ?? undefined;
		const entries = ctx.sessionManager.getEntries();
		const texts = [...entries.flatMap((entry, at) => (entry.type === "message" && entry.message.role === "user" ? [{ text: textOf(entry.message.content), at }] : [])), ...(prompt === undefined ? [] : [{ text: prompt, at: entries.length }])];
		if (texts.length === 0) return undefined;
		let start: { spec: DelegationSpec; at: number } | undefined;
		for (const { text, at } of texts) {
			const spec = delegationStart(text);
			if (spec) start = { spec, at };
		}
		if (!start) {
			children.set(sessionId, null);
			return undefined;
		}
		const { spec } = start;
		let run = 1;
		for (const { text, at } of texts) {
			const m = parseMarker(text);
			if (at >= start.at && m?.id === spec.id) run = m.run;
		}
		// A fork's copied messages are its source's cost.
		let cost = 0;
		for (const entry of entries.slice(start.at)) {
			if (entry.type === "message" && entry.message.role === "assistant") cost += entry.message.usage.cost.total;
		}
		const saved = readState(dir, spec.id);
		const state: DelegationState = saved?.run === run && saved.sessionId === sessionId ? { ...saved, cost } : { sessionId, cost, run, done: false };
		const child: Child = { spec, state, submitRegistered: false };
		children.set(sessionId, child);
		return child;
	};

	const save = (child: Child) => writeState(dir, child.spec.id, child.state);

	const registerSubmit = (child: Child) => {
		if (!child.spec.schema || child.submitRegistered) return;
		child.submitRegistered = true;
		pi.registerTool({
			name: SUBMIT_TOOL,
			label: "Submit result",
			description: "Submit this run's result: an object matching these parameters. A later call in the same run replaces it. After submitting, finish with a brief summary.",
			// SAFETY: Pi validates arguments against any JSON Schema (pi-schema); prepareDelegation checked it is an object schema.
			parameters: child.spec.schema as unknown as TSchema,
			defaultActive: false,
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const current = resolve(ctx);
				if (!current) throw new Error("this session is not a delegated agent");
				current.state = { ...current.state, submitted: true, result: params };
				save(current);
				releaseWork(sessionJobs(ctx.sessionManager.getSessionId()), true);
				return { content: [{ type: "text", text: "Result recorded. Finish with a brief summary." }], details: undefined };
			},
		});
	};

	/** The entries of the current branch since its last user message. */
	const sinceLastUser = (ctx: ExtensionContext) => {
		const branch = ctx.sessionManager.getBranch();
		const start = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user");
		return branch.slice(start + 1);
	};

	pi.on("session_start", (_event, ctx) => void resolve(ctx));

	pi.on("before_agent_start", (event, ctx) => {
		const prompt = event.messageType === "user" ? event.prompt : undefined;
		const child = resolve(ctx, prompt);
		if (!child) return;
		if (!event.reloaded && prompt !== undefined) {
			// A new run: by the parent (its marker numbers the run) or by the user in the child's thread.
			const marker = parseMarker(prompt);
			const run = marker?.id === child.spec.id ? marker.run : child.state.run;
			const { sessionId, cost, compactions, compactionError } = child.state;
			child.state = { sessionId, cost, run, done: false, ...(compactions ? { compactions } : {}), ...(compactionError ? { compactionError } : {}) };
			releaseWork(sessionJobs(ctx.sessionManager.getSessionId()), false);
		} else if (!event.reloaded) {
			// The session continues on its own (a background job ended): the run is not done yet.
			child.state = { ...child.state, done: false };
		}

		const options = event.systemPromptOptions;
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		// submit_result is this extension's own (registered next, with the schema): listing it is no error.
		const listed = (child.spec.tools ?? []).filter((name) => name !== SUBMIT_TOOL);
		const unknown = listed.filter((name) => !available.has(name));
		if (unknown.length) {
			child.state = { ...child.state, done: true, error: `unknown tool${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}; this session has ${[...available].sort().join(", ")}` };
			save(child);
			ctx.abort();
			return;
		}
		registerSubmit(child);
		const tools = [...(child.spec.tools ? listed : options.selectedTools.filter((name) => name !== SUBMIT_TOOL)), ...(child.spec.schema ? [SUBMIT_TOOL] : [])];
		if (child.spec.system !== undefined) options.customPrompt = child.spec.system;
		options.selectedTools = tools;
		pi.setActiveTools(tools);
		// The prompt extension rendered the guidelines of the tools it saw; render them for these.
		if (TOOL_GUIDELINES_SECTION in options.sections) {
			const guidelines = toolGuidelinesSection(options);
			if (guidelines) options.sections[TOOL_GUIDELINES_SECTION] = guidelines;
			else delete options.sections[TOOL_GUIDELINES_SECTION];
		}
		save(child);
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const fresh = !children.has(ctx.sessionManager.getSessionId());
		const child = resolve(ctx);
		if (!child) return;
		// A child resolved just now counted the session's messages already.
		if (!fresh) child.state = { ...child.state, cost: child.state.cost + event.message.usage.cost.total };
		save(child);
		// The run's final message (no tool calls) after a submitted result carries the result.
		const message = event.message;
		if (!child.state.submitted || message.stopReason !== "stop" || message.content.some((block) => block.type === "toolCall")) return;
		const text = `${RESULT_HEADING}${JSON.stringify(child.state.result, null, 2)}\n\`\`\``;
		return { message: { ...message, content: [...message.content, { type: "text", text }] } };
	});

	// Compactions, for a parent's /compact (delegate's compact() checks that one happened).
	const compacted = (ctx: ExtensionContext, error?: string) => {
		const child = resolve(ctx);
		if (!child) return;
		const { compactionError: _previous, ...rest } = child.state;
		child.state = { ...rest, compactions: (child.state.compactions ?? 0) + 1, ...(error ? { compactionError: error } : {}) };
		save(child);
	};
	pi.on("session_compact", (_event, ctx) => compacted(ctx));
	pi.on("session_compact_failed", (event, ctx) => compacted(ctx, event.aborted ? "the compaction was aborted" : (event.errorMessage ?? "the compaction failed")));

	pi.on("agent_before_settle", (event, ctx) => {
		const child = resolve(ctx);
		if (!child?.spec.schema || child.state.submitted || child.state.error) return;
		// Another extension continues the run already, or it stopped: nothing to remind of now.
		if (event.continue || event.outcome !== "completed") return;
		const reminders = sinceLastUser(ctx).filter((entry) => entry.type === "custom_message" && entry.customType === REMINDER_TYPE).length;
		if (reminders >= MAX_REMINDERS) return;
		return { entries: [...event.entries, { type: "custom_message", customType: REMINDER_TYPE, content: reminderText(reminders + 1), display: true }], continue: true };
	});

	pi.on("agent_settled", (event, ctx) => {
		const child = resolve(ctx);
		if (!child) return;
		const last = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		const message = last?.type === "message" && last.message.role === "assistant" ? last.message : undefined;
		let error = child.state.error;
		if (!error && event.aborted) error = RUN_STOPPED;
		else if (!error && message?.stopReason === "error") error = `the request failed: ${message.errorMessage ?? "unknown error"}`;
		else if (!error && child.spec.schema && !child.state.submitted) error = `it finished without calling ${SUBMIT_TOOL} (reminded ${MAX_REMINDERS} times)`;
		const text = message ? textOf(message.content) : "";
		const cut = text.indexOf(RESULT_HEADING.trimStart());
		child.state = { ...child.state, done: true, text: (cut < 0 ? text : text.slice(0, cut)).trimEnd() };
		if (error) child.state.error = error;
		save(child);
	});

	return { active: (ctx) => resolve(ctx)?.spec.tools !== undefined, spec: (ctx) => resolve(ctx)?.spec };
}
