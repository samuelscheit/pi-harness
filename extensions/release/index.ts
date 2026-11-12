// Hot reload of the harness (see extensions/lib/release.ts for releases).
//
// Every Pi process that runs a release watches the release's source branch. A new commit is
// deployed by whichever process sees it first (the others find it deployed), after its extensions
// pass an import check; the dashboard is moved to the new release. Each
// session then reloads into the deployed release with `pi.requestReload()`: at once when idle,
// else at the next turn boundary of its run (the run continues on the new tools and prompt; a tool
// call running then finishes on the old code), else when the run settles. Pi itself (vendor/pi)
// cannot be swapped in a running process; a session says so once when a release changed it.
//
// Running from a repository checkout (tests, development) this extension does nothing.

import { statSync } from "node:fs";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ensureDashboard } from "../../dashboard/server/launch.ts";
import { changedBetween, currentRelease, type DeployOptions, type DeployResult, deploy, refFiles, shortCommit } from "../lib/release.ts";
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

	let timer: ReturnType<typeof setInterval> | undefined;
	let busy = false;
	let fingerprint = "";
	const reported = new Set<string>();

	const outdated = () => {
		const deployed = currentRelease(agentDir);
		return deployed !== undefined && deployed.commit !== loaded.commit;
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
			if (outdated()) pi.requestReload();
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
		if (!state.piNoticeShown && state.started !== loaded.commit && (await changedBetween(loaded.source, state.started, loaded.commit, "vendor/pi"))) {
			state.piNoticeShown = true;
			ctx.ui.notify("Pi itself (vendor/pi) changed since this process started; restart Pi to run the new version.", "warning");
		}
		clearInterval(timer);
		timer = setInterval(() => void tick(ctx), pollMs);
		timer.unref?.();
		void tick(ctx);
	});
	pi.on("session_shutdown", () => clearInterval(timer));
}
