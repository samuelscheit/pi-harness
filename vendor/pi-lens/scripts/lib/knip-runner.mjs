// scripts/lib/knip-runner.mjs (#2698).
//
// Orchestrates one `npm run knip` invocation: copy the working tree without
// its gitignored build output (scripts/lib/knip-snapshot.mjs), spawn knip's
// real bin entry (scripts/lib/knip-command.mjs) in the copy, remove the copy.
// The checkout itself is never written, so agents sharing it keep their
// compiled `.js` twins (the 2026-11-14 purge broke their vitest runs).
//
// A snapshot failure aborts loudly (an `::error::` line under CI too) rather
// than running knip in the built checkout, which would report every source
// behind a compiled twin as unused (#2698 review round 2, F3). `--help` and
// `--version` (`-h`, `-V`) analyse nothing, so they run in the checkout
// without a copy (#2698 review rounds 2-3).
import { spawnSync } from "node:child_process";
import { resolveKnipCommand } from "./knip-command.mjs";
import { createKnipSnapshot, removeKnipSnapshot } from "./knip-snapshot.mjs";

const INFORMATIONAL_ARGS = new Set(["--help", "-h", "--version", "-V"]);

/**
 * @typedef {{
 *   snapshot?: typeof createKnipSnapshot,
 *   removeSnapshot?: typeof removeKnipSnapshot,
 *   resolveCommand?: typeof resolveKnipCommand,
 *   spawn?: typeof spawnSync,
 *   log?: (message: string) => void,
 *   logError?: (message: string) => void,
 *   isCI?: boolean,
 * }} RunKnipDeps
 */

/**
 * @param {string[]} argv `process.argv.slice(2)`
 * @param {string} repoRoot
 * @param {RunKnipDeps} [deps]
 * @returns {number} the process exit code to use.
 */
export function runKnip(argv, repoRoot, deps = {}) {
	const snapshot = deps.snapshot ?? createKnipSnapshot;
	const removeSnapshot = deps.removeSnapshot ?? removeKnipSnapshot;
	const resolveCommand = deps.resolveCommand ?? resolveKnipCommand;
	const spawn = deps.spawn ?? spawnSync;
	const log = deps.log ?? ((message) => console.log(message));
	const logError = deps.logError ?? ((message) => console.error(message));
	const isCI = deps.isCI ?? Boolean(process.env.CI);

	const { command, args } = resolveCommand(argv);
	const run = (cwd) => {
		const result = spawn(command, args, { cwd, stdio: "inherit" });
		if (result.error) {
			logError(`[run-knip] failed to start knip: ${result.error.message}`);
			return 1;
		}
		// Killed by a signal (e.g. SIGTERM from a CI timeout): non-zero.
		return typeof result.status === "number" ? result.status : 1;
	};

	if (argv.some((arg) => INFORMATIONAL_ARGS.has(arg))) return run(repoRoot);

	let copy;
	try {
		copy = snapshot(repoRoot);
	} catch (err) {
		const message =
			`could not copy the working tree for analysis (${err.message}); ` +
			`refusing to run knip in the built checkout, where compiled .js ` +
			`twins make it report their sources as unused.`;
		logError(`[run-knip] ${message}`);
		if (isCI) logError(`::error::${message}`);
		return 1;
	}
	log(
		`[run-knip] analysing a copy of ${copy.files} file(s) without build output: ${copy.dir}`,
	);
	try {
		return run(copy.dir);
	} finally {
		removeSnapshot(copy.dir);
	}
}
