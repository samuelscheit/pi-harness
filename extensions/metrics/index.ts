// Harness metrics, derived from Pi's session files (see indexer.ts) into ~/.pi/agent/metrics.db.
//
// `/harness stats` reports on the current project, `/harness stats all` on every session.
// `/harness dashboard` starts the usage dashboard (dashboard/) detached, unless it runs, and
// gives its URL scoped to the current project. `/harness experiment` runs the A/B experiments
// (see experiment.ts).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { launch } from "../../dashboard/server/launch.ts";
import { DEFAULT_PORT, lanUrls } from "../../dashboard/server/server.ts";
import { ARM_ENTRY, listExperiments, recordedArms } from "../lib/experiments.ts";
import { commitToSource } from "../lib/release.ts";
import { RELEASE, SOURCE_ROOT } from "../lib/repository.ts";
import { EXPERIMENT_USAGE, experimentCommand } from "./experiment.ts";
import { stats } from "./stats.ts";

const USAGE = `Usage: /harness stats [all] | /harness dashboard | ${EXPERIMENT_USAGE.replace("Usage: ", "")}`;

export default function metrics(pi: ExtensionAPI) {
	pi.registerCommand("harness", {
		description: "Harness metrics: /harness stats [all], /harness dashboard, /harness experiment [<name> on|off|stop]",
		getArgumentCompletions: (prefix) =>
			[
				"stats",
				"stats all",
				"dashboard",
				"experiment",
				...listExperiments().flatMap((e) => ["on", "off", "stop"].map((action) => `experiment ${e.name} ${action}`)),
			]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const [command, ...rest] = args.trim().split(/\s+/);
			if (command === "stats" && rest.every((arg) => arg === "all")) {
				ctx.ui.notify(stats(rest.includes("all") ? {} : { project: ctx.cwd }), "info");
			} else if (command === "dashboard" && rest.length === 0) {
				ctx.ui.notify("Starting the usage dashboard…", "info");
				try {
					const { url, started } = await launch();
					const project = `/?project=${encodeURIComponent(ctx.cwd)}`;
					const lan = lanUrls(new URL(url).port === "" ? DEFAULT_PORT : Number(new URL(url).port)).map((at) => `${at}${project}`);
					ctx.ui.notify([`Usage dashboard ${started ? "started" : "running"}: ${url}${project} (all projects: ${url})`, ...lan.map((at) => `LAN: ${at}`)].join("\n"), "info");
				} catch (error) {
					ctx.ui.notify(`Could not start the usage dashboard: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			} else if (command === "experiment") {
				const { text, level } = experimentCommand(rest, {
					sessionId: ctx.sessionManager.getSessionId(),
					recorded: recordedArms(ctx.sessionManager.getEntries()),
					appendEntry: (data) => pi.appendEntry(ARM_ENTRY, data),
					// Running a release, the stop takes effect once committed to the harness repository.
					...(RELEASE ? { publish: (paths: string[], message: string) => commitToSource(SOURCE_ROOT, paths, message) } : {}),
				});
				ctx.ui.notify(text, level);
			} else {
				ctx.ui.notify(USAGE, "warning");
			}
		},
	});
}
