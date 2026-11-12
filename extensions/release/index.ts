// Hot reload of the harness (see extensions/lib/release.ts for releases).
//
// Every Pi process that runs a release watches the release's source branch. A new commit is
// deployed by whichever process sees it first (the others find it deployed), after its extensions
// pass an import check; a running dashboard of an older release is restarted on the new one. Each
// session then reloads into the deployed release as soon as it is idle (never during a run): at
// once when it is idle already, else when its run settles. Pi itself (vendor/pi) cannot be
// swapped in a running process; a session says so once when a release changed it.
//
// Running from a repository checkout (tests, development) this extension does nothing.

import { statSync } from "node:fs";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { restartOutdated } from "../../dashboard/server/launch.ts";
import { changedBetween, currentRelease, type DeployOptions, type DeployResult, deploy, refFiles, shortCommit } from "../lib/release.ts";
import { RELEASE, type ReleaseMarker } from "../lib/repository.ts";

export const RELOAD_COMMAND = "harness-reload";
const POLL_MS = 3000;

/** Per process, across reloads (module state is new after each): the release the process started with and last loaded. */
const processState = globalThis as { __harnessRelease?: { started: string; loaded: string; piNoticeShown?: boolean } };

export interface ReleaseOptions {
	agentDir?: string;
	pollMs?: number;
	release?: ReleaseMarker;
	deploy?: (options: DeployOptions) => Promise<DeployResult>;
	restartDashboard?: (deployed: string) => Promise<unknown>;
}

export default function release(pi: ExtensionAPI, options: ReleaseOptions = {}) {
	const loaded = options.release ?? RELEASE;
	if (!loaded) return;
	const { agentDir = getAgentDir(), pollMs = POLL_MS, deploy: deployRelease = deploy } = options;
	const restartDashboard = options.restartDashboard ?? ((deployed: string) => restartOutdated({ agentDir, deployed }));
	const previous = processState.__harnessRelease?.loaded;
	const state = (processState.__harnessRelease ??= { started: loaded.commit, loaded: loaded.commit });
	state.loaded = loaded.commit;

	pi.registerCommand(RELOAD_COMMAND, {
		description: "Reload the harness into the deployed release",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});

	let timer: ReturnType<typeof setInterval> | undefined;
	let requested = false;
	let busy = false;
	let fingerprint = "";
	const reported = new Set<string>();

	const outdated = () => {
		const deployed = currentRelease(agentDir);
		return deployed !== undefined && deployed.commit !== loaded.commit;
	};
	const requestReload = () => {
		if (requested) return;
		requested = true;
		pi.sendUserMessage(`/${RELOAD_COMMAND}`, { expandPromptTemplates: true });
	};

	/** Deploy a new commit of the branch if its ref moved, then reload when idle and outdated. */
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
				if (result.status === "deployed") await restartDashboard(result.commit).catch(() => undefined);
			}
			if (outdated() && ctx.isIdle()) requestReload();
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
	// A session busy when the release changed reloads once its run settles.
	pi.on("agent_settled", () => {
		if (outdated()) requestReload();
	});
	pi.on("session_shutdown", () => clearInterval(timer));
}
