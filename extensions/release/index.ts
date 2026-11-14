// Hot reload of the harness (see extensions/lib/release.ts for releases).
//
// Every Pi process that runs a release watches the release's source branch. A new commit is
// deployed by whichever process sees it first (the others find it deployed), after its extensions
// pass an import check; the dashboard is moved to the new release. Each
// session then reloads into the deployed release with `pi.requestReload()`: at once when idle,
// else at the next turn boundary of its run (the run continues on the new tools and prompt; a tool
// call running then finishes on the old code), else when the run settles. Pi itself (vendor/pi)
// cannot be swapped in a running process, and a release's extensions may use Pi APIs newer than the
// process has: a session reloads only into releases whose vendor/pi is the build the process
// started with (deploying rebuilds the global Pi for new processes), and says once that a newer
// release needs a restart.
//
// Running from a repository checkout (tests, development) this extension does nothing.

import { statSync } from "node:fs";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ensureDashboard } from "../../dashboard/server/launch.ts";
import { builtPi, currentRelease, type DeployOptions, type DeployResult, deploy, holdRelease, piTree, refFiles, shortCommit } from "../lib/release.ts";
import { RELEASE, type ReleaseMarker } from "../lib/repository.ts";

const POLL_MS = 3000;

/** Per process, across reloads (module state is new after each): the Pi build it started with (a vendor/pi tree id) and the release it last loaded. */
const processState = globalThis as { __harnessRelease?: { pi: string | undefined; loaded: string; piNoticeShown?: boolean } };

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
	const state = (processState.__harnessRelease ??= { pi: builtPi(agentDir), loaded: loaded.commit });
	state.loaded = loaded.commit;
	// This process now runs `loaded`: deploys elsewhere must not prune it until the process reloads or exits.
	holdRelease(agentDir, loaded.commit);

	let timer: ReturnType<typeof setInterval> | undefined;
	let busy = false;
	let fingerprint = "";
	const reported = new Set<string>();
	/** Per deployed commit: its vendor/pi tree id. */
	const needsPi = new Map<string, Promise<string | undefined>>();

	/** Reload into the deployed release when it is newer and built for this process's Pi; else say once that it needs a restart. */
	const follow = async (ctx: ExtensionContext) => {
		const deployed = currentRelease(agentDir);
		if (deployed === undefined || deployed.commit === loaded.commit) return;
		if (!needsPi.has(deployed.commit)) needsPi.set(deployed.commit, piTree(loaded.source, deployed.commit));
		// Unknown build (no record): it may lack APIs the release uses.
		if (state.pi !== undefined && (await needsPi.get(deployed.commit)) === state.pi) {
			pi.requestReload();
			return;
		}
		if (state.piNoticeShown) return;
		state.piNoticeShown = true;
		ctx.ui.notify(
			`Harness ${shortCommit(deployed.commit)} needs another Pi build than this process runs (vendor/pi changed); this session keeps ${shortCommit(loaded.commit)}. Restart Pi to run it.`,
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
