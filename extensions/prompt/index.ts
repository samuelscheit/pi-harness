// Base system prompt of the harness: prompt/base.md (imported from Codex CLI, see prompt/SOURCE.json).
//
// It replaces Pi's default preamble only; Pi still appends AGENTS.md / context files, the skills
// list and the working directory as their own sections. The file is read on every run, so an
// edit (by the user or the improvement loop) reaches running sessions as a section update.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_PROMPT = join(dirname(fileURLToPath(import.meta.url)), "../../prompt/base.md");

export default function prompt(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.customPrompt = readFileSync(BASE_PROMPT, "utf8").trim();
	});
}
