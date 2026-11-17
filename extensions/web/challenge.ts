// Detects pages that only a real browser can read: bot challenges (AWS WAF, Cloudflare, DataDome,
// PerimeterX) and JavaScript-only shells. Anthropic's fetcher returns such a page as an empty or
// near-empty document (or as url_not_accessible), which web_fetch would otherwise pass on as the
// page, or have summarized as if it were the page.

/** A page as fetched over plain HTTP: what a non-browser client gets. `body` is undefined when not read (not HTML). */
export interface RawPage {
	status: number;
	headers: Headers;
	body?: string;
}

/** The fetched document as web_fetch sees it: its text, or the fetcher's error code. */
export interface FetchedPage {
	text?: string;
	error?: string;
}

/** Less text than this is no page content worth trusting without a closer look. */
export const THIN_TEXT = 200;
/** Challenge markers count only on pages with less text than this, not in an article that mentions them. */
export const MARKER_TEXT = 1000;
/** An HTML page this large with almost no text is a shell that renders its content with JavaScript. */
const SHELL_HTML_BYTES = 2048;
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_BYTES = 2 * 1024 * 1024;
const BROWSER_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Markers of challenge pages, in their HTML and in the text extracted from it. */
const CHALLENGE_MARKERS: { pattern: RegExp; name: string }[] = [
	{
		pattern:
			/challenges\.cloudflare\.com|cdn-cgi\/challenge-platform|_cf_chl_opt|just a moment\.\.\.|checking your browser before accessing|enable javascript and cookies to continue/i,
		name: "a Cloudflare challenge",
	},
	{ pattern: /awswaf|AwsWafIntegration|aws-waf-token/i, name: "an AWS WAF challenge" },
	{ pattern: /captcha-delivery\.com/i, name: "a DataDome challenge" },
	{ pattern: /px-captcha|perimeterx/i, name: "a PerimeterX challenge" },
];

const JAVASCRIPT_REQUIRED = /(enable|requires?|turn on)\s+javascript|javascript (is )?(required|disabled)/i;

/** The challenge whose marker the page's HTML or text shows, if any. */
export const challengeIn = (text: string) => CHALLENGE_MARKERS.find((m) => m.pattern.test(text))?.name;

/** The text a reader sees in an HTML page without running its scripts. */
export function visibleText(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(head|script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;|&#160;/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Why a plain HTTP client gets no content from this page, or undefined for a readable page. */
export function rawPageBlock(page: RawPage): string | undefined {
	const waf = page.headers.get("x-amzn-waf-action");
	if (waf) return `an AWS WAF challenge (x-amzn-waf-action: ${waf})`;
	if (page.headers.get("cf-mitigated") === "challenge") return "a Cloudflare challenge (cf-mitigated: challenge)";
	if (page.body === undefined) return undefined;
	if (page.body.trim() === "") return page.status === 202 ? "a bot challenge (HTTP 202 with an empty body)" : `an empty page (HTTP ${page.status})`;
	const text = visibleText(page.body);
	const marker = text.length < MARKER_TEXT && challengeIn(page.body);
	if (marker) return `${marker} (HTTP ${page.status})`;
	if (text.length >= THIN_TEXT || !/<html|<body|<script/i.test(page.body)) return undefined;
	const noscript = [...page.body.matchAll(/<noscript\b[^>]*>([\s\S]*?)<\/noscript\s*>/gi)].map((m) => m[1]).join(" ");
	if (JAVASCRIPT_REQUIRED.test(visibleText(noscript))) return "a page that requires JavaScript (its <noscript> says so)";
	if (page.body.length >= SHELL_HTML_BYTES) return `a JavaScript-only page (${page.body.length} bytes of HTML, ${text.length} characters of text)`;
	return undefined;
}

/** The document text without the front matter (title, meta tags) the fetcher puts first. */
export function documentBody(text: string): string {
	return text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

/** Why the fetcher's text of a page is no content, or undefined when it reads as content. */
export function documentBlock(text: string): string | undefined {
	const body = documentBody(text);
	const marker = body.length < MARKER_TEXT && challengeIn(text);
	if (marker) return marker;
	if (body.length >= THIN_TEXT) return undefined;
	if (body === "") return "a page with no text without JavaScript";
	if (JAVASCRIPT_REQUIRED.test(body)) return "a page that requires JavaScript";
	return undefined;
}

/** Fetches the page as a plain HTTP client to see the status, headers and HTML; undefined when that fails. */
export async function probePage(url: string, signal?: AbortSignal): Promise<RawPage | undefined> {
	const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			redirect: "follow",
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			headers: { "user-agent": BROWSER_USER_AGENT, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
		});
		const type = response.headers.get("content-type") ?? "";
		// Only HTML, plain text and empty bodies show a challenge; documents such as PDFs are not read.
		if ((type && !/html|text\/plain/i.test(type)) || Number(response.headers.get("content-length")) > PROBE_MAX_BYTES) {
			await response.body?.cancel();
			return { status: response.status, headers: response.headers };
		}
		return { status: response.status, headers: response.headers, body: (await response.text()).slice(0, PROBE_MAX_BYTES) };
	} catch (error) {
		if (signal?.aborted) throw error;
		return undefined;
	}
}

/**
 * Why the fetched page is no content and needs a real browser, or undefined when it is the page.
 * Only an inaccessible or thin document is probed: the probe shows the status and headers the
 * fetcher hides (an AWS WAF 202, a challenge header) and the HTML of a JavaScript shell.
 */
export async function pageBlock(url: string, page: FetchedPage, signal?: AbortSignal, probe = probePage): Promise<string | undefined> {
	const fromText = page.text === undefined ? undefined : documentBlock(page.text);
	const thin = page.text !== undefined && documentBody(page.text).length < THIN_TEXT;
	if (page.error !== "url_not_accessible" && !thin && !fromText) return undefined;
	const raw = await probe(url, signal);
	return (raw && rawPageBlock(raw)) ?? fromText;
}

export const PREVIEW_TOOLS = { open: "mcp__t3-code__preview_open", evaluate: "mcp__t3-code__preview_evaluate" };

/**
 * The error for a page that needs a real browser and that the fabric browser could not render
 * either. A tab left open holds a challenge the user can solve; otherwise the session's browser
 * tools are named when it has them.
 */
export function browserNeeded(url: string, reason: string, render: { message: string; tabOpen: boolean }, toolNames: readonly string[]): string {
	const head = `${url} needs a real browser: web_fetch got ${reason}, not the page content; curl and other plain HTTP clients get the same. Rendering it in the fabric browser failed: ${render.message}.`;
	if (render.tabOpen) {
		return `${head} The page stays open in the fabric browser window: ask the user to solve the challenge there, then call web_fetch again (the browser keeps the cookies).`;
	}
	if (toolNames.includes(PREVIEW_TOOLS.open) && toolNames.includes(PREVIEW_TOOLS.evaluate)) {
		return `${head} Open it with ${PREVIEW_TOOLS.open} (url) and read it with ${PREVIEW_TOOLS.evaluate} (expression: document.body.innerText).`;
	}
	return `${head} This session has no other browser tool: ask the user to open it in a browser and share the content.`;
}
