// pi-lens configuration, layered globally and per project.
//
// pi-lens (vendor/pi-lens, loaded as the package after this one) reads one global config file and
// honours only a few keys from a project's own `.pi-lens.json`. This extension makes every pi-lens
// setting configurable at both levels:
//
// - global:  config/pi-lens.json in this repository (versioned, so the improvement loop and the
//            changelog see every change);
// - project: <repository root>/.pi/pi-lens.json, any key, overriding the global value.
//
// Objects merge key by key, other values (arrays included) replace, and `null` removes a global
// key so pi-lens falls back to its default. The merged file is written to the agent directory and
// handed to pi-lens through PI_LENS_CONFIG_PATH before pi-lens loads (Pi loads packages and their
// extensions in order). pi-lens reads it once per session: edits apply to the next session.
// pi-lens's own `.pi-lens.json` (nested monorepo rules, ignores) keeps working on top.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { HARNESS_ROOT, repositoryRoot } from "../lib/repository.ts";

export const GLOBAL_CONFIG = join(HARNESS_ROOT, "config", "pi-lens.json");
export const PROJECT_CONFIG = join(".pi", "pi-lens.json");

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (value: Json | undefined): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** `override` on top of `base`: objects merge recursively, `null` deletes, anything else replaces. */
export function mergeConfig(base: JsonObject, override: JsonObject): JsonObject {
	const merged: JsonObject = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (value === null) delete merged[key];
		else if (isObject(value) && isObject(merged[key])) merged[key] = mergeConfig(merged[key], value);
		else merged[key] = value;
	}
	return merged;
}

function readConfig(file: string): JsonObject {
	if (!existsSync(file)) return {};
	const value = JSON.parse(readFileSync(file, "utf8")) as Json;
	if (!isObject(value)) throw new Error(`${file}: expected a JSON object`);
	return value;
}

/**
 * The config file pi-lens should read for a session in `cwd`: the global file itself when the
 * project overrides nothing, else a merged file per project in `stateDir`.
 */
export function effectiveConfigPath(cwd: string, stateDir: string, globalFile = GLOBAL_CONFIG): string {
	const root = repositoryRoot(cwd);
	const projectFile = join(root, PROJECT_CONFIG);
	if (!existsSync(projectFile)) return globalFile;
	const merged = mergeConfig(readConfig(globalFile), readConfig(projectFile));
	mkdirSync(stateDir, { recursive: true });
	const file = join(stateDir, `${createHash("sha256").update(root).digest("hex").slice(0, 16)}.json`);
	// pi-lens reports unknown keys, so the sources are named by the file's location only.
	writeFileSync(file, `${JSON.stringify(merged, null, "\t")}\n`);
	return file;
}

export default function lens(pi: ExtensionAPI) {
	try {
		process.env.PI_LENS_CONFIG_PATH = effectiveConfigPath(process.cwd(), join(getAgentDir(), "pi-lens"));
	} catch (error) {
		// A broken project file must not take the session down: run with the global config and say why.
		process.env.PI_LENS_CONFIG_PATH = GLOBAL_CONFIG;
		const reason = error instanceof Error ? error.message : String(error);
		pi.on("session_start", (_event, ctx) => ctx.ui.notify(`pi-lens project config ignored: ${reason}`, "warning"));
	}
}
