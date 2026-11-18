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
import { RenderError } from "../extensions/web/browser.ts";
import { fetchedDocument, formatSearch, registerWeb, searchResults } from "../extensions/web/index.ts";
import { pdfText } from "../extensions/web/pdf.ts";

/** A minimal PDF with one Helvetica text line per entry, one page per array. */
function pdf(pages: string[][]): Buffer {
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(" ")}] /Count ${pages.length} >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	pages.forEach((lines, i) => {
		const stream = `BT /F1 10 Tf 12 TL 40 800 Td ${lines.map((line) => `(${line.replace(/[\\()]/g, "\\$&")}) Tj T*`).join(" ")} ET`;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`,
			`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		);
	});
	let out = "%PDF-1.4\n";
	const offsets = objects.map((object, i) => {
		const offset = out.length;
		out += `${i + 1} 0 obj\n${object}\nendobj\n`;
		return offset;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}
const noPdftotext = !(await pdfText(pdf([["probe"]])).then(
	() => true,
	() => false,
)) && "pdftotext is not installed";

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
	assert.deepEqual(fetchedDocument([pdf]), { url: "https://example.com/", text: undefined, pdf: "JVBER" });
	const image = { ...page, content: { ...page.content, content: { type: "document", source: { type: "base64", media_type: "image/png", data: "iVBOR" } } } };
	assert.deepEqual(fetchedDocument([image]), { url: "https://example.com/", text: undefined });
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

test("after a failed render, points to the open tab or names the session's browser tools only when it has them", () => {
	const failed = { message: "fabric is not installed (set FABRIC_BIN)", tabOpen: false };
	const both = browserNeeded("https://x.test/", "a Cloudflare challenge", failed, [PREVIEW_TOOLS.open, PREVIEW_TOOLS.evaluate, "read"]);
	assert.match(both, /^https:\/\/x\.test\/ needs a real browser: web_fetch got a Cloudflare challenge, not the page content/);
	assert.match(both, /Rendering it in the fabric browser failed: fabric is not installed \(set FABRIC_BIN\)\./);
	assert.match(both, /Open it with mcp__t3-code__preview_open \(url\) and read it with mcp__t3-code__preview_evaluate \(expression: document\.body\.innerText\)\.$/);
	for (const tools of [[], ["read"], [PREVIEW_TOOLS.open]]) {
		const text = browserNeeded("https://x.test/", "a Cloudflare challenge", failed, tools);
		assert.doesNotMatch(text, /preview/);
		assert.match(text, /This session has no other browser tool/);
	}
	// A challenge left open in the browser beats the preview tools: the user solves it there.
	const open = browserNeeded("https://x.test/", "a Cloudflare challenge", { message: "still a challenge", tabOpen: true }, [PREVIEW_TOOLS.open, PREVIEW_TOOLS.evaluate]);
	assert.match(open, /stays open in the fabric browser window: ask the user to solve the challenge there, then call web_fetch again/);
	assert.doesNotMatch(open, /preview/);
});

describe("web_fetch tool", () => {
	const PAGE = "https://curia.europa.eu/juris/liste.jsf?num=C-311/18";
	const realFetch = globalThis.fetch;
	let page: () => Response;
	let documentText: string;
	/** The fetched document's source, when not the text documentText. */
	let documentSource: Record<string, string> | undefined;
	let answerText: string;
	const requests: { url: string; headers?: Record<string, string>; body?: any }[] = [];
	const pdfBin = process.env.PDFTOTEXT_BIN;
	const tools: Record<string, any> = {};
	let toolNames: string[] = [];
	let render: (url: string) => Promise<{ url: string; title: string; text: string }>;
	const rendered: string[] = [];
	registerWeb({ registerTool: (tool: any) => (tools[tool.name] = tool), getAllTools: () => toolNames.map((name) => ({ name })) } as any, async (url) => {
		rendered.push(url);
		return render(url);
	});
	const RENDERED = { url: PAGE, title: "Judgment C-311/18", text: `Paragraph 1. ${"The Court rules on the transfer of personal data. ".repeat(10)}` };
	const model = { id: "claude-haiku-5-5", provider: "anthropic", baseUrl: "https://api.test", cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } };
	const ctx = { modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) } };

	beforeEach(() => {
		requests.length = 0;
		rendered.length = 0;
		toolNames = [];
		documentSource = undefined;
		answerText = "The page does not contain the judgment.";
		render = async () => RENDERED;
		globalThis.fetch = (async (input: string, init?: RequestInit) => {
			const url = String(input);
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			requests.push({ url, headers: init?.headers as Record<string, string> | undefined, body });
			if (url !== "https://api.test/v1/messages") return page();
			// The answer about a rendered page: a plain request without the fetch tool.
			if (!body.tools) return Response.json({ content: [{ type: "text", text: "Paragraph 1 reads: The Court rules." }], stop_reason: "end_turn", usage: { input_tokens: 2000, output_tokens: 20 } });
			const content = [
				{ type: "server_tool_use", id: "f", name: "web_fetch", input: { url: PAGE } },
				{
					type: "web_fetch_tool_result",
					tool_use_id: "f",
					content: {
						type: "web_fetch_result",
						url: PAGE,
						retrieved_at: "2026-11-18T02:09:50+00:00",
						content: { type: "document", source: documentSource ?? { type: "text", media_type: "text/plain", data: documentText } },
					},
				},
				{ type: "text", text: answerText },
			];
			return Response.json({ content, stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10 } });
		}) as typeof fetch;
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
		if (pdfBin === undefined) delete process.env.PDFTOTEXT_BIN;
		else process.env.PDFTOTEXT_BIN = pdfBin;
	});

	const pdfSource = (bytes: Buffer) => ({ type: "base64", media_type: "application/pdf", data: bytes.toString("base64") });
	const READINESS = [
		["E-EVIDENCE PACKAGE: STATE OF READINESS", "Last updated: 6 November 2026", "1. FINLAND", "Issuing: ready (EPOC)"],
		["7. LITHUANIA", "Receiving: ready (EPOC-PR)"],
	];

	test("fetches fresh: the cache-bypassing tool version, called directly, without a beta header", async () => {
		documentText = ARTICLE_TEXT;
		await tools.web_fetch.execute("id", { url: PAGE }, undefined, undefined, ctx);
		assert.deepEqual(requests[0].body.tools, [
			{ type: "web_fetch_20260309", name: "web_fetch", max_uses: 2, max_content_tokens: 100_000, use_cache: false, allowed_callers: ["direct"] },
		]);
		assert.equal(requests[0].headers?.["anthropic-beta"], undefined);
		assert.equal(requests[0].headers?.["x-api-key"], "k");
	});

	test("returns a PDF's text itself without a prompt", { skip: noPdftotext }, async () => {
		documentSource = pdfSource(pdf(READINESS));
		page = () => assert.fail("a PDF is not probed");
		const result = await tools.web_fetch.execute("id", { url: PAGE }, undefined, undefined, ctx);
		assert.equal(result.isError, undefined);
		const text: string = result.content[0].text;
		assert.match(text, /^E-EVIDENCE PACKAGE: STATE OF READINESS\n+Last updated: 6 November 2026\n+1\. FINLAND\n+Issuing: ready \(EPOC\)\n+7\. LITHUANIA\n+Receiving: ready \(EPOC-PR\)$/);
		assert.doesNotMatch(text, /[ \t]$|\f/m);
		assert.deepEqual(result.details, { url: PAGE, rendered: false, pdf: true });
		assert.equal(requests.length, 1);
		assert.equal(requests[0].body.system, "Fetch the URL. Then reply with only: done.");
	});

	test("truncates a long PDF's text like a page", { skip: noPdftotext }, async () => {
		const lines = Array.from({ length: 3000 }, (_, i) => `Line ${i + 1} of the readiness table`);
		documentSource = pdfSource(pdf(Array.from({ length: 50 }, (_, p) => lines.slice(p * 60, p * 60 + 60))));
		const result = await tools.web_fetch.execute("id", { url: PAGE }, undefined, undefined, ctx);
		const text: string = result.content[0].text;
		assert.match(text, /^Line 1 of the readiness table\n/);
		assert.match(text, /\n\n\[Truncated: showing \d+ of \d+ lines\. For the rest, pass a prompt that names the part you need/);
		assert.doesNotMatch(text, /Line 3000 of/);
		assert.ok(Buffer.byteLength(text) < 52 * 1024);
	});

	test("answers a prompt about a PDF from the fetched PDF, without extracting it", async () => {
		process.env.PDFTOTEXT_BIN = "/nonexistent/pdftotext";
		documentSource = pdfSource(pdf(READINESS));
		answerText = 'The document says "Last updated: 6 November 2026"; Finland and Lithuania are listed.';
		const result = await tools.web_fetch.execute("id", { url: PAGE, prompt: "Which states are ready, and when was it updated?" }, undefined, undefined, ctx);
		assert.equal(result.isError, undefined);
		assert.equal(result.content[0].text, `${answerText}\n\nSource: ${PAGE}`);
		assert.deepEqual(result.details, { url: PAGE, rendered: false, pdf: true });
		assert.match(requests[0].body.system, /dates exactly as the document states them \(including its own date, such as "last updated"/);
		assert.equal(requests[0].body.messages[0].content, `Fetch ${PAGE}\n\nRequest: Which states are ready, and when was it updated?`);
	});

	test("reports a corrupt PDF", { skip: noPdftotext }, async () => {
		documentSource = pdfSource(Buffer.from("%PDF-1.4\nthis is not a PDF body"));
		const result = await tools.web_fetch.execute("id", { url: PAGE }, undefined, undefined, ctx);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /^Could not extract the text of the PDF https:\/\/curia\S+: pdftotext could not read the PDF: .+\. Pass a prompt to have the model read the PDF instead\.$/);
		assert.ok(result.usage.cost.total > 0);
	});

	test("reports a missing pdftotext with how to install it", async () => {
		process.env.PDFTOTEXT_BIN = "/nonexistent/pdftotext";
		documentSource = pdfSource(pdf(READINESS));
		const result = await tools.web_fetch.execute("id", { url: PAGE }, undefined, undefined, ctx);
		assert.equal(result.isError, true);
		assert.match(
			result.content[0].text,
			/: pdftotext is not installed \(tried \/nonexistent\/pdftotext\); install poppler \(brew install poppler, apt install poppler-utils\) or set PDFTOTEXT_BIN\. Pass a prompt/,
		);
	});

	test("says when a PDF has no text layer", { skip: noPdftotext }, async () => {
		documentSource = pdfSource(pdf([[]]));
		const result = await tools.web_fetch.execute("id", { url: PAGE }, undefined, undefined, ctx);
		assert.equal(result.isError, undefined);
		assert.equal(result.content[0].text, `The PDF ${PAGE} has no text layer (a scanned document?). Pass a prompt to have the model read its pages.`);
	});

	test("an abort while extracting a PDF ends the call", { skip: noPdftotext }, async () => {
		documentSource = pdfSource(pdf(READINESS));
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(tools.web_fetch.execute("id", { url: PAGE }, controller.signal, undefined, ctx), { name: "AbortError" });
	});

	test("still asks for a prompt for a non-PDF binary document", async () => {
		documentSource = { type: "base64", media_type: "image/png", data: "iVBOR" };
		const result = await tools.web_fetch.execute("id", { url: PAGE }, undefined, undefined, ctx);
		assert.equal(result.content[0].text, `${PAGE} is not a text document; pass a prompt to read it.`);
	});

	test("answers the prompt from the page rendered in the browser, not from the empty shell", async () => {
		documentText = CURIA_TEXT;
		page = () => new Response(fixture("js-shell.html"), { headers: html });
		const result = await tools.web_fetch.execute("id", { url: PAGE, prompt: "Quote paragraph 1 verbatim" }, undefined, undefined, ctx);
		assert.equal(result.isError, undefined);
		assert.equal(result.content[0].text, `Paragraph 1 reads: The Court rules.\n\nSource: ${PAGE} (rendered in a browser)`);
		assert.deepEqual(rendered, [PAGE]);
		assert.deepEqual(requests.map((r) => r.url), ["https://api.test/v1/messages", PAGE, "https://api.test/v1/messages"]);
		assert.match(requests[0].body.system, /^You read web pages.*Fetch the URL, then answer.*verbatim and complete, without summarizing/);
		const answer = requests[2].body;
		assert.equal(answer.tools, undefined);
		assert.match(answer.system, /^You read web pages for a coding agent\. Answer the request.*verbatim and complete/);
		assert.match(answer.messages[0].content, /^The page https:\/\/curia\.europa\.eu\/\S+, rendered in a browser:\n\n<page>\n# Judgment C-311\/18\n\nParagraph 1\. The Court rules/);
		assert.match(answer.messages[0].content, /<\/page>\n\nRequest: Quote paragraph 1 verbatim$/);
		// Both requests count: 100 + 2000 input tokens at $1/M, 10 + 20 output at $5/M.
		assert.equal(result.usage.input, 2100);
		assert.equal(result.usage.output, 30);
		assert.ok(Math.abs(result.usage.cost.total - (2100 * 1 + 30 * 5) / 1e6) < 1e-12);
		assert.deepEqual(result.details, { url: PAGE, rendered: true });
	});

	test("returns the rendered text itself without a prompt", async () => {
		documentText = "";
		page = () => new Response(null, { status: 202, headers: { "x-amzn-waf-action": "challenge" } });
		render = async () => ({ ...RENDERED, url: `${PAGE}&after-challenge` });
		const result = await tools.web_fetch.execute("id", { url: PAGE }, undefined, undefined, ctx);
		assert.equal(result.isError, undefined);
		assert.equal(result.content[0].text, `# ${RENDERED.title}\n\n${RENDERED.text}`);
		assert.deepEqual(result.details, { url: `${PAGE}&after-challenge`, rendered: true });
		assert.equal(requests.filter((r) => r.url === "https://api.test/v1/messages").length, 1);
	});

	test("caps the rendered text sent to the model", async () => {
		documentText = CURIA_TEXT;
		page = () => new Response(fixture("js-shell.html"), { headers: html });
		render = async () => ({ ...RENDERED, title: "", text: "x".repeat(1_000_000) });
		await tools.web_fetch.execute("id", { url: PAGE, prompt: "anything" }, undefined, undefined, ctx);
		const content: string = requests[2].body.messages[0].content;
		assert.equal(content.match(/x+/)![0].length, 400_000);
	});

	test("reports the AWS WAF challenge when the browser can't get through, naming the preview tools", async () => {
		documentText = "";
		page = () => new Response(null, { status: 202, headers: { "x-amzn-waf-action": "challenge" } });
		render = async () => {
			throw new RenderError("fabric is not installed (set FABRIC_BIN)");
		};
		toolNames = [PREVIEW_TOOLS.open, PREVIEW_TOOLS.evaluate];
		const result = await tools.web_fetch.execute("id", { url: PAGE, prompt: "Quote paragraph 1" }, undefined, undefined, ctx);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /got an AWS WAF challenge \(x-amzn-waf-action: challenge\).*failed: fabric is not installed.*Open it with mcp__t3-code__preview_open/);
		assert.doesNotMatch(result.content[0].text, /does not contain/);
		assert.deepEqual(result.details.render, { message: "fabric is not installed (set FABRIC_BIN)", tabOpen: false });
		assert.ok(result.usage.cost.total > 0);
	});

	test("points to the open tab when a challenge stays in the browser", async () => {
		documentText = CLOUDFLARE_TEXT;
		page = () => new Response(fixture("cloudflare-challenge.html"), { status: 403, headers: html });
		render = async () => {
			throw new RenderError("the fabric browser still showed a Cloudflare challenge after 30 s", true);
		};
		const result = await tools.web_fetch.execute("id", { url: PAGE }, undefined, undefined, ctx);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /still showed a Cloudflare challenge after 30 s\. The page stays open in the fabric browser window/);
	});

	test("an abort while rendering ends the call", async () => {
		documentText = CURIA_TEXT;
		page = () => new Response(fixture("js-shell.html"), { headers: html });
		const controller = new AbortController();
		render = async () => {
			controller.abort();
			throw new Error("aborted");
		};
		await assert.rejects(tools.web_fetch.execute("id", { url: PAGE }, controller.signal, undefined, ctx), /aborted/);
	});

	test("returns a normal page as is without probing it", async () => {
		documentText = ARTICLE_TEXT;
		page = () => assert.fail("a page with content is not probed");
		render = () => assert.fail("a page with content is not rendered");
		const result = await tools.web_fetch.execute("id", { url: PAGE }, undefined, undefined, ctx);
		assert.equal(result.isError, undefined);
		assert.equal(result.content[0].text, ARTICLE_TEXT);
		assert.deepEqual(result.details, { url: PAGE, rendered: false });
		assert.equal(requests.length, 1);
	});
});
