import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchedDocument, formatSearch, searchResults } from "../extensions/web/index.ts";

const result = (title: string, url: string, page_age?: string) => ({ type: "web_search_result", title, url, page_age, encrypted_content: "x" });

test("formats search findings with deduplicated sources", () => {
	const content = [
		{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "ts" } },
		{ type: "web_search_tool_result", tool_use_id: "s1", content: [result("TS 7", "https://ts.dev/7", "July 8, 2026"), result("npm", "https://npm.im/typescript")] },
		{ type: "server_tool_use", id: "s2", name: "web_search", input: { query: "ts again" } },
		{ type: "web_search_tool_result", tool_use_id: "s2", content: [result("TS 7 again", "https://ts.dev/7")] },
		{ type: "text", text: "TypeScript 7.0.2 ", citations: [{ url: "https://ts.dev/7" }] },
		{ type: "text", text: "is the latest." },
	];
	const { text, isError } = formatSearch("ts", content);
	assert.equal(isError, false);
	assert.equal(text, "TypeScript 7.0.2 is the latest.\n\nSources:\n- TS 7 — https://ts.dev/7 (July 8, 2026)\n- npm — https://npm.im/typescript");
});

test("reports search errors and empty searches", () => {
	const failed = [{ type: "web_search_tool_result", tool_use_id: "s", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } }];
	assert.deepEqual(searchResults(failed), { results: [], errors: ["max_uses_exceeded"] });
	assert.deepEqual(formatSearch("q", failed), { text: 'Web search for "q" found nothing (max_uses_exceeded).', isError: true });
	assert.deepEqual(formatSearch("q", [{ type: "text", text: "no tool used" }]), { text: 'Web search for "q" found nothing.', isError: false });
});

test("reads the fetched document, a fetch error, or a missing fetch", () => {
	const page = {
		type: "web_fetch_tool_result",
		tool_use_id: "f",
		content: { type: "web_fetch_result", url: "https://example.com/", content: { type: "document", source: { type: "text", media_type: "text/plain", data: "hello" } } },
	};
	assert.deepEqual(fetchedDocument([page]), { url: "https://example.com/", text: "hello" });
	const pdf = { ...page, content: { ...page.content, content: { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBER" } } } };
	assert.deepEqual(fetchedDocument([pdf]), { url: "https://example.com/", text: undefined });
	const error = { type: "web_fetch_tool_result", tool_use_id: "f", content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" } };
	assert.deepEqual(fetchedDocument([error]), { error: "url_not_accessible" });
	assert.deepEqual(fetchedDocument([{ type: "text", text: "I will not fetch that" }]), { error: "the page was not fetched" });
});
