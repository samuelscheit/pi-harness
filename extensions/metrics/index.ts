// Harness metrics, derived from Pi's session files (see indexer.ts) into ~/.pi/agent/metrics.db.
//
// `/harness stats` reports on the current project, `/harness stats all` on every session.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stats } from "./stats.ts";

const USAGE = "Usage: /harness stats [all]";

export default function metrics(pi: ExtensionAPI) {
	pi.registerCommand("harness", {
		description: "Harness metrics: /harness stats [all]",
		getArgumentCompletions: (prefix) =>
			["stats", "stats all"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const [command, ...rest] = args.trim().split(/\s+/);
			if (command !== "stats" || rest.some((arg) => arg !== "all")) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			ctx.ui.notify(stats(rest.includes("all") ? {} : { cwd: ctx.cwd }), "info");
		},
	});
}
