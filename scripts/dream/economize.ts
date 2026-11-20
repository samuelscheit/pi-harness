// Dreaming, economize: from the spend facts (spend.ts), an economist model proposes how to spend
// less without working worse, and each proposal that can be measured starts as an A/B experiment
// (lib/experiments.ts) of its own commit. Nothing it proposes reaches every session untested: the
// judge (judge.ts) promotes an experiment only when it saved money and quality held, and stops it
// otherwise. Proposals that need code or configuration beyond a prompt section and the session
// settings (lib/variants.ts) are returned as notes for the report.
//
// The economist sees the facts, the rules and settings in force, every experiment (running and
// stopped, with why dreaming ended its own), and what each model costs per token.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type Experiment, listExperiments, NAME, settingsConflict, withFrontmatter } from "../../extensions/lib/experiments.ts";
import { listRules } from "../../extensions/lib/rules.ts";
import { describeSettings, hasSettings, parseSessionKind, parseSettings, piDefaults, type SessionKind, type SessionSettings } from "../../extensions/lib/variants.ts";
import { type Ask, askJson } from "../lib/labels.ts";
import { fallbackBranch } from "./apply.ts";
import { type Committed, commitFiles, dirty } from "./commit.ts";
import { clip } from "../../extensions/metrics/format.ts";
import { GUARDS, LEVEL, MAX_DAYS, MIN_SESSIONS, REVIEW_GUARD, type Verdict } from "./judge.ts";
import { type EconomyRecord, experimentsDir, pendingBranches, readEconomy, rulesDir } from "./ledger.ts";

export const ECONOMIST_MODEL = "claude-opus-5-5";
/** Dream experiments running at once at most: each one halves the sessions the others are measured on alone. */
export const MAX_RUNNING = 3;
/** New experiments per run at most. */
export const MAX_NEW = 2;
const MAX_BODY_CHARS = 1200;

export interface Proposal {
	name: string;
	hypothesis: string;
	body: string;
	settings: SessionSettings;
	sessions: SessionKind;
	expectedWeeklySaving: number;
	qualityRisk: "low" | "medium";
	evidence: string;
}

export interface Note {
	title: string;
	body: string;
}

export interface Economy {
	proposals: Proposal[];
	notes: Note[];
	/** Proposals refused by validation, with the reason. */
	refused: { name: string; reason: string }[];
}

const INSTRUCTIONS = `You are the economist of an AI coding agent harness. Your goal: lower what the agent's model usage costs, with no loss in the quality of its work. Quality comes first: a saving that makes the work worse is a failure.

You receive the spend facts (where the money went in the last window and the week before, with quality signals), the working rules and session settings in force, every experiment so far, and the per-token prices of the models in use.

Propose at most {max} new A/B experiments. Each one runs on half of the new sessions it enrolls; the other half is the control. Dreaming judges it nightly: it is promoted to every session only when cost per package (a package is one user request) drops with {level} confidence and every quality guard holds: {guards}. It is stopped when quality gets worse, when it costs more, or after {days} days without promotion. So a proposal must be measurable within about {sessions} sessions per arm.

An experiment can change:
- "body": a prompt section the agent reads in arm B: concrete working behaviour that wastes less (for example how much command output to read at once, when to compact or start fresh, what to delegate and how to brief it). Imperative, specific, short, never weakening verification, testing or review.
- "settings": the session settings of arm B: "model" (provider/id; replaces only the default model), "thinking" (off, minimal, low, medium, high, xhigh, max; replaces only the default level). When to compact is not yours to set: a fixed context limit forces compactions on tasks that need their context and makes sessions read again what they lost; sessions decide it themselves (the compaction decider, with its own experiment and measurements in the facts).
- "sessions": which new sessions it enrolls: "all", "delegated" (subagent sessions a parent started with delegate_task) or "top-level". Settings experiments enroll new sessions only.

Rules for proposals:
- Ground each one in the facts: name the numbers that make the saving likely and estimate the weekly saving in USD.
- Prefer the largest saving with the lowest quality risk. Never propose a "high" quality risk; such ideas are notes at most.
- Do not repeat a running experiment or one that was stopped, unless the facts changed in a way you name. Do not set a setting that a running experiment sets for the same sessions.
- One change per experiment, so its effect can be attributed.
- Proposing nothing is right when nothing is both promising and safe.

Notes: improvements that cannot be an experiment of this kind (they need code: tools, compaction, caching, the metrics) and are worth a person's or an agent's time, each with its evidence and estimated saving.

Reply with only JSON:
{"experiments":[{"name":"<kebab-case>","hypothesis":"<one sentence: what changes and why it saves without hurting quality>","body":"<prompt section or empty>","settings":{…},"sessions":"all|delegated|top-level","expectedWeeklySaving":<USD number>,"qualityRisk":"low|medium","evidence":"<the facts behind it>"}],"notes":[{"title":"…","body":"…"}]}`;

function instructions(max: number): string {
	const guards = [...GUARDS, REVIEW_GUARD]
		.map((g) => `${g.label} not ${g.worse === "higher" ? "higher" : "lower"} by more than ${g.margin}${g.kinds ? ` (${g.kinds.join(", ")} sessions)` : ""}`)
		.join("; ");
	return INSTRUCTIONS.replace("{max}", String(max)).replace("{level}", `${LEVEL * 100}%`).replace("{guards}", guards).replace("{days}", String(MAX_DAYS)).replace("{sessions}", String(MIN_SESSIONS));
}

/** What each model cost per million tokens over the last 30 days of requests. */
function prices(db: DatabaseSync, now: number): string {
	const rows = db
		.prepare(
			`SELECT provider, model, AVG(input_rate) input, AVG(read_rate) read, AVG(write_rate) write, AVG(CASE WHEN output > 0 THEN cost_output * 1.0 / output END) output, COUNT(*) turns
			FROM requests WHERE kind = 'turn' AND ts >= ? AND input_rate IS NOT NULL GROUP BY provider, model ORDER BY turns DESC LIMIT 12`,
		)
		.all(now - 30 * 86_400_000) as { provider: string; model: string; input: number; read: number; write: number; output: number | null; turns: number }[];
	const m = (rate: number | null) => (rate === null ? "–" : `$${(rate * 1e6).toFixed(2)}`);
	return rows.map((r) => `- ${r.provider}/${r.model}: input ${m(r.input)}, cache read ${m(r.read)}, cache write ${m(r.write)}, output ${m(r.output)} per million tokens (${r.turns} turns)`).join("\n");
}

function describeExperiment(e: Experiment, history: readonly EconomyRecord[]): string {
	const ended = history.filter((r) => r.kind === "verdict" && r.experiment === e.name && r.decision !== "continue").at(-1);
	return [
		`<experiment name="${e.name}" status="${e.status}"${e.frontmatter.source ? ` source="${String(e.frontmatter.source)}"` : ""}${e.frontmatter.started ? ` started="${String(e.frontmatter.started)}"` : ""} sessions="${e.sessions}">`,
		...(e.frontmatter.hypothesis ? [`hypothesis: ${String(e.frontmatter.hypothesis)}`] : []),
		...(hasSettings(e.settings) ? [`settings: ${describeSettings(e.settings)}`] : []),
		...(e.tools.length ? [`tools: ${e.tools.join(", ")}`] : []),
		...(e.body ? [`body: ${clip(e.body, 600)}`] : []),
		...(ended ? [`ended by dreaming: ${ended.decision}: ${ended.reasons?.join("; ")}`] : []),
		"</experiment>",
	].join("\n");
}

export interface EconomyContext {
	source: string;
	db: DatabaseSync;
	now: Date;
	facts: string;
	ask?: Ask;
}

/** The economist's input: facts, rules, settings, experiments, prices. */
export function economistInput({ source, db, now, facts }: EconomyContext): string {
	const rules = listRules(rulesDir(source)).filter((r) => !r.problem);
	const defaults = piDefaults();
	const history = readEconomy(source);
	const experiments = listExperiments(experimentsDir(source));
	const agents = join(source, "prompt", "AGENTS.md");
	return [
		`<facts>\n${facts}\n</facts>`,
		`<settings>\nDefault model ${defaults.model ?? "(not set)"}, default thinking level ${defaults.thinking}. Pi compacts at the model's context window minus a reserve (about 984k tokens on a 1M window), or where a session decided to (the compaction decider).\n${
			rules.filter((r) => hasSettings(r.settings)).map((r) => `Rule ${r.name} sets ${describeSettings(r.settings)} for ${r.sessions} sessions.`).join("\n") || "No rule sets session settings."
		}\n</settings>`,
		`<prices>\n${prices(db, now.getTime())}\n</prices>`,
		`<user_rules>\n${existsSync(agents) ? readFileSync(agents, "utf8").trim() : ""}\n</user_rules>`,
		`<rules>\n${rules.map((r) => `<rule name="${r.name}">${clip(r.body, 400)}</rule>`).join("\n")}\n</rules>`,
		`<experiments>\n${experiments.map((e) => describeExperiment(e, history)).join("\n") || "none yet"}\n</experiments>`,
	].join("\n\n");
}

/** The economist's answer, validated: invalid proposals are refused with the reason, not thrown. */
export function parseEconomy(value: unknown, existing: readonly Experiment[], taken: ReadonlySet<string>, max: number): Economy {
	const raw = value as { experiments?: unknown; notes?: unknown };
	if (!raw || !Array.isArray(raw.experiments) || (raw.notes !== undefined && !Array.isArray(raw.notes))) throw new Error('expected {"experiments": [...], "notes": [...]}');
	const proposals: Proposal[] = [];
	const refused: Economy["refused"] = [];
	const running = existing.filter((e) => e.status === "running" && !e.problem);
	for (const item of raw.experiments as Record<string, unknown>[]) {
		const name = typeof item?.name === "string" ? item.name : "";
		const refuse = (reason: string) => refused.push({ name: name || "(unnamed)", reason });
		if (!NAME.test(name)) refuse("invalid name");
		else if (taken.has(name) || proposals.some((p) => p.name === name)) refuse("the name is taken by an experiment or rule");
		else {
			const settings = parseSettings(item.settings);
			const sessions = parseSessionKind(item.sessions);
			const body = typeof item.body === "string" ? item.body.trim() : "";
			const risk = item.qualityRisk;
			const saving = Number(item.expectedWeeklySaving);
			if ("problem" in settings) refuse(settings.problem);
			else if (settings.maxContextTokens !== undefined || settings.decideCompactionAbove !== undefined) refuse("when to compact is the compaction decider's, not a spend experiment's");
			else if (!sessions) refuse(`invalid sessions ${JSON.stringify(item.sessions)}`);
			else if (!body && !hasSettings(settings)) refuse("neither a body nor settings");
			else if (body.length > MAX_BODY_CHARS) refuse(`body longer than ${MAX_BODY_CHARS} characters`);
			else if (risk !== "low" && risk !== "medium") refuse(`quality risk ${JSON.stringify(risk)}: only low and medium risks are tested`);
			else if (!Number.isFinite(saving) || saving <= 0) refuse("no expected saving");
			else if (typeof item.hypothesis !== "string" || !item.hypothesis.trim()) refuse("no hypothesis");
			else {
				const candidate = { settings, sessions };
				const clash = [...running, ...proposals].find((o) => settingsConflict(candidate, o).length);
				if (clash) refuse(`sets ${settingsConflict(candidate, clash).join(", ")} like ${clash.name} for the same sessions`);
				else if (proposals.length >= max) refuse(`only ${max} new experiments this run`);
				else proposals.push({ name, hypothesis: item.hypothesis.trim(), body, settings, sessions, expectedWeeklySaving: saving, qualityRisk: risk, evidence: typeof item.evidence === "string" ? item.evidence.trim() : "" });
			}
		}
	}
	const notes = ((raw.notes ?? []) as Record<string, unknown>[]).filter((n) => typeof n?.title === "string" && typeof n?.body === "string").map((n) => ({ title: String(n.title), body: String(n.body) }));
	return { proposals, notes, refused };
}

/** The experiment file of a proposal. */
export function experimentFile(p: Proposal, now: Date): string {
	return withFrontmatter(
		{
			status: "running",
			started: now.toISOString(),
			source: "dream",
			hypothesis: p.hypothesis,
			expectedWeeklySaving: Math.round(p.expectedWeeklySaving),
			qualityRisk: p.qualityRisk,
			...(hasSettings(p.settings) ? { settings: p.settings } : {}),
			...(p.sessions !== "all" ? { sessions: p.sessions } : {}),
		},
		p.body,
	);
}

function commitMessage(p: Proposal, now: Date): string {
	return [
		`feat(experiments): dreamed spend experiment ${p.name}`,
		"",
		`Dreaming (scripts/dream/economize.ts) on ${now.toISOString().slice(0, 10)} started an A/B experiment to spend less without working worse.`,
		"",
		`Hypothesis: ${p.hypothesis}`,
		"",
		`Arm B: ${[p.body ? "a prompt section" : "", hasSettings(p.settings) ? `settings ${describeSettings(p.settings)}` : ""].filter(Boolean).join(" and ")}; enrolls ${p.sessions} new sessions.`,
		`Expected saving: about $${Math.round(p.expectedWeeklySaving)} a week. Quality risk: ${p.qualityRisk}.`,
		"",
		"## Evidence",
		"",
		p.evidence || "(none given)",
		"",
		"## How it ends",
		"",
		`Dreaming judges it every night (scripts/dream/judge.ts): promoted when cost per package drops with ${LEVEL * 100}% confidence while the quality guards hold (dream labels, tool errors, interrupts, the parent's rework for subagents, blind reviews), stopped when quality or cost gets worse or after ${MAX_DAYS} days.`,
		"",
		"## Revert",
		"",
		`Delete prompt/experiments/${p.name}.md, or stop it with /harness experiment ${p.name} stop.`,
	].join("\n");
}

export interface Started extends Partial<Committed> {
	proposal: Proposal;
	skipped?: string;
}

/** Ask the economist and start its experiments (unless a dry run). */
export async function economize(ctx: EconomyContext & { dryRun: boolean }): Promise<{ economy: Economy; started: Started[] }> {
	const { source, now, ask = askJson, dryRun } = ctx;
	const dir = experimentsDir(source);
	const existing = listExperiments(dir);
	// Experiments committed on a branch that did not land yet count as running and keep their names.
	const pending = [...pendingBranches(readEconomy(source)).keys()].filter((name) => !existing.some((e) => e.name === name));
	const free = Math.min(MAX_NEW, MAX_RUNNING - existing.filter((e) => e.status === "running" && !e.problem && e.frontmatter.source === "dream").length - pending.length);
	const taken = new Set([...existing.map((e) => e.name), ...listRules(rulesDir(source)).map((r) => r.name), ...pending]);
	if (free <= 0) return { economy: { proposals: [], notes: [], refused: [] }, started: [] };
	const economy = await ask(ECONOMIST_MODEL, instructions(free), economistInput(ctx), (value) => parseEconomy(value, existing, taken, free), 16_000);
	const started = economy.proposals.map((proposal): Started => {
		if (dryRun) return { proposal };
		const path = join(dir, `${proposal.name}.md`);
		if (existsSync(path) && dirty(source, path)) return { proposal, skipped: `${path} has uncommitted changes` };
		return { proposal, ...commitFiles(source, [{ path, content: experimentFile(proposal, now) }], commitMessage(proposal, now), fallbackBranch({ now }, `experiment-${proposal.name}`)) };
	});
	return { economy, started };
}

/** The report's spend section: the facts, the verdicts on running experiments, the experiments started, and the notes. */
export function spendSection({ facts, verdicts, started, economy }: { facts: string; verdicts: readonly (Verdict & Partial<Committed> & { skipped?: string })[]; started: readonly Started[]; economy: Economy }): string {
	const outcome = (r: Partial<Committed> & { skipped?: string }) =>
		r.skipped ? ` — not applied: ${r.skipped}` : r.commit ? ` (${r.commit.slice(0, 9)}${r.branch ? `, on branch ${r.branch}, not landed: ${r.refused}` : ""})` : "";
	return [
		"## Spend",
		"",
		facts,
		"",
		"### Dream experiments judged",
		"",
		...(verdicts.length ? verdicts.map((v) => `- ${v.experiment}: **${v.decision}**${outcome(v)} — ${v.reasons.join("; ")}`) : ["None running."]),
		"",
		"### Dream experiments started",
		"",
		...(started.length
			? started.map(
					({ proposal: p, ...r }) =>
						`- ${p.name}${outcome(r)}: ${p.hypothesis} Arm B: ${[p.body ? "prompt section" : "", hasSettings(p.settings) ? describeSettings(p.settings) : ""].filter(Boolean).join(" + ")}, ${p.sessions} sessions; about $${Math.round(p.expectedWeeklySaving)} a week, quality risk ${p.qualityRisk}.`,
				)
			: ["None."]),
		...(economy.refused.length ? ["", "Refused proposals:", "", ...economy.refused.map((r) => `- ${r.name}: ${r.reason}`)] : []),
		"",
		"### Spend improvements that need code",
		"",
		...(economy.notes.length ? economy.notes.flatMap((n) => [`#### ${n.title}`, "", n.body, ""]) : ["None."]),
	].join("\n");
}
