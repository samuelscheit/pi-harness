// node extensions/metrics/cli.ts [--all] [--cwd <dir>] [--since <ISO date>] [--source pi|claude-code|all]
// Prints the metrics report; the scope defaults to Pi sessions in the current directory.
// `--source claude-code` imports ~/.claude/projects for analysis (never into harness versions).

import { parseArgs } from "node:util";
import type { Scope } from "./report.ts";
import { stats } from "./stats.ts";

const SOURCES = ["pi", "claude-code", "all"];
const { values } = parseArgs({
	options: { all: { type: "boolean" }, cwd: { type: "string" }, since: { type: "string" }, source: { type: "string" } },
});
const since = values.since === undefined ? undefined : Date.parse(values.since);
if (since !== undefined && Number.isNaN(since)) throw new Error(`--since: not a date: ${values.since}`);
if (values.source !== undefined && !SOURCES.includes(values.source)) throw new Error(`--source: one of ${SOURCES.join(", ")}`);
console.log(stats({ cwd: values.all ? undefined : (values.cwd ?? process.cwd()), since, source: values.source as Scope["source"] }));
