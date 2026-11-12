// Labels every human follow-up and steer message in the metrics index with an LLM, so the context
// evidence analysis (analyze.ts) can measure corrections, forgotten context and recurring rules.
//
// Machine-written messages (task notifications, delegated-task results, interrupt markers, resumed
// session preambles) are excluded by `isHuman`. Labels are cached by session and entry id in
// LABELS_FILE, so a re-run only classifies new messages.
//
// Usage: node scripts/evidence/classify-messages.ts [--model claude-sonnet-5-5]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { askJson, LABELS, LABELS_FILE, type Label, type Labels, openIndex } from "./shared.ts";

const BATCH = 40;
const CONCURRENCY = 6;
const MAX_CHARS = 700;
const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : "claude-sonnet-5-5";

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
];

export function isHuman(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.length > 0 && !MACHINE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

const INSTRUCTIONS = `You label messages a user sent to an AI coding agent in the middle of a session (not the first message).
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
Also give "rule": if the message states or implies a general, reusable working rule that should hold in future sessions too, write it as one short imperative English sentence (e.g. "Do not wait idly on long-running processes; work on something else."). Otherwise null.
Reply with only a JSON array, one object per message, in order: [{"i": <index>, "label": "<label>", "rule": <string or null>}].`;

function classify(batch: { i: number; text: string }[]): Promise<{ i: number; label: Label; rule: string | null }[]> {
	const body = batch.map(({ i, text }) => `<message i="${i}">\n${text.slice(0, MAX_CHARS)}\n</message>`).join("\n");
	return askJson(model, INSTRUCTIONS, body, (value) => {
		const known = new Set(batch.map((m) => m.i));
		const valid = (value as { i: number; label: string; rule: string | null }[]).filter((p) => known.has(p.i) && (LABELS as readonly string[]).includes(p.label));
		if (valid.length !== batch.length) throw new Error(`got ${valid.length} of ${batch.length} labels`);
		return valid as { i: number; label: Label; rule: string | null }[];
	});
}

async function main(): Promise<void> {
	const labels: Labels = existsSync(LABELS_FILE) ? JSON.parse(readFileSync(LABELS_FILE, "utf8")) : {};

	const db = openIndex();
	const rows = db
		.prepare("SELECT session_id, entry_id, text FROM user_messages WHERE kind IN ('follow-up', 'steer') ORDER BY ts")
		.all() as { session_id: string; entry_id: string; text: string }[];
	const todo = rows.filter((r) => isHuman(r.text) && !labels[`${r.session_id} ${r.entry_id}`]);
	console.log(`${rows.length} follow-ups, ${todo.length} human messages to label with ${model}`);

	const batches: (typeof todo)[] = [];
	for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
	let next = 0;
	let done = 0;
	const save = () => {
		mkdirSync(dirname(LABELS_FILE), { recursive: true });
		writeFileSync(LABELS_FILE, JSON.stringify(labels));
	};
	await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => {
			while (next < batches.length) {
				const batch = batches[next++];
				const result = await classify(batch.map((row, i) => ({ i, text: row.text })));
				for (const { i, label, rule } of result) labels[`${batch[i].session_id} ${batch[i].entry_id}`] = { label, rule, model };
				done += batch.length;
				save();
				console.log(`${done}/${todo.length}`);
			}
		}),
	);
	save();
}

if (import.meta.main) await main();
