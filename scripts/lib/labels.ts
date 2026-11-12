// Labelling the user's mid-session messages with a model: what kind of message it is (a correction,
// a failure report, a new task, …) and the reusable working rule it implies, if any. Used by the
// evidence scripts (scripts/evidence) and by dreaming (scripts/dream).
//
// Models are called through the user's gateway with Pi's anthropic credentials (`askJson`).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LABELS = ["correction", "forgot_context", "process", "quality", "failure_report", "new_task", "question", "answer", "approval", "other"] as const;
export type Label = (typeof LABELS)[number];

/** Labels that mean the agent fell short: the user had to correct, remind, complain or report breakage. */
export const NEGATIVE: readonly Label[] = ["correction", "forgot_context", "process", "quality", "failure_report"];
export const isNegative = (label: string | undefined) => label !== undefined && (NEGATIVE as readonly string[]).includes(label);

/** Where a rule applies: every session (how the agent works), or one project (its code, tools, conventions). */
export type RuleScope = "global" | "project";

/** Messages a tool, t3 or the harness wrote into the user's turn, not the user. */
const MACHINE_PREFIXES = [
	"<",
	"Delegated task",
	"[Request interrupted",
	"Update on pull request",
	"Continue where you left off",
	"[Assistant quote]",
	"Caveat:",
	"This session is being continued",
	"## Resumed session",
	"The user answered your ask_user questions",
];

export function isHuman(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.length > 0 && !MACHINE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

let credentials: { apiKey: string; baseUrl: string } | undefined;

/**
 * Ask an Anthropic model through the user's gateway (Pi's anthropic provider) and parse the JSON
 * value in its reply. `validate` throws on a malformed answer; the call is retried up to 3 times.
 * The reply is streamed, so a long answer keeps the connection busy past the gateway's idle timeout.
 */
export async function askJson<T>(model: string, system: string, user: string, validate: (value: unknown) => T, maxTokens = 8000): Promise<T> {
	credentials ??= {
		apiKey: execFileSync("pi", ["auth", "print-api-key", "--provider", "anthropic"], { encoding: "utf8" }).trim(),
		baseUrl: (JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8")) as { providers: { anthropic: { baseUrl: string } } }).providers.anthropic.baseUrl.replace(/\/$/, ""),
	};
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await fetch(`${credentials.baseUrl}/v1/messages`, {
				method: "POST",
				headers: { "x-api-key": credentials.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
				body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, system, messages: [{ role: "user", content: user }] }),
			});
			if (!response.ok || !response.body) throw new Error(`${response.status}: ${(await response.text()).slice(0, 200)}`);
			let text = "";
			let buffer = "";
			for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.startsWith("data:")) continue;
					const event = JSON.parse(line.slice(5)) as { type: string; delta?: { type: string; text?: string }; error?: { message: string } };
					if (event.type === "error") throw new Error(event.error?.message);
					if (event.type === "content_block_delta" && event.delta?.type === "text_delta") text += event.delta.text ?? "";
				}
			}
			const start = text.search(/[[{]/);
			const end = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
			return validate(JSON.parse(text.slice(start, end + 1)));
		} catch (error) {
			if (attempt >= 3) throw error;
			await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
		}
	}
}

/** The signature of `askJson`, so callers can be tested with a scripted model. */
export type Ask = typeof askJson;

export interface MessageToLabel {
	text: string;
	/** The agent's last message before it, which tells a correction from a new request. */
	before?: string;
}

export interface MessageLabel {
	label: Label;
	rule: string | null;
	/** Set when `rule` is. */
	scope: RuleScope | null;
}

const INSTRUCTIONS = `You label messages a user sent to an AI coding agent in the middle of a session (not the first message). When given, <agent_before> is the agent's last message before the user's: use it to tell a correction from a new request.
For each message pick exactly one label:
- correction: the agent misunderstood or did the wrong thing, the user rejects or redirects its approach ("no, I meant…", "use X instead", "that's wrong").
- forgot_context: the user repeats or points back to something already said or established earlier in the session that the agent ignored or forgot ("I told you…", "did you see this instruction", "as I said", re-pasting an earlier instruction).
- process: complaint about how the agent works: waiting/polling on long processes, pretending to work, ending its turn early or without finishing, asking for permission, inefficiency, not using tools well, not following working rules.
- quality: the result runs but is not good enough (design, polish, depth, thoroughness).
- failure_report: the user reports something the agent built or changed is broken, failing or erroring (pasted errors, failing CI, "doesn't work", "still broken").
- new_task: a new request or an extension of scope that is not a complaint.
- question: the user asks for information or an explanation.
- answer: the user answers a question the agent asked, or makes a decision between options.
- approval: short acknowledgement or go-ahead ("yes", "ok", "merge it", "continue").
- other: anything else, including pasted text without instruction.
Also give "rule": if the message states or implies a general, reusable working rule that should hold in future sessions too, write it as one short imperative English sentence (e.g. "Do not wait idly on long-running processes; work on something else."). Otherwise null. A one-off decision about the current task is not a rule.
And "scope" for a rule: "global" when it is about how the agent works in any project, "project" when it depends on this project's code, tools, infrastructure or conventions; null without a rule.
Reply with only a JSON array, one object per message, in order: [{"i": <index>, "label": "<label>", "rule": <string or null>, "scope": "global" | "project" | null}].`;

const MAX_CHARS = 700;
const MAX_BEFORE = 500;

/**
 * Label messages in batches, several batches at once. `onBatch` sees each finished batch (indexes
 * into `messages`), so a caller can persist progress.
 */
export async function labelMessages(
	messages: readonly MessageToLabel[],
	model: string,
	{ ask = askJson, batch = 30, concurrency = 6, onBatch }: { ask?: Ask; batch?: number; concurrency?: number; onBatch?: (labels: Map<number, MessageLabel>) => void } = {},
): Promise<MessageLabel[]> {
	const result: MessageLabel[] = new Array(messages.length);
	const starts: number[] = [];
	for (let i = 0; i < messages.length; i += batch) starts.push(i);
	let next = 0;
	const worker = async () => {
		while (next < starts.length) {
			const start = starts[next++]!;
			const slice = messages.slice(start, start + batch);
			const body = slice
				.map((m, i) => `<message i="${i}">\n${m.before ? `<agent_before>\n${m.before.slice(-MAX_BEFORE)}\n</agent_before>\n` : ""}${m.text.slice(0, MAX_CHARS)}\n</message>`)
				.join("\n");
			const labels = await ask(model, INSTRUCTIONS, body, (value) => parseLabels(value, slice.length));
			for (const [i, label] of labels) result[start + i] = label;
			onBatch?.(new Map([...labels].map(([i, label]) => [start + i, label])));
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, starts.length) }, worker));
	return result;
}

/** The model's answer for a batch of `count` messages; throws unless every message got a valid label. */
export function parseLabels(value: unknown, count: number): Map<number, MessageLabel> {
	if (!Array.isArray(value)) throw new Error("expected a JSON array");
	const labels = new Map<number, MessageLabel>();
	for (const item of value as { i?: unknown; label?: unknown; rule?: unknown; scope?: unknown }[]) {
		if (typeof item?.i !== "number" || item.i < 0 || item.i >= count || !(LABELS as readonly unknown[]).includes(item.label)) continue;
		const rule = typeof item.rule === "string" && item.rule.trim() ? item.rule.trim() : null;
		const scope = rule && (item.scope === "global" || item.scope === "project") ? item.scope : rule ? "global" : null;
		labels.set(item.i, { label: item.label as Label, rule, scope });
	}
	if (labels.size !== count) throw new Error(`got ${labels.size} of ${count} labels`);
	return labels;
}
