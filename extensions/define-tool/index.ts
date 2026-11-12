// define_tool: the agent defines a named tool for a shell command it keeps running with different
// arguments (see template.ts for the definition and its quoting). The tool is registered at once
// and callable from the agent's next call; it runs through the session's bash tool (same output
// limits, hooks and abort), so its file effects reach the metrics through the nested call.
//
// Definitions are kept as `harness-defined-tool` custom entries and registered again when the
// session resumes (its current branch only). `scope: "project"` also writes
// `<repository>/.pi/tools/<name>.json`, which every later session in the repository loads.
// Redefining a tool this extension defined replaces it; other tools' names are refused.
//
// define_tool is registered inactive; the `define-tool` experiment (prompt/experiments) activates
// it in arm B. Defined tools follow define_tool: active exactly when it is, so arm A never sees
// project tools defined in arm B sessions.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { applyToolSwitches, EXPERIMENTS_DIR, listExperiments, recordedArms, toolSwitches } from "../lib/experiments.ts";
import { repositoryRoot } from "../lib/repository.ts";
import { renderCommand, specProblem, type ToolSpec } from "./template.ts";

export const DEFINE_TOOL = "define_tool";
export const DEFINED_ENTRY = "harness-defined-tool";
export const projectToolsDir = (cwd: string) => join(repositoryRoot(cwd), ".pi", "tools");

/** The definitions a session's repository shares (`.pi/tools/*.json`), with the files that are invalid. */
export function projectTools(cwd: string): { specs: ToolSpec[]; problems: string[] } {
	const dir = projectToolsDir(cwd);
	const specs: ToolSpec[] = [];
	const problems: string[] = [];
	if (!existsSync(dir)) return { specs, problems };
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
		try {
			const spec = JSON.parse(readFileSync(join(dir, file), "utf8")) as ToolSpec;
			const problem = specProblem(spec) ?? (`${spec.name}.json` === file ? undefined : `name ${spec.name} does not match the file name`);
			if (problem) problems.push(`${join(dir, file)}: ${problem}`);
			else specs.push(spec);
		} catch (error) {
			problems.push(`${join(dir, file)}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { specs, problems };
}

const parameterSchema = (spec: ToolSpec): TSchema => {
	const properties: Record<string, TSchema> = {};
	for (const p of spec.parameters) {
		const options = { description: p.default === undefined ? p.description : `${p.description} (default ${JSON.stringify(p.default)})` };
		const schema = p.type === "number" ? Type.Number(options) : Type.String(options);
		properties[p.name] = p.default === undefined ? schema : Type.Optional(schema);
	}
	return Type.Object(properties);
};

export default function defineTool(pi: ExtensionAPI, experimentsDir = EXPERIMENTS_DIR) {
	/** The tools defined in the current session, and every name this extension registered in this process. */
	const defined = new Map<string, ToolSpec>();
	const owned = new Set<string>();

	const register = (spec: ToolSpec, active: boolean) => {
		owned.add(spec.name);
		defined.set(spec.name, spec);
		pi.registerTool({
			name: spec.name,
			label: spec.name,
			description: `${spec.description.trim()}\n\n(Defined with define_tool; runs: ${spec.command})`,
			parameters: parameterSchema(spec),
			defaultActive: active,
			async execute(_id, args, signal, onUpdate, ctx) {
				const command = renderCommand(spec, args as Record<string, unknown>);
				const outcome = await ctx.executeTool("bash", { command }, { signal, onUpdate });
				return { content: outcome.result.content, details: { command }, isError: outcome.isError };
			},
		});
	};

	/** Why `name` cannot be (re)defined here, if it cannot. */
	const conflict = (name: string) =>
		!owned.has(name) && pi.getAllTools().some((tool) => tool.name === name) ? `a tool named ${name} exists already; choose another name` : undefined;

	pi.registerTool({
		name: DEFINE_TOOL,
		label: "Define tool",
		description: [
			"Define a named tool for a shell command you run repeatedly with different arguments; it is callable from your next tool call.",
			"`command` is a shell template with {{parameter}} placeholders. Each value is inserted as one safely quoted shell word, so write placeholders unquoted (`grep -rn -- {{pattern}} src`), and put `--` before values that could start with `-`.",
			"Optional: `outputFilter` (a shell command reading the output on stdin, e.g. `grep -E 'FAIL|error'`), `maxLines` (keep the last lines), `cwd`, and `scope: project` to share the tool with later sessions in this repository.",
			"Defining an existing name you defined replaces it.",
		].join(" "),
		promptSnippet: "Define a reusable, parameterized shell-command tool for this session or project",
		promptGuidelines: [
			"Use define_tool when you are about to run the same kind of long shell command a second time with different arguments (a focused test run, a query, a build of one target): define it once and call it, so arguments are quoted correctly and the output is filtered the same way every time.",
			"Use define_tool with scope project only for commands every future session in this repository will need.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Tool name, lowercase snake_case (a-z, 0-9, _), not an existing tool's." }),
			description: Type.String({ description: "What the tool does and when to use it, for whoever calls it later." }),
			parameters: Type.Array(
				Type.Object({
					name: Type.String({ description: "Parameter name, used as {{name}} in command." }),
					type: StringEnum(["string", "number"]),
					description: Type.String(),
					default: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "Makes the parameter optional." })),
				}),
				{ description: "The tool's parameters; each must appear in command." },
			),
			command: Type.String({ description: "Shell command template with unquoted {{parameter}} placeholders." }),
			outputFilter: Type.Optional(Type.String({ description: "Shell command that reads the output on stdin and prints what to return." })),
			maxLines: Type.Optional(Type.Integer({ minimum: 1, description: "Return only the last lines of the (filtered) output." })),
			cwd: Type.Optional(Type.String({ description: "Directory to run in, relative to the working directory." })),
			scope: Type.Optional(StringEnum(["session", "project"], { description: "session (default) or project (saved in .pi/tools/ for later sessions)." })),
		}),
		defaultActive: false,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// SAFETY: StringEnum's fields infer as unknown; specProblem checks every parameter type and the scope right below.
			const spec = { ...params } as ToolSpec;
			const problem = specProblem(spec) ?? conflict(spec.name);
			if (problem) throw new Error(problem);
			const replaced = defined.has(spec.name);
			register(spec, true);
			pi.appendEntry(DEFINED_ENTRY, spec);
			let saved = "";
			if (spec.scope === "project") {
				const dir = projectToolsDir(ctx.cwd);
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, `${spec.name}.json`), `${JSON.stringify(spec, null, "\t")}\n`);
				saved = ` Saved for later sessions in ${join(dir, `${spec.name}.json`)}.`;
			}
			const signature = spec.parameters.map((p) => `${p.name}${p.default === undefined ? "" : "?"}: ${p.type}`).join(", ");
			return {
				content: [{ type: "text", text: `${replaced ? "Redefined" : "Defined"} ${spec.name}(${signature}); call it from your next tool call.${saved}` }],
				details: { spec },
			};
		},
	});

	/** Register the session's tools: the repository's, then the session's own definitions (later ones win). Inactive until the next run decides. */
	const restore = (ctx: ExtensionContext) => {
		for (const name of defined.keys()) {
			pi.registerTool({ name, label: name, description: "withdrawn", parameters: Type.Object({}), exposure: "hidden", execute: async () => ({ content: [], details: undefined }) });
		}
		defined.clear();
		const { specs, problems } = projectTools(ctx.cwd);
		const session = ctx.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === DEFINED_ENTRY)
			.map((entry) => (entry as { data?: unknown }).data as ToolSpec)
			.filter((spec) => spec && !specProblem(spec));
		for (const spec of [...specs, ...session]) {
			const clash = conflict(spec.name);
			if (clash) problems.push(`${spec.name}: ${clash}`);
			else register(spec, false);
		}
		if (problems.length && ctx.hasUI) ctx.ui.notify(`define_tool: skipped invalid definitions:\n${problems.join("\n")}`, "warning");
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));

	// Defined tools follow define_tool, which the experiments switch per arm (see extensions/prompt).
	pi.on("before_agent_start", (event, ctx) => {
		const options = event.systemPromptOptions;
		const session = ctx.sessionManager;
		const on =
			toolSwitches(listExperiments(experimentsDir), session.getSessionId(), recordedArms(session.getEntries())).get(DEFINE_TOOL) ??
			options.selectedTools.includes(DEFINE_TOOL);
		options.selectedTools = applyToolSwitches(options.selectedTools, new Map([...defined.keys()].map((name) => [name, on])));
	});
}
