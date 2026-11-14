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
//   in-use/<pid>         the release a running Pi process loaded (extensions/release writes it on
//                        every load): pruning never removes a release a live process holds, so a
//                        process that has not reloaded (or cannot: an older Pi) keeps its files
//
//   pi-build             the `vendor/pi` tree id the global Pi (a link to vendor/pi) was built from
//
// A release is deployed only if every extension entry point imports in a fresh Node process: a
// commit with a broken import or a syntax error stays undeployed and the previous release keeps
// running. Its extensions may use Pi APIs of its own `vendor/pi`, so before that check the global Pi
// is rebuilt when it was built from another tree: a Pi process started later loads the release on
// the matching Pi. A running process keeps the Pi it started with; extensions/release reloads it
// only into releases built for that Pi.

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
const inUseDir = (agentDir: string) => join(harnessDir(agentDir), "in-use");
const piBuildFile = (agentDir: string) => join(harnessDir(agentDir), "pi-build");

/** The `vendor/pi` tree id the global Pi was built from, or undefined if unknown. */
export const builtPi = (agentDir: string): string | undefined => (existsSync(piBuildFile(agentDir)) ? readFileSync(piBuildFile(agentDir), "utf8").trim() : undefined);

/** Record the `vendor/pi` tree id of `commit` as the global Pi's build. */
export async function recordPiBuild(agentDir: string, source: string, commit: string): Promise<void> {
	mkdirSync(harnessDir(agentDir), { recursive: true });
	writeFileSync(piBuildFile(agentDir), `${(await piTree(source, commit)) ?? ""}\n`);
}

/** The id of `vendor/pi` in `commit` of the source (the working tree plays no part), undefined if absent. */
export async function piTree(source: string, commit: string): Promise<string | undefined> {
	try {
		return (await git(source, "rev-parse", "--verify", "-q", `${commit}:vendor/pi`)).toString("utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Build the global Pi from the source's `vendor/pi` working tree (what scripts/install.mjs builds). */
export async function buildPi(source: string): Promise<void> {
	try {
		await exec("npm", ["run", "build:offline"], { cwd: join(source, "vendor", "pi"), timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string; message: string };
		throw new Error(`building Pi (vendor/pi) failed:\n${`${e.stdout ?? ""}\n${e.stderr ?? e.message}`.trim().split("\n").slice(-20).join("\n")}`);
	}
}

/**
 * Make the global Pi the build of `commit`'s `vendor/pi`: rebuild it unless it is that build already.
 * The build reads the working tree, so it must hold exactly that `vendor/pi`.
 */
async function ensurePi(source: string, commit: string, agentDir: string, build: (source: string) => Promise<void>): Promise<void> {
	const tree = await piTree(source, commit);
	if (!tree || builtPi(agentDir) === tree) return;
	try {
		await git(source, "diff", "--quiet", commit, "--", "vendor/pi");
	} catch {
		throw new Error(`vendor/pi in ${source} has changes not in ${shortCommit(commit)}; commit them, or run scripts/install.mjs to build Pi from the working tree`);
	}
	await build(source);
	await recordPiBuild(agentDir, source, commit);
}

/** Record that process `pid` runs release `commit`, so pruning keeps that release while the process lives. */
export function holdRelease(agentDir: string, commit: string, pid = process.pid): void {
	mkdirSync(inUseDir(agentDir), { recursive: true });
	writeFileSync(join(inUseDir(agentDir), String(pid)), commit);
}

/** The releases live processes hold; the holds of processes that exited are removed. */
export function heldReleases(agentDir: string): Set<string> {
	const held = new Set<string>();
	if (!existsSync(inUseDir(agentDir))) return held;
	for (const name of readdirSync(inUseDir(agentDir))) {
		const pid = Number(name);
		const file = join(inUseDir(agentDir), name);
		if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) held.add(readFileSync(file, "utf8").trim());
		else rmSync(file, { force: true });
	}
	return held;
}

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

/** Remove all but the current release, the KEEP newest others and those a live process holds. */
function prune(agentDir: string): void {
	const keep = heldReleases(agentDir);
	const current = currentRelease(agentDir)?.commit;
	if (current) keep.add(current);
	const old = readdirSync(releasesDir(agentDir))
		.filter((name) => !name.startsWith(".") && !keep.has(name))
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
	/** Build the global Pi from the source's vendor/pi. */
	buildPi?: (source: string) => Promise<void>;
}

/** Deploy the branch's latest commit unless it is deployed already or failed before. */
export async function deploy({ source, branch, agentDir, validate = importCheck, buildPi: build = buildPi }: DeployOptions): Promise<DeployResult> {
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
				await extract(source, branch, commit, temporary);
				await ensurePi(source, commit, agentDir, build);
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
async function extract(source: string, branch: string, commit: string, dir: string): Promise<void> {
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
