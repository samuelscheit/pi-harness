// Harness prompt: prompt/base.md as the base system prompt, prompt/AGENTS.md, the user's
// global working rules, as the first context file, the stable rules (prompt/rules, see
// extensions/lib/rules.ts: each its own section, its tools on in every session), and the variants
// of the A/B experiments (prompt/experiments, see extensions/lib/experiments.ts): in arm B their
// prompt sections and tools; every tool an experiment names is off otherwise, unless a rule names it.
//
// The base replaces Pi's default preamble, and with it Pi's `tools` and `rules` sections: Pi puts
// tools' `promptGuidelines` into `rules` only in its default prompt. So this extension renders the
// active tools' guidelines (and extensions' global ones) as the section `tool-guidelines`; without
// it, no tool's guidance reached the model (found 2026-11-13: the bash `tool` command went unused).
// Pi still appends context files (AGENTS.md of the project and its parents), the skills list and
// the working directory as their own sections.
// Sections other extensions set before this handler (the goal, extensions/goal) are moved after
// the harness's own: they change during a session, and a change at the end leaves the prompt before
// it, and its cache, intact also for models that get no mid-conversation prompt updates.
// Everything is read on every run, so an edit (by the user or the improvement loop), a forced arm
// or a stopped experiment reaches running sessions as a section and tool update.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyToolSwitches,
	ARM_ENTRY,
	armUpdates,
	EXPERIMENTS_DIR,
	listExperiments,
	recordedArms,
	sectionName,
	toolSwitches,
} from "../lib/experiments.ts";
import { HARNESS_ROOT, inSource } from "../lib/repository.ts";
import { applyRules, listRules, RULES_DIR } from "../lib/rules.ts";

const PROMPT_DIR = join(HARNESS_ROOT, "prompt");
const BASE_PROMPT = join(PROMPT_DIR, "base.md");
const GLOBAL_RULES = join(PROMPT_DIR, "AGENTS.md");
// The path the model sees: the file in the harness repository. A release's own copy sits under its
// commit, so showing that path changed the project_context section with every release (a prompt
// update per running session), and it is not the file to edit anyway.
const GLOBAL_RULES_SHOWN = inSource(GLOBAL_RULES);

export const TOOL_GUIDELINES_SECTION = "tool-guidelines";

/** The guidelines of the selected tools in their order, then the global ones; each once, as bullets. */
export function toolGuidelinesSection(options: { selectedTools: readonly string[]; toolGuidelines: Readonly<Record<string, readonly string[]>>; promptGuidelines: readonly string[] }): string {
	const rules = [...new Set([...options.selectedTools.flatMap((name) => options.toolGuidelines[name] ?? []), ...options.promptGuidelines].map((rule) => rule.trim()).filter(Boolean))];
	return rules.map((rule) => `- ${rule}`).join("\n");
}

export default function prompt(pi: ExtensionAPI, experimentsDir = EXPERIMENTS_DIR, rulesDir = RULES_DIR) {
	let reported = "";
	pi.on("before_agent_start", (event, ctx) => {
		const options = event.systemPromptOptions;
		const foreign = Object.entries(options.sections);
		options.customPrompt = readFileSync(BASE_PROMPT, "utf8").trim();
		options.contextFiles = [
			{ path: GLOBAL_RULES_SHOWN, content: readFileSync(GLOBAL_RULES, "utf8").trim() },
			...options.contextFiles.filter((file) => file.path !== GLOBAL_RULES && file.path !== GLOBAL_RULES_SHOWN),
		];

		// Rules before experiments, so an experiment section can never take a rule's name.
		const { tools: ruleTools, problems } = applyRules(listRules(rulesDir), options.sections);
		if (problems && problems !== reported && ctx.hasUI) ctx.ui.notify(`Ignored prompt rules:\n${problems}`, "warning");
		reported = problems;

		// Record missing assignments and ended experiments first (appendEntry writes synchronously),
		// then read the arms back: a forced arm from `/harness experiment` wins over the hash.
		const session = ctx.sessionManager;
		const sessionId = session.getSessionId();
		const experiments = listExperiments(experimentsDir);
		const running = experiments.filter((e) => e.status === "running" && !e.problem);
		for (const update of armUpdates(sessionId, recordedArms(session.getEntries()), running)) pi.appendEntry(ARM_ENTRY, update);
		const arms = recordedArms(session.getEntries());
		for (const experiment of running) {
			if (experiment.body && arms.get(experiment.name)?.arm === "B") options.sections[sectionName(experiment.name)] = experiment.body;
		}
		const switches = toolSwitches(experiments, sessionId, arms);
		for (const tool of ruleTools) switches.set(tool, true);
		options.selectedTools = applyToolSwitches(options.selectedTools, switches);
		const guidelines = toolGuidelinesSection(options);
		if (guidelines) options.sections[TOOL_GUIDELINES_SECTION] = guidelines;
		else delete options.sections[TOOL_GUIDELINES_SECTION];
		for (const [name, content] of foreign) {
			delete options.sections[name];
			options.sections[name] = content;
		}
	});
}
