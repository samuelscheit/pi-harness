// node extensions/metrics/cli.ts [--all] [--cwd <dir>] [--since <ISO date>]
// Prints the metrics report; the scope defaults to the current directory.

import { parseArgs } from "node:util";
import { stats } from "./stats.ts";

const { values } = parseArgs({
	options: { all: { type: "boolean" }, cwd: { type: "string" }, since: { type: "string" } },
});
const since = values.since === undefined ? undefined : Date.parse(values.since);
if (since !== undefined && Number.isNaN(since)) throw new Error(`--since: not a date: ${values.since}`);
console.log(stats({ cwd: values.all ? undefined : (values.cwd ?? process.cwd()), since }));
