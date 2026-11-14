// Pi builds: the global `pi` runs `<harness>/pi`, a link to `<harness>/pi-builds/<tree>`, the
// `vendor/pi` of one commit (by its git tree id) extracted with `git archive` and built there.
// Deploying a commit (release.ts) builds its tree unless it is built already. The build never reads
// the working tree, so agents editing vendor/pi do not hold up deploys, and the built Pi is exactly
// the commit's.
//
// Layout of `<harness>/pi-builds/<tree>/`:
//   the tree's files, built in place (`npm run build:offline`)
//   node_modules/  links to the entries of the source's vendor/pi/node_modules (installed by
//                  scripts/install.mjs with `npm ci`), except the workspace packages, which link to
//                  this build's own packages; each workspace's own node_modules links to the source's
//   packages/ai/src/providers/data/  model data, copied from the source: it is gitignored and
//                  generated from the network; hydrated here when the commit needs other data
// `.<tree>.<pid>/` is a build in progress, renamed into place when done, so a build directory is
// always complete.
//
// `<harness>/pi` switches atomically (rename); the global npm package links to
// `<harness>/pi/packages/coding-agent` (scripts/install.mjs). A running Pi keeps the build it started
// from (Node loads modules by their real path): it names it in `in-use/<pid>` (extensions/release),
// and pruning keeps it.
//
// `<harness>/pi-build` holds the tree id of `<harness>/pi` for releases deployed before builds moved
// out of the working tree: their processes read it to decide whether the global Pi needs a rebuild.

import { execFile } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { pidAlive } from "./lock.ts";

const exec = promisify(execFile);
const BUILD_TIMEOUT_MS = 15 * 60_000;
/** Generated inputs of a build that its tree does not hold: copied from the source's vendor/pi. */
const GENERATED = ["packages/ai/src/providers/data"];

export const piBuildsDir = (harness: string) => join(harness, "pi-builds");
/** The global Pi: a link to the build it runs. */
export const piLink = (harness: string) => join(harness, "pi");
const legacyRecord = (harness: string) => join(harness, "pi-build");

/** The vendor/pi tree id the global Pi was built from, or undefined before the first build. */
export function builtPi(harness: string): string | undefined {
	try {
		return basename(readlinkSync(piLink(harness)));
	} catch {
		return undefined;
	}
}

/** The tree id of the build a Pi package directory belongs to, or undefined when it is no build (a checkout). */
export function piBuildOf(harness: string, packageDir: string): string | undefined {
	try {
		const path = relative(realpathSync(piBuildsDir(harness)), realpathSync(packageDir)).split(sep).join("/");
		return /^([0-9a-f]{40,64})\/packages\/coding-agent$/.exec(path)?.[1];
	} catch {
		return undefined;
	}
}

/** The tree id of the build a release's node_modules links to, or undefined. */
export function releasePi(release: string): string | undefined {
	try {
		const target = readlinkSync(join(release, "node_modules"));
		return basename(target) === "node_modules" ? /^[0-9a-f]{40,64}$/.exec(basename(dirname(target)))?.[0] : undefined;
	} catch {
		return undefined;
	}
}

/** Build the Pi in `dir` (its vendor/pi tree with node_modules linked): what a deploy runs. */
export async function buildPi(dir: string): Promise<void> {
	const npm = (...args: string[]) => exec("npm", args, { cwd: dir, timeout: BUILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
	try {
		// The source's model data, unless this commit needs other data: then it is generated (downloads).
		await npm("--prefix", "packages/ai", "run", "check:model-data").catch(() => npm("run", "hydrate:model-data"));
		await npm("run", "build:offline");
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string; message: string };
		throw new Error(`building Pi (vendor/pi) failed:\n${`${e.stdout ?? ""}\n${e.stderr ?? e.message}`.trim().split("\n").slice(-20).join("\n")}`);
	}
}

/**
 * Link `dir`'s node_modules to the entries of `sourcePi`'s: workspace packages (links into the
 * source's own tree) link to `dir`'s packages instead, and each workspace's node_modules to the source's.
 */
export function linkModules(sourcePi: string, dir: string): void {
	const from = join(sourcePi, "node_modules");
	mkdirSync(join(dir, "node_modules"), { recursive: true });
	if (!existsSync(from)) return;
	const workspaces = new Set<string>();
	const link = (entry: string) => {
		const source = join(from, entry);
		const target = join(dir, "node_modules", entry);
		if (lstatSync(source).isSymbolicLink()) {
			const inSource = relative(sourcePi, resolve(dirname(source), readlinkSync(source)));
			if (!inSource.startsWith("..") && inSource.split(sep)[0] !== "node_modules") {
				workspaces.add(inSource);
				symlinkSync(relative(dirname(target), join(dir, inSource)), target);
				return;
			}
		}
		symlinkSync(source, target);
	};
	for (const name of readdirSync(from)) {
		if (!name.startsWith("@") || !lstatSync(join(from, name)).isDirectory()) {
			link(name);
			continue;
		}
		mkdirSync(join(dir, "node_modules", name));
		for (const scoped of readdirSync(join(from, name))) link(`${name}/${scoped}`);
	}
	for (const workspace of workspaces) {
		const own = join(sourcePi, workspace, "node_modules");
		if (existsSync(own) && existsSync(join(dir, workspace))) symlinkSync(own, join(dir, workspace, "node_modules"));
	}
}

export interface PiBuildOptions {
	/** The harness repository: vendor/pi/node_modules and the generated inputs come from its working tree. */
	source: string;
	/** The vendor/pi tree id. */
	tree: string;
	harness: string;
	/** Writes the tree's files into a directory (git archive of the tree). */
	extract: (dir: string) => Promise<void>;
	build?: (dir: string) => Promise<void>;
}

/** The build directory of `tree`, built unless it is already; a failed build leaves nothing behind. */
export async function ensurePiBuild({ source, tree, harness, extract, build = buildPi }: PiBuildOptions): Promise<string> {
	mkdirSync(piBuildsDir(harness), { recursive: true });
	// The real path: tools resolve modules by real path, and a build seen under two paths has two copies of each type.
	const builds = realpathSync(piBuildsDir(harness));
	const target = join(builds, tree);
	if (existsSync(target)) return target;
	removeOrphanedBuilds(harness);
	const temporary = join(builds, `.${tree}.${process.pid}`);
	rmSync(temporary, { recursive: true, force: true });
	mkdirSync(temporary);
	try {
		await extract(temporary);
		linkModules(join(source, "vendor", "pi"), temporary);
		for (const path of GENERATED) {
			if (existsSync(join(source, "vendor", "pi", path))) cpSync(join(source, "vendor", "pi", path), join(temporary, path), { recursive: true });
		}
		await build(temporary);
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		throw error;
	}
	try {
		renameSync(temporary, target);
	} catch (error) {
		// Another process built the same tree first: keep its build.
		if (!existsSync(target)) throw error;
		rmSync(temporary, { recursive: true, force: true });
	}
	return target;
}

/** Point the global Pi at the build of `tree`, atomically. */
export function switchPi(harness: string, tree: string): void {
	const temporary = `${piLink(harness)}.${process.pid}`;
	rmSync(temporary, { force: true });
	symlinkSync(join("pi-builds", tree), temporary);
	renameSync(temporary, piLink(harness));
	writeFileSync(legacyRecord(harness), `${tree}\n`);
}

/** Remove builds that processes left behind when they died while building (`.<tree>.<pid>`). */
function removeOrphanedBuilds(harness: string): void {
	for (const name of readdirSync(piBuildsDir(harness))) {
		const pid = Number(/^\.[0-9a-f]+\.(\d+)$/.exec(name)?.[1]);
		if (pid && pid !== process.pid && !pidAlive(pid)) rmSync(join(piBuildsDir(harness), name), { recursive: true, force: true });
	}
}

/** Remove the builds outside `keep` (the global Pi's is always kept); builds in progress stay. */
export function prunePiBuilds(harness: string, keep: ReadonlySet<string>): void {
	if (!existsSync(piBuildsDir(harness))) return;
	removeOrphanedBuilds(harness);
	const current = builtPi(harness);
	for (const name of readdirSync(piBuildsDir(harness))) {
		if (name.startsWith(".") || name === current || keep.has(name)) continue;
		rmSync(join(piBuildsDir(harness), name), { recursive: true, force: true });
	}
}
