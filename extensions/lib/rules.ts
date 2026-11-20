// Stable prompt rules: one file per rule, `prompt/rules/<name>.md`, for every session.
//
// A rule is what an A/B experiment (lib/experiments.ts) becomes once it is promoted: the body is
// its own prompt section `<name>` (extensions/prompt), and the tools its frontmatter names
// (`tools:`) are active in every session. Keeping each rule in its own file keeps it revertible
// and comparable on its own: deleting the file removes the section and switches its tools off
// again (they are registered inactive), and the section name stays the experiment's name.
//
// Frontmatter keys: `tools` (a tool name or a list), `settings` and `sessions` (session settings for
// every new session of that kind, see lib/variants.ts), `promoted` (when it left the experiments,
// informational). Other keys are kept as they are.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type ArmState, EXPERIMENTS_DIR, type Experiment, type FileChange, listExperiments, NAME, nameList, recordedArms, TOOL, withFrontmatter } from "./experiments.ts";
import { HARNESS_ROOT, inSource } from "./repository.ts";
import { hasSettings, matchesKind, mergeSettings, parseSessionKind, parseSettings, type SessionKind, type SessionSettings, sessionFacts } from "./variants.ts";

export const RULES_DIR = join(HARNESS_ROOT, "prompt/rules");

export interface Rule {
	name: string;
	file: string;
	body: string;
	/** Tools active in every session (frontmatter `tools`). */
	tools: string[];
	/** Settings of every new session of its kind (frontmatter `settings`). */
	settings: SessionSettings;
	sessions: SessionKind;
	/** Why the rule is ignored (invalid name, unreadable frontmatter, nothing in it). */
	problem?: string;
}

export function readRule(file: string, name: string): Rule {
	const base = { name, file, body: "", tools: [], settings: {}, sessions: "all" as const };
	if (!NAME.test(name)) return { ...base, problem: `invalid name (use ${NAME.source})` };
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter(readFileSync(file, "utf8"));
	} catch (error) {
		return { ...base, problem: `unreadable frontmatter: ${error instanceof Error ? error.message : String(error)}` };
	}
	const tools = nameList(parsed.frontmatter.tools, (tool) => TOOL.test(tool));
	if (!tools) return { ...base, problem: `tools must name tools, got ${JSON.stringify(parsed.frontmatter.tools)}` };
	const settings = parseSettings(parsed.frontmatter.settings);
	if ("problem" in settings) return { ...base, problem: settings.problem };
	const sessions = parseSessionKind(parsed.frontmatter.sessions);
	if (!sessions) return { ...base, problem: `sessions must be all, delegated or top-level, got ${JSON.stringify(parsed.frontmatter.sessions)}` };
	const body = parsed.body.trim();
	return { name, file, body, tools, settings, sessions, ...(body || tools.length || hasSettings(settings) ? {} : { problem: "empty rule" }) };
}

/** Every rule file, by name. */
export function listRules(dir = RULES_DIR): Rule[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.map((file) => readRule(join(dir, file), file.slice(0, -".md".length)));
}

/**
 * Add the rules' sections to a prompt's sections and collect their tools. A rule with a problem, or
 * whose name a section has already, is left out and reported (one line each, joined).
 */
export function applyRules(rules: readonly Rule[], sections: Record<string, string>): { tools: Set<string>; problems: string } {
	const tools = new Set<string>();
	const problems: string[] = [];
	for (const rule of rules) {
		if (rule.problem) problems.push(`${rule.file}: ${rule.problem}`);
		else if (rule.body && rule.name in sections) problems.push(`${rule.file}: the prompt has a section ${rule.name} already`);
		else {
			if (rule.body) sections[rule.name] = rule.body;
			for (const tool of rule.tools) tools.add(tool);
		}
	}
	return { tools, problems: problems.join("\n") };
}

/**
 * An experiment turned into a rule in the harness repository (the source of a release, see
 * repository.ts): its body, tools and settings move to `<rules>/<name>.md`, the experiment file is
 * deleted (it stays in git history). `toSource` as in `stoppedExperiment`.
 */
export function promotedExperiment(experiment: Experiment, rulesDir = RULES_DIR, at = new Date(), toSource: (path: string) => string = inSource): FileChange[] {
	const rule = toSource(join(rulesDir, `${experiment.name}.md`));
	if (existsSync(rule)) throw new Error(`${rule} exists already`);
	const frontmatter: Record<string, unknown> = {};
	if (experiment.tools.length === 1) frontmatter.tools = experiment.tools[0]!;
	else if (experiment.tools.length > 1) frontmatter.tools = experiment.tools;
	if (hasSettings(experiment.settings)) frontmatter.settings = experiment.settings;
	if (experiment.sessions !== "all") frontmatter.sessions = experiment.sessions;
	frontmatter.promoted = at.toISOString().slice(0, 10);
	return [
		{ path: rule, content: withFrontmatter(frontmatter, experiment.body) },
		{ path: toSource(experiment.file), content: null },
	];
}

/** The settings of the session these entries belong to (see `sessionSettings`); `prompt` is the run's prompt, for a session without messages yet. */
export function currentSettings(entries: Parameters<typeof sessionFacts>[0] & Parameters<typeof recordedArms>[0], prompt: string | undefined, experimentsDir = EXPERIMENTS_DIR, rulesDir = RULES_DIR): SessionSettings {
	return sessionSettings(listRules(rulesDir), listExperiments(experimentsDir), recordedArms(entries), sessionFacts(entries, prompt).firstPrompt);
}

/**
 * The settings a session runs with: those of the rules for its kind, then those of the running
 * experiments it is in arm B of (not ended), which win. The model and thinking level of the result
 * are meant for a fresh session only (lib/variants.ts).
 */
export function sessionSettings(rules: readonly Rule[], experiments: readonly Experiment[], recorded: Map<string, ArmState>, firstPrompt: string): SessionSettings {
	const fromRules = rules.filter((r) => !r.problem && matchesKind(r.sessions, firstPrompt)).map((r) => r.settings);
	const fromArms = experiments
		.filter((e) => !e.problem && e.status === "running")
		.filter((e) => {
			const state = recorded.get(e.name);
			return state?.arm === "B" && state.endedAt === undefined;
		})
		.map((e) => e.settings);
	return mergeSettings(...fromRules, ...fromArms);
}
