// renderPage against a real Chrome through the fabric endpoint. Needs fabric and a display, so it
// runs only with FABRIC_E2E=1: `FABRIC_E2E=1 node --test test/web-browser.test.ts`.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { RenderError, renderPage } from "../extensions/web/browser.ts";

const ARTICLE = `<h1>Article 4</h1><p>${"‘personal data’ means any information relating to an identified or identifiable natural person. ".repeat(5)}</p>`;
const CHALLENGE = (script: string) =>
	`<!doctype html><html><head><title>Just a moment...</title></head><body><p>Enable JavaScript and cookies to continue</p><script>${script}</script></body></html>`;

const pages: Record<string, ((cookie: string) => string) | undefined> = {
	// A JavaScript shell that renders its content after a while.
	"/spa": () => `<!doctype html><html><head><title>SPA</title></head><body><div id="root"></div><script>setTimeout(() => { document.getElementById("root").innerHTML = ${JSON.stringify(ARTICLE)}; }, 800);</script></body></html>`,
	// A challenge that sets a clearance cookie and reloads, like Cloudflare's.
	"/challenge": (cookie) =>
		cookie.includes("clearance=1")
			? `<!doctype html><html><head><title>Cleared</title></head><body>${ARTICLE}</body></html>`
			: CHALLENGE(`setTimeout(() => { document.cookie = "clearance=1; path=/"; location.reload(); }, 1200);`),
	"/stuck": () => CHALLENGE(""),
	// DataDome: the challenge is an iframe; the page itself has no text and only the HTML names it.
	"/datadome": () =>
		`<!doctype html><html><head><title>example.test</title></head><body><script>var dd={'host':'geo.captcha-delivery.com'}</script><iframe src="about:blank" title="DataDome CAPTCHA"></iframe></body></html>`,
	// A short page that is complete: it counts once its text stayed the same.
	"/short": () => `<!doctype html><html><head><title>Short</title></head><body><p>Hello there.</p></body></html>`,
	// A page that grows past the first stable poll: the full text is returned, not the first part.
	"/growing": () =>
		`<!doctype html><html><body><div id="a">${ARTICLE}</div><script>let n = 0; const t = setInterval(() => { document.getElementById("a").insertAdjacentHTML("beforeend", "<p>more " + n + "</p>"); if (++n === 3) clearInterval(t); }, 100);</script></body></html>`,
};

const endpoint = process.env.FABRIC_ENDPOINT ?? "http://127.0.0.1:9222";

async function targets(): Promise<{ id: string; url: string }[]> {
	return (await (await fetch(`${endpoint}/json/list`)).json()) as { id: string; url: string }[];
}

describe("renderPage in the fabric browser", { skip: process.env.FABRIC_E2E !== "1" && "set FABRIC_E2E=1 to run against a real browser" }, () => {
	let server: Server;
	let base: string;
	before(async () => {
		server = createServer((request, response) => {
			const path = new URL(request.url!, "http://x").pathname;
			const page = pages[path];
			response.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
			response.end(page ? page(request.headers.cookie ?? "") : "not found");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	// Chrome keeps its connections alive; close them so the server stops.
	after(() => {
		server.closeAllConnections();
		server.close();
	});

	test("renders a JavaScript-only page and closes its tab", async () => {
		const page = await renderPage(`${base}/spa`);
		assert.equal(page.url, `${base}/spa`);
		assert.equal(page.title, "SPA");
		assert.match(page.text, /^Article 4\n/);
		assert.ok(page.text.length > 400);
		assert.ok(!(await targets()).some((target) => target.url.startsWith(base)), "the tab is closed");
	});

	test("waits through a challenge that reloads the page", async () => {
		const page = await renderPage(`${base}/challenge`);
		assert.equal(page.title, "Cleared");
		assert.match(page.text, /personal data/);
		assert.doesNotMatch(page.text, /Enable JavaScript/);
	});

	test("returns a short complete page once it settled", async () => {
		const started = Date.now();
		const page = await renderPage(`${base}/short`);
		assert.equal(page.text, "Hello there.");
		assert.ok(Date.now() - started >= 3000, "a short page waits until it settled");
	});

	test("returns the whole text of a page still growing at first, in a background tab with throttled timers", async () => {
		const page = await renderPage(`${base}/growing`);
		assert.match(page.text, /more 0\n\nmore 1\n\nmore 2$/);
	});

	test("keeps the tab of a challenge that does not clear open for the user", async () => {
		const error = await renderPage(`${base}/stuck`, undefined, { timeoutMs: 3000 }).catch((e) => e);
		assert.ok(error instanceof RenderError);
		assert.equal(error.tabOpen, true);
		assert.equal(error.message, "the fabric browser still showed a Cloudflare challenge after 3 s");
		const open = (await targets()).filter((target) => target.url === `${base}/stuck`);
		assert.equal(open.length, 1);
		await fetch(`${endpoint}/json/close/${open[0].id}`);
	});

	test("names a DataDome challenge that only the HTML shows, keeping its tab open", async () => {
		const error = await renderPage(`${base}/datadome`, undefined, { timeoutMs: 2000 }).catch((e) => e);
		assert.ok(error instanceof RenderError);
		assert.equal(error.message, "the fabric browser still showed a DataDome challenge after 2 s");
		assert.equal(error.tabOpen, true);
		const open = (await targets()).filter((target) => target.url === `${base}/datadome`);
		assert.equal(open.length, 1);
		await fetch(`${endpoint}/json/close/${open[0].id}`);
	});

	test("reports a page the browser cannot load and closes its tab", async () => {
		// A port that was just free: nothing listens there.
		const probe = createServer();
		await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
		const closed = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/`;
		await new Promise((resolve) => probe.close(resolve));
		const error = await renderPage(closed).catch((e) => e);
		assert.ok(error instanceof RenderError);
		assert.equal(error.message, "the browser could not load the page: net::ERR_CONNECTION_REFUSED");
		assert.equal(error.tabOpen, false);
		assert.ok(!(await targets()).some((target) => target.url.startsWith(closed)));
	});

	test("an abort ends the render and closes its tab", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(new Error("stop")), 500);
		await assert.rejects(renderPage(`${base}/stuck`, controller.signal, { timeoutMs: 10_000 }), /stop/);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.ok(!(await targets()).some((target) => target.url === `${base}/stuck`));
	});

	test("renders pages in parallel, each in its own tab", async () => {
		const results = await Promise.all([renderPage(`${base}/spa`), renderPage(`${base}/challenge`), renderPage(`${base}/spa`)]);
		assert.deepEqual(results.map((page) => page.title), ["SPA", "Cleared", "SPA"]);
	});

	test("reports a missing fabric binary when no browser answers", async () => {
		const previous = process.env.FABRIC_BIN;
		process.env.FABRIC_BIN = "/nonexistent/fabric";
		try {
			const error = await renderPage(`${base}/spa`, undefined, { endpoint: "http://127.0.0.1:1" }).catch((e) => e);
			assert.ok(error instanceof RenderError);
			assert.equal(error.message, "/nonexistent/fabric is not installed (set FABRIC_BIN)");
		} finally {
			if (previous === undefined) delete process.env.FABRIC_BIN;
			else process.env.FABRIC_BIN = previous;
		}
	});
});
