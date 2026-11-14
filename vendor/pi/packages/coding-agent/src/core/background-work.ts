// Background work items (`pi.setBackgroundWork`): checked when an extension sets them, copied so a
// later change of the extension's objects does not change what the session reported.

import type { BackgroundWorkItem } from "./extensions/types.ts";

const OPTIONAL_STRINGS = ["command", "logPath", "url", "toolCallId"] as const;
const OPTIONAL_PIDS = ["pid", "processGroup"] as const;

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** `items` checked and copied with their known fields only; throws `Invalid background work: …`. */
export function validBackgroundWork(items: readonly BackgroundWorkItem[]): BackgroundWorkItem[] {
	if (!Array.isArray(items)) throw new Error(`Invalid background work: expected an array of items, got ${JSON.stringify(items)}`);
	const ids = new Set<string>();
	return items.map((item, index) => {
		const problem = (what: string) => new Error(`Invalid background work: item ${index} ${what}`);
		if (typeof item !== "object" || item === null) throw problem("is not an object");
		if (!nonEmpty(item.id)) throw problem("needs a non-empty id");
		if (ids.has(item.id)) throw problem(`repeats id ${JSON.stringify(item.id)}`);
		ids.add(item.id);
		if (!nonEmpty(item.kind)) throw problem("needs a non-empty kind");
		if (!nonEmpty(item.label)) throw problem("needs a non-empty label");
		if (!Number.isFinite(item.startedAt)) throw problem("needs startedAt in epoch milliseconds");
		const copy: BackgroundWorkItem = { id: item.id, kind: item.kind, label: item.label, startedAt: item.startedAt };
		for (const key of OPTIONAL_STRINGS) {
			const value = item[key];
			if (value === undefined) continue;
			if (!nonEmpty(value)) throw problem(`has an empty or non-string ${key}`);
			copy[key] = value;
		}
		for (const key of OPTIONAL_PIDS) {
			const value = item[key];
			if (value === undefined) continue;
			if (!Number.isInteger(value) || value <= 0) throw problem(`has an invalid ${key}: ${value}`);
			copy[key] = value;
		}
		return copy;
	});
}
