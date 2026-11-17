// Renders a page in the fabric browser (a real, visible Chrome driven over CDP), for the pages
// web_fetch can't read over plain HTTP: bot challenges and JavaScript-only shells. Each render
// gets a background tab of its own, so parallel fetches and the user's tabs don't collide.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { challengeIn, documentBlock, MARKER_TEXT, THIN_TEXT } from "./challenge.ts";

const execFileAsync = promisify(execFile);

export interface RenderedPage {
	url: string;
	title: string;
	text: string;
}

export interface RenderOptions {
	/** fabric's DevTools HTTP endpoint. */
	endpoint?: string;
	/** How long a challenge may take to clear and the page to render. */
	timeoutMs?: number;
}

const DEFAULT_ENDPOINT = process.env.FABRIC_ENDPOINT ?? "http://127.0.0.1:9222";
const RENDER_TIMEOUT_MS = 30_000;
const POLL_MS = 500;
/**
 * How long the text must stay the same before it counts as rendered. Chrome wakes the timers of a
 * background tab at most once a second, so a page still rendering can look unchanged for a second.
 */
const SETTLE_MS = 1_500;
/** A page shorter than THIN_TEXT counts after this long: a short page, not one still rendering. */
const SHORT_SETTLE_MS = 3_000;
const PROBE_TIMEOUT_MS = 5_000;
/** The first connection may wait for the browser to start, or for the user to allow remote debugging. */
const CONNECT_TIMEOUT_MS = 120_000;

/** Why the browser could not render the page; `tabOpen` when its tab stays open for the user to solve a challenge. */
export class RenderError extends Error {
	readonly tabOpen: boolean;
	constructor(message: string, tabOpen = false) {
		super(message);
		this.tabOpen = tabOpen;
	}
}

type Message = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string };

/** A minimal CDP client on one browser WebSocket, with flattened sessions. */
class Cdp {
	#id = 0;
	readonly #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

	readonly socket: WebSocket;

	private constructor(socket: WebSocket) {
		this.socket = socket;
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as Message;
			const pending = message.id === undefined ? undefined : this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id!);
			if (message.error) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result ?? {});
		});
		socket.addEventListener("close", () => {
			for (const pending of this.#pending.values()) pending.reject(new Error("the browser connection closed"));
			this.#pending.clear();
		});
	}

	static connect(url: string, signal: AbortSignal): Promise<Cdp> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(url);
			const fail = (error: Error) => {
				socket.close();
				reject(error);
			};
			const abort = () => fail(new Error(String(signal.reason ?? "aborted")));
			signal.addEventListener("abort", abort, { once: true });
			socket.addEventListener("open", () => {
				signal.removeEventListener("abort", abort);
				resolve(new Cdp(socket));
			});
			socket.addEventListener("error", () => fail(new Error(`cannot connect to ${url}`)));
		});
	}

	send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
		const id = ++this.#id;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}

	close() {
		this.socket.close();
	}
}

async function socketUrl(endpoint: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
	const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
	if (!response.ok) throw new Error(`${endpoint}/json/version answered HTTP ${response.status}`);
	const { webSocketDebuggerUrl } = (await response.json()) as { webSocketDebuggerUrl?: string };
	if (!webSocketDebuggerUrl) throw new Error(`${endpoint} published no browser WebSocket`);
	return webSocketDebuggerUrl;
}

/** The browser WebSocket of the running fabric browser, starting it with `fabric up` when none answers. */
async function browserSocket(endpoint: string, signal: AbortSignal): Promise<string> {
	try {
		return await socketUrl(endpoint, PROBE_TIMEOUT_MS, signal);
	} catch (error) {
		if (signal.aborted) throw error;
	}
	const fabric = process.env.FABRIC_BIN ?? "fabric";
	try {
		await execFileAsync(fabric, ["up"], { timeout: CONNECT_TIMEOUT_MS, signal });
	} catch (error) {
		if (signal.aborted) throw error;
		const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? `${fabric} is not installed (set FABRIC_BIN)` : `\`${fabric} up\` failed: ${(error as Error).message}`;
		throw new RenderError(reason);
	}
	return socketUrl(endpoint, CONNECT_TIMEOUT_MS, signal);
}

/** The page as a reader sees it now, with the start of its HTML, where a challenge in an iframe (DataDome) shows. */
const SNAPSHOT =
	"({ url: location.href, title: document.title, ready: document.readyState, text: document.body ? document.body.innerText : '', html: document.documentElement.outerHTML.slice(0, 50000) })";

type Snapshot = RenderedPage & { ready: string; html: string };

/** Why the snapshot is no content yet: a challenge, or an empty or JavaScript-only page (judged like the fetcher's document). */
const snapshotBlock = (page: Snapshot) =>
	(page.text.length < MARKER_TEXT && challengeIn(page.html)) || documentBlock(`---\ntitle: ${page.title}\n---\n\n${page.text}`);

/**
 * Opens the URL in a background tab of the fabric browser and returns its rendered text once a
 * challenge has cleared and the text has settled. A page still blocked at the timeout keeps its tab
 * open, so the user can solve the challenge in the visible window and the agent can fetch again.
 */
export async function renderPage(url: string, signal?: AbortSignal, options: RenderOptions = {}): Promise<RenderedPage> {
	const own = signal ?? new AbortController().signal;
	const cdp = await Cdp.connect(await browserSocket(options.endpoint ?? DEFAULT_ENDPOINT, own), own);
	let targetId: string | undefined;
	let keepTab = false;
	try {
		({ targetId } = await cdp.send("Target.createTarget", { url: "about:blank", background: true }));
		const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
		const navigation = await cdp.send("Page.navigate", { url }, sessionId);
		if (navigation.errorText) throw new RenderError(`the browser could not load the page: ${navigation.errorText}`);
		const timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;
		const deadline = Date.now() + timeoutMs;
		let last: Snapshot | undefined;
		let stableSince = Date.now();
		while (true) {
			own.throwIfAborted();
			// A challenge that reloads the page destroys the context mid-evaluation; the next poll reads the new page.
			const snapshot = await cdp
				.send("Runtime.evaluate", { expression: SNAPSHOT, returnByValue: true }, sessionId)
				.then((reply) => reply.result?.value as Snapshot | undefined, () => undefined);
			if (snapshot) {
				if (snapshot.text !== last?.text || snapshot.url !== last?.url) stableSince = Date.now();
				last = snapshot;
				const settled = Date.now() - stableSince;
				if (snapshot.ready === "complete" && !snapshotBlock(snapshot)) {
					if (settled >= (snapshot.text.length >= THIN_TEXT ? SETTLE_MS : SHORT_SETTLE_MS)) {
						return { url: snapshot.url, title: snapshot.title, text: snapshot.text };
					}
				}
			}
			if (Date.now() >= deadline) {
				keepTab = true;
				const reason = last ? (snapshotBlock(last) ?? "a page that did not finish loading") : "no page";
				throw new RenderError(`the fabric browser still showed ${reason} after ${Math.round(timeoutMs / 1000)} s`, true);
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
	} finally {
		if (targetId && !keepTab) await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
		cdp.close();
	}
}
