// Hot reload of the harness (see extensions/lib/release.ts for releases).
//
// Every Pi process that runs a release watches the release's source branch. A new commit is
// deployed by whichever process sees it first (the others find it deployed), after its extensions
// pass an import check; the dashboard is moved to the new release. Each
// session then reloads into the deployed release with `pi.requestReload()`: at once when idle,
// else at the next turn boundary of its run (the run continues on the new tools and prompt; a tool
// call running then finishes on the old code), else when the run settles. Pi itself (vendor/pi)
// cannot be swapped in a running process, and a release's extensions may use Pi APIs newer than the
// process has: a session reloads only into releases with the Pi it started with, and says once that
// a newer release needs a restart.
//
// Running from a repository checkout (tests, development) this extension does nothing.

import { statSync } from "node:fs";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ensureDashboard } from "../../dashboard/server/launch.ts";
import { changedBetween, currentRelease, type DeployOptions, type DeployResult, deploy, holdRelease, refFiles, shortCommit } from "../lib/release.ts";
import { RELEASE, type ReleaseMarker } from "../lib/repository.ts";

const POLL_MS = 3000;

/** Per process, across reloads (module state is new after each): the release the process started with and last loaded. */
const processState = globalThis as { __harnessRelease?: { started: string; loaded: string; piNoticeShown?: boolean } };

export interface ReleaseOptions {
	agentDir?: string;
	pollMs?: number;
	release?: ReleaseMarker;
	deploy?: (options: DeployOptions) => Promise<DeployResult>;
	/** Move the dashboard to the deployed release (ensureDashboard). */
	ensureDashboard?: () => Promise<unknown>;
}

export default function release(pi: ExtensionAPI, options: ReleaseOptions = {}) {
	const loaded = options.release ?? RELEASE;
	if (!loaded) return;
	const { agentDir = getAgentDir(), pollMs = POLL_MS, deploy: deployRelease = deploy } = options;
	const dashboard = options.ensureDashboard ?? (() => ensureDashboard({ agentDir }));
	const previous = processState.__harnessRelease?.loaded;
	const state = (processState.__harnessRelease ??= { started: loaded.commit, loaded: loaded.commit });
	state.loaded = loaded.commit;
	// This process now runs `loaded`: deploys elsewhere must not prune it until the process reloads or exits.
	holdRelease(agentDir, loaded.commit);

	let timer: ReturnType<typeof setInterval> | undefined;
	let busy = false;
	let fingerprint = "";
	const reported = new Set<string>();
	/** Per deployed commit: whether it changed Pi itself since this process started. */
	const newPi = new Map<string, Promise<boolean>>();

	/** Reload into the deployed release when it is newer and runs on this process's Pi; else say once that it needs a restart. */
	const follow = async (ctx: ExtensionContext) => {
		const deployed = currentRelease(agentDir);
		if (deployed === undefined || deployed.commit === loaded.commit) return;
		if (!newPi.has(deployed.commit)) newPi.set(deployed.commit, changedBetween(loaded.source, state.started, deployed.commit, "vendor/pi"));
		if (!(await newPi.get(deployed.commit))) {
			pi.requestReload();
			return;
		}
		if (state.piNoticeShown) return;
		state.piNoticeShown = true;
		ctx.ui.notify(
			`Harness ${shortCommit(deployed.commit)} needs a newer Pi (vendor/pi changed); this session keeps ${shortCommit(loaded.commit)}. Restart Pi to run it.`,
			"warning",
		);
	};

	/** Deploy a new commit of the branch if its ref moved, then reload when outdated (Pi picks the moment; repeated requests are one). */
	const tick = async (ctx: ExtensionContext) => {
		if (busy) return;
		busy = true;
		try {
			const files = await refFiles(loaded.source, loaded.branch);
			const next = files.map((file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0).join(":");
			if (next !== fingerprint) {
				const result = await deployRelease({ source: loaded.source, branch: loaded.branch, agentDir });
				// Busy: another process is deploying; look again next time.
				fingerprint = result.status === "busy" ? "" : next;
				if (result.status === "failed" && !reported.has(result.commit)) {
					reported.add(result.commit);
					ctx.ui.notify(`Harness commit ${shortCommit(result.commit)} was not deployed; this session keeps ${shortCommit(loaded.commit)}.\n${result.error}`, "warning");
				}
				// Failures are reported by the metrics extension's periodic check, which retries.
				if (result.status === "deployed") await dashboard().catch(() => undefined);
			}
			await follow(ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!reported.has(message)) {
				reported.add(message);
				ctx.ui.notify(`Harness release watch: ${message}`, "warning");
			}
		} finally {
			busy = false;
		}
	};

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "reload" && previous && previous !== loaded.commit) {
			ctx.ui.notify(`Harness reloaded: ${shortCommit(previous)} → ${shortCommit(loaded.commit)} ${loaded.subject}`, "info");
		}
		clearInterval(timer);
		timer = setInterval(() => void tick(ctx), pollMs);
		timer.unref?.();
		void tick(ctx);
	});
	pi.on("session_shutdown", () => clearInterval(timer));
}
