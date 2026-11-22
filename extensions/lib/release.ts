// Harness releases: Pi loads the harness from `<agent dir>/harness/current`, a link to an immutable
// snapshot of one commit of the harness repository. Committing to the deployed branch builds the
// next release; running sessions then reload into it when idle (extensions/release). Half-done edits
// in the repository therefore never reach a running session, and going back is switching the link.
//
// Layout of `<agent dir>/harness`:
//   releases/<commit>/   the commit's files without vendor/ (git archive), plus links to what is not
//                        versioned there: vendor/ (pi-lens, not hot-swappable) and
//                        dashboard/node_modules to the source, node_modules to the commit's Pi build,
//                        and `.release.json`
//   current              link to the deployed release, switched atomically (rename)
//   failed/<commit>.txt  why a commit was not deployed, so it is tried once
//   .lock/               held while deploying (several Pi processes watch the same repository); holds
//                        the holder's pid, and the holder touches it every few seconds
//   in-use/<pid>         what a running Pi process holds, one per line: the release it loaded last, the
//                        Pi build it runs, then the other releases its sessions still run
//                        (extensions/release writes it on every load and session end): pruning never
//                        removes a release or a Pi build a live process holds, so a process that has
//                        not reloaded (or cannot: another Pi) keeps its files
//   pi-builds/<tree>/, pi, pi-build   the global Pi, built per `vendor/pi` tree (pi-build.ts)
//
// A release is deployed only if every extension entry point imports in a fresh Node process: a
// commit with a broken import or a syntax error stays undeployed and the previous release keeps
// running. Its extensions may use Pi APIs of its own `vendor/pi`, so the commit's `vendor/pi` tree is
// built first (unless built already), and the check resolves Pi's packages from that build. Once it
// passes, the global Pi and `current` switch: a Pi process started later loads the release on the
// matching Pi. A running process keeps the Pi it started with; extensions/release reloads it only
// into releases built for that Pi, and deploys (so prunes) only while it runs the deployed release:
// older code may misread the holds newer releases write.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { AGY_PLUGIN_NAME, AGY_PLUGINS_DIRNAME, buildAgyPlugin, validateAgyPlugin } from "../../agy/build.ts";
import { acquireLock, pidAlive } from "./lock.ts";
import { buildPi, builtPi as builtPiIn, ensurePiBuild, prunePiBuilds, releasePi, switchPi } from "./pi-build.ts";
import { RELEASE_MARKER, type ReleaseMarker } from "./repository.ts";

const exec = promisify(execFile);
/** Releases kept besides the current one, for sessions that have not reloaded yet and for going back. */
const KEEP = 5;
const VALIDATE_TIMEOUT_MS = 120_000;

/** Paths in a release that link to the source repository instead of being copied. */
const LINKS = ["vendor", "dashboard/node_modules"];

export const harnessDir = (agentDir: string) => join(agentDir, "harness");
export const currentLink = (agentDir: string) => join(harnessDir(agentDir), "current");
const releasesDir = (agentDir: string) => join(harnessDir(agentDir), "releases");
const failedFile = (agentDir: string, commit: string) => join(harnessDir(agentDir), "failed", `${commit}.txt`);
const inUseDir = (agentDir: string) => join(harnessDir(agentDir), "in-use");

/** The `vendor/pi` tree id the global Pi was built from, or undefined before the first build. */
export const builtPi = (agentDir: string): string | undefined => builtPiIn(harnessDir(agentDir));

/**
 * The id of `vendor/pi` in `commit` of the source (the working tree plays no part), undefined if
 * absent. Other failures throw: git that could not run (a spawn failure under memory pressure on
 * 2026-11-14) must not make a commit read as one without Pi, which deploy() records for good.
 */
export async function piTree(source: string, commit: string): Promise<string | undefined> {
	try {
		return (await git(source, "rev-parse", "--verify", "-q", `${commit}:vendor/pi`)).toString("utf8").trim() || undefined;
	} catch (error) {
		// `--verify -q` exits 1 without output when the object does not exist.
		if ((error as { code?: unknown }).code === 1) return undefined;
		throw error;
	}
}

/**
 * Record that process `pid` runs `releases` (the one it loaded last first) on the Pi build `pi`
 * (undefined: not a build, e.g. a checkout), so pruning keeps them while the process lives. The
 * last loaded release and the Pi come first because processes that cannot reload run releases
 * whose pruning reads only those two lines. Written whole (a rename): a reader never sees a part.
 */
export function holdRelease(agentDir: string, releases: readonly [string, ...string[]], pi: string | undefined, pid = process.pid): void {
	const [last, ...others] = releases;
	mkdirSync(inUseDir(agentDir), { recursive: true });
	// Outside in-use/: pruning removes names there that are no pid.
	const temporary = join(harnessDir(agentDir), `.in-use.${pid}.${process.hrtime.bigint()}`);
	writeFileSync(temporary, [last, pi ?? "", ...others.filter((commit) => commit !== last)].map((line) => `${line}\n`).join(""));
	renameSync(temporary, join(inUseDir(agentDir), String(pid)));
}

/** The releases and Pi builds live processes hold; the holds of processes that exited are removed. */
export function holds(agentDir: string): { releases: Set<string>; pis: Set<string> } {
	const held = { releases: new Set<string>(), pis: new Set<string>() };
	if (!existsSync(inUseDir(agentDir))) return held;
	for (const name of readdirSync(inUseDir(agentDir))) {
		const pid = Number(name);
		const file = join(inUseDir(agentDir), name);
		if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) {
			rmSync(file, { force: true });
			continue;
		}
		const [last, pi, ...others] = readFileSync(file, "utf8").split("\n").map((line) => line.trim());
		for (const release of [last, ...others]) if (release) held.releases.add(release);
		if (pi) held.pis.add(pi);
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

/** Every extension (and agy) entry point imports in a fresh Node process; throws with its output otherwise. */
export async function importCheck(root: string): Promise<void> {
	const entries = readdirSync(join(root, "extensions"))
		.map((name) => join(root, "extensions", name, "index.ts"))
		.filter((path) => existsSync(path));
	for (const rel of ["agy/hooks/dispatch.ts", "agy/mcp/server.ts", "agy/mcp/protocol.ts", "agy/build.ts"]) {
		const path = join(root, rel);
		if (existsSync(path)) entries.push(path);
	}
	const script = `for (const f of ${JSON.stringify(entries)}) { try { await import(f); } catch (e) { console.error(f + ": " + (e && e.stack || e)); process.exitCode = 1; } }`;
	try {
		await exec(process.execPath, ["--input-type=module", "-e", script], { cwd: root, timeout: VALIDATE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
	} catch (error) {
		const e = error as { stderr?: string; message: string };
		throw new Error((e.stderr || e.message).trim().split("\n").slice(0, 20).join("\n"));
	}
	const agyPluginDir = join(root, AGY_PLUGINS_DIRNAME, AGY_PLUGIN_NAME);
	if (existsSync(agyPluginDir)) {
		const validation = validateAgyPlugin(agyPluginDir);
		if (validation.status === "failed") {
			throw new Error(`agy plugin validation failed:\n${validation.output}`);
		}
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

/**
 * Remove all but the current release, the KEEP newest others and those a live process holds; then
 * the Pi builds that none of the remaining releases uses and no live process runs.
 */
function prune(agentDir: string): void {
	const held = holds(agentDir);
	const keep = new Set(held.releases);
	const current = currentRelease(agentDir)?.commit;
	if (current) keep.add(current);
	const old = readdirSync(releasesDir(agentDir))
		.filter((name) => !name.startsWith(".") && !keep.has(name))
		.map((name) => ({ name, mtime: statSync(join(releasesDir(agentDir), name)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime)
		.slice(KEEP);
	for (const { name } of old) rmSync(join(releasesDir(agentDir), name), { recursive: true, force: true });
	const used = readdirSync(releasesDir(agentDir)).flatMap((name) => releasePi(join(releasesDir(agentDir), name)) ?? []);
	prunePiBuilds(harnessDir(agentDir), new Set([...used, ...held.pis]));
}

/**
 * Why `commit` was not deployed, if it was tried. Releases from before Pi builds moved out of the
 * working tree refused commits whose vendor/pi the working tree did not match; that no longer
 * applies, so such a commit is tried again (their processes still deploy until restarted). Neither
 * does "has no vendor/pi" recorded before piTree told a missing tree from git failing to run.
 */
function failure(agentDir: string, commit: string): string | undefined {
	if (!existsSync(failedFile(agentDir, commit))) return undefined;
	const text = readFileSync(failedFile(agentDir, commit), "utf8");
	return /^vendor\/pi in .* has changes not in [0-9a-f]+;|^[0-9a-f]+ has no vendor\/pi$/.test(text) ? undefined : text;
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
	/** Build Pi in a directory holding a vendor/pi tree with its node_modules linked (pi-build.ts). */
	buildPi?: (dir: string) => Promise<void>;
}

/** Deploy the branch's latest commit, and make the global Pi its build, unless both are already or it failed before. */
export async function deploy({ source, branch, agentDir, validate = importCheck, buildPi: build = buildPi }: DeployOptions): Promise<DeployResult> {
	const commit = await branchCommit(source, branch);
	const tree = await piTree(source, commit);
	const deployed = () => currentRelease(agentDir)?.commit === commit && builtPi(agentDir) === tree;
	const previous = currentRelease(agentDir)?.commit;
	if (deployed()) return { status: "current", commit };
	const failed = failure(agentDir, commit);
	if (failed !== undefined) return { status: "failed", commit, error: failed, fresh: false };
	const unlock = acquireLock(join(harnessDir(agentDir), ".lock"));
	if (!unlock) return { status: "busy", commit };
	try {
		// Another process may have deployed it while this one waited.
		if (deployed()) return { status: "current", commit };
		const target = join(releasesDir(agentDir), commit);
		mkdirSync(releasesDir(agentDir), { recursive: true });
		removeOrphanedBuilds(agentDir);
		const temporary = join(releasesDir(agentDir), `.${commit}.${process.pid}`);
		try {
			if (!tree) throw new Error(`${shortCommit(commit)} has no vendor/pi`);
			const pi = await ensurePiBuild({ source, tree, harness: harnessDir(agentDir), build, extract: async (dir) => untar(await git(source, "archive", "--format=tar", tree), dir) });
			if (!existsSync(target)) {
				rmSync(temporary, { recursive: true, force: true });
				mkdirSync(temporary, { recursive: true });
				await extract(source, branch, commit, temporary, pi, agentDir);
				await validate(temporary);
				try {
					renameSync(temporary, target);
				} catch (error) {
					// A process that took over an abandoned lock built the same commit first: keep its build.
					if (!existsSync(target)) throw error;
					rmSync(temporary, { recursive: true, force: true });
				}
			}
		} catch (error) {
			rmSync(temporary, { recursive: true, force: true });
			// Name files by the release they would have been in, not the temporary build directory.
			const message = (error instanceof Error ? error.message : String(error)).replace(/\/(?:private\/)?\S*?\/releases\/\.[0-9a-f]+\.\d+/g, `releases/${shortCommit(commit)}`);
			mkdirSync(join(harnessDir(agentDir), "failed"), { recursive: true });
			writeFileSync(failedFile(agentDir, commit), message);
			return { status: "failed", commit, error: message, fresh: true };
		}
		// Pi first: a process starting in between runs the previous release on the new Pi, not this one on the old.
		switchPi(harnessDir(agentDir), tree);
		switchTo(agentDir, commit);
		prune(agentDir);
		return { status: "deployed", commit, ...(previous ? { previous } : {}) };
	} finally {
		unlock();
	}
}

/** Write the files of a tar archive into `dir`. */
async function untar(archive: Buffer, dir: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const tar = execFile("tar", ["-x", "-C", dir], (error) => (error ? reject(error) : resolve()));
		tar.stdin!.end(archive);
	});
}

/**
 * Extract `commit` (without vendor/) into `dir`, link the unversioned parts (node_modules to the Pi
 * build `pi`, whose workspace packages are the commit's Pi), build the native agy plugin if present,
 * and write the marker.
 */
async function extract(source: string, branch: string, commit: string, dir: string, pi: string, agentDir: string): Promise<void> {
	await untar(await git(source, "archive", "--format=tar", commit, "--", ".", ":(exclude)vendor"), dir);
	const links: [string, string][] = [...LINKS.map((path): [string, string] => [path, join(source, path)]), ["node_modules", join(pi, "node_modules")]];
	for (const [path, target] of links) {
		if (!existsSync(target)) continue;
		rmSync(join(dir, path), { recursive: true, force: true });
		mkdirSync(join(dir, path, ".."), { recursive: true });
		symlinkSync(target, join(dir, path));
	}
	if (existsSync(join(dir, "agy", "hooks", "dispatch.ts")) && existsSync(join(dir, "prompt"))) {
		const targetBuild = join(dir, "agy", "build.ts");
		const mod = existsSync(targetBuild) ? ((await import(pathToFileURL(targetBuild).href)) as { buildAgyPlugin?: typeof buildAgyPlugin }) : undefined;
		(mod?.buildAgyPlugin ?? buildAgyPlugin)({
			harnessRoot: dir,
			pluginsParentDir: join(dir, AGY_PLUGINS_DIRNAME),
			runtimeRoot: currentLink(agentDir),
		});
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
