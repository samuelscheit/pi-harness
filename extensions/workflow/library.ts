// Saved workflows: `<harness>/workflows/<name>.ts` (shipped with the harness, every repository) and
// `<repository>/.pi/workflows/<name>.ts` (this repository; a project workflow replaces a harness one
// of the same name). Each file exports `meta` (WorkflowMeta in api.d.ts) and a default function,
// and becomes the tool `<name>`. Files are read again when they change (mtime and size).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_ROOT, repositoryRoot } from "../lib/repository.ts";
import { compile, evaluate } from "./compile.ts";

export const HARNESS_WORKFLOWS = join(HARNESS_ROOT, "workflows");
export const projectWorkflowsDir = (cwd: string) => join(repositoryRoot(cwd), ".pi", "workflows");

/** Tool names as the workflow files name them. */
export const WORKFLOW_NAME = /^[a-z][a-z0-9_]{1,63}$/;

export interface WorkflowMeta {
	description: string;
	parameters: Record<string, unknown> & { type: "object" };
	budget: number;
	guidelines?: string[];
}

export interface SavedWorkflow {
	name: string;
	file: string;
	source: string;
	meta: WorkflowMeta;
	/** Changes when the file changes, so registrations can tell. */
	version: string;
}

/** Why `meta` is invalid; undefined when valid. */
export function metaProblem(meta: unknown): string | undefined {
	if (!meta || typeof meta !== "object") return "no `export const meta = { description, parameters, budget }`";
	const m = meta as Record<string, unknown>;
	if (typeof m.description !== "string" || !m.description.trim()) return "meta.description must be a non-empty string";
	const parameters = m.parameters as Record<string, unknown> | undefined;
	if (!parameters || typeof parameters !== "object" || parameters.type !== "object") return 'meta.parameters must be a JSON Schema with type "object"';
	if (typeof m.budget !== "number" || !Number.isFinite(m.budget) || m.budget <= 0) return "meta.budget must be a positive number (USD per run)";
	if (m.guidelines !== undefined && (!Array.isArray(m.guidelines) || !m.guidelines.every((g) => typeof g === "string"))) return "meta.guidelines must be an array of strings";
	return undefined;
}

const loaded = new Map<string, { version: string; result: SavedWorkflow | { problem: string } }>();

/** One workflow file, read again only when it changed. */
function loadFile(file: string, name: string): SavedWorkflow | { problem: string } {
	const stat = statSync(file);
	const version = `${stat.mtimeMs}:${stat.size}`;
	const cached = loaded.get(file);
	if (cached?.version === version) return cached.result;
	let result: SavedWorkflow | { problem: string };
	try {
		const source = readFileSync(file, "utf8");
		// The top level only declares, so evaluating it without the API globals reads `meta`.
		const { meta } = evaluate(compile(source, file), file, {});
		const problem = metaProblem(meta);
		result = problem ? { problem } : { name, file, source, meta: structuredClone(meta) as WorkflowMeta, version };
	} catch (error) {
		result = { problem: error instanceof Error ? error.message : String(error) };
	}
	loaded.set(file, { version, result });
	return result;
}

/** The saved workflows for a working directory, by name, with the files that are invalid. */
export function loadWorkflows(cwd: string, dirs = [HARNESS_WORKFLOWS, projectWorkflowsDir(cwd)]): { workflows: Map<string, SavedWorkflow>; problems: string[] } {
	const workflows = new Map<string, SavedWorkflow>();
	const problems: string[] = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")).sort()) {
			const name = entry.slice(0, -".ts".length);
			const file = join(dir, entry);
			if (!WORKFLOW_NAME.test(name) || name === "workflow") {
				problems.push(`${file}: the file name must be a tool name (${WORKFLOW_NAME.source}, not "workflow")`);
				continue;
			}
			const result = loadFile(file, name);
			if ("problem" in result) problems.push(`${file}: ${result.problem}`);
			else workflows.set(name, result);
		}
	}
	return { workflows, problems };
}
