// Harness prompt: prompt/base.md as the base system prompt, prompt/AGENTS.md, the user's
// global working rules, as the first context file, the stable rules (prompt/rules, see
// extensions/lib/rules.ts: each its own section, its tools on in every session), and the variants
// of the A/B experiments (prompt/experiments, see extensions/lib/experiments.ts): in arm B their
// prompt sections and tools; every tool an experiment names is off otherwise, unless a rule names it.
//
// The base replaces Pi's default preamble only; Pi still appends context files (AGENTS.md of the
// project and its parents), the skills list and the working directory as their own sections.
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

export default function prompt(pi: ExtensionAPI, experimentsDir = EXPERIMENTS_DIR, rulesDir = RULES_DIR) {
	let reported = "";
	pi.on("before_agent_start", (event, ctx) => {
		const options = event.systemPromptOptions;
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
	});
}
