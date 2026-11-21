// Dreaming, step 3: turn the labelled corrections into small, itemized deltas on the rules (ACE's
// curator, docs/research/context-engineering/05 §4): a correction an existing rule already states
// is a recurrence of that rule; a new reusable rule is added; a rule whose wording proved too narrow
// is updated; a one-off is skipped. Never a rewrite of a whole file: ACE measured that collapsing
// the playbook (18,282 to 122 tokens) and scoring below no memory at all.

import { NAME } from "../../extensions/lib/experiments.ts";
import type { Label } from "../../extensions/metrics/labels.ts";
import { type Ask, askJson, type RuleScope } from "../lib/labels.ts";
import type { KnownRule } from "./rules.ts";

export interface Candidate {
	/** Short reference the model answers with (`c1`, `c2`, …). */
	ref: string;
	label: Label;
	text: string;
	rule: string;
	scope: RuleScope;
	repo: string;
	before?: string;
}

export type Delta =
	| { op: "recur"; rule: string; evidence: string[] }
	| { op: "add"; scope: "global"; name: string; text: string; evidence: string[] }
	| { op: "add"; scope: "project"; repo: string; text: string; evidence: string[] }
	| { op: "update"; rule: string; text: string; reason: string; evidence: string[] }
	| { op: "skip"; reason: string; evidence: string[] };

const MAX_RULE_CHARS = 600;
/** How much an update may lengthen a rule: it sharpens or widens the rule, it does not rewrite it. */
const MAX_UPDATE_GROWTH = 300;

const INSTRUCTIONS = `You curate the working rules of an AI coding agent from the corrections its user made. You receive the rules the agent already reads (each with an id) and new candidates: a message the user typed mid-session (with the agent's message before it when known), its label, and a rule a classifier derived from it, with a scope.

Decide for every candidate exactly one of these deltas; several candidates can share one delta:
- {"op":"recur","rule":"<id>","evidence":["c1",…]}: an existing rule already asks for this behaviour, even in other words. The agent broke a rule it had. Prefer this whenever a rule covers the candidate.
- {"op":"update","rule":"<id>","text":"<the rule's new full text>","reason":"…","evidence":[…]}: only for a rule marked editable, when the candidates show its wording is too narrow, too vague or contradicted by the user's newer statement. Keep the update minimal: same rule, sharper or wider wording.
- {"op":"add","scope":"global","name":"<kebab-case-name>","text":"…","evidence":[…]}: a new rule about how the agent works in any project, that no rule covers.
- {"op":"add","scope":"project","repo":"<repository path from the candidate>","text":"…","evidence":[…]}: a new rule that depends on that repository's code, tools, infrastructure or conventions.
- {"op":"skip","reason":"…","evidence":[…]}: a one-off decision about one task, a preference that does not generalize, unclear, or conflicting with other candidates without a clear winner.

Writing rules: one rule per delta, an imperative sentence or two, and the reason when it is not obvious. A new rule has at most ${MAX_RULE_CHARS} characters; an update makes a rule at most ${MAX_UPDATE_GROWTH} characters longer. Write it for any future session, not about this conversation. Match the existing rules' style. Never restate a rule that exists. A global rule must make sense in every project; anything naming a project's paths, commands, services or people is a project rule.
Reply with only JSON: {"deltas":[…]} covering every candidate ref exactly once.`;

function render(candidates: readonly Candidate[], rules: { global: readonly KnownRule[]; projects: ReadonlyMap<string, readonly KnownRule[]> }): string {
	const ruleLine = (rule: KnownRule) => `<rule id="${rule.id}"${rule.editable ? " editable" : ""}>${rule.text}</rule>`;
	const projects = [...rules.projects].map(([repo, list]) => `<project repo="${repo}">\n${list.map(ruleLine).join("\n") || "(no rules yet)"}\n</project>`);
	const items = candidates.map(
		(c) =>
			`<candidate ref="${c.ref}" label="${c.label}" scope="${c.scope}" repo="${c.repo}">\n${c.before ? `<agent_before>${c.before.slice(-500)}</agent_before>\n` : ""}<user>${c.text.slice(0, 1500)}</user>\n<derived_rule>${c.rule}</derived_rule>\n</candidate>`,
	);
	return [`<global_rules>\n${rules.global.map(ruleLine).join("\n")}\n</global_rules>`, ...projects, `<candidates>\n${items.join("\n")}\n</candidates>`].join("\n\n");
}

/**
 * A rule's text as the model wrote it, trimmed and without the list markers it may start with
 * ("- ", "* ", "1. "; apply writes a project rule as a list item itself). A project rule is one
 * line: its id is its line. Throws the reason when nothing is left or it is longer than `max`.
 */
function ruleText(value: unknown, oneLine: boolean, max: number): string {
	if (typeof value !== "string") throw new Error("text is not a string");
	let text = value.trim().replace(/^(?:(?:[-*+]|\d+[.)])(?:\s+|$))+/, "");
	if (oneLine) text = text.replace(/\s+/g, " ");
	if (!/[\p{L}\p{N}]/u.test(text)) throw new Error("text has no words");
	if (text.length > max) throw new Error(`text has ${text.length} characters, the limit is ${max}`);
	return text;
}

/** One delta of the model's answer; throws why it is invalid. */
function parseDelta(raw: Record<string, unknown>, evidence: string[], rules: ReadonlyMap<string, KnownRule>, repos: ReadonlySet<string>): Delta {
	const known = (id: unknown): KnownRule => {
		const rule = typeof id === "string" ? rules.get(id) : undefined;
		if (!rule) throw new Error(`no rule has the id ${JSON.stringify(id)}`);
		return rule;
	};
	const reason = String(raw.reason ?? "");
	switch (raw.op) {
		case "recur":
			return { op: "recur", rule: known(raw.rule).id, evidence };
		case "update": {
			const rule = known(raw.rule);
			if (!rule.editable) throw new Error(`${rule.id} is not editable`);
			const max = Math.max(MAX_RULE_CHARS, rule.text.length + MAX_UPDATE_GROWTH);
			return { op: "update", rule: rule.id, text: ruleText(raw.text, !rule.id.startsWith("rules/"), max), reason, evidence };
		}
		case "add":
			if (raw.scope === "global") {
				if (typeof raw.name !== "string" || !NAME.test(raw.name)) throw new Error(`name ${JSON.stringify(raw.name)} is not kebab-case`);
				return { op: "add", scope: "global", name: raw.name, text: ruleText(raw.text, false, MAX_RULE_CHARS), evidence };
			}
			if (raw.scope === "project") {
				if (typeof raw.repo !== "string" || !repos.has(raw.repo)) throw new Error(`repo ${JSON.stringify(raw.repo)} is no candidate's repository`);
				return { op: "add", scope: "project", repo: raw.repo, text: ruleText(raw.text, true, MAX_RULE_CHARS), evidence };
			}
			throw new Error(`scope ${JSON.stringify(raw.scope)} is neither global nor project`);
		case "skip":
			return { op: "skip", reason, evidence };
		default:
			throw new Error(`op ${JSON.stringify(raw.op)} is unknown`);
	}
}

/** The model's deltas, validated against the candidates and rules; throws on anything malformed. */
export function parseDeltas(value: unknown, candidates: readonly Candidate[], rules: readonly KnownRule[]): Delta[] {
	const deltas = (value as { deltas?: unknown })?.deltas;
	if (!Array.isArray(deltas)) throw new Error("expected {deltas: [...]}");
	const refs = new Set(candidates.map((c) => c.ref));
	const repos = new Set(candidates.map((c) => c.repo));
	const byId = new Map(rules.map((rule) => [rule.id, rule]));
	const seen = new Set<string>();
	const result: Delta[] = [];
	for (const raw of deltas as Record<string, unknown>[]) {
		const evidence = raw?.evidence;
		if (!Array.isArray(evidence) || evidence.length === 0 || !evidence.every((ref) => typeof ref === "string" && refs.has(ref))) throw new Error(`bad evidence in ${JSON.stringify(raw)}`);
		for (const ref of evidence as string[]) {
			if (seen.has(ref)) throw new Error(`${ref} is in two deltas`);
			seen.add(ref);
		}
		try {
			result.push(parseDelta(raw, evidence as string[], byId, repos));
		} catch (error) {
			throw new Error(`invalid delta (${(error as Error).message}): ${JSON.stringify(raw)}`);
		}
	}
	const missing = [...refs].filter((ref) => !seen.has(ref));
	if (missing.length) throw new Error(`no delta for ${missing.join(", ")}`);
	return result;
}

/** Ask the curator model for the deltas of `candidates` (empty: no call). */
export async function curate(
	candidates: readonly Candidate[],
	rules: { global: readonly KnownRule[]; projects: ReadonlyMap<string, readonly KnownRule[]> },
	model: string,
	ask: Ask = askJson,
): Promise<Delta[]> {
	if (candidates.length === 0) return [];
	const all = [...rules.global, ...[...rules.projects.values()].flat()];
	return ask(model, INSTRUCTIONS, render(candidates, rules), (value) => parseDeltas(value, candidates, all), 32_000);
}
