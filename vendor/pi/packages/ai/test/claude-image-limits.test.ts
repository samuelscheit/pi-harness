import { describe, expect, it } from "vitest";
import { claudeImageResize, supportsClaudeHighResImages } from "../catalog/families/anthropic.ts";

// https://platform.claude.com/docs/en/build-with-claude/vision#resolution-and-token-cost
describe("Claude image resolution tiers", () => {
	it.each([
		"claude-opus-4-7",
		"claude-opus-4.7",
		"claude-opus-4-8",
		"claude-opus-5",
		"claude-opus-5-20260723",
		"claude-opus-5-5",
		"claude-sonnet-5",
		"claude-haiku-5-5",
		"claude-fable-5-2",
		"claude-mythos-5",
		"anthropic/claude-opus-4.7",
		"anthropic.claude-opus-4-7",
		"us.anthropic.claude-sonnet-5-5",
		"claude-opus-4-7@20260101",
		"~anthropic/claude-opus-latest",
		"Claude-Opus-4-7",
	])("%s reads images at high resolution", (id) => {
		expect(supportsClaudeHighResImages(id)).toBe(true);
		expect(claudeImageResize(id)).toEqual({ maxWidth: 2576, maxHeight: 2576, patchSize: 28, maxPatches: 4784 });
	});

	it.each([
		"claude-opus-4-6",
		"claude-sonnet-4-6",
		"claude-opus-4-5-20251101",
		"claude-haiku-4-5",
		"claude-opus-4-1-20250805",
		// The date is no minor version: this is Claude Opus 4.
		"claude-opus-4-20250514",
		"anthropic.claude-sonnet-4-20250514-v1:0",
		"claude-3-7-sonnet-20250219",
		"claude-3-5-haiku-latest",
	])("%s reads images at standard resolution", (id) => {
		expect(supportsClaudeHighResImages(id)).toBe(false);
		expect(claudeImageResize(id)).toEqual({ maxWidth: 1568, maxHeight: 1568, patchSize: 28, maxPatches: 1568 });
	});

	it("leaves non-Claude models alone", () => {
		expect(claudeImageResize("gpt-4o")).toBeUndefined();
		expect(claudeImageResize("gemini-2.5-flash")).toBeUndefined();
	});
});
