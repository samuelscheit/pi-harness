import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { stale } from "../dashboard/server/launch.ts";
import { type Dashboard, startDashboard } from "../dashboard/server/server.ts";
import { overview, Scope, totals } from "../extensions/metrics/queries/index.ts";
import { MIN, seed, T0 } from "./seed.ts";

let dir: string;
let dashboard: Dashboard;
let base: string;

const get = async (path: string, init?: RequestInit) => {
	const response = await fetch(`${base}${path}`, init);
	const text = await response.text();
	return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
};

/** A minimal Pi session file: header, system prompt, one question and one answer. */
function piSession(id: string, cwd: string, at: number): string {
	const ts = (offset: number) => new Date(at + offset).toISOString();
	const cost = { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0.01, total: 0.013 };
	return [
		{ type: "session", version: 3, id, timestamp: ts(0), cwd },
		{ type: "message", id: "s", parentId: null, timestamp: ts(1), message: { role: "system", content: "", sections: { base: "Be Pi." }, toolsAdded: [], timestamp: 0 } },
		{ type: "message", id: "u", parentId: "s", timestamp: ts(2), message: { role: "user", content: "hello there", timestamp: 0 } },
		{
			type: "message",
			id: "a",
			parentId: "u",
			timestamp: ts(3),
			message: { role: "assistant", content: [{ type: "text", text: "hi" }], api: "anthropic-messages", provider: "anthropic", model: "claude-opus", usage: { input: 200, output: 80, cacheRead: 0, cacheWrite: 1600, cost }, stopReason: "stop", timestamp: 0 },
		},
	]
		.map((line) => JSON.stringify(line))
		.join("\n");
}

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "pi-dashboard-"));
	mkdirSync(join(dir, "agent", "sessions"), { recursive: true });
	mkdirSync(join(dir, "claude"), { recursive: true });
	mkdirSync(join(dir, "dist", "assets"), { recursive: true });
	writeFileSync(join(dir, "dist", "index.html"), "<!doctype html><title>app</title>");
	writeFileSync(join(dir, "dist", "assets", "app.js"), "console.log(1)");
	writeFileSync(join(dir, "secret.txt"), "outside dist");
	dashboard = await startDashboard({ port: 0, agentDir: join(dir, "agent"), claudeDir: join(dir, "claude"), dist: join(dir, "dist"), indexOnStart: false });
	base = dashboard.url;
	seed(dashboard.db);
});
after(async () => {
	await dashboard.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("API", () => {
	test("binds to 127.0.0.1 and reports its index status", async () => {
		assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
		const status = (await get("/api/status")).json();
		assert.deepEqual([status.app, status.indexing, status.generation, status.claudeIndexed], ["pi-harness-dashboard", false, 0, false]);
	});

	test("every view answers with the query layer's result for the filters", async () => {
		for (const view of ["overview", "breakdown?group=model", "context", "sessions", "waste", "subagents", "versions", "options", "sessions/A", "versions/diff?from=v1&to=v2"]) {
			const response = await get(`/api/${view}`);
			assert.equal(response.status, 200, view);
		}
		const body = (await get(`/api/overview?start=${T0}&end=${T0 + 45 * MIN}`)).json();
		const expected = overview(new Scope(dashboard.db, { start: T0, end: T0 + 45 * MIN }));
		assert.deepEqual(body.kpis, expected.kpis);
		assert.deepEqual(body.findings, JSON.parse(JSON.stringify(expected.findings)));
	});

	test("times as ms or ISO, sources, projects, models and sessions are filters", async () => {
		const iso = (await get(`/api/overview?start=${new Date(T0).toISOString()}&end=${new Date(T0 + 45 * MIN).toISOString()}`)).json();
		const ms = (await get(`/api/overview?start=${T0}&end=${T0 + 45 * MIN}`)).json();
		assert.deepEqual(iso.kpis, ms.kpis);
		const all = (await get("/api/overview?source=all")).json();
		assert.equal(all.kpis.cost, totals(new Scope(dashboard.db, { source: "all" })).cost);
		assert.equal((await get("/api/sessions?project=/p2")).json().total, 1);
		assert.equal((await get("/api/sessions?model=claude-sonnet")).json().total, 2);
		assert.equal((await get("/api/sessions?session=C")).json().rows[0].id, "C");
		assert.equal((await get("/api/overview?project=")).json().kpis.sessions, 4, "an empty value is no filter");
	});

	test("a session id with a slash is one path segment, encoded", async () => {
		const detail = (await get(`/api/sessions/${encodeURIComponent("X/agent1")}`)).json();
		assert.equal(detail.session.parent.id, "X");
	});

	test("bad input is a 400 with the reason, unknown things a 404", async () => {
		const cases: [string, number, RegExp][] = [
			["/api/overview?source=codex", 400, /source/],
			["/api/overview?start=yesterday", 400, /not a time/],
			[`/api/overview?start=${T0}&end=${T0}`, 400, /before end/],
			["/api/breakdown?group=user", 400, /group: one of/],
			["/api/sessions?page=0", 400, /page/],
			["/api/sessions?pageSize=500", 400, /pageSize/],
			["/api/sessions?sort=name", 400, /sort/],
			["/api/context?limit=1.5", 400, /limit/],
			["/api/versions/diff?from=v1", 400, /from and to/],
			["/api/versions/diff?from=v1&to=nope", 404, /no such version/],
			["/api/sessions/nope", 404, /no such session/],
			["/api/users", 404, /no such view/],
		];
		for (const [path, status, error] of cases) {
			const response = await get(path);
			assert.equal(response.status, status, path);
			assert.match(response.json().error, error, path);
		}
		assert.equal((await get("/api/overview", { method: "DELETE" })).status, 405);
	});

	test("responses are cached per view and filters, in any parameter order", async () => {
		const first = await get("/api/breakdown?group=project&source=all");
		const again = await get("/api/breakdown?source=all&group=project");
		assert.equal(first.headers.get("x-cache"), null);
		assert.equal(again.headers.get("x-cache"), "hit");
		assert.equal(again.text, first.text);
		assert.equal((await get("/api/breakdown?group=project&source=pi")).headers.get("x-cache"), null, "other filters, other entry");
	});

	test("a refresh indexes in a worker, clears the cache, and imports Claude Code only when the source needs it", async () => {
		assert.equal((await get("/api/refresh")).status, 405);
		assert.equal((await get("/api/refresh?source=codex", { method: "POST" })).status, 400);
		await get("/api/sessions?project=/new");
		writeFileSync(join(dir, "agent", "sessions", "new.jsonl"), piSession("new-session", "/new", T0 + 100 * MIN));
		const status = (await get("/api/refresh?wait=1", { method: "POST" })).json();
		assert.deepEqual([status.indexing, status.indexed, status.generation, status.claudeIndexed, status.failed], [false, 1, 1, false, []]);
		const sessions = await get("/api/sessions?project=/new");
		assert.equal(sessions.headers.get("x-cache"), null, "the cache was cleared");
		assert.deepEqual(sessions.json().rows.map((r: { id: string; title: string }) => [r.id, r.title]), [["new-session", "hello there"]]);
		const withClaude = (await get("/api/refresh?source=all&wait=1", { method: "POST" })).json();
		assert.deepEqual([withClaude.generation, withClaude.claudeIndexed, withClaude.indexed], [2, true, 0]);
	});

	test("a refresh during a pass queues one more pass, which keeps the Claude Code request", async () => {
		const before = (await get("/api/status")).json().generation;
		const first = dashboard.indexer.refresh(false);
		const second = dashboard.indexer.refresh(true);
		const third = dashboard.indexer.refresh(false);
		assert.equal(dashboard.indexer.status.indexing, true);
		await Promise.all([first, second, third]);
		assert.equal(dashboard.indexer.status.generation, before + 2, "the two queued requests ran as one pass");
		assert.equal(dashboard.indexer.status.indexing, false);
		assert.equal(dashboard.indexer.status.claudeIndexed, true);
	});
});

describe("static files", () => {
	test("the app for every client route, assets cached for good, nothing outside dist", async () => {
		const index = await get("/");
		assert.equal(index.status, 200);
		assert.match(index.headers.get("content-type")!, /text\/html/);
		assert.equal((await get("/sessions/A?range=7d")).text, index.text, "client-side route");
		const asset = await get("/assets/app.js");
		assert.match(asset.headers.get("content-type")!, /javascript/);
		assert.match(asset.headers.get("cache-control")!, /immutable/);
		assert.equal((await get("/..%2Fsecret.txt")).text, index.text, "an escape from dist gets the app, not the file");
		assert.equal((await get("/%2e%2e/secret.txt")).text, index.text);
		assert.equal((await get("/", { method: "POST" })).status, 405);
	});

	test("only requests addressed to this machine by name are answered", async () => {
		const status = await new Promise<number>((done, fail) => {
			const url = new URL(base);
			const req = request({ host: url.hostname, port: url.port, path: "/api/status", headers: { host: "evil.example:80" } }, (res) => {
				res.resume();
				done(res.statusCode!);
			});
			req.on("error", fail);
			req.end();
		});
		assert.equal(status, 403);
	});

	test("without a built frontend the app path explains how to build it", async () => {
		const bare = await startDashboard({ port: 0, agentDir: join(dir, "agent"), claudeDir: join(dir, "claude"), dist: join(dir, "missing"), indexOnStart: false });
		try {
			const response = await fetch(`${bare.url}/`);
			assert.equal(response.status, 503);
			assert.match(await response.text(), /npm run dashboard/);
		} finally {
			await bare.close();
		}
	});
});

test("the frontend is rebuilt when a build input is newer than the build", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-dashboard-build-"));
	try {
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "app.tsx"), "x");
		assert.equal(stale(root), true, "never built");
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "dist", "index.html"), "x");
		const past = new Date(Date.now() - 60_000);
		utimesSync(join(root, "src", "app.tsx"), past, past);
		utimesSync(join(root, "src"), past, past);
		assert.equal(stale(root), false, "built after the last change");
		writeFileSync(join(root, "src", "new.tsx"), "y");
		assert.equal(stale(root), true, "a source changed since");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
