// What kind of message each message the user typed is (a correction, a failure report, a new task,
// …), as dreaming's model labelled it (scripts/lib/labels.ts, scripts/dream). The labels are the
// quality signal of the A/B comparison (queries/experiments.ts): the share of the user's messages
// that correct the agent or report something broken.
//
// Dreaming appends every label to `.agents/dreams/labels.jsonl` in the harness repository (local
// state, git-ignored), the source of truth like the session files; `indexLabels` loads the file
// into the table `message_labels` whenever it changed, so a schema rebuild loses nothing.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { appendJsonl, readJsonl } from "../lib/jsonl.ts";
import { SOURCE_ROOT } from "../lib/repository.ts";
import { transaction } from "./store.ts";

export const LABELS = ["correction", "forgot_context", "process", "quality", "failure_report", "new_task", "question", "answer", "approval", "other"] as const;
export type Label = (typeof LABELS)[number];

/** Labels that mean the agent fell short: the user had to correct, remind, complain or report breakage. */
export const NEGATIVE: readonly Label[] = ["correction", "forgot_context", "process", "quality", "failure_report"];
export const isNegative = (label: string | undefined) => label !== undefined && (NEGATIVE as readonly string[]).includes(label);

/** SQL list of the negative labels. */
export const NEGATIVE_SQL = NEGATIVE.map((label) => `'${label}'`).join(", ");

export const LABELS_FILE_NAME = "labels.jsonl";
export const LABELS_FILE = join(SOURCE_ROOT, ".agents", "dreams", LABELS_FILE_NAME);

export interface LabelRecord {
	session: string;
	entry: string;
	ts: number;
	label: Label;
}

export const appendLabels = (records: readonly LabelRecord[], file = LABELS_FILE) => appendJsonl(file, records);

const validLabel = (value: unknown) => {
	const r = value as Partial<LabelRecord>;
	return typeof r.session === "string" && typeof r.entry === "string" && typeof r.ts === "number" && (LABELS as readonly unknown[]).includes(r.label);
};

const META_KEY = "labels_file";

/** Load the labels file into `message_labels` when it changed since the last load; a later label of the same message wins. */
export function indexLabels(db: DatabaseSync, file = LABELS_FILE): void {
	const stamp = existsSync(file) ? (({ size, mtimeMs }) => `${file}:${size}:${mtimeMs}`)(statSync(file)) : "";
	const loaded = (db.prepare("SELECT value FROM meta WHERE key = ?").get(META_KEY) as { value: string } | undefined)?.value ?? "";
	if (stamp === loaded) return;
	const records = readJsonl<LabelRecord>(file, validLabel);
	transaction(db, () => {
		db.exec("DELETE FROM message_labels");
		const insert = db.prepare("INSERT OR REPLACE INTO message_labels (session_id, entry_id, ts, label) VALUES (?, ?, ?, ?)");
		for (const r of records) insert.run(r.session, r.entry, r.ts, r.label);
		db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(META_KEY, stamp);
	});
}
