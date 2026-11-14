import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionAPI } from "../../src/index.ts";

/**
 * A tool call that keeps running in the background across a reload (as workflow, fix_loop and
 * delegate_task do across harness deploys) keeps a working ctx: it reaches the reloaded tools.
 * Session replacement still makes it stale.
 */

interface Fixture {
	runtime: AgentSessionRuntime;
	/** The ctx of the `slow` tool call, captured while it ran. */
	ctx(): ExtensionToolContext;
	/** Extension instances loaded so far: 1 at start, +1 per reload. */
	instances(): number;
	/** Whether the next loaded instances register `echo`. */
	setRegistersEcho(registers: boolean): void;
}

function text(outcome: AgentToolCallOutcome): string {
	return outcome.result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

describe("tool call ctx across reload and session replacement", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function createFixture(): Promise<Fixture> {
		const tempDir = join(tmpdir(), `pi-tool-ctx-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});

		let instances = 0;
		let registersEcho = true;
		let captured: ExtensionToolContext | undefined;
		const extension = (pi: ExtensionAPI) => {
			const instance = ++instances;
			pi.registerProvider(faux.getModel().provider, {
				baseUrl: faux.getModel().baseUrl,
				apiKey: "faux-key",
				api: faux.api,
				models: faux.models.map((model) => ({
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				})),
			});
			if (registersEcho) {
				pi.registerTool({
					name: "echo",
					label: "echo",
					description: "Echo the extension instance.",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: `echo v${instance}` }], details: {} }),
				});
			}
			pi.registerTool({
				name: "slow",
				label: "slow",
				description: "Keeps its ctx for work that outlives the call.",
				parameters: Type.Object({}),
				execute: async (_id, _params, _signal, _onUpdate, ctx) => {
					captured = ctx;
					return { content: [{ type: "text", text: "started" }], details: {} };
				},
			});
		};

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				modelRuntime,
				resourceLoaderOptions: {
					extensionFactories: [extension],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await runtime.session.prompt("go");

		return {
			runtime,
			ctx: () => {
				if (!captured) throw new Error("slow did not run");
				return captured;
			},
			instances: () => instances,
			setRegistersEcho: (registers) => {
				registersEcho = registers;
			},
		};
	}

	it("runs the reloaded tool definition after one or more reloads", async () => {
		const { runtime, ctx, instances } = await createFixture();
		const toolCtx = ctx();
		const runner = runtime.session.extensionRunner;
		expect(text(await toolCtx.executeTool("echo", {}))).toBe("echo v1");

		await runtime.session.reload();
		expect(instances()).toBe(2);
		// Event handler contexts of the old runner stay stale; only the tool call's ctx survives.
		expect(() => runner.createContext().cwd).toThrow("stale after session replacement or reload");
		const afterReload = await toolCtx.executeTool("echo", {});
		expect(afterReload.isError).toBe(false);
		expect(text(afterReload)).toBe("echo v2");

		// Chained reloads resolve to the newest runner.
		await runtime.session.reload();
		expect(text(await toolCtx.executeTool("echo", {}))).toBe("echo v3");

		// The other session-scoped members act through the current runner too.
		expect(toolCtx.cwd).toBe(runtime.session.sessionManager.getCwd());
		expect(toolCtx.sessionManager).toBe(runtime.session.sessionManager);
		expect(toolCtx.model).toBe(runtime.session.model);
		expect(toolCtx.isIdle()).toBe(true);
		expect(toolCtx.tools.map((tool) => tool.name)).toContain("echo");
	});

	it("reaches the session's tools while the reload builds the next runner", async () => {
		const { runtime, ctx } = await createFixture();
		const toolCtx = ctx();
		let duringReload: Promise<AgentToolCallOutcome> | undefined;
		const loader = runtime.session.resourceLoader;
		const reloadResources = loader.reload.bind(loader);
		loader.reload = async (...args) => {
			duringReload = toolCtx.executeTool("echo", {});
			await reloadResources(...args);
		};

		await runtime.session.reload();

		if (!duringReload) throw new Error("reload did not run");
		expect(text(await duringReload)).toBe("echo v1");
		expect(text(await toolCtx.executeTool("echo", {}))).toBe("echo v2");
	});

	it("reports a tool the reload removed as not found", async () => {
		const { runtime, ctx, setRegistersEcho } = await createFixture();
		const toolCtx = ctx();
		setRegistersEcho(false);

		await runtime.session.reload();

		expect(toolCtx.tools.map((tool) => tool.name)).not.toContain("echo");
		const outcome = await toolCtx.executeTool("echo", {});
		expect(outcome.isError).toBe(true);
		expect(text(outcome)).toBe("Tool echo not found");
		// The calling tool itself is still callable.
		expect(text(await toolCtx.executeTool("slow", {}))).toBe("started");
	});

	it.each([
		["newSession", false],
		["reload, then newSession", true],
	] as const)("throws stale after %s", async (_name, reloadFirst) => {
		const { runtime, ctx } = await createFixture();
		const toolCtx = ctx();
		if (reloadFirst) await runtime.session.reload();

		await runtime.newSession();

		await expect(toolCtx.executeTool("echo", {})).rejects.toThrow("stale after session replacement or reload");
		expect(() => toolCtx.cwd).toThrow("stale after session replacement or reload");
		expect(() => toolCtx.tools).toThrow("stale after session replacement or reload");
	});
});
