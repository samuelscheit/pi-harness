import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type CompactionPreparation,
	compactsWithoutSummary,
	compactWithoutSummary,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	SummarizationError,
} from "../src/core/compaction/index.ts";

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const assistant = (text: string): AgentMessage => fauxAssistantMessage(text);
const toolResult = (text: string): AgentMessage => ({
	role: "toolResult",
	toolCallId: "call",
	toolName: "bash",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 0,
});

function preparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "kept",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 990_000,
		fileOps: createFileOps(),
		settings: DEFAULT_COMPACTION_SETTINGS,
		...overrides,
	};
}

const errorResponse = (errorMessage: string): AssistantMessage =>
	fauxAssistantMessage("", { stopReason: "error", errorMessage });
const POLICY_BLOCK =
	"This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.";

describe("compactsWithoutSummary", () => {
	const blocked = new SummarizationError(`Summarization failed: ${POLICY_BLOCK}`, errorResponse(POLICY_BLOCK));
	const badRequest = new SummarizationError("Summarization failed: 400 bad", errorResponse("400 bad request"));
	const truncated = new SummarizationError("truncated", fauxAssistantMessage("partial", { stopReason: "length" }));
	const toolCall = new SummarizationError("tool", fauxAssistantMessage("x", { stopReason: "toolUse" }));
	const overloaded = new SummarizationError("Summarization failed: overloaded", errorResponse("529 overloaded"));
	const rateLimited = new SummarizationError("Summarization failed: 429", errorResponse("429 rate limit exceeded"));
	const thrown = new Error("No API key");

	it("always lets overflow recovery go on without a summary", () => {
		for (const error of [blocked, overloaded, rateLimited, thrown, "string error"]) {
			expect(compactsWithoutSummary("overflow", error)).toBe(true);
		}
	});

	it("lets a threshold compaction go on only after a deterministic summary failure", () => {
		expect(compactsWithoutSummary("threshold", blocked)).toBe(true);
		expect(compactsWithoutSummary("threshold", badRequest)).toBe(true);
		expect(compactsWithoutSummary("threshold", truncated)).toBe(true);
		expect(compactsWithoutSummary("threshold", toolCall)).toBe(true);
		expect(compactsWithoutSummary("threshold", overloaded)).toBe(false);
		expect(compactsWithoutSummary("threshold", rateLimited)).toBe(false);
		expect(compactsWithoutSummary("threshold", thrown)).toBe(false);
	});

	it("never drops history unsummarized for optional or manual compactions", () => {
		for (const reason of ["economic", "cold", "manual"] as const) {
			expect(compactsWithoutSummary(reason, blocked)).toBe(false);
		}
	});
});

describe("compactWithoutSummary", () => {
	it("keeps the previous summary, the user's requests, the last assistant text and the files", () => {
		const fileOps = createFileOps();
		fileOps.read.add("src/read.ts");
		fileOps.edited.add("src/edited.ts");
		const result = compactWithoutSummary(
			preparation({
				previousSummary: "## Goal\nShip the feature",
				messagesToSummarize: [
					user("first request"),
					assistant("working on it"),
					toolResult("secret tool output"),
					assistant(""),
				],
				turnPrefixMessages: [user("split turn request"), assistant("latest plan")],
				isSplitTurn: true,
				fileOps,
			}),
			`Summarization failed: ${POLICY_BLOCK}`,
		);

		expect(result.firstKeptEntryId).toBe("kept");
		expect(result.tokensBefore).toBe(990_000);
		expect(result.usage).toBeUndefined();
		expect(result.generatedBy).toBeUndefined();
		expect(result.details).toEqual({ readFiles: ["src/read.ts"], modifiedFiles: ["src/edited.ts"] });
		const summary = result.summary;
		expect(summary.startsWith("## Goal\nShip the feature\n\n---\n\n## Removed without a summary")).toBe(true);
		expect(summary).toContain(`6 earlier messages were removed`);
		expect(summary).toContain(POLICY_BLOCK);
		expect(summary).toContain(
			"### What the user asked in them\n\n[User]: first request\n\n[User]: split turn request",
		);
		expect(summary).toContain("### The assistant's last message in them\n\n[Assistant]: latest plan");
		expect(summary).not.toContain("secret tool output");
		expect(summary).toContain("<read-files>\nsrc/read.ts\n</read-files>");
		expect(summary).toContain("<modified-files>\nsrc/edited.ts\n</modified-files>");
	});

	it("keeps the latest requests and truncates long texts", () => {
		const requests = Array.from({ length: 25 }, (_, i) => user(`request ${i + 1}`));
		const long = "y".repeat(5000);
		const { summary } = compactWithoutSummary(
			preparation({ messagesToSummarize: [...requests, user(long), assistant(long)] }),
			"boom",
		);

		expect(summary).toContain("### What the user asked in them (the last 20 of 26)");
		expect(summary).not.toContain("[User]: request 6\n");
		expect(summary).toContain("[User]: request 7\n");
		expect(summary).toContain("[... 3000 more characters truncated]");
		expect(summary).not.toContain("y".repeat(2001));
	});

	it("says what was removed even without requests or assistant text", () => {
		const { summary } = compactWithoutSummary(preparation({ messagesToSummarize: [toolResult("x")] }), "boom");

		expect(summary).toBe(
			"## Removed without a summary\n\n1 earlier messages were removed from the context without a summary, because the summary request failed: boom",
		);
	});

	it("refuses a preparation without a kept entry", () => {
		expect(() => compactWithoutSummary(preparation({ firstKeptEntryId: "" }), "boom")).toThrow("First kept entry");
	});
});
