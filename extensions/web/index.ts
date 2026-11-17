// web_search and web_fetch through Anthropic's server tools, passed through by the gateway.
//
// Pi keeps no server-tool blocks (server_tool_use, *_tool_result, citations) in its messages,
// so the session model can't hold these tools itself. Like Claude Code's WebSearch, each call
// is its own small Messages request with the server tool; the tool returns the findings as text
// and reports the request's usage, so it counts in session cost and the harness metrics. This
// works whatever model the session runs on.

import { calculateCost } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { browserNeeded, pageBlock } from "./challenge.ts";

export const WEB_MODEL = { provider: "anthropic", id: "claude-haiku-5-5" };
// Anthropic bills web search per request; tokens are billed as usual.
const SEARCH_REQUEST_COST = 10 / 1000;
const MAX_CONTINUATIONS = 4;
const MAX_FETCH_TOKENS = 100_000;

type Block = Record<string, any>;

export interface ServerToolReply {
	content: Block[];
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; searches: number };
}

async function serverToolRequest(
	ctx: ExtensionContext,
	tool: Block,
	system: string,
	prompt: string,
	signal: AbortSignal | undefined,
	beta?: string,
): Promise<ServerToolReply> {
	const model = ctx.modelRegistry.find(WEB_MODEL.provider, WEB_MODEL.id);
	if (!model) throw new Error(`model ${WEB_MODEL.provider}/${WEB_MODEL.id} is not configured`);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	const base = (auth.baseUrl ?? model.baseUrl).replace(/\/+$/, "");
	const messages: Block[] = [{ role: "user", content: prompt }];
	const reply: ServerToolReply = { content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, searches: 0 } };
	// A long server-tool loop pauses the turn; sending the reply back resumes it.
	for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
		const response = await fetch(`${base}/v1/messages`, {
			method: "POST",
			signal,
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				...(auth.apiKey ? { "x-api-key": auth.apiKey } : {}),
				...(beta ? { "anthropic-beta": beta } : {}),
				...(auth.headers as Record<string, string> | undefined),
			},
			body: JSON.stringify({ model: model.id, max_tokens: 4096, system, tools: [tool], messages }),
		});
		const body = (await response.json()) as Block;
		if (!response.ok) throw new Error(`${tool.name} request failed: HTTP ${response.status} ${JSON.stringify(body.error ?? body).slice(0, 500)}`);
		reply.content.push(...body.content);
		const u = body.usage ?? {};
		reply.usage.input += u.input_tokens ?? 0;
		reply.usage.output += u.output_tokens ?? 0;
		reply.usage.cacheRead += u.cache_read_input_tokens ?? 0;
		reply.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
		reply.usage.searches += u.server_tool_use?.web_search_requests ?? 0;
		if (body.stop_reason !== "pause_turn") break;
		messages.push({ role: "assistant", content: body.content });
	}
	return reply;
}

/** Pi usage for a server-tool reply, priced like the model plus the per-search fee. */
function piUsage(ctx: ExtensionContext, reply: ServerToolReply) {
	const model = ctx.modelRegistry.find(WEB_MODEL.provider, WEB_MODEL.id)!;
	const { searches, ...tokens } = reply.usage;
	const usage = {
		...tokens,
		totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	usage.cost.input += searches * SEARCH_REQUEST_COST;
	usage.cost.total += searches * SEARCH_REQUEST_COST;
	return usage;
}

const textOf = (content: Block[]) =>
	content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("")
		.trim();

/** The search results and errors in a reply. */
export function searchResults(content: Block[]): { results: { title: string; url: string; age?: string }[]; errors: string[] } {
	const results: { title: string; url: string; age?: string }[] = [];
	const errors: string[] = [];
	for (const block of content) {
		if (block.type !== "web_search_tool_result") continue;
		if (Array.isArray(block.content)) {
			for (const r of block.content) if (r.type === "web_search_result") results.push({ title: r.title, url: r.url, age: r.page_age ?? undefined });
		} else if (block.content?.error_code) errors.push(block.content.error_code);
	}
	return { results, errors };
}

export function formatSearch(query: string, content: Block[]): { text: string; isError: boolean } {
	const { results, errors } = searchResults(content);
	const seen = new Set<string>();
	const sources = results.filter((r) => !seen.has(r.url) && seen.add(r.url));
	if (sources.length === 0) {
		return { text: `Web search for "${query}" found nothing${errors.length ? ` (${errors.join(", ")})` : ""}.`, isError: errors.length > 0 };
	}
	const list = sources.map((r) => `- ${r.title} — ${r.url}${r.age ? ` (${r.age})` : ""}`).join("\n");
	return { text: `${textOf(content)}\n\nSources:\n${list}`, isError: false };
}

/** The fetched document and the answer about it, or the fetch error. */
export function fetchedDocument(content: Block[]): { url?: string; text?: string; error?: string } {
	for (const block of content) {
		if (block.type !== "web_fetch_tool_result") continue;
		const result = block.content ?? {};
		if (result.type === "web_fetch_tool_result_error" || result.error_code) return { error: result.error_code ?? "unknown error" };
		const source = result.content?.source ?? {};
		return { url: result.url, text: source.type === "text" ? source.data : undefined };
	}
	return { error: "the page was not fetched" };
}

const searchParameters = Type.Object({
	query: Type.String({ description: "What to search for." }),
	allowed_domains: Type.Optional(Type.Array(Type.String(), { description: "Only return results from these domains." })),
	blocked_domains: Type.Optional(Type.Array(Type.String(), { description: "Never return results from these domains." })),
});

const fetchParameters = Type.Object({
	url: Type.String({ description: "The http(s) URL to fetch. It must come from the user, an earlier search or fetch result, or a file in the workspace." }),
	prompt: Type.Optional(
		Type.String({
			description:
				"What to extract from the page; the answer quotes the page verbatim when the request asks for exact text. Omit it to get the page text itself (truncated if long).",
		}),
	),
});

export default function web(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description:
			"Search the web for current information: documentation, releases, error messages, known issues. Returns a short summary of what the results say and the source URLs. Use web_fetch to read a source in full.",
		promptSnippet: "Search the web; returns findings with source URLs",
		parameters: searchParameters,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const tool = {
				type: "web_search_20250305",
				name: "web_search",
				max_uses: 3,
				...(params.allowed_domains?.length ? { allowed_domains: params.allowed_domains } : {}),
				...(params.blocked_domains?.length ? { blocked_domains: params.blocked_domains } : {}),
			};
			const reply = await serverToolRequest(
				ctx,
				tool,
				"You search the web for a coding agent. Search for the query, then report what the results say about it: concrete facts, versions, dates and code, each with its source URL. Be concise. Do not answer from memory.",
				`Search the web for: ${params.query}`,
				signal,
			);
			const { text, isError } = formatSearch(params.query, reply.content);
			return { content: [{ type: "text", text }], details: searchResults(reply.content), usage: piUsage(ctx, reply), isError };
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web fetch",
		description:
			"Fetch a web page or PDF by URL. Without a prompt, returns the page text itself: use that when you need exact wording (statutes, specs, code). With a prompt, returns an answer extracted from the page. Only fetches URLs that came from the user, a search or fetch result, or the workspace. A page behind a bot challenge or rendered only by JavaScript returns an error that says so; it needs a real browser.",
		promptSnippet: "Fetch a URL and read it or answer a question about it",
		parameters: fetchParameters,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const tool = { type: "web_fetch_20250910", name: "web_fetch", max_uses: 2, max_content_tokens: MAX_FETCH_TOKENS };
			const reply = await serverToolRequest(
				ctx,
				tool,
				params.prompt
					? "You read web pages for a coding agent. Fetch the URL, then answer the request from the page's content only, quoting code and exact values. When the request asks for the exact, full or verbatim text of a part of the page, reproduce that part verbatim and complete, without summarizing or paraphrasing. Say so when the page doesn't answer it."
					: "Fetch the URL. Then reply with only: done.",
				params.prompt ? `Fetch ${params.url}\n\nRequest: ${params.prompt}` : `Fetch ${params.url}`,
				signal,
				"web-fetch-2025-09-10",
			);
			const usage = piUsage(ctx, reply);
			const document = fetchedDocument(reply.content);
			const blocked = await pageBlock(params.url, document, signal);
			if (blocked) {
				const text = browserNeeded(document.url ?? params.url, blocked, pi.getAllTools().map((tool) => tool.name));
				return { content: [{ type: "text", text }], details: { ...document, blocked }, usage, isError: true };
			}
			if (document.error) {
				return { content: [{ type: "text", text: `Could not fetch ${params.url}: ${document.error}` }], details: document, usage, isError: true };
			}
			let text: string;
			if (params.prompt) text = `${textOf(reply.content)}\n\nSource: ${document.url ?? params.url}`;
			else if (document.text === undefined) text = `${document.url ?? params.url} is not a text document; pass a prompt to read it.`;
			else {
				const truncated = truncateHead(document.text);
				text = truncated.truncated
					? `${truncated.content}\n\n[Truncated: showing ${truncated.outputLines} of ${truncated.totalLines} lines. For the rest, pass a prompt that names the part you need (asking for its verbatim text if you need the exact wording).]`
					: document.text;
			}
			return { content: [{ type: "text", text }], details: { url: document.url ?? params.url }, usage };
		},
	});
}
