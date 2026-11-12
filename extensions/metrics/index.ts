// Harness metrics, derived from Pi's session files (see indexer.ts) into ~/.pi/agent/metrics.db.
//
// `/harness stats` reports on the current project, `/harness stats all` on every session.
// `/harness dashboard` makes the usage dashboard (dashboard/) run and gives its URL scoped to the
// current project. `/harness experiment` runs the A/B experiments (see experiment.ts).
//
// Running the installed harness (a release), every Pi process keeps the dashboard running: at
// session start and every DASHBOARD_CHECK_MS it starts it when none answers and replaces one on an
// older release (ensureDashboard). From a repository checkout (tests, development) it does not.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type EnsureResult, ensureDashboard } from "../../dashboard/server/launch.ts";
import { DEFAULT_PORT, lanUrls } from "../../dashboard/server/server.ts";
import { ARM_ENTRY, listExperiments, recordedArms } from "../lib/experiments.ts";
import { commitToSource } from "../lib/release.ts";
import { RELEASE, SOURCE_ROOT } from "../lib/repository.ts";
import { EXPERIMENT_USAGE, experimentCommand } from "./experiment.ts";
import { stats } from "./stats.ts";

 /** How often each Pi process checks that the dashboard runs (a status request). */
export const DASHBOARD_CHECK_MS = 30_000;

const USAGE = `Usage: /harness stats [all] | /harness dashboard | ${EXPERIMENT_USAGE.replace("Usage: ", "")}`;

export interface MetricsOptions {
	/** Keep the dashboard running; default: when running a release. */
	keepDashboard?: boolean;
	ensure?: () => Promise<EnsureResult>;
	checkMs?: number;
}

export default function metrics(pi: ExtensionAPI, options: MetricsOptions = {}) {
	const { keepDashboard = RELEASE !== undefined, ensure = () => ensureDashboard(), checkMs = DASHBOARD_CHECK_MS } = options;
	if (keepDashboard) {
		let timer: ReturnType<typeof setInterval> | undefined;
		let checking = false;
		let reported = "";
		pi.on("session_start", (_event, ctx) => {
			const check = async () => {
				if (checking) return;
				checking = true;
				try {
					await ensure();
					reported = "";
				} catch (error) {
					// Said once per distinct failure, not every check.
					const message = error instanceof Error ? error.message : String(error);
					if (message !== reported) ctx.ui.notify(`Usage dashboard: ${message}`, "warning");
					reported = message;
				} finally {
					checking = false;
				}
			};
			clearInterval(timer);
			timer = setInterval(() => void check(), checkMs);
			timer.unref?.();
			void check();
		});
		pi.on("session_shutdown", () => clearInterval(timer));
	}

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
				try {
					const { url, state } = await ensureDashboard();
					const project = `/?project=${encodeURIComponent(ctx.cwd)}`;
					const lan = lanUrls(new URL(url).port === "" ? DEFAULT_PORT : Number(new URL(url).port)).map((at) => `${at}${project}`);
					ctx.ui.notify([`Usage dashboard ${state === "running" ? "running" : state === "busy" ? "starting (by another Pi process)" : state}: ${url}${project} (all projects: ${url})`, ...lan.map((at) => `LAN: ${at}`)].join("\n"), "info");
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
