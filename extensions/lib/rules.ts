// Stable prompt rules: one file per rule, `prompt/rules/<name>.md`, for every session.
//
// A rule is what an A/B experiment (lib/experiments.ts) becomes once it is promoted: the body is
// its own prompt section `<name>` (extensions/prompt), and the tools its frontmatter names
// (`tools:`) are active in every session. Keeping each rule in its own file keeps it revertible
// and comparable on its own: deleting the file removes the section and switches its tools off
// again (they are registered inactive), and the section name stays the experiment's name.
//
// Frontmatter keys: `tools` (a tool name or a list), `promoted` (when it left the experiments,
// informational). Other keys are kept as they are.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { stringify } from "yaml";
import { type Experiment, NAME, nameList, TOOL } from "./experiments.ts";
import { HARNESS_ROOT, inSource } from "./repository.ts";

export const RULES_DIR = join(HARNESS_ROOT, "prompt/rules");

export interface Rule {
	name: string;
	file: string;
	body: string;
	/** Tools active in every session (frontmatter `tools`). */
	tools: string[];
	/** Why the rule is ignored (invalid name, unreadable frontmatter, nothing in it). */
	problem?: string;
}

export function readRule(file: string, name: string): Rule {
	const base = { name, file, body: "", tools: [] };
	if (!NAME.test(name)) return { ...base, problem: `invalid name (use ${NAME.source})` };
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter(readFileSync(file, "utf8"));
	} catch (error) {
		return { ...base, problem: `unreadable frontmatter: ${error instanceof Error ? error.message : String(error)}` };
	}
	const tools = nameList(parsed.frontmatter.tools, (tool) => TOOL.test(tool));
	if (!tools) return { ...base, problem: `tools must name tools, got ${JSON.stringify(parsed.frontmatter.tools)}` };
	const body = parsed.body.trim();
	return { name, file, body, tools, ...(body || tools.length ? {} : { problem: "empty rule" }) };
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
 * Turn an experiment into a rule in the harness repository (the source of a release, see
 * repository.ts): its body and tools move to `<rules>/<name>.md`, the experiment file is deleted
 * (it stays in git history). Returns the files written and removed.
 */
export function promoteExperiment(experiment: Experiment, rulesDir = RULES_DIR, at = new Date()): string[] {
	const rule = inSource(join(rulesDir, `${experiment.name}.md`));
	if (existsSync(rule)) throw new Error(`${rule} exists already`);
	const frontmatter: Record<string, string | string[]> = {};
	if (experiment.tools.length === 1) frontmatter.tools = experiment.tools[0]!;
	else if (experiment.tools.length > 1) frontmatter.tools = experiment.tools;
	frontmatter.promoted = at.toISOString().slice(0, 10);
	mkdirSync(dirname(rule), { recursive: true });
	writeFileSync(rule, `---\n${stringify(frontmatter)}---\n\n${experiment.body}\n`);
	const source = inSource(experiment.file);
	rmSync(source);
	return [rule, source];
}
