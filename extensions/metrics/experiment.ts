// `/harness experiment`: the A/B experiments (extensions/lib/experiments.ts) from the command line.
//
//   /harness experiment              running experiments, this session's arms, interim results
//                                    (with the crossed cells of experiments that declare `interacts`)
//   /harness experiment <name> on    force this session into arm B (off: arm A), from its next run
//   /harness experiment <name> stop  mark the experiment stopped and log its result in the changelog

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
	hashArm,
	listExperiments,
	stopExperiment,
} from "../lib/experiments.ts";
import { HARNESS_ROOT } from "../lib/repository.ts";
import { money, percent, table } from "./format.ts";
import { type CellMetric, type ExperimentComparison, experiments, Scope } from "./queries/index.ts";
import { indexAll, metricsPath } from "./stats.ts";
import { openStore } from "./store.ts";

export const CHANGELOG = join(HARNESS_ROOT, ".agents/changelog.md");

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
	if (!state) return `this session: ${armLabel(hashArm(sessionId, experiment.name))} from its next run`;
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

/** The changelog entry for a stopped experiment, with its results at that point (alone and crossed). */
export function stopEntry(results: ExperimentComparison[], name: string, at: Date): string {
	return [
		"",
		`## ${at.toISOString().slice(0, 10)} — experiment stopped: ${name}`,
		"",
		`**Change:** \`prompt/experiments/${name}.md\` marked \`status: stopped\`; no session gets its section any more. Promote the variant into \`prompt/base.md\` or delete the file.`,
		"",
		"**Result at stop (random sessions, projects with every arm or cell):**",
		"",
		"```",
		results.length ? results.map(renderComparison).join("\n\n") : `${name}: no sessions recorded`,
		"```",
		"",
		"**Revert:** set `status: running` in the file (arms stay as recorded).",
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
	changelog?: string;
	/** The comparisons from the index of the given groups of experiments (every recorded experiment alone when undefined). */
	compare?: (groups?: string[][]) => ExperimentComparison[];
	now?: Date;
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
	if (args.length !== 2 || !["on", "off", "stop"].includes(action)) return { text: EXPERIMENT_USAGE, level: "warning" };
	const experiment = files.find((f) => f.name === name);
	if (!experiment) return { text: `No experiment ${name} in ${dir}.`, level: "warning" };
	if (experiment.problem) return { text: `Experiment ${name} is ignored: ${experiment.problem}.`, level: "warning" };
	if (experiment.status !== "running") return { text: `Experiment ${name} is already stopped.`, level: "warning" };
	if (action === "stop") {
		const at = context.now ?? new Date();
		const results = compare([[name], ...crossed.filter((group) => group.includes(name))]);
		stopExperiment(experiment, at);
		appendFileSync(context.changelog ?? CHANGELOG, stopEntry(results, name, at));
		return { text: `Stopped ${name}; result logged in the changelog.\n${results.map(renderComparison).join("\n\n")}`.trim(), level: "info" };
	}
	const arm: Arm = action === "on" ? "B" : "A";
	context.appendEntry({ experiment: name, arm, forced: true });
	return { text: `This session is in ${armLabel(arm)} of ${name} from its next run; it no longer counts in the random comparison.`, level: "info" };
}

export const EXPERIMENT_USAGE = "Usage: /harness experiment [<name> on|off|stop]";
