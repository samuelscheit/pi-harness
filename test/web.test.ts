import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	browserNeeded,
	documentBlock,
	documentBody,
	PREVIEW_TOOLS,
	pageBlock,
	rawPageBlock,
	visibleText,
} from "../extensions/web/challenge.ts";
import web, { fetchedDocument, formatSearch, searchResults } from "../extensions/web/index.ts";

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

const fixture = (name: string) => readFileSync(new URL(`./fixtures/web/${name}`, import.meta.url), "utf8");
const html = { "content-type": "text/html; charset=utf-8" };
const raw = (status: number, headers: Record<string, string>, body?: string) => ({ status, headers: new Headers(headers), body });
// The text Anthropic's fetcher returned for curia.europa.eu (an Angular shell): front matter, no body.
const CURIA_TEXT = "---\nbase: /\nmeta-referrer: strict-origin-when-cross-origin\nmeta-viewport: width=device-width, initial-scale=1\ntitle: RPEX\n---\n\n";
const CLOUDFLARE_TEXT = "---\ntitle: Just a moment...\n---\n\nEnable JavaScript and cookies to continue";
const ARTICLE_TEXT = `---\ntitle: Article 4\n---\n\n# Definitions\n\n${"‘personal data’ means any information relating to an identified or identifiable natural person. ".repeat(4)}`;

test("detects each bot challenge and JavaScript shell in the raw page", () => {
	assert.equal(rawPageBlock(raw(202, { "x-amzn-waf-action": "challenge" }, "")), "an AWS WAF challenge (x-amzn-waf-action: challenge)");
	assert.equal(rawPageBlock(raw(202, {}, "")), "a bot challenge (HTTP 202 with an empty body)");
	assert.equal(rawPageBlock(raw(200, html, " \n")), "an empty page (HTTP 200)");
	assert.equal(rawPageBlock(raw(405, html, fixture("aws-waf-captcha.html"))), "an AWS WAF challenge (HTTP 405)");
	assert.equal(rawPageBlock(raw(403, { ...html, "cf-mitigated": "challenge" }, fixture("cloudflare-challenge.html"))), "a Cloudflare challenge (cf-mitigated: challenge)");
	assert.equal(rawPageBlock(raw(403, html, fixture("cloudflare-challenge.html"))), "a Cloudflare challenge (HTTP 403)");
	assert.equal(rawPageBlock(raw(200, html, fixture("noscript-only.html"))), "a page that requires JavaScript (its <noscript> says so)");
	assert.match(rawPageBlock(raw(200, html, fixture("js-shell.html"))) ?? "", /^a JavaScript-only page \(\d+ bytes of HTML, 0 characters of text\)$/);
	// The challenge header counts even when the body was not read (not HTML).
	assert.equal(rawPageBlock(raw(403, { "content-type": "application/pdf", "cf-mitigated": "challenge" })), "a Cloudflare challenge (cf-mitigated: challenge)");
});

test("reads normal pages as content", () => {
	// An article that mentions a challenge domain, and has a <noscript> note, is still the page.
	assert.equal(rawPageBlock(raw(200, html, fixture("normal.html"))), undefined);
	// A small page with little text but no scripts is a page, not a shell.
	assert.equal(rawPageBlock(raw(200, html, fixture("small.html"))), undefined);
	assert.equal(rawPageBlock(raw(200, { "content-type": "text/plain" }, "hello")), undefined);
	assert.equal(rawPageBlock(raw(200, { "content-type": "application/pdf" })), undefined);
	assert.equal(rawPageBlock(raw(200, {}, '{"ok":true}')), undefined);
});

test("strips scripts, styles, head and comments from the visible text", () => {
	assert.equal(visibleText("<html><head><title>T</title></head><body><!-- c --><script>x()</script><style>a{}</style><p>Hi&nbsp;there</p></body></html>"), "Hi there");
	assert.equal(visibleText(fixture("js-shell.html")), "");
});

test("detects a fetched document that is no content", () => {
	assert.equal(documentBody(CURIA_TEXT), "");
	assert.equal(documentBlock(CURIA_TEXT), "a page with no text without JavaScript");
	assert.equal(documentBlock(""), "a page with no text without JavaScript");
	assert.equal(documentBlock(CLOUDFLARE_TEXT), "a Cloudflare challenge");
	assert.equal(documentBlock("---\ntitle: App\n---\n\nYou need to enable JavaScript to run this app."), "a page that requires JavaScript");
	assert.equal(documentBlock(ARTICLE_TEXT), undefined);
	assert.equal(documentBlock("hello"), undefined);
	// A long article about Cloudflare challenges is content.
	assert.equal(documentBlock(`Just a moment... ${"text ".repeat(300)}`), undefined);
});

test("probes only inaccessible or thin documents and prefers what the probe shows", async () => {
	const probed: string[] = [];
	const probe = (page?: ReturnType<typeof raw>) => async (url: string) => (probed.push(url), page);
	const url = "https://eur-lex.europa.eu/eli/reg/2016/679/oj";
	assert.equal(await pageBlock(url, { text: ARTICLE_TEXT }, undefined, probe()), undefined);
	assert.deepEqual(probed, []);
	assert.equal(await pageBlock(url, { error: "url_not_allowed" }, undefined, probe()), undefined);
	assert.deepEqual(probed, []);
	// The fetcher hides the AWS WAF 202; the probe sees it.
	assert.equal(await pageBlock(url, { error: "url_not_accessible" }, undefined, probe(raw(202, { "x-amzn-waf-action": "challenge" }, ""))), "an AWS WAF challenge (x-amzn-waf-action: challenge)");
	assert.equal(await pageBlock(url, { error: "url_not_accessible" }, undefined, probe(raw(500, html, fixture("normal.html")))), undefined);
	assert.equal(await pageBlock(url, { text: CURIA_TEXT }, undefined, probe(raw(200, html, fixture("js-shell.html")))), "a JavaScript-only page (2820 bytes of HTML, 0 characters of text)");
	// The probe fails or sees a readable page: the document's own signs decide.
	assert.equal(await pageBlock(url, { text: CURIA_TEXT }, undefined, probe()), "a page with no text without JavaScript");
	assert.equal(await pageBlock(url, { text: CLOUDFLARE_TEXT }, undefined, probe(raw(200, html, fixture("small.html")))), "a Cloudflare challenge");
	assert.equal(await pageBlock(url, { text: "hello" }, undefined, probe(raw(200, { "content-type": "text/plain" }, "hello"))), undefined);
	// A fetched non-text document (a PDF) is content and is not probed.
	assert.equal(await pageBlock(url, {}, undefined, probe()), undefined);
	assert.equal(probed.length, 6);
});

test("names the session's browser tools only when it has them", () => {
	const both = browserNeeded("https://x.test/", "a Cloudflare challenge", [PREVIEW_TOOLS.open, PREVIEW_TOOLS.evaluate, "read"]);
	assert.match(both, /^https:\/\/x\.test\/ needs a real browser: web_fetch got a Cloudflare challenge, not the page content/);
	assert.match(both, /Open it with mcp__t3-code__preview_open \(url\) and read it with mcp__t3-code__preview_evaluate \(expression: document\.body\.innerText\)\.$/);
	for (const tools of [[], ["read"], [PREVIEW_TOOLS.open]]) {
		const text = browserNeeded("https://x.test/", "a Cloudflare challenge", tools);
		assert.doesNotMatch(text, /preview/);
		assert.match(text, /This session has no browser tool/);
	}
});

describe("web_fetch tool", () => {
	const PAGE = "https://curia.europa.eu/juris/liste.jsf?num=C-311/18";
	const realFetch = globalThis.fetch;
	let page: () => Response;
	let documentText: string;
	const requests: { url: string; body?: any }[] = [];
	const tools: Record<string, any> = {};
	let toolNames: string[] = [];
	web({ registerTool: (tool: any) => (tools[tool.name] = tool), getAllTools: () => toolNames.map((name) => ({ name })) } as any);
	const model = { id: "claude-haiku-5-5", provider: "anthropic", baseUrl: "https://api.test", cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } };
	const ctx = { modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) } };

	beforeEach(() => {
		requests.length = 0;
		toolNames = [];
		globalThis.fetch = (async (input: string, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			if (url !== "https://api.test/v1/messages") return page();
			const content = [
				{ type: "server_tool_use", id: "f", name: "web_fetch", input: { url: PAGE } },
				{
					type: "web_fetch_tool_result",
					tool_use_id: "f",
					content: { type: "web_fetch_result", url: PAGE, content: { type: "document", source: { type: "text", media_type: "text/plain", data: documentText } } },
				},
				{ type: "text", text: "The page does not contain the judgment." },
			];
			return Response.json({ content, stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10 } });
		}) as typeof fetch;
	});
	afterEach(() => (globalThis.fetch = realFetch));

	test("returns a browser error, not a summary of the empty shell, naming the preview tools", async () => {
		documentText = CURIA_TEXT;
		page = () => new Response(fixture("js-shell.html"), { headers: html });
		toolNames = [PREVIEW_TOOLS.open, PREVIEW_TOOLS.evaluate];
		const result = await tools.web_fetch.execute("id", { url: PAGE, prompt: "Quote paragraph 1 verbatim" }, undefined, undefined, ctx);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /needs a real browser: web_fetch got a JavaScript-only page .* Open it with mcp__t3-code__preview_open/);
		assert.doesNotMatch(result.content[0].text, /does not contain/);
		assert.ok(result.usage.cost.total > 0);
		assert.deepEqual(requests.map((r) => r.url), ["https://api.test/v1/messages", PAGE]);
		assert.match(requests[0].body.system, /verbatim and complete, without summarizing/);
	});

	test("reports the AWS WAF challenge the fetcher hid", async () => {
		documentText = "";
		page = () => new Response(null, { status: 202, headers: { "x-amzn-waf-action": "challenge" } });
		const result = await tools.web_fetch.execute("id", { url: PAGE }, undefined, undefined, ctx);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /got an AWS WAF challenge \(x-amzn-waf-action: challenge\).*This session has no browser tool/);
	});

	test("returns a normal page as is without probing it", async () => {
		documentText = ARTICLE_TEXT;
		page = () => assert.fail("a page with content is not probed");
		const result = await tools.web_fetch.execute("id", { url: PAGE }, undefined, undefined, ctx);
		assert.equal(result.isError, undefined);
		assert.equal(result.content[0].text, ARTICLE_TEXT);
		assert.equal(requests.length, 1);
	});
});
