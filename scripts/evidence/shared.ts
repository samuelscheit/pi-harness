// Shared pieces of the context evidence scripts: the read-only metrics index and the cached message
// labels (labelling itself is scripts/lib/labels.ts).

import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { metricsPath } from "../../extensions/metrics/stats.ts";
import type { MessageLabel } from "../lib/labels.ts";

export const openIndex = () => new DatabaseSync(metricsPath(), { readOnly: true });

/** Labels by `${session_id} ${entry_id}`, with the model that gave them. */
export type Labels = Record<string, MessageLabel & { model: string }>;
export const LABELS_FILE = join(homedir(), ".pi", "agent", "cache", "user-message-labels.json");
