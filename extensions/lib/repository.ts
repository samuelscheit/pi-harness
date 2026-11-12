import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The harness code this module runs from: a release (see release.ts) or the repository itself. */
export const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** What a release records about itself in `.release.json`. */
export interface ReleaseMarker {
	commit: string;
	/** The repository it was built from, where edits go. */
	source: string;
	/** The branch whose commits are deployed. */
	branch: string;
	subject: string;
	deployedAt: string;
}

export const RELEASE_MARKER = ".release.json";

/** The release this code runs from, or undefined when it runs from the repository. */
export const RELEASE: ReleaseMarker | undefined = existsSync(join(HARNESS_ROOT, RELEASE_MARKER))
	? (JSON.parse(readFileSync(join(HARNESS_ROOT, RELEASE_MARKER), "utf8")) as ReleaseMarker)
	: undefined;

/**
 * The harness repository, where changes to the harness are written (backlog, changelog, experiment
 * files): the release's source, else this checkout. Code and prompts are read from HARNESS_ROOT.
 */
export const SOURCE_ROOT = RELEASE?.source ?? HARNESS_ROOT;

/** A path inside HARNESS_ROOT as the same path in SOURCE_ROOT. */
export const inSource = (path: string, code = HARNESS_ROOT, source = SOURCE_ROOT) => join(source, relative(code, path));

/** The closest directory at or above `dir` holding `.git`, else `dir`. */
export function repositoryRoot(dir: string): string {
	for (let current = resolve(dir); ; current = dirname(current)) {
		if (existsSync(join(current, ".git"))) return current;
		if (dirname(current) === current) return resolve(dir);
	}
}
