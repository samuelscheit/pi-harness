#!/usr/bin/env node
/**
 * scripts/run-knip.mjs (#2698, refs #2697 item 6).
 *
 * Runs knip in a temporary copy of the working tree that holds no gitignored
 * build output (scripts/lib/knip-snapshot.mjs), then removes the copy. The
 * checkout itself is never written: agents sharing it keep their compiled
 * `.js` twins and their running test suites.
 *
 * Why the copy is required: `npm run build` (tsc, no `outDir`) writes
 * `clients/x.js` beside every `clients/x.ts`, and every source imports its
 * siblings with an explicit `.js` specifier (nodenext). knip's resolver
 * (`extensionAlias`, packages/knip/src/util/resolve.ts) tries the literal
 * `.js` candidate before the `.ts` source and does not gitignore-filter a
 * resolved target, so on a built tree its graph walks into the compiled
 * copies: 491 files reported "unused" with them present, 0 without (see
 * knip.jsonc's header). No knip option changes that order.
 *
 * Orchestration (fail loud when the copy fails, no copy for --help/
 * --version) lives in scripts/lib/knip-runner.mjs, which is unit-tested.
 */
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { runKnip } from "./lib/knip-runner.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.exitCode = runKnip(process.argv.slice(2), repoRoot);
