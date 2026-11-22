// Compiles pi-harness prompts and promoted rules into a single Antigravity plugin `rules/AGENTS.md`.
//
// Antigravity caps each rule file at 24,000 bytes (and recommends a consolidated `rules/AGENTS.md`
// inside a plugin). This module reads `prompt/AGENTS.md` and `prompt/rules/*.md` from the harness,
// drops any rule explicitly marked `targets: [pi]` (or `harnesses: [pi]`), appends a concise guide
// to the harness tools exposed in `agy` (MCP + `tool edit -`), and enforces the byte budget.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { HARNESS_ROOT } from "../extensions/lib/repository.ts";
import { listRules, type Rule } from "../extensions/lib/rules.ts";

/** Leave a small safety margin below Antigravity's 24,000-byte per-file rule cap. */
export const MAX_AGY_RULE_BYTES = 23_500;

export interface CompiledRuleSection {
	name: string;
	text: string;
	hash: string;
}

export interface CompiledRules {
	content: string;
	hash: string;
	bytes: number;
	sections: CompiledRuleSection[];
	skipped: { name: string; reason: string }[];
	truncated: string[];
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Parse optional `targets` / `harnesses` frontmatter to check whether a rule applies to `agy`. */
function targetsAllowAgy(file: string): boolean {
	try {
		const { frontmatter } = parseFrontmatter(readFileSync(file, "utf8"));
		const raw = frontmatter.targets ?? frontmatter.harnesses;
		if (raw === undefined || raw === null) return true;
		const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : undefined;
		if (!list) return true;
		return list.some((t) => typeof t === "string" && (t.toLowerCase() === "agy" || t.toLowerCase() === "all"));
	} catch {
		return true;
	}
}

/**
 * Lightly adapt Pi-only tool names in rule bodies so instructions stay accurate inside `agy`
 * without altering the meaning of the rule.
 */
function adaptRuleForAgy(name: string, body: string): string {
	// Keep `tool edit -` verbatim since `agy` ships the same `tool edit -` CLI on PATH.
	if (name === "edit-tool") {
		return body.replace(
			"Change files with the `edit` and `write` tools",
			"Change files with the file-editing tools (`replace_file_content`, `write_to_file`, or `edit_blocks` / `tool edit -`)",
		);
	}
	if (name === "single-edit") {
		return body.replace(
			"in one `edit` call (several `edits[]`)",
			"in one edit call (`replace_file_content` / `edit_blocks`)",
		);
	}
	return body;
}

const AGY_TOOLS_SECTION = `## pi-harness Tools (synced from pi-harness)

The following tools and safety guards from \`pi-harness\` are active in this session:

- **\`note_improvement\`** (MCP): Capture harness or project friction (user corrections, missing rules, tool failures) into \`.agents/improvements.md\` for nightly dreaming; returns immediately.
- **\`goal\`** (MCP): Set or manage an objective the session keeps working on until \`achieved\` (runs optional shell \`check\`), \`blocked\`, or \`wait\` (when every remaining step depends on a running background job). While active, the \`Stop\` hook holds the turn until done.
- **\`workflow\` & saved workflows (e.g. \`fix_loop\`)** (MCP): Run deterministic TypeScript procedures with durable journaling and budgeted \`llm()\` / \`delegate()\` calls; use \`fix_loop\` for bounded check-repair loops.
- **\`edit_blocks\`** (MCP) and **\`tool edit - <<'EOF'\`** (in \`run_command\`): Atomic multi-file SEARCH/REPLACE edits checked before writing, tracked for own-writes commit safety.
- **\`pi-lens\`** (MCP): LSP diagnostics, symbol navigation, and structural search configured with the harness's layered \`config/pi-lens.json\` + \`.pi/pi-lens.json\`.
- **Git & shell guards (\`PreToolUse\`)**: Destructive whole-tree git commands (\`git stash\`, \`git reset --hard\`, \`git clean -f\`, whole-tree \`checkout\`/\`restore\`), commit message files (\`git commit -F <file>\`, use \`-F - <<'EOF'\`), \`setsid\`, commits containing edits your tools did not make (override after \`git diff\` with \`PI_COMMIT_CHECKED=1 git commit …\`), and idle \`t3_thread_wait\` loops are refused automatically.`;

/** Compile `prompt/AGENTS.md` + `prompt/rules/*.md` into Antigravity's consolidated `rules/AGENTS.md`. */
export function compileAgyRules(harnessRoot = HARNESS_ROOT, maxBytes = MAX_AGY_RULE_BYTES): CompiledRules {
	const sections: CompiledRuleSection[] = [];
	const skipped: { name: string; reason: string }[] = [];
	const truncated: string[] = [];

	const agentsFile = join(harnessRoot, "prompt", "AGENTS.md");
	if (existsSync(agentsFile)) {
		const text = readFileSync(agentsFile, "utf8").trim();
		if (text) sections.push({ name: "working-rules", text, hash: sha(text) });
	}

	sections.push({ name: "pi-harness-tools", text: AGY_TOOLS_SECTION, hash: sha(AGY_TOOLS_SECTION) });

	const rules: Rule[] = listRules(join(harnessRoot, "prompt", "rules"));
	for (const rule of rules) {
		if (rule.problem) {
			skipped.push({ name: rule.name, reason: rule.problem });
			continue;
		}
		if (!targetsAllowAgy(rule.file)) {
			skipped.push({ name: rule.name, reason: "excluded by targets frontmatter" });
			continue;
		}
		if (!rule.body) {
			skipped.push({ name: rule.name, reason: "no body (tool/settings-only rule)" });
			continue;
		}
		const adapted = adaptRuleForAgy(rule.name, rule.body);
		const text = `### ${rule.name}\n\n${adapted}`;
		sections.push({ name: rule.name, text, hash: sha(text) });
	}

	const header = "# pi-harness Rules\n\n<!-- Generated from pi-harness prompt/AGENTS.md and prompt/rules/*.md. Edit in pi-harness and commit to sync. -->\n";
	const kept: CompiledRuleSection[] = [];
	let content = header;
	for (const section of sections) {
		const candidate = `${content}\n${section.text}\n`;
		if (Buffer.byteLength(candidate, "utf8") > maxBytes) {
			truncated.push(section.name);
			continue;
		}
		content = candidate;
		kept.push(section);
	}

	return {
		content,
		hash: sha(content),
		bytes: Buffer.byteLength(content, "utf8"),
		sections: kept,
		skipped,
		truncated,
	};
}

/** Sections added or changed relative to a previously seen `{ sectionName: hash }` map. */
export function diffRuleSections(compiled: CompiledRules, seen: Record<string, string>): CompiledRuleSection[] {
	return compiled.sections.filter((s) => seen[s.name] !== s.hash);
}
