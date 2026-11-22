#!/usr/bin/env node
// Wrapper around `vendor/pi-lens/mcp/server.js` that applies pi-harness's layered
// `config/pi-lens.json` + `<repo>/.pi/pi-lens.json` resolution before pi-lens initializes.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { effectiveConfigPath, GLOBAL_CONFIG } from "../../extensions/lens/index.ts";
import { HARNESS_ROOT, SOURCE_ROOT } from "../../extensions/lib/repository.ts";

const stateDir = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"), "pi-lens");
const globalConfig = existsSync(GLOBAL_CONFIG) ? GLOBAL_CONFIG : join(SOURCE_ROOT, "config", "pi-lens.json");

try {
	process.env.PI_LENS_CONFIG_PATH = effectiveConfigPath(process.cwd(), stateDir, globalConfig);
} catch (error) {
	process.env.PI_LENS_CONFIG_PATH = globalConfig;
	process.stderr.write(`pi-lens project config ignored: ${error instanceof Error ? error.message : String(error)}\n`);
}

// Resolve vendor/pi-lens/mcp/server.js from the release (which symlinks vendor/) or source repo.
const candidates = [
	join(HARNESS_ROOT, "vendor", "pi-lens", "mcp", "server.js"),
	join(SOURCE_ROOT, "vendor", "pi-lens", "mcp", "server.js"),
];
const serverPath = candidates.find((p) => existsSync(p));
if (!serverPath) {
	process.stderr.write(`pi-lens MCP server not found in ${candidates.join(" or ")}\n`);
	process.exit(1);
}

await import(pathToFileURL(serverPath).href);
