// Harness prompt: prompt/base.md as the base system prompt, prompt/AGENTS.md, the user's
// global working rules, as the first context file, and the variants of the running A/B
// experiments (prompt/experiments, see extensions/lib/experiments.ts) in arm B.
//
// The base replaces Pi's default preamble only; Pi still appends context files (AGENTS.md of the
// project and its parents), the skills list and the working directory as their own sections.
// Everything is read on every run, so an edit (by the user or the improvement loop), a forced arm
// or a stopped experiment reaches running sessions as a section update.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ARM_ENTRY, armUpdates, EXPERIMENTS_DIR, recordedArms, runningExperiments, sectionName } from "../lib/experiments.ts";
import { HARNESS_ROOT } from "../lib/repository.ts";

const PROMPT_DIR = join(HARNESS_ROOT, "prompt");
const BASE_PROMPT = join(PROMPT_DIR, "base.md");
const GLOBAL_RULES = join(PROMPT_DIR, "AGENTS.md");

export default function prompt(pi: ExtensionAPI, experimentsDir = EXPERIMENTS_DIR) {
	pi.on("before_agent_start", (event, ctx) => {
		const options = event.systemPromptOptions;
		options.customPrompt = readFileSync(BASE_PROMPT, "utf8").trim();
		options.contextFiles = [
			{ path: GLOBAL_RULES, content: readFileSync(GLOBAL_RULES, "utf8").trim() },
			...options.contextFiles.filter((file) => file.path !== GLOBAL_RULES),
		];

		// Record missing assignments and ended experiments first (appendEntry writes synchronously),
		// then read the arms back: a forced arm from `/harness experiment` wins over the hash.
		const session = ctx.sessionManager;
		const running = runningExperiments(experimentsDir);
		for (const update of armUpdates(session.getSessionId(), recordedArms(session.getEntries()), running)) pi.appendEntry(ARM_ENTRY, update);
		const arms = recordedArms(session.getEntries());
		for (const experiment of running) {
			if (arms.get(experiment.name)?.arm === "B") options.sections[sectionName(experiment.name)] = experiment.body;
		}
	});
}
