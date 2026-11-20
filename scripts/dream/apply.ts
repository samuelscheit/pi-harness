// Dreaming, step 4: apply each delta as its own commit, live at once (the user's choice: one
// reviewable commit per change, judged afterwards by whether the correction comes back).
//
//   global add     prompt/rules/<name>.md in the harness repository (frontmatter `source: dream`)
//   global update  the rule file's body; its frontmatter stays, `updated` is set
//   project add    a line under `## Learned rules` in the repository's instruction file
//   project update that line, which must still read as the curator saw it
//
// A file with uncommitted changes is not touched (the delta is reported as skipped), so dreaming
// never commits the user's own work in progress. The commit is built without the checkout and the
// branch moved after (commit.ts): a branch that refuses the move keeps the checkout as it was and
// the commit lands on `dream/<date>-<slug>` instead, reported as not landed.

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { stringify } from "yaml";
import { type Committed, commitFiles, dirty, firstLine, isRepository } from "./commit.ts";
import type { Delta } from "./curate.ts";
import { instructionFile, type KnownRule, LEARNED_HEADING } from "./rules.ts";

export interface Evidence {
	ts: number;
	sessionId: string;
	text: string;
}

export interface ApplyContext {
	/** The harness repository (the source of releases). */
	source: string;
	now: Date;
	rules: ReadonlyMap<string, KnownRule>;
	evidence: (ref: string) => Evidence;
}

export interface Applied extends Partial<Committed> {
	delta: Delta;
	/** The rule the delta is about: an existing id, the new rule's id, or where a new rule was meant to go. */
	target?: string;
	skipped?: string;
}

const day = (at: Date | number) => new Date(at).toISOString().slice(0, 10);

/** The branch that keeps a commit the checked-out branch refused. */
export function fallbackBranch(ctx: { now: Date }, text: string): string {
	const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").split("-").filter(Boolean).slice(0, 6).join("-").slice(0, 48).replace(/-$/, "");
	return `dream/${day(ctx.now)}-${slug || "rule"}`;
}

function message(title: string, rule: string, delta: Delta, ctx: ApplyContext, why?: string): string {
	const quotes = delta.evidence.map((ref) => {
		const e = ctx.evidence(ref);
		return `- ${day(e.ts)}, session ${e.sessionId.slice(0, 8)}: "${e.text.replace(/\s+/g, " ").trim().slice(0, 300)}"`;
	});
	return [
		title,
		"",
		`Dreaming (scripts/dream) on ${day(ctx.now)}, from ${delta.evidence.length} correction${delta.evidence.length === 1 ? "" : "s"} the user typed.`,
		"",
		"## Rule",
		"",
		rule,
		...(why ? ["", "## Why changed", "", why] : []),
		"",
		"## Evidence",
		"",
		...quotes,
		"",
		"## Judged by",
		"",
		"Recurrence: a later correction the curator matches to this rule is logged against it in .agents/dreams/ledger.jsonl and counted in the dream reports.",
		"",
		"## Revert",
		"",
		"git revert this commit.",
		"",
	].join("\n");
}

/** The rule file for a new global rule: the name, or the name with the first free numeric suffix. */
function freeRuleFile(source: string, rulesDir: string, name: string): { file: string; name: string } {
	for (let i = 1; ; i++) {
		const candidate = i === 1 ? name : `${name}-${i}`;
		const file = join(rulesDir, `${candidate}.md`);
		if (!existsSync(file) && !dirty(source, file)) return { file, name: candidate };
	}
}

/** Insert `line` as the last line of the learned section, adding the section at the end when missing. */
export function withLearnedLine(content: string, line: string): string {
	const lines = content.replace(/\n+$/, "").split("\n");
	const heading = lines.findIndex((l) => l.trim() === LEARNED_HEADING);
	if (heading < 0) return `${[...(content.trim() ? [...lines, ""] : []), LEARNED_HEADING, "", line].join("\n")}\n`;
	let end = lines.findIndex((l, i) => i > heading && l.trim().startsWith("#"));
	if (end < 0) end = lines.length;
	let last = end - 1;
	while (last > heading && !lines[last]!.trim()) last--;
	const insertAt = last === heading ? heading + 1 : last + 1;
	const added = last === heading ? ["", line] : [line];
	lines.splice(insertAt, 0, ...added);
	return `${lines.join("\n")}\n`;
}

function applyGlobal(delta: Extract<Delta, { op: "add"; scope: "global" }> | Extract<Delta, { op: "update" }>, ctx: ApplyContext): Applied {
	const rulesDir = join(ctx.source, "prompt", "rules");
	if (delta.op === "add") {
		const { file, name } = freeRuleFile(ctx.source, rulesDir, delta.name);
		const content = `---\n${stringify({ source: "dream", added: day(ctx.now) })}---\n\n${delta.text}\n`;
		return { delta, target: `rules/${name}`, ...commitFiles(ctx.source, [{ path: file, content }], message(`feat(rules): learned rule ${name}`, delta.text, delta, ctx), fallbackBranch(ctx, name)) };
	}
	const name = delta.rule.slice("rules/".length);
	const file = join(rulesDir, `${name}.md`);
	if (dirty(ctx.source, file)) return { delta, target: delta.rule, skipped: `${relative(ctx.source, file)} has uncommitted changes` };
	const { frontmatter } = parseFrontmatter(readFileSync(file, "utf8"));
	const content = `---\n${stringify({ ...frontmatter, updated: day(ctx.now) })}---\n\n${delta.text}\n`;
	return { delta, target: delta.rule, ...commitFiles(ctx.source, [{ path: file, content }], message(`fix(rules): sharpen rule ${name}`, delta.text, delta, ctx, delta.reason), fallbackBranch(ctx, name)) };
}

function applyProject(delta: Extract<Delta, { op: "add"; scope: "project" }> | Extract<Delta, { op: "update" }>, ctx: ApplyContext, target: string): Applied {
	const repo = delta.op === "add" ? delta.repo : delta.rule.slice(0, delta.rule.lastIndexOf(":"));
	if (!isRepository(repo)) return { delta, target, skipped: `${repo} is not a git repository` };
	const file = instructionFile(repo);
	const name = relative(repo, file);
	if (dirty(repo, file)) return { delta, target, skipped: `${name} in ${repo} has uncommitted changes` };
	const content = existsSync(file) ? readFileSync(file, "utf8") : "";
	if (delta.op === "add") {
		const next = withLearnedLine(content, `- ${delta.text}`);
		const line = next.split("\n").indexOf(`- ${delta.text}`) + 1;
		return { delta, target: `${repo}:${line}`, ...commitFiles(repo, [{ path: file, content: next }], message(`docs(agents): learned rule`, delta.text, delta, ctx), fallbackBranch(ctx, delta.text)) };
	}
	const lines = content.split("\n");
	const index = Number(delta.rule.slice(delta.rule.lastIndexOf(":") + 1)) - 1;
	const known = ctx.rules.get(delta.rule)?.text;
	if (lines[index]?.trim() !== known) return { delta, target, skipped: `${name}:${index + 1} changed since the rules were read` };
	lines[index] = `${/^\s*-\s/.test(lines[index]!) ? "- " : ""}${delta.text}`;
	return { delta, target, ...commitFiles(repo, [{ path: file, content: lines.join("\n") }], message(`docs(agents): sharpen learned rule`, delta.text, delta, ctx, delta.reason), fallbackBranch(ctx, delta.text)) };
}

/** What a delta is about before it is applied: the rule it names, or where a new rule goes. */
export function plannedTarget(delta: Delta): string | undefined {
	if (delta.op === "recur" || delta.op === "update") return delta.rule;
	if (delta.op === "add") return delta.scope === "global" ? `rules/${delta.name}` : instructionFile(delta.repo);
	return undefined;
}

/** Apply one delta: recurrences and skips change no file; a failure is reported as skipped. */
export function applyDelta(delta: Delta, ctx: ApplyContext): Applied {
	const target = plannedTarget(delta);
	if (delta.op === "recur") return { delta, target: delta.rule };
	if (delta.op === "skip") return { delta };
	try {
		if (delta.op === "add") return delta.scope === "global" ? applyGlobal(delta, ctx) : applyProject(delta, ctx, target!);
		return delta.rule.startsWith("rules/") ? applyGlobal(delta, ctx) : applyProject(delta, ctx, target!);
	} catch (error) {
		return { delta, ...(target ? { target } : {}), skipped: `failed: ${firstLine(error)}` };
	}
}
