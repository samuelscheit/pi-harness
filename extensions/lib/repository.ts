import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This harness repository: global prompt, config and backlog live here. */
export const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The closest directory at or above `dir` holding `.git`, else `dir`. */
export function repositoryRoot(dir: string): string {
	for (let current = resolve(dir); ; current = dirname(current)) {
		if (existsSync(join(current, ".git"))) return current;
		if (dirname(current) === current) return resolve(dir);
	}
}
