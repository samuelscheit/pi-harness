// Where templates live, and using one: resolve a name, rebuild it when stale, list them.
//
// Recipes: `<repo>/.pi/templates/<name>.md` (a project's; it replaces a global one of the same name),
// then `<harness>/templates/<name>.md` (every repository's; its paths are relative to the harness).
// Builds: `<agentDir>/templates/<name>/<scope>/{session.jsonl,meta.json}`, where the scope is
// `global`, `<repo-basename>-<hash of the repo path>` for a project (every checkout builds its own:
// files differ between worktrees), or `captured` for a template saved from a session.
//
// A built template is stale when its recipe or a file it read changed (hashes in meta.json), the
// glob expansion changed, or its model is gone. Using it rebuilds it once, under a lock (Pi's
// FileLocks, as for fork bases), so parallel uses wait and then share the rebuild. A captured
// template cannot be rebuilt: when what its read calls return changed, using it warns.

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { FileLocks, type SessionProjection, writeFileAtomic } from "@earendil-works/pi-coding-agent";
import { HARNESS_ROOT, repositoryRoot } from "../lib/repository.ts";
import type { TemplateUse } from "../workflow/delegation.ts";
import { type BuiltTemplate, buildTemplate, captureTemplate, changedReads, expandReads, type ReadRecord } from "./build.ts";
import { parseRecipe, type Recipe, sha256, TEMPLATE_NAME } from "./recipe.ts";

export const HARNESS_TEMPLATES = join(HARNESS_ROOT, "templates");
export const projectTemplatesDir = (cwd: string) => join(repositoryRoot(cwd), ".pi", "templates");
export const templatesDir = (agentDir: string) => join(agentDir, "templates");

/** Finds a model by "provider/id"; undefined when it is gone. */
export type FindModel = (spec: string) => Model<Api> | undefined;

export interface TemplateMeta {
	name: string;
	kind: "recipe" | "captured";
	/** The recipe file and its hash, for a built template. */
	recipe?: { file: string; hash: string };
	/** Where its paths resolve: the repository (or the harness), or the captured session's cwd. */
	root: string;
	model: string;
	thinking?: string;
	description?: string;
	reads: ReadRecord[];
	builtAt: string;
	/** The id chain key of the template's end: with a model and a prompt hash, its prompt cache key. */
	prefixKey: string;
	leafId: string;
	/** The session a captured template was taken from. */
	capturedFrom?: string;
}

/** A template that can be used: its session file and metadata, and why it is stale if it is. */
export interface UsableTemplate {
	file: string;
	meta: TemplateMeta;
	/** A captured template whose reads changed: used as it is. */
	warning?: string;
	/** It was (re)built for this use. */
	rebuilt?: string[];
}

/** Where a template named `name` comes from for `cwd`, before any build. */
export interface TemplateSource {
	name: string;
	kind: "recipe" | "captured";
	scope: string;
	dir: string;
	recipeFile?: string;
	root?: string;
}

const locks = (agentDir: string, name: string) => new FileLocks(join(templatesDir(agentDir), name));
const metaPath = (dir: string) => join(dir, "meta.json");
export const sessionPath = (dir: string) => join(dir, "session.jsonl");

function readMeta(dir: string): TemplateMeta | undefined {
	try {
		return JSON.parse(readFileSync(metaPath(dir), "utf8")) as TemplateMeta;
	} catch {
		return undefined;
	}
}

/** The recipe of `name` for `cwd` (project, then global), or the captured template; undefined when there is none. */
export function findTemplate(name: string, cwd: string, agentDir: string): TemplateSource | undefined {
	if (!TEMPLATE_NAME.test(name)) return undefined;
	const repo = repositoryRoot(cwd);
	for (const [recipes, root, scope] of [
		[projectTemplatesDir(cwd), repo, `${basename(repo).replace(/[^A-Za-z0-9._-]/g, "_")}-${sha256(repo).slice(0, 8)}`],
		[HARNESS_TEMPLATES, HARNESS_ROOT, "global"],
	] as const) {
		const recipeFile = join(recipes, `${name}.md`);
		if (existsSync(recipeFile)) return { name, kind: "recipe", scope, dir: join(templatesDir(agentDir), name, scope), recipeFile, root };
	}
	const captured = join(templatesDir(agentDir), name, "captured");
	return readMeta(captured) ? { name, kind: "captured", scope: "captured", dir: captured } : undefined;
}

/** Every template name usable from `cwd`: recipes of the project and the harness, and captured ones. */
export function templateNames(cwd: string, agentDir: string): string[] {
	const names = new Set<string>();
	for (const dir of [projectTemplatesDir(cwd), HARNESS_TEMPLATES]) {
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)) if (file.endsWith(".md") && TEMPLATE_NAME.test(file.slice(0, -3))) names.add(file.slice(0, -3));
	}
	const built = templatesDir(agentDir);
	if (existsSync(built)) for (const name of readdirSync(built)) if (readMeta(join(built, name, "captured"))) names.add(name);
	return [...names].sort();
}

/** Why a built template no longer matches its recipe, files and model; empty when it matches. */
export async function staleness(meta: TemplateMeta, findModel: FindModel, recipe?: Recipe): Promise<string[]> {
	const reasons: string[] = [];
	if (recipe) {
		if (meta.recipe?.hash !== recipe.hash) reasons.push("its recipe changed");
		else {
			let paths: string[] | undefined;
			try {
				paths = expandReads(meta.root, recipe.read);
			} catch (error) {
				reasons.push(error instanceof Error ? error.message : String(error));
			}
			if (paths && paths.join("\n") !== meta.reads.map((read) => read.path).join("\n")) reasons.push("its globs match other files now");
		}
	}
	if (!reasons.length) reasons.push(...(await changedReads(meta.root, meta.reads)));
	if (!findModel(meta.model)) reasons.push(`its model ${meta.model} is gone`);
	return reasons;
}

function save(dir: string, built: BuiltTemplate, meta: Omit<TemplateMeta, "reads" | "prefixKey" | "leafId" | "builtAt">): TemplateMeta {
	mkdirSync(dir, { recursive: true });
	writeFileAtomic(sessionPath(dir), built.text);
	const full: TemplateMeta = { ...meta, reads: built.reads, prefixKey: built.prefixKey, leafId: built.leafId, builtAt: new Date().toISOString() };
	writeFileAtomic(metaPath(dir), `${JSON.stringify(full, null, "\t")}\n`);
	return full;
}

/** Build a recipe's template into its directory; throws when the recipe, a file or the model is wrong. */
export async function build(source: TemplateSource, findModel: FindModel): Promise<TemplateMeta> {
	const recipe = parseRecipe(source.name, readFileSync(source.recipeFile!, "utf8"));
	const model = findModel(recipe.model);
	if (!model) throw new Error(`template ${source.name}: unknown model ${recipe.model}`);
	const built = await buildTemplate(recipe, source.root!, model);
	return save(source.dir, built, {
		name: source.name,
		kind: "recipe",
		recipe: { file: source.recipeFile!, hash: recipe.hash },
		root: source.root!,
		model: recipe.model,
		...(recipe.thinking ? { thinking: recipe.thinking } : {}),
		...(recipe.description ? { description: recipe.description } : {}),
	});
}

/**
 * The template `name` for a use from `cwd`, built or rebuilt when it is missing or stale. The check
 * and the build hold the template's lock: parallel uses wait, find it fresh and share the build.
 */
export async function useTemplate(name: string, cwd: string, agentDir: string, findModel: FindModel): Promise<UsableTemplate> {
	const source = findTemplate(name, cwd, agentDir);
	if (!source) {
		const names = templateNames(cwd, agentDir);
		throw new Error(`no template ${name}${names.length ? ` (templates: ${names.join(", ")})` : " (none exist: write .pi/templates/<name>.md)"}`);
	}
	if (source.kind === "captured") {
		const meta = readMeta(source.dir)!;
		const reasons = await staleness(meta, findModel);
		if (!findModel(meta.model)) throw new Error(`template ${name}: its model ${meta.model} is gone, and a captured template cannot be rebuilt`);
		return { file: sessionPath(source.dir), meta, ...(reasons.length ? { warning: `captured template ${name} is stale (${reasons.join("; ")}); it cannot be rebuilt, so it is used as captured` } : {}) };
	}
	return locks(agentDir, name).withLock(source.scope, async () => {
		const recipe = parseRecipe(name, readFileSync(source.recipeFile!, "utf8"));
		const current = readMeta(source.dir);
		const reasons = current && existsSync(sessionPath(source.dir)) ? await staleness(current, findModel, recipe) : ["it was not built yet"];
		if (!reasons.length) return { file: sessionPath(source.dir), meta: current! };
		return { file: sessionPath(source.dir), meta: await build(source, findModel), rebuilt: reasons };
	});
}

/** The template `name` for a delegation from `cwd` (delegation.ts): built when needed, with a note on a rebuild or a stale capture. */
export async function templateUse(name: string, cwd: string, agentDir: string, findModel: FindModel): Promise<TemplateUse> {
	const usable = await useTemplate(name, cwd, agentDir, findModel);
	const note = usable.warning ?? (usable.rebuilt ? `rebuilt now: ${usable.rebuilt.join("; ")}` : undefined);
	return {
		name,
		builtAt: usable.meta.builtAt,
		file: usable.file,
		model: usable.meta.model,
		...(usable.meta.thinking ? { thinking: usable.meta.thinking } : {}),
		...(note ? { note } : {}),
	};
}

/** Save a session's context at its current point as the captured template `name`. */
export async function captureSession(name: string, agentDir: string, session: { cwd: string; file?: string; model: string; thinking?: string; projection: Pick<SessionProjection, "entries"> }): Promise<TemplateMeta> {
	if (!TEMPLATE_NAME.test(name)) throw new Error(`template names match ${TEMPLATE_NAME.source}`);
	const dir = join(templatesDir(agentDir), name, "captured");
	return locks(agentDir, name).withLock("captured", async () => {
		const built = await captureTemplate(name, session.cwd, session.projection);
		return save(dir, built, {
			name,
			kind: "captured",
			root: session.cwd,
			model: session.model,
			...(session.thinking ? { thinking: session.thinking } : {}),
			...(session.file ? { capturedFrom: session.file } : {}),
		});
	});
}

/** A line per template usable from `cwd`: where it comes from, its model and whether it is fresh. */
export async function describeTemplates(cwd: string, agentDir: string, findModel: FindModel): Promise<string[]> {
	const lines: string[] = [];
	for (const name of templateNames(cwd, agentDir)) {
		const source = findTemplate(name, cwd, agentDir)!;
		const meta = readMeta(source.dir);
		let state: string;
		let recipe: Recipe | undefined;
		try {
			recipe = source.recipeFile ? parseRecipe(name, readFileSync(source.recipeFile, "utf8")) : undefined;
			const reasons = meta ? await staleness(meta, findModel, recipe) : ["not built yet"];
			state = reasons.length ? `stale: ${reasons.join("; ")}` : `built ${meta!.builtAt}`;
		} catch (error) {
			state = `invalid: ${error instanceof Error ? error.message : String(error)}`;
		}
		const where = source.kind === "captured" ? `captured from ${meta?.capturedFrom ?? "a session"}` : source.scope === "global" ? "harness" : "project";
		const description = recipe?.description ?? meta?.description;
		lines.push(`${name} (${where}, ${recipe?.model ?? meta?.model}): ${state}${description ? ` — ${description}` : ""}`);
	}
	return lines;
}
