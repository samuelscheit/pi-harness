// Dreaming: the rules the agent already reads, each with a stable id, so a new correction can be
// matched to the rule it repeats (a recurrence) instead of adding a duplicate.
//
//   global   prompt/AGENTS.md, the user's own working rules: one rule per non-empty line, never edited
//            by dreaming (id `AGENTS.md:<line>`); every prompt rule file (id `rules/<name>`), which
//            dreaming adds and updates.
//   project  the repository's instruction file (AGENTS.md, else CLAUDE.md, at its root): one rule per
//            non-empty, non-heading line (id `<repository>:<line>`); dreaming appends under
//            `## Learned rules` and updates its own lines.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listRules } from "../../extensions/lib/rules.ts";

export interface KnownRule {
	id: string;
	text: string;
	/** Whether dreaming may update it. */
	editable: boolean;
}

/** The heading dreaming appends project rules under. */
export const LEARNED_HEADING = "## Learned rules";

/** One rule per non-empty line that is not a heading, a rule or a list marker alone. */
function lineRules(content: string, prefix: string, editable: (line: number, lines: string[]) => boolean): KnownRule[] {
	const lines = content.split("\n");
	return lines.flatMap((line, i) => {
		const text = line.trim();
		if (!text || text.startsWith("#") || /^(-{3,}|[-*])$/.test(text)) return [];
		return [{ id: `${prefix}:${i + 1}`, text, editable: editable(i, lines) }];
	});
}

/** The user's global rules (read-only) and the prompt rules (editable). */
export function globalRules(promptDir: string): KnownRule[] {
	const agents = join(promptDir, "AGENTS.md");
	return [
		...(existsSync(agents) ? lineRules(readFileSync(agents, "utf8"), "AGENTS.md", () => false) : []),
		...listRules(join(promptDir, "rules"))
			.filter((rule) => rule.body)
			.map((rule) => ({ id: `rules/${rule.name}`, text: rule.body, editable: true })),
	];
}

/** A repository's instruction file: AGENTS.md, else an existing CLAUDE.md, at its root. */
export function instructionFile(repo: string): string {
	const agents = join(repo, "AGENTS.md");
	const claude = join(repo, "CLAUDE.md");
	return existsSync(agents) || !existsSync(claude) ? agents : claude;
}

/** A repository's rules; the lines under the learned heading are editable. */
export function projectRules(repo: string): KnownRule[] {
	const file = instructionFile(repo);
	if (!existsSync(file)) return [];
	const learned = (line: number, lines: string[]) => {
		const heading = lines.slice(0, line).findLastIndex((l) => l.trim().startsWith("#"));
		return heading >= 0 && lines[heading]!.trim() === LEARNED_HEADING;
	};
	return lineRules(readFileSync(file, "utf8"), repo, learned);
}
