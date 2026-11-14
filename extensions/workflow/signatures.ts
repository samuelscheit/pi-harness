// TypeScript signatures of `tools.*` for the workflow tool's description, generated from the
// session's tool schemas whenever its tools change (the workflow tool's `prepareLoadout`, Pi's own
// means to describe a loadout). Compact on purpose, since the description goes with every request:
// parameter names and types, nested objects three levels deep (then `object`), and a tool's
// description only when its first sentence is short.
//
// Two tools resolve to more than their text: `ask_user` to the answers (it waits until they exist)
// and t3's `delegate_task`, which is `delegate` itself.

import { T3_DELEGATE } from "./t3.ts";

const MAX_DEPTH = 3;
const SHORT = 80;
/** Characters that need a property name quoted. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

type Schema = Record<string, unknown>;

const key = (name: string) => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

/** A compact TypeScript type for a JSON Schema. */
export function tsType(schema: unknown, depth = 0): string {
	if (!schema || typeof schema !== "object") return "unknown";
	const s = schema as Schema;
	if ("const" in s) return JSON.stringify(s.const);
	if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
	const union = (s.anyOf ?? s.oneOf) as unknown[] | undefined;
	if (Array.isArray(union)) return [...new Set(union.map((u) => tsType(u, depth)))].join(" | ");
	const type = Array.isArray(s.type) ? s.type : [s.type];
	if (type.length > 1) return type.map((t) => tsType({ ...s, type: t }, depth)).join(" | ");
	switch (type[0]) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array": {
			const item = tsType(s.items, depth + 1);
			return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
		}
		default: {
			const properties = s.properties as Record<string, unknown> | undefined;
			if (!properties || !Object.keys(properties).length) return s.additionalProperties === false ? "{}" : "Record<string, unknown>";
			if (depth >= MAX_DEPTH) return "object";
			const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
			return `{ ${Object.entries(properties).map(([name, value]) => `${key(name)}${required.has(name) ? "" : "?"}: ${tsType(value, depth + 1)}`).join("; ")} }`;
		}
	}
}

export interface SignatureTool {
	name: string;
	description?: string;
	parameters: unknown;
	outputSchema?: unknown;
}

/** A description's first sentence when it is short and says more than the name. */
function shortDescription(name: string, description: string | undefined): string | undefined {
	const first = description?.trim().split(/(?<=[.!?])\s|\n/)[0]?.trim();
	if (!first || first.length > SHORT || name.endsWith(first)) return undefined;
	return first.replace(/\*\//g, "* /");
}

/** What a tool resolves to in a script. */
function result(tool: SignatureTool): string {
	if (tool.name === "ask_user") return "Promise<(string | undefined)[]>";
	return tool.outputSchema ? "Promise<any>" : "Promise<string>";
}

/** `declare const tools: { … }` for the tools a script can call. */
export function toolsDeclaration(tools: readonly SignatureTool[]): string {
	const lines = [...tools]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((tool) => {
			if (tool.name === T3_DELEGATE) return `\t${key(tool.name)}: typeof delegate;`;
			const description = shortDescription(tool.name, tool.description);
			return `${description ? `\t/** ${description} */\n` : ""}\t${key(tool.name)}(args: ${tsType(tool.parameters)}, options?: CallOptions): ${result(tool)};`;
		});
	return `type CallOptions = { idempotent?: boolean };\ndeclare const tools: {\n${lines.join("\n")}\n};`;
}
