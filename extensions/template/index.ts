// Templates: named, persistent, rebuildable prepared sessions that tasks fork from, so the prepared
// part (role, way of working, files read, examples) is cached once and read by every task.
//
// - recipe.ts parses `<repo>/.pi/templates/<name>.md` and `<harness>/templates/<name>.md`;
// - build.ts builds a recipe's session deterministically (no model call) or captures a session;
// - store.ts finds, rebuilds when stale (under a lock) and lists them;
// - Pi (vendor/pi) forks them: the fork runs with its current prompt in front, and its first request
//   writes the template prefix's shared cache entry when that pays (template-prefix.ts).
//
// Using one is forking from it, everywhere: `delegate_task({ template, task })` and a workflow's
// `delegate({ template })` (extensions/workflow), and for the user `/template <name>`.

import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { captureSession, describeTemplates, type FindModel, templateNames, useTemplate } from "./store.ts";

/** "provider/id" in a model registry. */
export const modelFinder =
	(find: (provider: string, id: string) => ReturnType<FindModel>): FindModel =>
	(spec) => {
		const slash = spec.indexOf("/");
		return slash > 0 ? find(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
	};

const USAGE = "/template <name> starts a session from the template; /template list; /template save <name> saves this session as a template";

export default function template(pi: ExtensionAPI, options: { agentDir?: string } = {}) {
	const agentDir = options.agentDir ?? getAgentDir();
	const find = (ctx: ExtensionCommandContext) => modelFinder((provider, id) => ctx.modelRegistry.find(provider, id));

	pi.registerCommand("template", {
		description: "Session templates: /template <name> | list | save <name>",
		getArgumentCompletions: (prefix) => {
			const items = ["list", "save", ...templateNames(process.cwd(), agentDir)].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [command, name, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (!command || rest.length || (command !== "save" && name)) return ctx.ui.notify(USAGE, "warning");
			try {
				if (command === "list") {
					const lines = await describeTemplates(ctx.cwd, agentDir, find(ctx));
					return ctx.ui.notify(lines.length ? lines.join("\n") : "No templates. Write .pi/templates/<name>.md (see docs/templates.md) or /template save <name>.", "info");
				}
				if (command === "save") {
					if (!name) return ctx.ui.notify(USAGE, "warning");
					if (!ctx.model) return ctx.ui.notify("/template save needs a model: the template's turns belong to it", "warning");
					await ctx.waitForIdle();
					const meta = await captureSession(name, agentDir, {
						cwd: ctx.cwd,
						file: ctx.sessionManager.getSessionFile(),
						model: `${ctx.model.provider}/${ctx.model.id}`,
						thinking: pi.getThinkingLevel(),
						projection: ctx.sessionManager.buildSessionProjection(),
					});
					return ctx.ui.notify(`Saved template ${name} (${meta.reads.length} read calls tracked). Use it with /template ${name} or delegate_task({ template: "${name}" }).`, "info");
				}
				await startFrom(command, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	/** A fresh session forked from the template, on the template's model. */
	async function startFrom(name: string, ctx: ExtensionCommandContext): Promise<void> {
		const usable = await useTemplate(name, ctx.cwd, agentDir, find(ctx));
		if (usable.warning) ctx.ui.notify(usable.warning, "warning");
		const fork = SessionManager.forkFrom(usable.file, ctx.cwd, ctx.sessionManager.getSessionDir());
		const [provider, ...id] = usable.meta.model.split("/");
		fork.appendModelChange(provider!, id.join("/"));
		if (usable.meta.thinking) fork.appendThinkingLevelChange(usable.meta.thinking);
		const file = fork.getSessionFile()!;
		await ctx.switchSession(file, {
			withSession: async (next) => next.ui.notify(`Session from template ${name} (built ${usable.meta.builtAt}${usable.rebuilt ? `, rebuilt: ${usable.rebuilt.join("; ")}` : ""}) on ${usable.meta.model}.`, "info"),
		});
	}
}
