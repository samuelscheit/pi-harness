// pi.requestReload(): a reload at the next safe point. Idle: at once. During a run: at the next turn
// boundary, after which the run continues on the reloaded tools and prompt. Without a later
// boundary: once the run settles. Extension factories run again on each reload, so a module-level
// `version` stands for a new release of the extension's code.

import { fauxAssistantMessage, fauxToolCall, getSystemMessageText, type TranscriptContext } from "@earendil-works/pi-ai";
import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

let version = 1;
let api: ExtensionAPI | undefined;
const log: string[] = [];
const errors: string[] = [];

/** An extension whose tool, prompt section and handlers report the version they were loaded as. */
function versioned(pi: ExtensionAPI): void {
	const loaded = version;
	api = pi;
	log.push(`load v${loaded}`);
	pi.registerTool({
		name: "probe",
		label: "probe",
		description: `Probe, version ${loaded}.`,
		parameters: Type.Object({ reload: Type.Optional(Type.Boolean()) }),
		async execute(_id, params) {
			if (params.reload) {
				// A new release arrives while this call runs; it finishes on the old code.
				version = loaded + 1;
				pi.requestReload();
				pi.requestReload();
			}
			return { content: [{ type: "text", text: `probe v${loaded}` }], details: undefined };
		},
	});
	pi.on("session_start", (event) => {
		log.push(`session_start ${event.reason} v${loaded}`);
	});
	pi.on("before_agent_start", (event) => {
		log.push(`before_agent_start${event.reloaded ? " reloaded" : ""} v${loaded}`);
		event.systemPromptOptions.sections["probe-version"] = `Probe section v${loaded}.`;
		if (loaded >= 2 && !event.systemPromptOptions.selectedTools.includes("probe")) {
			event.systemPromptOptions.selectedTools = [...event.systemPromptOptions.selectedTools, "probe"];
		}
	});
	pi.on("agent_settled", () => {
		log.push(`agent_settled v${loaded}`);
	});
}

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
	version = 1;
	api = undefined;
	log.length = 0;
	expect(errors).toEqual([]);
	errors.length = 0;
});

/**
 * reload() resets the API providers to the built-in ones; real extension providers register again
 * when their extension reloads. The test's faux provider is registered by the harness, so this
 * extension puts it back on every reload.
 */
let fauxProvider: ReturnType<typeof getApiProvider>;
function restoreFaux(pi: ExtensionAPI): void {
	pi.on("session_start", (event) => {
		const api = harness!.faux.api;
		if (event.reason !== "reload") fauxProvider = getApiProvider(api);
		else if (fauxProvider && !getApiProvider(api)) registerApiProvider(fauxProvider as never);
	});
}

async function start(): Promise<Harness> {
	const created = await createHarness();
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: created.tempDir,
		agentDir: created.tempDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		extensionFactories: [versioned, restoreFaux],
	});
	await resourceLoader.reload();
	created.cleanup();
	harness = await createHarness({ resourceLoader });
	// Like the RPC mode: errors reported, reloads through session.reload().
	await harness.session.bindExtensions({
		onError: (error) => errors.push(`${error.event}: ${error.error}`),
		commandContextActions: { reload: () => harness!.session.reload() } as never,
	});
	log.length = 0;
	return harness;
}

const call = (args: Record<string, boolean>) => fauxAssistantMessage([fauxToolCall("probe", args)], { stopReason: "toolUse" });
const toolTexts = (h: Harness) =>
	h.session.messages.flatMap((m) => (m.role === "toolResult" ? m.content.map((c) => (c.type === "text" ? c.text : "")) : []));
/** The system prompt text a request saw: its system messages joined. */
const systemText = (context: TranscriptContext) =>
	context.messages
		.filter((m) => m.role === "system")
		.map((m) => getSystemMessageText(m))
		.join("\n");

describe("requestReload", () => {
	test("idle: reloads at once", async () => {
		const h = await start();
		version = 2;
		api!.requestReload();
		await expect.poll(() => log).toContain("session_start reload v2");
		expect(log).toEqual(["load v2", "session_start reload v2"]);
		expect(h.session.isStreaming).toBe(false);
	});

	test("during a run: reloads at the next turn boundary; the run continues on the new tools and prompt", async () => {
		const h = await start();
		const seen: string[] = [];
		h.setResponses([
			call({ reload: true }),
			(context) => {
				seen.push(systemText(context));
				return call({});
			},
			(context) => {
				seen.push(systemText(context));
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("go");
		// The call that requested the reload finished on v1; the next turn's call ran v2.
		expect(toolTexts(h)).toEqual(["probe v1", "probe v2"]);
		expect(log).toEqual([
			"before_agent_start v1",
			"load v2",
			"session_start reload v2",
			"before_agent_start reloaded v2",
			"agent_settled v2",
		]);
		// The second request already carried the reloaded prompt section and tool description.
		expect(seen[0]).toContain("Probe section v2.");
		expect(seen[1]).toContain("Probe section v2.");
		expect(h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		const probe = h.session.agent.state.tools.find((t) => t.name === "probe");
		expect(probe?.description).toContain("version 2");
	});

	test("a reload requested in the run's last turn happens once the run settles, once", async () => {
		const h = await start();
		h.setResponses([
			(_context) => {
				version = 2;
				api!.requestReload();
				api!.requestReload();
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("go");
		await expect.poll(() => log).toContain("session_start reload v2");
		expect(log).toEqual(["before_agent_start v1", "agent_settled v1", "load v2", "session_start reload v2"]);
		expect(h.session.isStreaming).toBe(false);
	});

	test("requested from an agent_settled handler: after the handlers finish", async () => {
		const h = await start();
		h.setResponses([fauxAssistantMessage("done")]);
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type === "agent_settled") {
				version = 2;
				api!.requestReload();
			}
		});
		await h.session.prompt("go");
		unsubscribe();
		await expect.poll(() => log).toContain("session_start reload v2");
		expect(log.indexOf("agent_settled v1")).toBeLessThan(log.indexOf("load v2"));
	});

	test("the next run starts on the reloaded extensions; tools a reloaded handler adds are declared", async () => {
		const h = await start();
		h.session.setActiveToolsByName(h.session.getActiveToolNames().filter((name) => name !== "probe"));
		version = 2;
		api!.requestReload();
		await expect.poll(() => log).toContain("session_start reload v2");
		h.setResponses([call({}), fauxAssistantMessage("done")]);
		await h.session.prompt("go");
		expect(toolTexts(h)).toEqual(["probe v2"]);
		expect(h.session.getActiveToolNames()).toContain("probe");
	});

	test("reload() itself still refuses during a run", async () => {
		const h = await start();
		let refused = "";
		h.setResponses([
			async () => {
				refused = await h.session.reload().then(
					() => "",
					(error: Error) => error.message,
				);
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("go");
		expect(refused).toMatch(/Wait for the current response to finish/);
	});
});
