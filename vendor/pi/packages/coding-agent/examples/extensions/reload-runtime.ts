/**
 * Reload Runtime Extension
 *
 * Demonstrates ctx.reload() from ExtensionCommandContext and an LLM-callable tool that reloads
 * with pi.requestReload(): the run continues on the reloaded extensions from its next turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	// Command entrypoint for reload.
	// Treat reload as terminal for this handler.
	pi.registerCommand("reload-runtime", {
		description: "Reload extensions, skills, prompts, themes, and context files",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});

	// LLM-callable tool. Tools do not receive ExtensionCommandContext, so they cannot call
	// ctx.reload(); requestReload() reloads at the next turn boundary of the running run.
	pi.registerTool({
		name: "reload_runtime",
		label: "Reload Runtime",
		description: "Reload extensions, skills, prompts, themes, and context files",
		parameters: Type.Object({}),
		async execute() {
			pi.requestReload();
			return {
				content: [{ type: "text", text: "Reload requested; the next turn runs on the reloaded extensions." }],
				details: {},
			};
		},
	});
}
