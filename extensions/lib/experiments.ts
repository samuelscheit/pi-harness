// Randomized A/B experiments on the harness.
//
// An experiment is a file `prompt/experiments/<name>.md`: optional YAML frontmatter, then the
// variant's prompt text. Every session is assigned an arm per experiment, 50/50 from a hash of
// the session id and the experiment name, so arms are stable when a session resumes and
// independent across experiments. Arm B gets the text as its own prompt section
// `experiment-<name>` (see extensions/prompt); arm A gets nothing. The arm is recorded in the
// session file as a custom entry, so the metrics index (extensions/metrics) can compare the arms
// even after the file is gone.
//
// Frontmatter keys:
//   status:  running (default) | stopped. A stopped experiment assigns no arms and adds no section.
//   started: date the experiment started (informational).
//   stopped: when `/harness experiment <name> stop` ended it.
//   interacts: an experiment name, or a list of them, whose arms this one's effect may depend on
//              (one changes how much the other can act). `/harness experiment` then also compares
//              the crossed cells (AA, AB, BA, BB) and their interaction.
// Other keys are kept as they are. An experiment with an empty body has nothing to test and is
// ignored (listed with a problem), like one whose name is not a valid section name.
//
// Non-prompt variants (a setting such as the compaction threshold) would use the same files and
// entries: the file names the variant in its frontmatter (for example `setting:
// compaction.reserveTokens` and `value: 300000`) with an optional empty body, and the extension
// owning the setting applies the value in arm B after calling `sessionArm` for the experiment.
// The prompt extension would then skip such experiments instead of treating an empty body as a
// problem. Not built yet.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { stringify } from "yaml";
import { HARNESS_ROOT } from "./repository.ts";

export const EXPERIMENTS_DIR = join(HARNESS_ROOT, "prompt/experiments");
/** The custom entry type that records arms in session files. */
export const ARM_ENTRY = "harness-experiment";

/** A: control (no variant), B: the variant. */
export type Arm = "A" | "B";
export const ARMS: readonly Arm[] = ["A", "B"];

// Pi's section names are `[a-z][a-z0-9_-]*`; the section is `experiment-<name>`.
const NAME = /^[a-z0-9][a-z0-9_-]*$/;

export const sectionName = (experiment: string) => `experiment-${experiment}`;

export interface Experiment {
	name: string;
	file: string;
	status: "running" | "stopped";
	frontmatter: Record<string, unknown>;
	/** The variant's prompt text. */
	body: string;
	/** Experiments whose arms to cross with this one's in the comparison (frontmatter `interacts`). */
	interacts: string[];
	/** Why the experiment cannot run (invalid name, empty body, unreadable frontmatter). */
	problem?: string;
}

export function readExperiment(file: string, name: string): Experiment {
	const base = { name, file, status: "running" as const, frontmatter: {}, body: "", interacts: [] };
	if (!NAME.test(name)) return { ...base, problem: `invalid name (use ${NAME.source})` };
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter(readFileSync(file, "utf8"));
	} catch (error) {
		return { ...base, problem: `unreadable frontmatter: ${error instanceof Error ? error.message : String(error)}` };
	}
	const status = parsed.frontmatter.status ?? "running";
	if (status !== "running" && status !== "stopped") return { ...base, problem: `unknown status ${JSON.stringify(status)}` };
	const raw = parsed.frontmatter.interacts ?? [];
	const interacts = typeof raw === "string" ? [raw] : raw;
	if (!Array.isArray(interacts) || !interacts.every((other) => typeof other === "string" && NAME.test(other) && other !== name)) {
		return { ...base, problem: `interacts must name other experiments, got ${JSON.stringify(raw)}` };
	}
	const body = parsed.body.trim();
	return { name, file, status, frontmatter: parsed.frontmatter, body, interacts, ...(body ? {} : { problem: "empty variant" }) };
}

/** Every experiment file, by name. */
export function listExperiments(dir = EXPERIMENTS_DIR): Experiment[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.map((file) => readExperiment(join(dir, file), file.slice(0, -".md".length)));
}

/** Experiments that assign arms now: running and without a problem. */
export const runningExperiments = (dir = EXPERIMENTS_DIR) => listExperiments(dir).filter((e) => e.status === "running" && !e.problem);

/** The random arm of a session: 50/50 from a hash of the experiment name and the session id. */
export function hashArm(sessionId: string, experiment: string): Arm {
	const digest = createHash("sha256").update(`${experiment}\0${sessionId}`).digest();
	return digest.readUInt32BE(0) < 0x8000_0000 ? "A" : "B";
}

/** What an arm entry records: an assignment (random or forced), or that the experiment ended for the session. */
export type ArmEntryData = { experiment: string; arm: Arm; forced: boolean } | { experiment: string; ended: true };

export interface ArmState {
	arm: Arm;
	/** Whether the arm was ever set by hand: such sessions are left out of the random comparison. */
	forced: boolean;
	/** When the session was first assigned (entry time, ms). */
	assignedAt: number;
	/** When the experiment last ended for the session, unless it was assigned again since. */
	endedAt?: number;
}

interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
	timestamp: string;
}

/** The arms recorded in a session's entries (file order), by experiment. */
export function recordedArms(entries: readonly EntryLike[]): Map<string, ArmState> {
	const arms = new Map<string, ArmState>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ARM_ENTRY) continue;
		const data = entry.data as ArmEntryData | undefined;
		if (!data || typeof data.experiment !== "string") continue;
		const ts = Date.parse(entry.timestamp);
		const state = arms.get(data.experiment);
		if ("ended" in data) {
			if (state) state.endedAt = ts;
		} else if (data.arm === "A" || data.arm === "B") {
			arms.set(data.experiment, {
				arm: data.arm,
				forced: (state?.forced ?? false) || data.forced === true,
				assignedAt: state?.assignedAt ?? ts,
			});
		}
	}
	return arms;
}

/**
 * The entries a run must append so the session's arms match the experiments: an assignment for
 * every running experiment the session has no arm in (or that ended for it and runs again), and
 * an end for every arm whose experiment no longer runs.
 */
export function armUpdates(sessionId: string, recorded: Map<string, ArmState>, running: readonly Pick<Experiment, "name">[]): ArmEntryData[] {
	const names = new Set(running.map((e) => e.name));
	const updates: ArmEntryData[] = [];
	for (const { name } of running) {
		const state = recorded.get(name);
		if (!state) updates.push({ experiment: name, arm: hashArm(sessionId, name), forced: false });
		else if (state.endedAt !== undefined) updates.push({ experiment: name, arm: state.arm, forced: state.forced });
	}
	for (const [name, state] of recorded) {
		if (!names.has(name) && state.endedAt === undefined) updates.push({ experiment: name, ended: true });
	}
	return updates;
}

/** Mark an experiment stopped in its file: it stays in git history and can be restarted by setting `status: running`. */
export function stopExperiment(experiment: Experiment, at = new Date()): void {
	const frontmatter = { ...experiment.frontmatter, status: "stopped", stopped: at.toISOString() };
	writeFileSync(experiment.file, `---\n${stringify(frontmatter)}---\n\n${experiment.body}\n`);
}
