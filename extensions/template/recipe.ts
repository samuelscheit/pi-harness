// A template's recipe: `<repo>/.pi/templates/<name>.md` (a project's) or `<harness>/templates/<name>.md`
// (every repository's). The frontmatter declares the model and the files to read; the body is the
// role, the way of working and the process description, followed by optional example exchanges:
//
//   ---
//   model: anthropic/claude-sonnet-5-5
//   thinking: medium              # optional, the children's default
//   description: Reviews …        # optional, for /template list
//   read:                         # optional: paths or globs, relative to the repository
//     - docs/architecture.md
//     - extensions/workflow/*.ts
//   ---
//   You review changes to …
//
//   :::user
//   An example request
//   :::
//   :::assistant
//   The answer, written by the recipe's author
//   :::
//
// Example turns are only ever the author's words: the build never asks a model to write them.

import { createHash } from "node:crypto";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { THINKING, type Thinking } from "../workflow/models.ts";

/** Template names: file names that are also safe path segments and session ids. */
export const TEMPLATE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface Example {
	user: string;
	assistant: string;
}

export interface Recipe {
	name: string;
	/** "provider/id": the template's turns belong to it, so every fork runs on it. */
	model: string;
	thinking?: Thinking;
	description?: string;
	/** Paths or globs as written, relative to the repository. */
	read: string[];
	/** The body before the examples. */
	instructions: string;
	examples: Example[];
	/** sha256 of the recipe file's text. */
	hash: string;
}

const KEYS = new Set(["model", "thinking", "description", "read"]);
const FENCE = /^:::[ \t]*(user|assistant)?[ \t]*$/;

export const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** Parse a recipe; throws naming what is wrong. */
export function parseRecipe(name: string, text: string): Recipe {
	if (!TEMPLATE_NAME.test(name)) throw new Error(`template ${name}: the name must match ${TEMPLATE_NAME.source}`);
	const fail = (problem: string): never => {
		throw new Error(`template ${name}: ${problem}`);
	};
	if (!text.trimStart().startsWith("---")) fail("the recipe needs frontmatter (--- model: provider/id ---)");
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(text);
	const unknown = Object.keys(frontmatter).filter((key) => !KEYS.has(key));
	if (unknown.length) fail(`unknown frontmatter key${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} (use ${[...KEYS].join(", ")})`);
	const { model, thinking, description, read = [] } = frontmatter;
	if (typeof model !== "string" || !/^[^/\s]+\/\S+$/.test(model)) fail('model must be "provider/id"');
	if (thinking !== undefined && !(THINKING as readonly unknown[]).includes(thinking)) fail(`thinking must be one of ${THINKING.join(", ")}`);
	if (description !== undefined && (typeof description !== "string" || !description.trim())) fail("description must be a non-empty string");
	const reads = typeof read === "string" ? [read] : read;
	if (!Array.isArray(reads) || !reads.every((path) => typeof path === "string" && path.trim())) fail("read must be a path or glob, or a list of them");
	for (const path of reads as string[]) {
		if (path.startsWith("/") || path.split("/").includes("..")) fail(`read ${path}: paths are relative to the repository and stay inside it`);
	}
	const { instructions, examples } = parseBody(body, fail);
	if (!instructions) fail("the body (role, instructions, process) is empty");
	return {
		name,
		model: model as string,
		...(thinking !== undefined ? { thinking: thinking as Thinking } : {}),
		...(description !== undefined ? { description: (description as string).trim() } : {}),
		read: (reads as string[]).map((path) => path.trim()),
		instructions,
		examples,
		hash: sha256(text),
	};
}

/** The instructions, then `:::user` / `:::assistant` blocks closed by `:::`, alternating from a user turn. */
function parseBody(body: string, fail: (problem: string) => never): { instructions: string; examples: Example[] } {
	const lines = body.split("\n");
	const start = lines.findIndex((line) => FENCE.exec(line)?.[1] !== undefined);
	const instructions = (start < 0 ? lines : lines.slice(0, start)).join("\n").trim();
	const turns: { role: "user" | "assistant"; text: string }[] = [];
	let open: { role: "user" | "assistant"; lines: string[] } | undefined;
	for (const [index, line] of (start < 0 ? [] : lines.slice(start)).entries()) {
		const fence = FENCE.exec(line);
		if (!open) {
			if (!fence?.[1]) {
				if (line.trim()) fail(`line ${start + index + 1} of the body: after the first example only :::user and :::assistant blocks may follow`);
				continue;
			}
			open = { role: fence[1] as "user" | "assistant", lines: [] };
			continue;
		}
		if (fence && !fence[1]) {
			const text = open.lines.join("\n").trim();
			if (!text) fail(`an empty :::${open.role} block`);
			turns.push({ role: open.role, text });
			open = undefined;
			continue;
		}
		if (fence) fail(`a :::${fence[1]} block inside a :::${open.role} block (close it with :::)`);
		open.lines.push(line);
	}
	if (open) fail(`the last :::${open.role} block is not closed with :::`);
	const examples: Example[] = [];
	for (let i = 0; i < turns.length; i += 2) {
		const [user, assistant] = [turns[i]!, turns[i + 1]];
		if (user.role !== "user" || assistant?.role !== "assistant") fail("examples alternate :::user and :::assistant blocks, starting with :::user and ending with :::assistant");
		examples.push({ user: user.text, assistant: assistant!.text });
	}
	return { instructions, examples };
}
