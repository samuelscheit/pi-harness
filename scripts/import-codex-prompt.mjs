#!/usr/bin/env node
// Import the base instructions Codex CLI sends to its newest model and adapt them to this harness.
//
// Usage: node scripts/import-codex-prompt.mjs [path/to/openai/codex checkout] [model slug]
//
// Codex keeps per-model instructions in codex-rs/models-manager/models.json
// (`model_messages.instructions_template`). The text is harness-neutral except for a few
// lines that name Codex, its model, or Codex-only tools and features; ADAPTATIONS rewrites
// exactly those. Every rule must match, so an upstream wording change fails loudly instead
// of silently leaving a Codex-specific line in the prompt.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const codexDir = process.argv[2] ?? join(process.env.HOME, "Developer/Developer/test/harness/codex");
const slug = process.argv[3] ?? "gpt-6.1-sol";

const git = (...args) => execFileSync("git", ["-C", codexDir, ...args], { encoding: "utf8" });
const ref = git("rev-parse", "--verify", "origin/HEAD").trim();
const catalog = JSON.parse(git("show", `${ref}:codex-rs/models-manager/models.json`));
const model = (catalog.models ?? catalog).find((m) => m.slug === slug);
if (!model?.model_messages?.instructions_template) throw new Error(`no instructions for ${slug} at ${ref}`);
let text = model.model_messages.instructions_template;

/** [description, pattern, replacement]: each pattern must match at least once. */
const ADAPTATIONS = [
	["identity", /^You are Codex, an agent based on GPT-6\. /m, "You are a coding agent. "],
	["personality identity", /\bAs Codex, you are\b/, "You are"],
	["ask tool", /`functions\.request_user_input_async` tool/, "`ask_user` tool"],
	["shell tool", /\bexec_command calls\b/, "bash calls"],
	["shell argument", /passed to the `cmd` argument/, "passed to the `command` argument"],
	[
		"orchestrator skills",
		/, environment-owned skills should be access via the corresponding environment, and orchestrator skills should be discovered by calling `skills\.list`[^.]*\./,
		".",
	],
	["apps and plugins", /\n# Apps \(Connectors\)\n[\s\S]*$/, "\n"],
];

for (const [name, pattern, replacement] of ADAPTATIONS) {
	if (!pattern.test(text)) throw new Error(`adaptation "${name}" no longer matches upstream; update ADAPTATIONS`);
	text = text.replace(pattern, replacement);
}
for (const leftover of ["Codex", "GPT-6", "{{", "request_user_input", "exec_command", "tool_search", "Connectors"]) {
	if (text.includes(leftover)) throw new Error(`"${leftover}" is still in the adapted prompt`);
}

const out = join(root, "prompt/base.md");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${text.trim()}\n`);
writeFileSync(
	join(root, "prompt/SOURCE.json"),
	`${JSON.stringify({ upstream: "https://github.com/openai/codex", license: "Apache-2.0", commit: ref, model: slug, file: "codex-rs/models-manager/models.json#model_messages.instructions_template" }, null, "\t")}\n`,
);
console.log(`prompt/base.md: ${text.split(/\s+/).length} words from ${slug} at ${ref.slice(0, 10)}`);
