/**
 * The Lean toolchain the real-process Lean tests run against, or `undefined`
 * when elan or Lake is missing. Bounded: never a download, never a hang.
 *
 * Tests run under an isolated HOME, where elan finds no toolchain, so
 * `ELAN_HOME` is taken from the elan binary on PATH (`<ELAN_HOME>/bin/elan`)
 * and handed to every Lean process the test starts through `env`. elan marks
 * the default toolchain `(default)` in older releases and
 * `(resolved from default '…')` in newer ones; both are read, so a format
 * change cannot silently skip every Lean test.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface LeanToolchain {
	toolchain: string;
	/** Environment for every Lean process the test starts. */
	env: NodeJS.ProcessEnv;
}

function elanHome(): string | undefined {
	if (process.env.ELAN_HOME) return process.env.ELAN_HOME;
	const which = spawnSync("which", ["elan"], {
		encoding: "utf8",
		timeout: 5_000,
	});
	const binary = which.status === 0 ? which.stdout.trim() : "";
	if (!binary) return undefined;
	return path.dirname(path.dirname(fs.realpathSync(binary)));
}

export function installedLeanToolchain(): LeanToolchain | undefined {
	if (process.platform === "win32") return undefined;
	const home = elanHome();
	if (!home) return undefined;
	const env = { ...process.env, ELAN_HOME: home };
	const elanShow = spawnSync("elan", ["show"], {
		encoding: "utf8",
		timeout: 5_000,
		env,
	});
	if (elanShow.status !== 0) return undefined;
	const toolchain = elanShow.stdout.match(
		/^\s*(leanprover\/lean4:\S+)\s+\((?:default|resolved from default\b[^)]*)\)$/m,
	)?.[1];
	const lake = spawnSync("lake", ["--version"], {
		encoding: "utf8",
		timeout: 5_000,
		env,
	});
	return toolchain !== undefined && lake.status === 0
		? { toolchain, env: { ELAN_HOME: home } }
		: undefined;
}
