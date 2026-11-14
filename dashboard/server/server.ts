// The usage dashboard's server: node:http on every interface (this machine and its LAN), the JSON
// API under /api/ and the built frontend (dashboard/dist) for every other path.
//
// Workflow runs have pages of their own under /workflows, updated live (workflows.ts).
//
// It indexes Pi's sessions on start and on POST /api/refresh, in a worker; Claude Code
// transcripts are imported only once a refresh asks for a source that includes them. Responses
// are cached per URL until the next index completes.

import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SOURCES, type Source } from "../../extensions/metrics/queries/index.ts";
import { CLAUDE_PROJECTS, metricsPath, needsClaude } from "../../extensions/metrics/stats.ts";
import { RELEASE } from "../../extensions/lib/repository.ts";
import { openStore } from "../../extensions/metrics/store.ts";
import { ApiError, route } from "./api.ts";
import { handleWorkflows } from "./workflows.ts";

export const APP = "pi-harness-dashboard";
export const DEFAULT_PORT = 4317;
/** Where this machine reaches the server; it listens on every interface. */
export const HOST = "127.0.0.1";

/**
 * Whether a Host header names this server: an IP address, localhost, or this machine's own name.
 * Any other name could be a page on another site that rebound its DNS to us.
 */
export function allowedHost(header: string, machine = hostname()): boolean {
	const name = header.toLowerCase().replace(/:\d+$/, "");
	if (name.startsWith("[") && name.endsWith("]")) return isIP(name.slice(1, -1)) === 6;
	const own = machine.toLowerCase().replace(/\.local$/, "");
	return isIP(name) === 4 || name === "localhost" || name === own || name === `${own}.local`;
}

/** The dashboard's URLs on this machine's external IPv4 addresses (LAN, VPN). */
export function lanUrls(port: number, interfaces = networkInterfaces()): string[] {
	return Object.values(interfaces)
		.flatMap((addresses) => addresses ?? [])
		.filter((address) => address.family === "IPv4" && !address.internal)
		.map((address) => `http://${address.address}:${port}`);
}
export const DIST = fileURLToPath(new URL("../dist", import.meta.url));

export interface IndexStatus {
	app: typeof APP;
	indexing: boolean;
	/** Whether Claude Code transcripts were imported since the server started. */
	claudeIndexed: boolean;
	/** When the last index finished (ms), and what it found. */
	lastIndexed: number | null;
	indexed: number;
	failed: { path: string; error: string }[];
	error: string | null;
	/** Bumped by every completed index; clients refetch when it changes. */
	generation: number;
	/** The harness release the server runs (null from a repository checkout), and its process, so a newer release can replace it. */
	release: string | null;
	pid: number;
}

/** Runs index passes one at a time in a worker; a request during a pass queues one more. */
export class Indexer {
	readonly status: IndexStatus = { app: APP, indexing: false, claudeIndexed: false, lastIndexed: null, indexed: 0, failed: [], error: null, generation: 0, release: RELEASE?.commit ?? null, pid: process.pid };
	private running: Promise<void> | undefined;
	private queued: { claude: boolean } | undefined;
	private readonly options: { path: string; agentDir: string; claudeDir: string; onDone: () => void };

	constructor(options: { path: string; agentDir: string; claudeDir: string; onDone: () => void }) {
		this.options = options;
	}

	/** Start a pass (or queue one after the current pass); resolves when the data includes it. */
	refresh(claude: boolean): Promise<void> {
		if (this.running) {
			this.queued = { claude: claude || (this.queued?.claude ?? false) };
			return this.running.then(() => this.running ?? undefined);
		}
		this.status.indexing = true;
		this.running = this.pass(claude).finally(() => {
			this.running = undefined;
			const next = this.queued;
			this.queued = undefined;
			if (next) void this.refresh(next.claude);
			else this.status.indexing = false;
		});
		return this.running;
	}

	private pass(claude: boolean): Promise<void> {
		const { path, agentDir, claudeDir } = this.options;
		return new Promise((done) => {
			const worker = new Worker(new URL("./index-worker.ts", import.meta.url), { workerData: { path, agentDir, claudeDir, claude } });
			let result: { indexed: number; failed: IndexStatus["failed"] } | undefined;
			worker.once("message", (message) => (result = message));
			worker.once("error", (error) => (this.status.error = error.message));
			worker.once("exit", () => {
				if (result) {
					this.status.indexed = result.indexed;
					this.status.failed = result.failed;
					this.status.error = null;
					if (claude) this.status.claudeIndexed = true;
				}
				this.status.lastIndexed = Date.now();
				this.status.generation += 1;
				this.options.onDone();
				done();
			});
		});
	}
}

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".json": "application/json",
	".woff2": "font/woff2",
};

function sendJson(res: ServerResponse, status: number, body: unknown, cached = false) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(cached ? { "x-cache": "hit" } : {}) });
	res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function serveStatic(res: ServerResponse, dist: string, pathname: string) {
	const file = resolve(dist, `.${decodeURIComponent(pathname)}`);
	const inside = file === dist || file.startsWith(dist + sep);
	const exists = (path: string) => {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	};
	// Client-side routes get the app; files under dist are served as they are.
	const target = inside && exists(file) ? file : join(dist, "index.html");
	if (!exists(target)) {
		res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
		res.end("The dashboard frontend is not built. Run `npm run dashboard` in the pi-harness repository.");
		return;
	}
	const immutable = target.includes(`${sep}assets${sep}`);
	res.writeHead(200, { "content-type": TYPES[extname(target)] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
	res.end(readFileSync(target));
}

export interface DashboardOptions {
	port?: number;
	agentDir?: string;
	claudeDir?: string;
	dist?: string;
	/** Index on start (tests turn it off and index themselves). */
	indexOnStart?: boolean;
}

export interface Dashboard {
	server: Server;
	db: DatabaseSync;
	indexer: Indexer;
	/** On this machine, and on its LAN addresses. */
	url: string;
	lan: string[];
	close: () => Promise<void>;
}

export async function startDashboard({ port = DEFAULT_PORT, agentDir = getAgentDir(), claudeDir = CLAUDE_PROJECTS, dist = DIST, indexOnStart = true }: DashboardOptions = {}): Promise<Dashboard> {
	const path = metricsPath(agentDir);
	const db = openStore(path);
	const cache = new Map<string, string>();
	const indexer = new Indexer({ path, agentDir, claudeDir, onDone: () => cache.clear() });

	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		const host = req.headers.host ?? "";
		if (!allowedHost(host)) return sendJson(res, 403, { error: "forbidden host" });
		const url = new URL(req.url ?? "/", `http://${host}`);
		if (!url.pathname.startsWith("/api/")) {
			if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
			if (handleWorkflows(req, res, url.pathname, agentDir)) return;
			return serveStatic(res, dist, url.pathname);
		}
		const path = url.pathname.slice("/api/".length);
		try {
			if (path === "status") return sendJson(res, 200, indexer.status);
			if (path === "refresh") {
				if (req.method !== "POST") return sendJson(res, 405, { error: "POST to refresh" });
				const source = url.searchParams.get("source") ?? "pi";
				if (!SOURCES.includes(source as Source)) throw new ApiError(400, `source: one of ${SOURCES.join(", ")}`);
				const done = indexer.refresh(needsClaude(source as Source));
				if (url.searchParams.get("wait") === "1") await done;
				return sendJson(res, 202, indexer.status);
			}
			if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
			const key = `${path}?${[...url.searchParams].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&")}`;
			const hit = cache.get(key);
			if (hit !== undefined) return sendJson(res, 200, hit, true);
			const body = JSON.stringify(route(db, path, url.searchParams));
			cache.set(key, body);
			return sendJson(res, 200, body);
		} catch (error) {
			if (error instanceof ApiError) return sendJson(res, error.status, { error: error.message });
			console.error(error);
			return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	};

	const server = createServer((req, res) => void handle(req, res));
	await new Promise<void>((ready, fail) => {
		server.once("error", fail);
		server.listen(port, () => ready());
	});
	const address = server.address();
	const bound = typeof address === "object" && address ? address.port : port;
	const url = `http://${HOST}:${bound}`;
	if (indexOnStart) void indexer.refresh(false);
	return {
		server,
		db,
		indexer,
		url,
		lan: lanUrls(bound),
		close: () =>
			new Promise((closed) => {
				server.closeAllConnections();
				server.close(() => {
					db.close();
					closed();
				});
			}),
	};
}
