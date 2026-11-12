// Dreaming, step 4: apply each delta as its own commit, live at once (the user's choice: one
// reviewable commit per change, judged afterwards by whether the correction comes back).
//
//   global add     prompt/rules/<name>.md in the harness repository (frontmatter `source: dream`)
//   global update  the rule file's body; its frontmatter stays, `updated` is set
//   project add    a line under `## Learned rules` in the repository's instruction file
//   project update that line, which must still read as the curator saw it
//
// A file with uncommitted edits is not touched (the delta is reported as skipped), so dreaming
// never commits the user's own work in progress. `git commit --only <file>` leaves anything else
// staged alone.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { stringify } from "yaml";
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

export interface Applied {
	delta: Delta;
	/** The rule the delta is about: an existing id, or the new rule's id. */
	target?: string;
	commit?: string;
	skipped?: string;
}

const git = (repo: string, args: string[], input?: string) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();

const isRepository = (dir: string) => {
	try {
		return git(dir, ["rev-parse", "--show-toplevel"]) !== "";
	} catch {
		return false;
	}
};

/** Uncommitted changes to `file` (staged or not, or untracked). */
const dirty = (repo: string, file: string) => git(repo, ["status", "--porcelain", "--", file]) !== "";

function commitFile(repo: string, file: string, message: string): string {
	git(repo, ["add", "--", file]);
	git(repo, ["commit", "--only", "-F", "-", "--", file], message);
	return git(repo, ["rev-parse", "HEAD"]);
}

const day = (at: Date | number) => new Date(at).toISOString().slice(0, 10);

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
function freeRuleFile(rulesDir: string, name: string): { file: string; name: string } {
	for (let i = 1; ; i++) {
		const candidate = i === 1 ? name : `${name}-${i}`;
		const file = join(rulesDir, `${candidate}.md`);
		if (!existsSync(file)) return { file, name: candidate };
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
		const { file, name } = freeRuleFile(rulesDir, delta.name);
		mkdirSync(rulesDir, { recursive: true });
		writeFileSync(file, `---\n${stringify({ source: "dream", added: day(ctx.now) })}---\n\n${delta.text}\n`);
		return { delta, target: `rules/${name}`, commit: commitFile(ctx.source, file, message(`feat(rules): learned rule ${name}`, delta.text, delta, ctx)) };
	}
	const name = delta.rule.slice("rules/".length);
	const file = join(rulesDir, `${name}.md`);
	if (dirty(ctx.source, file)) return { delta, target: delta.rule, skipped: `${relative(ctx.source, file)} has uncommitted changes` };
	const { frontmatter } = parseFrontmatter(readFileSync(file, "utf8"));
	writeFileSync(file, `---\n${stringify({ ...frontmatter, updated: day(ctx.now) })}---\n\n${delta.text}\n`);
	return { delta, target: delta.rule, commit: commitFile(ctx.source, file, message(`fix(rules): sharpen rule ${name}`, delta.text, delta, ctx, delta.reason)) };
}

function applyProject(delta: Extract<Delta, { op: "add"; scope: "project" }> | Extract<Delta, { op: "update" }>, ctx: ApplyContext): Applied {
	const separator = delta.op === "update" ? delta.rule.lastIndexOf(":") : -1;
	const repo = delta.op === "add" ? delta.repo : delta.rule.slice(0, separator);
	if (!isRepository(repo)) return { delta, ...(delta.op === "update" ? { target: delta.rule } : {}), skipped: `${repo} is not a git repository` };
	const file = instructionFile(repo);
	const name = relative(repo, file);
	if (existsSync(file) && dirty(repo, file)) return { delta, ...(delta.op === "update" ? { target: delta.rule } : {}), skipped: `${name} in ${repo} has uncommitted changes` };
	const content = existsSync(file) ? readFileSync(file, "utf8") : "";
	if (delta.op === "add") {
		const next = withLearnedLine(content, `- ${delta.text}`);
		const line = next.split("\n").indexOf(`- ${delta.text}`) + 1;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, next);
		return { delta, target: `${repo}:${line}`, commit: commitFile(repo, file, message(`docs(agents): learned rule`, delta.text, delta, ctx)) };
	}
	const lines = content.split("\n");
	const index = Number(delta.rule.slice(separator + 1)) - 1;
	const known = ctx.rules.get(delta.rule)?.text;
	if (lines[index]?.trim() !== known) return { delta, target: delta.rule, skipped: `${name}:${index + 1} changed since the rules were read` };
	lines[index] = `${/^\s*-\s/.test(lines[index]!) ? "- " : ""}${delta.text}`;
	writeFileSync(file, lines.join("\n"));
	return { delta, target: delta.rule, commit: commitFile(repo, file, message(`docs(agents): sharpen learned rule`, delta.text, delta, ctx, delta.reason)) };
}

/** Apply one delta: recurrences and skips change no file. */
export function applyDelta(delta: Delta, ctx: ApplyContext): Applied {
	if (delta.op === "recur") return { delta, target: delta.rule };
	if (delta.op === "skip") return { delta };
	if (delta.op === "add") return delta.scope === "global" ? applyGlobal(delta, ctx) : applyProject(delta, ctx);
	return delta.rule.startsWith("rules/") ? applyGlobal(delta, ctx) : applyProject(delta, ctx);
}
