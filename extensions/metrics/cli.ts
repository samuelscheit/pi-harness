// node extensions/metrics/cli.ts [--all] [--cwd <dir>] [--since <ISO date>] [--until <ISO date>] [--source pi|claude-code|all] [--model <id>]
// Prints the metrics report; the scope defaults to Pi sessions in the current directory.
// `--source claude-code` imports ~/.claude/projects for analysis (never into harness versions).

import { parseArgs } from "node:util";
import { SOURCES, type Source } from "./queries/index.ts";
import { stats } from "./stats.ts";

const { values } = parseArgs({
	options: {
		all: { type: "boolean" },
		cwd: { type: "string" },
		since: { type: "string" },
		until: { type: "string" },
		source: { type: "string" },
		model: { type: "string" },
	},
});
const date = (name: string, value: string | undefined) => {
	if (value === undefined) return undefined;
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) throw new Error(`--${name}: not a date: ${value}`);
	return ms;
};
if (values.source !== undefined && !SOURCES.includes(values.source as Source)) throw new Error(`--source: one of ${SOURCES.join(", ")}`);
console.log(
	stats({
		project: values.all ? undefined : (values.cwd ?? process.cwd()),
		start: date("since", values.since),
		end: date("until", values.until),
		source: values.source as Source | undefined,
		model: values.model,
	}),
);
