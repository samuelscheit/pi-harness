// pi.wrapToolExecution(wrapper): every tool call the model makes runs through the wrappers, in
// extension load order; calls a tool makes through ctx.executeTool() do not. A wrapper can give the
// tool another signal (its context and nested calls get it too) and return before the tool ends.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getApiProvider, registerApiProvider, type ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const text = (content: readonly { type: string; text?: string }[]) => content.map((c) => c.text ?? "").join("");

describe("pi.wrapToolExecution", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("wraps model-issued calls of every tool in load order, not nested calls; the signal it passes reaches the tool and its nested calls", async () => {
		const log: string[] = [];
		const signals = new Map<string, AbortSignal | undefined>();
		const own = new AbortController();
		const tools = (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "leaf",
				label: "leaf",
				description: "A leaf.",
				parameters: Type.Object({ value: Type.String() }),
				execute: async (id, params, signal) => {
					signals.set(id, signal);
					return { content: [{ type: "text", text: `leaf ${params.value}` }], details: {} };
				},
			});
			pi.registerTool({
				name: "caller",
				label: "caller",
				description: "Calls leaf.",
				parameters: Type.Object({}),
				execute: async (id, _params, signal, _onUpdate, ctx) => {
					signals.set(id, signal);
					const nested = await ctx.executeTool("leaf", { value: "nested" });
					return { content: nested.result.content, details: {} };
				},
			});
			pi.on("tool_call", (event) => {
				if (event.toolName === "leaf" && !event.parentToolCallId) event.input.value = "changed";
			});
		};
		const outer = (pi: ExtensionAPI) =>
			pi.wrapToolExecution(async (execution, ctx) => {
				log.push(`outer ${execution.toolName} ${JSON.stringify(execution.input)} ${ctx.cwd ? "ctx" : "-"}`);
				const result = await execution.execute(own.signal, execution.onUpdate);
				return { ...result, content: [...result.content, { type: "text", text: " +outer" }] };
			});
		const inner = (pi: ExtensionAPI) =>
			pi.wrapToolExecution(async (execution) => {
				log.push(`inner ${execution.toolName} ${execution.signal === own.signal ? "own" : "turn"}`);
				return execution.execute(execution.signal, execution.onUpdate);
			});
		const harness = await createHarness({ extensionFactories: [tools, outer, inner] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("leaf", { value: "model" }), fauxToolCall("caller", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		const results = harness.session.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(results.map((r) => text(r.content))).toEqual(["leaf changed +outer", "leaf nested +outer"]);
		expect(log).toEqual([
			'outer leaf {"value":"model"} ctx',
			"inner leaf own",
			"outer caller {} ctx",
			"inner caller own",
		]);
		const [leafId, callerId] = results.map((r) => r.toolCallId);
		expect(signals.get(leafId!)).toBe(own.signal);
		expect(signals.get(callerId!)).toBe(own.signal);
		expect(signals.get(`${callerId}/1`)).toBe(own.signal);
	});

	it("can return before the call ends: the turn goes on, the call keeps running", async () => {
		const { promise: released, resolve: release } = Promise.withResolvers<void>();
		let ended: Promise<unknown> | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.registerTool({
						name: "slow",
						label: "slow",
						description: "Slow.",
						parameters: Type.Object({}),
						execute: async () => {
							await released;
							return { content: [{ type: "text", text: "slow done" }], details: {} };
						},
					});
					pi.wrapToolExecution(async (execution) => {
						ended = execution.execute(undefined, () => {});
						return { content: [{ type: "text", text: "later" }], details: {} };
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const [result] = harness.session.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(text(result!.content)).toBe("later");
		release();
		expect(await ended).toMatchObject({ content: [{ type: "text", text: "slow done" }] });
	});

	it("a reload replaces the wrappers with the reloaded extension's", async () => {
		let generation = 0;
		const seen: number[] = [];
		const scratch = await createHarness();
		const settingsManager = SettingsManager.inMemory({});
		const resourceLoader = new DefaultResourceLoader({
			cwd: scratch.tempDir,
			agentDir: scratch.tempDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noContextFiles: true,
			extensionFactories: [
				(pi: ExtensionAPI) => {
					const mine = ++generation;
					pi.registerTool({
						name: "noop",
						label: "noop",
						description: "Nothing.",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
					pi.wrapToolExecution(async (execution) => {
						seen.push(mine);
						return execution.execute(execution.signal, execution.onUpdate);
					});
				},
			],
		});
		await resourceLoader.reload();
		scratch.cleanup();
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const call = () => fauxAssistantMessage([fauxToolCall("noop", {})], { stopReason: "toolUse" });
		harness.setResponses([call(), fauxAssistantMessage("one")]);
		await harness.session.prompt("go");
		// reload() resets the API providers to the built-in ones; the faux one goes back, as an extension's would.
		const provider = getApiProvider(harness.faux.api);
		await harness.session.reload();
		if (!getApiProvider(harness.faux.api)) registerApiProvider(provider as never);
		harness.setResponses([call(), fauxAssistantMessage("two")]);
		await harness.session.prompt("again");
		expect(seen).toEqual([1, 2]);
		expect(generation).toBe(2);
	});
});
