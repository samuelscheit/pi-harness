// Harness prompt: prompt/base.md as the base system prompt (imported from Codex CLI, see
// prompt/SOURCE.json) and prompt/AGENTS.md, the user's global working rules, as the first
// context file.
//
// The base replaces Pi's default preamble only; Pi still appends context files (AGENTS.md of the
// project and its parents), the skills list and the working directory as their own sections.
// Both files are read on every run, so an edit (by the user or the improvement loop) reaches
// running sessions as a section update.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../prompt");
const BASE_PROMPT = join(PROMPT_DIR, "base.md");
const GLOBAL_RULES = join(PROMPT_DIR, "AGENTS.md");

export default function prompt(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		options.customPrompt = readFileSync(BASE_PROMPT, "utf8").trim();
		options.contextFiles = [
			{ path: GLOBAL_RULES, content: readFileSync(GLOBAL_RULES, "utf8").trim() },
			...options.contextFiles.filter((file) => file.path !== GLOBAL_RULES),
		];
	});
}
