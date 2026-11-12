// Harness metrics, derived from Pi's session files (see indexer.ts) into ~/.pi/agent/metrics.db.
//
// `/harness stats` reports on the current project, `/harness stats all` on every session.
// `/harness dashboard` starts the usage dashboard (dashboard/) detached, unless it runs, and
// gives its URL scoped to the current project.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { launch } from "../../dashboard/server/launch.ts";
import { stats } from "./stats.ts";

const USAGE = "Usage: /harness stats [all] | /harness dashboard";

export default function metrics(pi: ExtensionAPI) {
	pi.registerCommand("harness", {
		description: "Harness metrics: /harness stats [all], /harness dashboard",
		getArgumentCompletions: (prefix) =>
			["stats", "stats all", "dashboard"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const [command, ...rest] = args.trim().split(/\s+/);
			if (command === "stats" && rest.every((arg) => arg === "all")) {
				ctx.ui.notify(stats(rest.includes("all") ? {} : { project: ctx.cwd }), "info");
			} else if (command === "dashboard" && rest.length === 0) {
				ctx.ui.notify("Starting the usage dashboard…", "info");
				try {
					const { url, started } = await launch();
					ctx.ui.notify(`Usage dashboard ${started ? "started" : "running"}: ${url}/?project=${encodeURIComponent(ctx.cwd)} (all projects: ${url})`, "info");
				} catch (error) {
					ctx.ui.notify(`Could not start the usage dashboard: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			} else {
				ctx.ui.notify(USAGE, "warning");
			}
		},
	});
}
