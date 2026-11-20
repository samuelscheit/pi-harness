// Randomized A/B experiments on the harness.
//
// An experiment is a file `prompt/experiments/<name>.md`: optional YAML frontmatter, then the
// variant's prompt text. Every session is assigned an arm per experiment, 50/50 from a hash of
// the session id and the experiment name, so arms are stable when a session resumes and
// independent across experiments. Arm B gets the text as its own prompt section
// `experiment-<name>` and the experiment's tools (see extensions/prompt); arm A gets neither. The
// arm is recorded in the session file as a custom entry, so the metrics index (extensions/metrics)
// can compare the arms even after the file is gone.
//
// Frontmatter keys:
//   status:  running (default) | stopped. A stopped experiment assigns no arms and adds no section.
//   started: date the experiment started (informational).
//   stopped: when `/harness experiment <name> stop` ended it.
//   interacts: an experiment name, or a list of them, whose arms this one's effect may depend on
//              (one changes how much the other can act). `/harness experiment` then also compares
//              the crossed cells (AA, AB, BA, BB) and their interaction.
//   tools:   a tool name, or a list of them, that arm B gets active and arm A does not. The tools
//            are registered inactive (`defaultActive: false`, or built-in like `codemode`); every
//            run switches them per arm (`toolSwitches`), so a forced arm or a stopped experiment
//            switches them from the next run. A stopped experiment turns its tools off for
//            everyone; promoting one means activating the tool by default and deleting the file.
//            The comparison adds each tool's usage per arm.
//   settings: session settings arm B runs with: model, thinking level, context limit (lib/variants.ts).
//            Such an experiment enrolls only sessions that made no request yet, and two running
//            experiments may not set the same setting for the same sessions (the one started
//            later gets a problem).
//   sessions: all (default) | delegated | top-level: the sessions the experiment enrolls.
//   source:  `dream` for experiments dreaming started (scripts/dream/economize.ts), which it also
//            judges (scripts/dream/judge.ts).
// Other keys are kept as they are. An experiment with neither a body, tools nor settings has
// nothing to test and is ignored (listed with a problem), like one whose name is not a valid
// section name.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { stringify } from "yaml";
import { HARNESS_ROOT, inSource } from "./repository.ts";
import { hasSettings, matchesKind, parseSessionKind, parseSettings, type SessionFacts, type SessionKind, type SessionSettings } from "./variants.ts";

export const EXPERIMENTS_DIR = join(HARNESS_ROOT, "prompt/experiments");
/** The custom entry type that records arms in session files. */
export const ARM_ENTRY = "harness-experiment";

/** A: control (no variant), B: the variant. */
export type Arm = "A" | "B";
export const ARMS: readonly Arm[] = ["A", "B"];

// Pi's section names are `[a-z][a-z0-9_-]*`; the section is `experiment-<name>`.
export const NAME = /^[a-z0-9][a-z0-9_-]*$/;
// Tool names as providers accept them.
export const TOOL = /^[a-zA-Z0-9_-]{1,64}$/;

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
	/** Tools active in arm B only (frontmatter `tools`). */
	tools: string[];
	/** Session settings of arm B (frontmatter `settings`). */
	settings: SessionSettings;
	/** The sessions it enrolls (frontmatter `sessions`). */
	sessions: SessionKind;
	/** Why the experiment cannot run (invalid name, nothing to test, unreadable frontmatter). */
	problem?: string;
}

export function readExperiment(file: string, name: string): Experiment {
	const base = { name, file, status: "running" as const, frontmatter: {}, body: "", interacts: [], tools: [], settings: {}, sessions: "all" as const };
	if (!NAME.test(name)) return { ...base, problem: `invalid name (use ${NAME.source})` };
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter(readFileSync(file, "utf8"));
	} catch (error) {
		return { ...base, problem: `unreadable frontmatter: ${error instanceof Error ? error.message : String(error)}` };
	}
	const status = parsed.frontmatter.status ?? "running";
	if (status !== "running" && status !== "stopped") return { ...base, frontmatter: parsed.frontmatter, problem: `unknown status ${JSON.stringify(status)}` };
	// Problems from here keep the frontmatter and status, so who started the experiment stays known.
	const read = { ...base, status: status as Experiment["status"], frontmatter: parsed.frontmatter };
	const interacts = nameList(parsed.frontmatter.interacts, (other) => NAME.test(other) && other !== name);
	if (!interacts) return { ...read, problem: `interacts must name other experiments, got ${JSON.stringify(parsed.frontmatter.interacts)}` };
	const tools = nameList(parsed.frontmatter.tools, (tool) => TOOL.test(tool));
	if (!tools) return { ...read, problem: `tools must name tools, got ${JSON.stringify(parsed.frontmatter.tools)}` };
	const settings = parseSettings(parsed.frontmatter.settings);
	if ("problem" in settings) return { ...read, problem: settings.problem };
	const sessions = parseSessionKind(parsed.frontmatter.sessions);
	if (!sessions) return { ...read, problem: `sessions must be all, delegated or top-level, got ${JSON.stringify(parsed.frontmatter.sessions)}` };
	const body = parsed.body.trim();
	const problem = body || tools.length || hasSettings(settings) ? {} : { problem: "empty variant" };
	return { name, file, status, frontmatter: parsed.frontmatter, body, interacts, tools, settings, sessions, ...problem };
}

/** Whether two experiments can enroll the same session. */
const overlap = (a: SessionKind, b: SessionKind) => a === "all" || b === "all" || a === b;

/** The settings `a` and `b` would both set for the same sessions (none: they can run together). */
export const settingsConflict = (a: Pick<Experiment, "settings" | "sessions">, b: Pick<Experiment, "settings" | "sessions">): string[] =>
	overlap(a.sessions, b.sessions) ? Object.keys(a.settings).filter((key) => key in b.settings) : [];

/** Whether an experiment enrolls only some sessions: by kind, or only fresh ones (settings). */
const restricted = (e: Experiment) => e.sessions !== "all" || hasSettings(e.settings);

/**
 * Whether a running experiment enrolls a session with these facts (lib/variants.ts): one of its
 * kind; for settings, one that made no request yet and still runs the defaults the settings replace.
 */
export const enrolls = (e: Experiment, facts: SessionFacts) =>
	matchesKind(e.sessions, facts.firstPrompt) &&
	(!hasSettings(e.settings) || facts.fresh) &&
	(e.settings.model === undefined || facts.onDefaults?.model !== false) &&
	(e.settings.thinking === undefined || facts.onDefaults?.thinking !== false);

/** A frontmatter value naming one thing or a list of them (absent: none); undefined when invalid. */
export function nameList(raw: unknown, valid: (name: string) => boolean): string[] | undefined {
	const list = raw === undefined || raw === null ? [] : typeof raw === "string" ? [raw] : raw;
	if (!Array.isArray(list) || !list.every((item) => typeof item === "string" && valid(item))) return undefined;
	return [...new Set(list as string[])];
}

/** Every experiment file, by name. */
export function listExperiments(dir = EXPERIMENTS_DIR): Experiment[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.map((file) => readExperiment(join(dir, file), file.slice(0, -".md".length)))
		.map((e, _, all) => {
			// The one started first keeps running; a later one setting the same thing gets the problem.
			const first = conflictOrder(all).filter((o) => !o.problem && o.status === "running");
			const earlier = e.problem || e.status !== "running" ? undefined : first.slice(0, first.indexOf(e)).find((o) => settingsConflict(e, o).length && !blocked(o, first));
			return earlier ? { ...e, problem: `sets ${settingsConflict(e, earlier).join(", ")} for the same sessions as running experiment ${earlier.name}` } : e;
		});
}

/** Experiments by when they started (`started`, missing last), then by name. */
const conflictOrder = (list: readonly Experiment[]) =>
	[...list].sort((a, b) => String(a.frontmatter.started ?? "~").localeCompare(String(b.frontmatter.started ?? "~")) || a.name.localeCompare(b.name));

/** Whether an earlier-started experiment in `order` blocks `e` (so `e` itself does not run and blocks nothing). */
function blocked(e: Experiment, order: readonly Experiment[]): boolean {
	const index = order.indexOf(e);
	return order.slice(0, index).some((o) => settingsConflict(e, o).length && !blocked(o, order));
}

/** Experiments that assign arms now: running and without a problem. */
export const runningExperiments = (dir = EXPERIMENTS_DIR) => listExperiments(dir).filter((e) => e.status === "running" && !e.problem);

/** The random arm of a session: 50/50 from a hash of the experiment name and the session id. */
export function hashArm(sessionId: string, experiment: string): Arm {
	const digest = createHash("sha256").update(`${experiment}\0${sessionId}`).digest();
	return digest.readUInt32BE(0) < 0x8000_0000 ? "A" : "B";
}

/**
 * The arm a session is in for a running experiment: the recorded one, else the one its next run
 * records; undefined when not recorded and the experiment enrolls only some sessions.
 */
export const sessionArm = (experiment: Experiment, sessionId: string, recorded: Map<string, ArmState>): Arm | undefined =>
	recorded.get(experiment.name)?.arm ?? (restricted(experiment) ? undefined : hashArm(sessionId, experiment.name));

/**
 * Which tools the experiments switch for a session, and how: every tool an experiment file names
 * (running or stopped) is off, unless a running experiment naming it has the session in arm B.
 * Tools no experiment names are not in the map. Experiments with a problem switch nothing.
 */
export function toolSwitches(experiments: readonly Experiment[], sessionId: string, recorded: Map<string, ArmState>): Map<string, boolean> {
	const switches = new Map<string, boolean>();
	for (const e of experiments) {
		if (e.problem) continue;
		const on = e.status === "running" && sessionArm(e, sessionId, recorded) === "B";
		for (const tool of e.tools) switches.set(tool, (switches.get(tool) ?? false) || on);
	}
	return switches;
}

/** A tool selection with the switches applied: switched-off tools removed, switched-on ones appended, the rest in order. */
export function applyToolSwitches(selected: readonly string[], switches: Map<string, boolean>): string[] {
	const kept = selected.filter((tool) => switches.get(tool) !== false);
	return [...kept, ...[...switches].filter(([tool, on]) => on && !kept.includes(tool)).map(([tool]) => tool)];
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
 * every running experiment that enrolls the session (`enrolls`) and has no arm in it (or ended for
 * it and runs again), and an end for every arm whose experiment no longer runs.
 */
export function armUpdates(sessionId: string, recorded: Map<string, ArmState>, running: readonly Experiment[], facts: { firstPrompt: string; fresh: boolean }): ArmEntryData[] {
	const names = new Set(running.map((e) => e.name));
	const updates: ArmEntryData[] = [];
	for (const e of running) {
		const state = recorded.get(e.name);
		if (state && state.endedAt === undefined) continue;
		if (!enrolls(e, facts)) continue;
		updates.push(state ? { experiment: e.name, arm: state.arm, forced: state.forced } : { experiment: e.name, arm: hashArm(sessionId, e.name), forced: false });
	}
	for (const [name, state] of recorded) {
		if (!names.has(name) && state.endedAt === undefined) updates.push({ experiment: name, ended: true });
	}
	return updates;
}

/** A file to write (`content`) or delete (`null`). */
export interface FileChange {
	path: string;
	content: string | null;
}

/** Write the changes in the checkout; returns their paths. */
export function writeChanges(changes: readonly FileChange[]): string[] {
	for (const { path, content } of changes) {
		if (content === null) rmSync(path, { force: true });
		else {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
	}
	return changes.map((c) => c.path);
}

/** A markdown file with YAML frontmatter. */
export const withFrontmatter = (frontmatter: Record<string, unknown>, body: string) => `---\n${stringify(frontmatter)}---\n${body ? `\n${body}\n` : ""}`;

/**
 * An experiment marked stopped in its file in the harness repository (the source of a release, see
 * repository.ts): it stays in git history and can be restarted by setting `status: running`.
 * `toSource` maps a path read to the path to write (identity for files read from the source).
 */
export function stoppedExperiment(experiment: Experiment, at = new Date(), toSource: (path: string) => string = inSource): FileChange {
	return { path: toSource(experiment.file), content: withFrontmatter({ ...experiment.frontmatter, status: "stopped", stopped: at.toISOString() }, experiment.body) };
}
