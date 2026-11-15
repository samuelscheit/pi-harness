// Hot reload of the harness (see extensions/lib/release.ts for releases).
//
// Every Pi process that runs a release watches the release's source branch. A new commit is
// deployed by whichever process running the deployed release sees it first (the others find it
// deployed), after its extensions pass an import check; the dashboard is moved to the new release.
// A process on an older release only follows: deploying prunes, and its older code may misread the
// holds newer releases write (2026-11-15: a process still on a release from before holds named their
// Pi build read `<release>\n<pi>` as one commit, so it pruned a release 13 live processes held,
// and their `tool` command lost its client). Each
// session then reloads into the deployed release with `pi.requestReload()`: at once when idle,
// else at the next turn boundary of its run (the run continues on the new tools and prompt; a tool
// call running then finishes on the old code), else when the run settles. Pi itself (vendor/pi)
// cannot be swapped in a running process, and a release's extensions may use Pi APIs newer than the
// process has: a session reloads only into releases whose vendor/pi is the build the process runs
// (the Pi build its package was loaded from; deploying switches the global Pi for new processes),
// and says once that a newer release needs a restart.
//
// Running from a repository checkout (tests, development) this extension does nothing.

import { statSync } from "node:fs";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { ensureDashboard } from "../../dashboard/server/launch.ts";
import { piBuildOf } from "../lib/pi-build.ts";
import { currentRelease, type DeployOptions, type DeployResult, deploy, harnessDir, holdRelease, piTree, refFiles, shortCommit } from "../lib/release.ts";
import { RELEASE, type ReleaseMarker } from "../lib/repository.ts";

const POLL_MS = 3000;

/**
 * Per process, across reloads (module state is new after each): the Pi build it runs (a vendor/pi
 * tree id), the release it loaded last, and the release each of its live sessions runs (several
 * sessions share a process, e.g. in-process delegates, and reload at different times).
 */
interface ProcessState {
	pi: string | undefined;
	last: string;
	sessions: Map<object, string>;
	piNoticeShown?: boolean;
}
const processState = globalThis as { __harnessRelease?: ProcessState };

export interface ReleaseOptions {
	agentDir?: string;
	pollMs?: number;
	release?: ReleaseMarker;
	/** The Pi build this process runs; by default the one its Pi package was loaded from (undefined: no build, e.g. a checkout). */
	pi?: string;
	deploy?: (options: DeployOptions) => Promise<DeployResult>;
	/** Move the dashboard to the deployed release (ensureDashboard). */
	ensureDashboard?: () => Promise<unknown>;
}

export default function release(pi: ExtensionAPI, options: ReleaseOptions = {}) {
	const loaded = options.release ?? RELEASE;
	if (!loaded) return;
	const { agentDir = getAgentDir(), pollMs = POLL_MS, deploy: deployRelease = deploy } = options;
	const dashboard = options.ensureDashboard ?? (() => ensureDashboard({ agentDir }));
	const previous = processState.__harnessRelease?.last;
	const build = "pi" in options ? options.pi : piBuildOf(harnessDir(agentDir), getPackageDir());
	const state: ProcessState = (processState.__harnessRelease ??= { pi: build, last: loaded.commit, sessions: new Map() });
	state.last = loaded.commit;
	const session = {};
	state.sessions.set(session, loaded.commit);
	// Deploys must not prune what this process runs: the release loaded last (the `tool` command's
	// bridge, also between a session's end and its reload) and every live session's, on its Pi.
	const hold = () => holdRelease(agentDir, [state.last, ...state.sessions.values()], state.pi);
	hold();

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
		// Unknown build (no record): it may lack APIs the release uses.
		if (state.pi !== undefined) {
			if (!needsPi.has(deployed.commit)) needsPi.set(deployed.commit, piTree(loaded.source, deployed.commit));
			let tree: string | undefined;
			try {
				tree = await needsPi.get(deployed.commit);
			} catch (error) {
				// Git failed to run: ask again next time instead of keeping the failure.
				needsPi.delete(deployed.commit);
				throw error;
			}
			if (tree === state.pi) {
				pi.requestReload();
				return;
			}
		}
		if (state.piNoticeShown) return;
		state.piNoticeShown = true;
		ctx.ui.notify(
			`Harness ${shortCommit(deployed.commit)} needs another Pi build than this process runs (vendor/pi changed); this session keeps ${shortCommit(loaded.commit)}. Restart Pi to run it.`,
			"warning",
		);
	};

	/** Deploy a new commit of the branch if its ref moved. */
	const deployNew = async (ctx: ExtensionContext) => {
		const files = await refFiles(loaded.source, loaded.branch);
		const next = files.map((file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0).join(":");
		if (next === fingerprint) return;
		const result = await deployRelease({ source: loaded.source, branch: loaded.branch, agentDir });
		// Busy: another process is deploying; look again next time.
		fingerprint = result.status === "busy" ? "" : next;
		if (result.status === "failed" && !reported.has(result.commit)) {
			reported.add(result.commit);
			ctx.ui.notify(`Harness commit ${shortCommit(result.commit)} was not deployed; this session keeps ${shortCommit(loaded.commit)}.\n${result.error}`, "warning");
		}
		// Failures are reported by the metrics extension's periodic check, which retries.
		if (result.status === "deployed") await dashboard().catch(() => undefined);
	};

	/** Deploy while this session runs the deployed release (only then: see the top), then reload when outdated (Pi picks the moment; repeated requests are one). */
	const tick = async (ctx: ExtensionContext) => {
		if (busy) return;
		busy = true;
		try {
			const deployed = currentRelease(agentDir)?.commit;
			if (deployed === undefined || deployed === loaded.commit) await deployNew(ctx);
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
	pi.on("session_shutdown", () => {
		clearInterval(timer);
		state.sessions.delete(session);
		hold();
	});
}
