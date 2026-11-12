// Groups the working rules the classifier extracted from user messages (classify-messages.ts) into
// canonical rules, and marks whether the harness's always-loaded instructions (prompt/AGENTS.md and
// prompt/base.md) already state each one. Prints how often each rule recurred across sessions.
//
// A rule users repeat although the instructions already state it points at instruction following
// (enforcement); one the instructions lack points at memory (writing it down).
//
// Usage: node scripts/evidence/cluster-rules.ts [--model claude-opus-5-5]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { askJson } from "../lib/labels.ts";
import { LABELS_FILE, type Labels, openIndex } from "./shared.ts";

const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : "claude-opus-5-5";
const CLUSTERS_FILE = LABELS_FILE.replace("user-message-labels", "rule-clusters");
const root = join(import.meta.dirname, "..", "..");
const instructions = ["prompt/AGENTS.md", "prompt/base.md"].map((file) => `<file path="${file}">\n${readFileSync(join(root, file), "utf8")}\n</file>`).join("\n");

type Cluster = { rule: string; members: number[]; covered: "yes" | "partly" | "no" };

const SYSTEM = `You receive working rules extracted from messages a user sent to AI coding agents, numbered, and the instructions the agent already loads in every session.
Group rules that ask for the same behaviour into one canonical rule (one short imperative sentence). Project-specific facts (a particular repo's command, a specific bug) are their own clusters.
For each cluster say whether the loaded instructions already state that behaviour: "yes", "partly" or "no".
Every rule number must appear in exactly one cluster.
Reply with only JSON: [{"rule": "...", "members": [numbers], "covered": "yes"|"partly"|"no"}].`;

async function main(): Promise<void> {
	const labels: Labels = JSON.parse(readFileSync(LABELS_FILE, "utf8"));
	const rules = Object.entries(labels)
		.filter(([, value]) => value.rule)
		.map(([key, value]) => ({ key, rule: value.rule as string }));
	const clusters: Cluster[] = existsSync(CLUSTERS_FILE)
		? JSON.parse(readFileSync(CLUSTERS_FILE, "utf8"))
		: await askJson(
				model,
				SYSTEM,
				`<instructions>\n${instructions}\n</instructions>\n<rules>\n${rules.map((r, i) => `${i}. ${r.rule}`).join("\n")}\n</rules>`,
				(value) => {
					const result = value as Cluster[];
					const seen = new Set(result.flatMap((c) => c.members));
					if (seen.size < rules.length * 0.95) throw new Error(`clusters cover ${seen.size} of ${rules.length} rules`);
					return result;
				},
				32_000,
			);
	writeFileSync(CLUSTERS_FILE, JSON.stringify(clusters));

	const db = openIndex();
	const when = db.prepare("SELECT ts FROM user_messages WHERE session_id = ? AND entry_id = ?");
	const rows = clusters.map((c) => {
		const members = c.members.filter((i) => rules[i]).map((i) => rules[i].key.split(" "));
		const sessions = new Set(members.map(([session]) => session.split("/")[0]));
		const days = new Set(members.map(([session, entry]) => new Date((when.get(session, entry) as { ts: number }).ts).toISOString().slice(0, 10)));
		return { ...c, messages: members.length, sessions: sessions.size, days: days.size };
	});
	rows.sort((a, b) => b.sessions - a.sessions);
	const recurring = rows.filter((r) => r.sessions >= 2);
	const repeats = (filter: (r: (typeof rows)[number]) => boolean) => recurring.filter(filter).reduce((sum, r) => sum + r.messages, 0);
	console.log(`${rules.length} rules in ${rows.length} clusters; ${recurring.length} recur in 2+ sessions, carrying ${repeats(() => true)} messages.`);
	console.log(`Of those messages: already in the instructions ${repeats((r) => r.covered === "yes")}, partly ${repeats((r) => r.covered === "partly")}, missing ${repeats((r) => r.covered === "no")}.\n`);
	console.log("| rule | messages | sessions | days | in instructions |\n|---|---|---|---|---|");
	for (const r of recurring.slice(0, 30)) console.log(`| ${r.rule.replaceAll("|", "/")} | ${r.messages} | ${r.sessions} | ${r.days} | ${r.covered} |`);
}

await main();
