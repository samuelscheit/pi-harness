// `/harness experiment`: the A/B experiments (extensions/lib/experiments.ts) from the command line.
//
//   /harness experiment              running experiments, this session's arms, interim results
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
import { type ArmMetric, type ExperimentComparison, experiments, Scope } from "./queries/index.ts";
import { indexAll, metricsPath } from "./stats.ts";
import { openStore } from "./store.ts";

export const CHANGELOG = join(HARNESS_ROOT, ".agents/changelog.md");

const value = (unit: ArmMetric["unit"], v: number | null, signed = false): string => {
	if (v === null) return "–";
	const sign = signed && v > 0 ? "+" : "";
	if (unit === "share") return `${sign}${percent(v)}`;
	if (unit === "usd") return `${sign}${money(v)}`;
	return `${sign}${v.toFixed(2)}`;
};

/** One experiment's comparison as text: sessions per arm, then each metric with B − A and its interval. */
export function renderComparison(c: ExperimentComparison): string {
	const head = [
		`${c.experiment}: ${c.sessions.A} sessions / ${c.turns.A} turns in A, ${c.sessions.B} / ${c.turns.B} in B` +
			` (${c.projects.length} ${c.projects.length === 1 ? "project" : "projects"} with both arms)`,
		...(c.forced || c.unmatched ? [`left out: ${c.forced} forced, ${c.unmatched} in projects with one arm only`] : []),
	];
	if (c.sessions.A + c.sessions.B === 0) return [...head, "no comparable sessions yet"].join("\n");
	const rows = c.metrics.map((m) => [
		m.label,
		value(m.unit, m.a),
		value(m.unit, m.b),
		value(m.unit, m.diff, true),
		m.ci ? `${value(m.unit, m.ci[0], true)} … ${value(m.unit, m.ci[1], true)}` : "–",
	]);
	return [...head, table(["metric", "A", "B", "B − A", "95% CI"], rows)].join("\n");
}

const armLabel = (arm: Arm) => (arm === "B" ? "B (variant)" : "A (control)");

/** This session's arm in an experiment: recorded, else the one its next run will get. */
function sessionLine(experiment: Experiment, sessionId: string, recorded: Map<string, ArmState>): string {
	const state = recorded.get(experiment.name);
	if (!state) return `this session: ${armLabel(hashArm(sessionId, experiment.name))} from its next run`;
	return `this session: ${armLabel(state.arm)}${state.forced ? ", forced" : ""}${state.endedAt !== undefined ? ", ended" : ""}`;
}

/** The status report: experiment files, this session's arms and the interim results from the index. */
export function experimentStatus(files: Experiment[], sessionId: string, recorded: Map<string, ArmState>, results: ExperimentComparison[]): string {
	const byName = new Map(results.map((r) => [r.experiment, r]));
	const blocks = files.map((e) => {
		const state = e.problem ? `ignored: ${e.problem}` : e.status;
		const lines = [`## ${e.name} (${state}${e.frontmatter.started ? `, started ${String(e.frontmatter.started)}` : ""})`];
		if (!e.problem && e.status === "running") lines.push(sessionLine(e, sessionId, recorded));
		const result = byName.get(e.name);
		lines.push(result ? renderComparison(result) : "no sessions recorded yet");
		return lines.join("\n");
	});
	// Experiments whose file is gone still have their sessions in the index.
	for (const result of results) {
		if (!files.some((f) => f.name === result.experiment)) blocks.push(`## ${result.experiment} (file removed)\n${renderComparison(result)}`);
	}
	return blocks.length ? blocks.join("\n\n") : `No experiments. Add one as ${EXPERIMENTS_DIR}/<name>.md.`;
}

/** The changelog entry for a stopped experiment, with its result at that point. */
export function stopEntry(result: ExperimentComparison | undefined, name: string, at: Date): string {
	return [
		"",
		`## ${at.toISOString().slice(0, 10)} — experiment stopped: ${name}`,
		"",
		`**Change:** \`prompt/experiments/${name}.md\` marked \`status: stopped\`; no session gets its section any more. Promote the variant into \`prompt/base.md\` or delete the file.`,
		"",
		"**Result at stop (random sessions, projects with both arms):**",
		"",
		"```",
		result ? renderComparison(result) : `${name}: no sessions recorded`,
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
	/** The comparisons from the index, by experiment name (all when undefined). */
	compare?: (name?: string) => ExperimentComparison[];
	now?: Date;
}

const compareFromIndex = (name?: string) => withIndex((db) => experiments(new Scope(db, {}), name));

/** Run `/harness experiment <args>`; returns the text to show and its level. */
export function experimentCommand(args: string[], context: ExperimentContext): { text: string; level: "info" | "warning" } {
	const { dir = EXPERIMENTS_DIR, compare = compareFromIndex } = context;
	const files = listExperiments(dir);
	if (args.length === 0) return { text: experimentStatus(files, context.sessionId, context.recorded, compare()), level: "info" };
	const [name = "", action = ""] = args;
	if (args.length !== 2 || !["on", "off", "stop"].includes(action)) return { text: EXPERIMENT_USAGE, level: "warning" };
	const experiment = files.find((f) => f.name === name);
	if (!experiment) return { text: `No experiment ${name} in ${dir}.`, level: "warning" };
	if (experiment.problem) return { text: `Experiment ${name} is ignored: ${experiment.problem}.`, level: "warning" };
	if (experiment.status !== "running") return { text: `Experiment ${name} is already stopped.`, level: "warning" };
	if (action === "stop") {
		const at = context.now ?? new Date();
		const [result] = compare(name);
		stopExperiment(experiment, at);
		appendFileSync(context.changelog ?? CHANGELOG, stopEntry(result, name, at));
		return { text: `Stopped ${name}; result logged in the changelog.\n${result ? renderComparison(result) : ""}`.trim(), level: "info" };
	}
	const arm: Arm = action === "on" ? "B" : "A";
	context.appendEntry({ experiment: name, arm, forced: true });
	return { text: `This session is in ${armLabel(arm)} of ${name} from its next run; it no longer counts in the random comparison.`, level: "info" };
}

export const EXPERIMENT_USAGE = "Usage: /harness experiment [<name> on|off|stop]";
