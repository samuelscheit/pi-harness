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
import { isHuman, labelMessages } from "../lib/labels.ts";
import { LABELS_FILE, type Labels, openIndex } from "./shared.ts";

const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1]! : "claude-sonnet-5-5";

async function main(): Promise<void> {
	const labels: Labels = existsSync(LABELS_FILE) ? JSON.parse(readFileSync(LABELS_FILE, "utf8")) : {};
	const rows = openIndex()
		.prepare("SELECT session_id, entry_id, text FROM user_messages WHERE kind IN ('follow-up', 'steer') ORDER BY ts")
		.all() as { session_id: string; entry_id: string; text: string }[];
	const todo = rows.filter((r) => isHuman(r.text) && !labels[`${r.session_id} ${r.entry_id}`]);
	console.log(`${rows.length} follow-ups, ${todo.length} human messages to label with ${model}`);
	let done = 0;
	await labelMessages(todo, model, {
		onBatch: (batch) => {
			for (const [i, label] of batch) labels[`${todo[i]!.session_id} ${todo[i]!.entry_id}`] = { ...label, model };
			done += batch.size;
			mkdirSync(dirname(LABELS_FILE), { recursive: true });
			writeFileSync(LABELS_FILE, JSON.stringify(labels));
			console.log(`${done}/${todo.length}`);
		},
	});
}

if (import.meta.main) await main();
