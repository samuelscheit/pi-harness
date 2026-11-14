// The harness's extension of t3's `delegate_task` (t3.ts): `schema`, `system` and `tools`, for the
// model directly as for a workflow's delegate() (delegate.ts), and the check of `fork`.
//
// The tool is t3's: its MCP bridge (a Pi extension t3 loads with `-e`, before the harness) registers
// it, and Pi keeps the first registration of a name, so a harness tool of the same name would never
// be called. The seam is Pi's own tool pipeline instead:
// - the schema: the harness adds its properties to the registered tool's parameter schema in place,
//   whenever the session starts, a run starts or a turn starts (the bridge registers its tools anew
//   on some events), before any call is validated against it, so the model sees and may pass them;
// - the call: a `tool_call` handler (it runs for the model's calls and for calls a tool makes, such
//   as a workflow's) turns the harness's keys into a delegation spec (delegation.ts) and the task
//   into its first message, and leaves t3 the rest; invalid arguments block the call with the
//   reason. `fork` and `forkThreadId` pass through to t3 untouched (a t3 that does not know them
//   refuses them), checked first: a fork takes its source's provider, model, options, system
//   prompt and tools, so it goes with none of target, system and tools;
// - the result: the child (child.ts) ends its run's final message with the submitted object, so it
//   is part of the task's result wherever t3 reports it.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DELEGATE_EXTENSION, type DelegationSpec, prepareDelegation } from "./delegation.ts";
import { T3_DELEGATE } from "./t3.ts";

/** The bridge also registers each tool under a hidden canonical name. */
export const DELEGATE_TOOLS = new Set([T3_DELEGATE, T3_DELEGATE.replace("mcp__t3-code__", "mcp__t3_code__")]);

/** Add the harness's properties to t3's delegate_task schemas; returns how many schemas changed. */
export function extendDelegateSchemas(pi: Pick<ExtensionAPI, "getAllTools">): number {
	let changed = 0;
	for (const tool of pi.getAllTools()) {
		if (!DELEGATE_TOOLS.has(tool.name)) continue;
		const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties;
		if (!properties || typeof properties !== "object") continue;
		const missing = Object.keys(DELEGATE_EXTENSION).filter((key) => !(key in properties));
		for (const key of missing) properties[key] = structuredClone(DELEGATE_EXTENSION[key as keyof typeof DELEGATE_EXTENSION]);
		if (missing.length) changed++;
	}
	return changed;
}

/** `specOf`: the calling session's own delegation spec: a fork of it keeps its system prompt and tools. */
export function extendDelegateTool(pi: ExtensionAPI, delegationsDir: string, specOf: (ctx: ExtensionContext) => DelegationSpec | undefined): void {
	const extend = () => void extendDelegateSchemas(pi);
	pi.on("session_start", extend);
	pi.on("before_agent_start", extend);
	pi.on("turn_start", extend);

	pi.on("tool_call", (event, ctx) => {
		if (!DELEGATE_TOOLS.has(event.toolName)) return;
		const input = event.input as Record<string, unknown>;
		let prepared: Record<string, unknown>;
		try {
			const own = input.fork === true && input.forkThreadId === undefined ? specOf(ctx) : undefined;
			prepared = prepareDelegation(input, delegationsDir, { callerSessionId: ctx.sessionManager.getSessionId(), ...(own ? { inherit: own } : {}) }).input;
		} catch (error) {
			return { block: true, reason: error instanceof Error ? error.message : String(error) };
		}
		if (prepared === input) return;
		// Changed in place: t3 gets this object.
		for (const key of Object.keys(input)) delete input[key];
		Object.assign(input, prepared);
	});
}
