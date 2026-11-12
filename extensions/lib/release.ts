// Harness releases: Pi loads the harness from `<agent dir>/harness/current`, a link to an immutable
// snapshot of one commit of the harness repository. Committing to the deployed branch builds the
// next release; running sessions then reload into it when idle (extensions/release). Half-done edits
// in the repository therefore never reach a running session, and going back is switching the link.
//
// Layout of `<agent dir>/harness`:
//   releases/<commit>/   the commit's files without vendor/ (git archive), plus links to what is not
//                        versioned there: vendor/ (Pi itself and pi-lens, not hot-swappable),
//                        node_modules and dashboard/node_modules, and `.release.json`
//   current              link to the deployed release, switched atomically (rename)
//   failed/<commit>.txt  why a commit was not deployed, so it is tried once
//   .lock/               held while deploying (several Pi processes watch the same repository); holds
//                        the holder's pid, and the holder touches it every few seconds
//
// A release is deployed only if every extension entry point imports in a fresh Node process: a
// commit with a broken import or a syntax error stays undeployed and the previous release keeps
// running.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { acquireLock, pidAlive } from "./lock.ts";
import { RELEASE_MARKER, type ReleaseMarker } from "./repository.ts";

const exec = promisify(execFile);
/** Releases kept besides the current one, for sessions that have not reloaded yet and for going back. */
const KEEP = 5;
const VALIDATE_TIMEOUT_MS = 120_000;

/** Paths in a release that link to the source repository instead of being copied. */
const LINKS = ["vendor", "node_modules", "dashboard/node_modules"];

export const harnessDir = (agentDir: string) => join(agentDir, "harness");
export const currentLink = (agentDir: string) => join(harnessDir(agentDir), "current");
const releasesDir = (agentDir: string) => join(harnessDir(agentDir), "releases");
const failedFile = (agentDir: string, commit: string) => join(harnessDir(agentDir), "failed", `${commit}.txt`);

/** The deployed release, or undefined before the first deploy. */
export function currentRelease(agentDir: string): (ReleaseMarker & { root: string }) | undefined {
	try {
		const root = realpathSync(currentLink(agentDir));
		return { ...(JSON.parse(readFileSync(join(root, RELEASE_MARKER), "utf8")) as ReleaseMarker), root };
	} catch {
		return undefined;
	}
}

const git = async (source: string, ...args: string[]) => (await exec("git", ["-C", source, ...args], { maxBuffer: 512 * 1024 * 1024, encoding: "buffer" })).stdout;

/** The commit a branch of the source points at. */
export const branchCommit = async (source: string, branch: string) => (await git(source, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`)).toString("utf8").trim();

/** The files whose change time tells that a branch may have moved (loose ref, packed refs). */
export async function refFiles(source: string, branch: string): Promise<string[]> {
	const paths = await Promise.all([`refs/heads/${branch}`, "packed-refs"].map(async (ref) => (await git(source, "rev-parse", "--git-path", ref)).toString("utf8").trim()));
	return paths.map((path) => join(source, path));
}

/** Every extension entry point imports in a fresh Node process; throws with its output otherwise. */
export async function importCheck(root: string): Promise<void> {
	const entries = readdirSync(join(root, "extensions"))
		.map((name) => join(root, "extensions", name, "index.ts"))
		.filter((path) => existsSync(path));
	const script = `for (const f of ${JSON.stringify(entries)}) { try { await import(f); } catch (e) { console.error(f + ": " + (e && e.stack || e)); process.exitCode = 1; } }`;
	try {
		await exec(process.execPath, ["--input-type=module", "-e", script], { cwd: root, timeout: VALIDATE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
	} catch (error) {
		const e = error as { stderr?: string; message: string };
		throw new Error((e.stderr || e.message).trim().split("\n").slice(0, 20).join("\n"));
	}
}

/** Remove builds that processes left behind when they died while deploying (`.<commit>.<pid>`). */
function removeOrphanedBuilds(agentDir: string): void {
	for (const name of readdirSync(releasesDir(agentDir))) {
		const pid = Number(/^\.[0-9a-f]+\.(\d+)$/.exec(name)?.[1]);
		if (pid && pid !== process.pid && !pidAlive(pid)) rmSync(join(releasesDir(agentDir), name), { recursive: true, force: true });
	}
}

/** Point `current` at a release, atomically. */
export function switchTo(agentDir: string, commit: string): void {
	const temporary = `${currentLink(agentDir)}.${process.pid}`;
	rmSync(temporary, { force: true });
	symlinkSync(join("releases", commit), temporary);
	renameSync(temporary, currentLink(agentDir));
}

/** Remove all but the current and the KEEP newest other releases. */
function prune(agentDir: string): void {
	const current = currentRelease(agentDir)?.commit;
	const old = readdirSync(releasesDir(agentDir))
		.filter((name) => !name.startsWith(".") && name !== current)
		.map((name) => ({ name, mtime: statSync(join(releasesDir(agentDir), name)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime)
		.slice(KEEP);
	for (const { name } of old) rmSync(join(releasesDir(agentDir), name), { recursive: true, force: true });
}

export type DeployResult =
	| { status: "current"; commit: string }
	| { status: "deployed"; commit: string; previous?: string }
	/** `fresh`: this call found the failure (else it was recorded before). */
	| { status: "failed"; commit: string; error: string; fresh: boolean }
	/** Another process is deploying. */
	| { status: "busy"; commit: string };

export interface DeployOptions {
	source: string;
	branch: string;
	agentDir: string;
	validate?: (root: string) => Promise<void>;
}

/** Deploy the branch's latest commit unless it is deployed already or failed before. */
export async function deploy({ source, branch, agentDir, validate = importCheck }: DeployOptions): Promise<DeployResult> {
	const commit = await branchCommit(source, branch);
	const previous = currentRelease(agentDir)?.commit;
	if (previous === commit) return { status: "current", commit };
	if (existsSync(failedFile(agentDir, commit))) return { status: "failed", commit, error: readFileSync(failedFile(agentDir, commit), "utf8"), fresh: false };
	const unlock = acquireLock(join(harnessDir(agentDir), ".lock"));
	if (!unlock) return { status: "busy", commit };
	try {
		// Another process may have deployed it while this one waited.
		if (currentRelease(agentDir)?.commit === commit) return { status: "current", commit };
		const target = join(releasesDir(agentDir), commit);
		mkdirSync(releasesDir(agentDir), { recursive: true });
		removeOrphanedBuilds(agentDir);
		if (!existsSync(target)) {
			const temporary = join(releasesDir(agentDir), `.${commit}.${process.pid}`);
			rmSync(temporary, { recursive: true, force: true });
			mkdirSync(temporary, { recursive: true });
			try {
				await build(source, branch, commit, temporary);
				await validate(temporary);
			} catch (error) {
				rmSync(temporary, { recursive: true, force: true });
				// Name files by the release they would have been in, not the temporary build directory.
				const message = (error instanceof Error ? error.message : String(error)).replace(/\/(?:private\/)?\S*?\/releases\/\.[0-9a-f]+\.\d+/g, `releases/${shortCommit(commit)}`);
				mkdirSync(join(harnessDir(agentDir), "failed"), { recursive: true });
				writeFileSync(failedFile(agentDir, commit), message);
				return { status: "failed", commit, error: message, fresh: true };
			}
			try {
				renameSync(temporary, target);
			} catch (error) {
				// A process that took over an abandoned lock built the same commit first: keep its build.
				if (!existsSync(target)) throw error;
				rmSync(temporary, { recursive: true, force: true });
			}
		}
		switchTo(agentDir, commit);
		prune(agentDir);
		return { status: "deployed", commit, ...(previous ? { previous } : {}) };
	} finally {
		unlock();
	}
}

/** Extract `commit` (without vendor/) into `dir`, link the unversioned parts and write the marker. */
async function build(source: string, branch: string, commit: string, dir: string): Promise<void> {
	const archive = await git(source, "archive", "--format=tar", commit, "--", ".", ":(exclude)vendor");
	await new Promise<void>((resolve, reject) => {
		const tar = execFile("tar", ["-x", "-C", dir], (error) => (error ? reject(error) : resolve()));
		tar.stdin!.end(archive);
	});
	for (const path of LINKS) {
		if (!existsSync(join(source, path))) continue;
		rmSync(join(dir, path), { recursive: true, force: true });
		mkdirSync(join(dir, path, ".."), { recursive: true });
		symlinkSync(join(source, path), join(dir, path));
	}
	const subject = (await git(source, "log", "-1", "--format=%s", commit)).toString("utf8").trim();
	const marker: ReleaseMarker = { commit, source, branch, subject, deployedAt: new Date().toISOString() };
	writeFileSync(join(dir, RELEASE_MARKER), `${JSON.stringify(marker, null, "\t")}\n`);
}

/**
 * Whether `path` (a file or directory) differs between two commits of the source: its tree or blob
 * ids are compared, so the working tree plays no part (a symlinked or missing path there does not
 * matter). A path absent from both commits is unchanged.
 */
export async function changedBetween(source: string, from: string, to: string, path: string): Promise<boolean> {
	const id = async (commit: string) => {
		try {
			return (await git(source, "rev-parse", "--verify", "-q", `${commit}:${path}`)).toString("utf8").trim();
		} catch {
			return undefined;
		}
	};
	return (await id(from)) !== (await id(to));
}

export const shortCommit = (commit: string) => commit.slice(0, 9);

/**
 * Commit `paths` (and nothing else staged) to the source repository; the release watch deploys
 * the commit. Returns what to tell the user, also when committing failed.
 */
export function commitToSource(source: string, paths: string[], message: string): string {
	try {
		execFileSync("git", ["-C", source, "commit", "--only", "-m", message, "--", ...paths], { stdio: "pipe" });
		const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		return `Committed ${shortCommit(commit)} (${message}); running sessions reload into it once it is deployed.`;
	} catch (error) {
		const e = error as { stderr?: Buffer; message: string };
		return `Not committed (${e.stderr?.toString().trim() || e.message}); commit ${paths.join(", ")} in ${source} for it to take effect.`;
	}
}
