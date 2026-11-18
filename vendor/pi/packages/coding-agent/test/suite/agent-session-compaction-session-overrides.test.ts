// pi.setCompactionOverrides(): one session's compaction token settings over the configured ones.
// A cap below the context makes the next prompt compact, the overrides reach compaction's
// preparation, `undefined` restores the configured settings, and a replaced session starts clean.

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, SessionBeforeCompactEvent } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "./harness.ts";

/** Two exchanges whose last assistant usage reports `totalTokens` of context. */
function seedHistory(harness: Harness, totalTokens: number): void {
	const model = harness.session.model!;
	for (const label of ["old", "recent"]) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: label.padEnd(400, "x") }],
			timestamp: Date.now() - 2000,
		});
		const assistant = fauxAssistantMessage(label.padEnd(400, "y"), { timestamp: Date.now() - 1000 });
		harness.sessionManager.appendMessage({
			...assistant,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...assistant.usage, input: totalTokens, totalTokens },
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("pi.setCompactionOverrides", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	async function start() {
		let api: ExtensionAPI | undefined;
		const preparations: SessionBeforeCompactEvent[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100_000 }],
			tools: [],
			settings: { compaction: { keepRecentTokens: 20_000 } },
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("session_before_compact", (event) => {
						preparations.push(event);
						return {
							compaction: {
								summary: "compacted history",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		return { harness, api: api!, preparations };
	}

	it("compacts at the session's cap with its keepRecentTokens, far below the window", async () => {
		const { harness, api, preparations } = await start();
		seedHistory(harness, 2500);
		expect(api.getCompactionSettings()).toEqual({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20_000 });

		api.setCompactionOverrides({ maxContextTokens: 2000, keepRecentTokens: 150 });
		expect(api.getCompactionSettings()).toEqual({
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 150,
			maxContextTokens: 2000,
		});
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("continue");

		expect(preparations).toHaveLength(1);
		expect(preparations[0]?.reason).toBe("threshold");
		expect(preparations[0]?.preparation.settings).toEqual({
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 150,
			maxContextTokens: 2000,
		});
		// The configured settings are untouched.
		expect(harness.settingsManager.getCompactionSettings(harness.session.model)).toEqual({
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20_000,
		});
	});

	it("does not compact below the window's threshold without a cap, or after the cap is removed", async () => {
		const { harness, api, preparations } = await start();
		seedHistory(harness, 2500);
		api.setCompactionOverrides({ maxContextTokens: 2000 });
		api.setCompactionOverrides(undefined);
		expect(api.getCompactionSettings()).not.toHaveProperty("maxContextTokens");
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("continue");
		expect(preparations).toHaveLength(0);
	});

	it("ignores undefined fields instead of clearing configured values", async () => {
		const { api } = await start();
		api.setCompactionOverrides({ keepRecentTokens: undefined, maxContextTokens: 5000 });
		expect(api.getCompactionSettings()).toEqual({
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20_000,
			maxContextTokens: 5000,
		});
	});
});
