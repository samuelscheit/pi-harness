// `/harness experiment`: the A/B experiments (extensions/lib/experiments.ts) from the command line.
//
//   /harness experiment              running experiments, this session's arms, interim results
//                                    (with the crossed cells of experiments that declare `interacts`)
//   /harness experiment <name> on    force this session into arm B (off: arm A), from its next run
//   /harness experiment <name> stop  mark the experiment stopped and log its result in the changelog
//   /harness experiment <name> promote  make it a stable rule (lib/rules.ts) for every session and log
//                                    its result in the changelog
//
// The changelog (.agents/changelog.md) is local state like the rest of `.agents/`: git-ignored and
// never committed. Only the experiment and rule files are committed.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type Arm,
	type ArmEntryData,
	type ArmState,
	EXPERIMENTS_DIR,
	type Experiment,
	listExperiments,
	sessionArm,
	stoppedExperiment,
	writeChanges,
} from "../lib/experiments.ts";
import { promotedExperiment, RULES_DIR } from "../lib/rules.ts";
import { describeSettings, hasSettings } from "../lib/variants.ts";
import { SOURCE_ROOT } from "../lib/repository.ts";
import { money, percent, table } from "./format.ts";
import { type CellMetric, type ExperimentComparison, experiments, Scope } from "./queries/index.ts";
import { indexAll, metricsPath } from "./stats.ts";
import { openStore } from "./store.ts";

export const CHANGELOG = join(SOURCE_ROOT, ".agents/changelog.md");

const value = (unit: CellMetric["unit"], v: number | null, signed = false): string => {
	if (v === null) return "–";
	const sign = signed && v > 0 ? "+" : "";
	if (unit === "share") return `${sign}${percent(v)}`;
	if (unit === "usd") return `${sign}${money(v)}`;
	return `${sign}${v.toFixed(2)}`;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A comparison as text: sessions and turns per cell, then each metric per cell with the effect and its interval. */
export function renderComparison(c: ExperimentComparison): string {
	const crossed = c.experiments.length > 1;
	const cells = c.cells.map((cell, i) => (i === 0 ? `${cell} ${plural(c.sessions[cell]!, "session")} / ${plural(c.turns[cell]!, "turn")}` : `${cell} ${c.sessions[cell]} / ${c.turns[cell]}`));
	const head = [
		`${c.experiments.join(" × ")}: ${cells.join(", ")} (${plural(c.projects.length, "project")} with every ${crossed ? "cell" : "arm"})`,
		...(crossed ? [`cells: arm in ${c.experiments.join(", then ")}; interaction = how much ${c.experiments.at(-1)}'s B − A differs between the arms of ${c.experiments.slice(0, -1).join(", ")}`] : []),
		...(c.forced || c.unmatched ? [`left out: ${c.forced} forced, ${c.unmatched} in projects missing ${crossed ? "a cell" : "an arm"}`] : []),
	];
	if (c.cells.every((cell) => c.sessions[cell] === 0)) return [...head, "no comparable sessions yet"].join("\n");
	const rows = c.metrics.map((m) => [
		m.label,
		...c.cells.map((cell) => value(m.unit, m.values[cell] ?? null)),
		value(m.unit, m.effect, true),
		m.ci ? `${value(m.unit, m.ci[0], true)} … ${value(m.unit, m.ci[1], true)}` : "–",
	]);
	return [...head, table(["metric", ...c.cells, crossed ? "interaction" : "B − A", "95% CI"], rows)].join("\n");
}

/** The pairs of experiments to cross: each declared `interacts`, once per pair, the declaring experiment first. */
export function crossedGroups(files: Experiment[]): string[][] {
	const seen = new Set<string>();
	const groups: string[][] = [];
	for (const e of files.filter((f) => !f.problem)) {
		for (const other of e.interacts) {
			const key = [e.name, other].sort((x, y) => x.localeCompare(y)).join("\0");
			if (!seen.has(key)) groups.push([e.name, other]);
			seen.add(key);
		}
	}
	return groups;
}

const armLabel = (arm: Arm) => (arm === "B" ? "B (variant)" : "A (control)");

/** This session's arm in an experiment: recorded, else the one its next run will get. */
function sessionLine(experiment: Experiment, sessionId: string, recorded: Map<string, ArmState>): string {
	const state = recorded.get(experiment.name);
	if (!state) {
		const arm = sessionArm(experiment, sessionId, recorded);
		return arm ? `this session: ${armLabel(arm)} from its next run` : "this session: not enrolled (the experiment enrolls only some sessions)";
	}
	return `this session: ${armLabel(state.arm)}${state.forced ? ", forced" : ""}${state.endedAt !== undefined ? ", ended" : ""}`;
}

/** The status report: experiment files, this session's arms and the interim results (single and crossed) from the index. */
export function experimentStatus(files: Experiment[], sessionId: string, recorded: Map<string, ArmState>, results: ExperimentComparison[]): string {
	const singles = new Map(results.filter((r) => r.experiments.length === 1).map((r) => [r.experiments[0]!, r]));
	const crossed = results.filter((r) => r.experiments.length > 1);
	const blocks = files.map((e) => {
		const state = e.problem ? `ignored: ${e.problem}` : e.status;
		const lines = [`## ${e.name} (${state}${e.frontmatter.started ? `, started ${String(e.frontmatter.started)}` : ""})`];
		if (e.tools.length) lines.push(`tools in arm B: ${e.tools.join(", ")}`);
		if (hasSettings(e.settings)) lines.push(`settings in arm B: ${describeSettings(e.settings)}`);
		if (e.sessions !== "all") lines.push(`enrolls ${e.sessions} sessions`);
		if (!e.problem && e.status === "running") lines.push(sessionLine(e, sessionId, recorded));
		const result = singles.get(e.name);
		lines.push(result ? renderComparison(result) : "no sessions recorded yet");
		for (const pair of crossed.filter((r) => r.experiments[0] === e.name)) lines.push("", renderComparison(pair));
		return lines.join("\n");
	});
	// Experiments whose file is gone still have their sessions in the index.
	for (const [name, result] of singles) {
		if (!files.some((f) => f.name === name)) blocks.push(`## ${name} (file removed)\n${renderComparison(result)}`);
	}
	return blocks.length ? blocks.join("\n\n") : `No experiments. Add one as ${EXPERIMENTS_DIR}/<name>.md.`;
}

/** How an experiment ended, for its changelog entry. */
const ENDINGS = {
	stop: {
		title: "experiment stopped",
		change: (name: string) =>
			`\`prompt/experiments/${name}.md\` marked \`status: stopped\`; no session gets its section, tools or settings any more. Promote it with \`/harness experiment ${name} promote\` after restarting it, or delete the file.`,
		revert: "set `status: running` in the file (arms stay as recorded).",
	},
	promote: {
		title: "experiment promoted",
		change: (name: string) => `\`prompt/experiments/${name}.md\` became the rule \`prompt/rules/${name}.md\`: every session gets its section \`${name}\`, its tools and its settings.`,
		revert: "delete the rule file (the section, its tools and its settings go), or move it back to `prompt/experiments/` with `status: running` to test it again.",
	},
} as const;

/** The changelog entry for an experiment that ended, with its results at that point (alone and crossed) and why it ended (`why`, when decided by dreaming). */
export function endEntry(results: ExperimentComparison[], name: string, at: Date, ending: keyof typeof ENDINGS, why?: string): string {
	const { title, change, revert } = ENDINGS[ending];
	return [
		"",
		`## ${at.toISOString().slice(0, 10)} — ${title}: ${name}`,
		"",
		`**Change:** ${change(name)}`,
		"",
		...(why ? [`**Why:** ${why}`, ""] : []),
		`**Result at ${ending} (random sessions, projects with every arm or cell):**`,
		"",
		"```",
		results.length ? results.map(renderComparison).join("\n\n") : `${name}: no sessions recorded`,
		"```",
		"",
		`**Revert:** ${revert}`,
		"",
	].join("\n");
}

function withIndex<T>(run: (db: DatabaseSync) => T, agentDir = getAgentDir()): T {
	const db = openStore(metricsPath(agentDir));
	try {
		indexAll(db, { agentDir });
		return run(db);
	} finally {
		db.close();
	}
}

export interface ExperimentContext {
	sessionId: string;
	recorded: Map<string, ArmState>;
	appendEntry: (data: ArmEntryData) => void;
	dir?: string;
	rulesDir?: string;
	changelog?: string;
	/** The comparisons from the index of the given groups of experiments (every recorded experiment alone when undefined). */
	compare?: (groups?: string[][]) => ExperimentComparison[];
	now?: Date;
	/**
	 * Commit files written to the harness repository, when Pi runs a release of it: a stop takes
	 * effect once committed (then deployed and reloaded). Returns what to tell the user.
	 */
	publish?: (paths: string[], message: string) => string;
}

/** The comparisons from the index, with the usage of the tools each experiment file switches. */
const compareFromIndex = (files: Experiment[]) => (groups?: string[][]) =>
	withIndex((db) => experiments(new Scope(db, {}), groups, (name) => files.find((f) => f.name === name)?.tools ?? []));

/** Run `/harness experiment <args>`; returns the text to show and its level. */
export function experimentCommand(args: string[], context: ExperimentContext): { text: string; level: "info" | "warning" } {
	const { dir = EXPERIMENTS_DIR } = context;
	const files = listExperiments(dir);
	const compare = context.compare ?? compareFromIndex(files);
	const crossed = crossedGroups(files);
	if (args.length === 0) {
		const results = [...compare(), ...(crossed.length ? compare(crossed) : [])];
		return { text: experimentStatus(files, context.sessionId, context.recorded, results), level: "info" };
	}
	const [name = "", action = ""] = args;
	if (args.length !== 2 || !["on", "off", "stop", "promote"].includes(action)) return { text: EXPERIMENT_USAGE, level: "warning" };
	const experiment = files.find((f) => f.name === name);
	if (!experiment) return { text: `No experiment ${name} in ${dir}.`, level: "warning" };
	if (experiment.problem) return { text: `Experiment ${name} is ignored: ${experiment.problem}.`, level: "warning" };
	if (experiment.status !== "running") return { text: `Experiment ${name} is already stopped.`, level: "warning" };
	if (action === "stop" || action === "promote") {
		const at = context.now ?? new Date();
		const results = compare([[name], ...crossed.filter((group) => group.includes(name))]);
		const files = writeChanges(action === "stop" ? [stoppedExperiment(experiment, at)] : promotedExperiment(experiment, context.rulesDir ?? RULES_DIR, at));
		const changelog = context.changelog ?? CHANGELOG;
		appendFileSync(changelog, endEntry(results, name, at, action));
		const published = context.publish ? `\n${context.publish(files, `chore(experiments): ${action} ${name}`)}` : "";
		const done = action === "stop" ? `Stopped ${name}` : `Promoted ${name} to a rule for every session`;
		return { text: `${done}; result logged in the changelog.${published}\n${results.map(renderComparison).join("\n\n")}`.trim(), level: "info" };
	}
	const arm: Arm = action === "on" ? "B" : "A";
	context.appendEntry({ experiment: name, arm, forced: true });
	return { text: `This session is in ${armLabel(arm)} of ${name} from its next run; it no longer counts in the random comparison.`, level: "info" };
}

export const EXPERIMENT_USAGE = "Usage: /harness experiment [<name> on|off|stop|promote]";
