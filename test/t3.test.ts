// The way to t3 (extensions/workflow/t3.ts) over real HTTP: a fake t3 MCP endpoint long-polls a
// child's run as t3's thread wait does (one response when the run ends or the wait times out), and
// the client fetches it as t3's bridge does in Pi, through an undici dispatcher with a headers
// timeout. Pi's default is 300 s; here it is 400 ms (undici's coarse timers cut at about 1 s) and
// every other time is scaled with it, so "a wait longer than the timeout" is the 2026-11-14 failure
// (a 10-minute wait cut at 300 s).

import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, test } from "node:test";
import { Agent } from "undici";
import { isInterruption } from "../extensions/workflow/durable.ts";
import { isTransportFailure, MAX_WAIT_MS, T3, type T3Call, T3Child, type T3Options, T3Unreachable, waitSliceMs } from "../extensions/workflow/t3.ts";

const HEADERS_TIMEOUT_MS = 400;

interface FakeT3 {
	server: Server;
	port: number;
	/** Every request: tool name, its arguments, and how it ended. */
	calls: { name: string; args: Record<string, unknown>; ended?: "answered" | "reset" | "cut" }[];
	/** When the child's run ends (ms since the epoch). */
	doneAt: number;
	/** The next `resets` wait requests get their connection destroyed. */
	resets: number;
	close(): Promise<void>;
}

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((r) => server.close(r)), server.closeAllConnections();
});

/** A fake t3 MCP endpoint: tools/call for t3_thread_wait, task_status and delegate_task. */
async function fakeT3(childMs: number, port = 0): Promise<FakeT3> {
	const fake: FakeT3 = { server: undefined!, port: 0, calls: [], doneAt: Date.now() + childMs, resets: 0, close: async () => undefined };
	const answer = (res: ServerResponse, data: Record<string, unknown>) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data } }));
	};
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk));
		req.on("end", () => {
			const { params } = JSON.parse(body) as { params: { name: string; arguments: Record<string, unknown> } };
			const call: FakeT3["calls"][number] = { name: params.name, args: params.arguments };
			fake.calls.push(call);
			if (params.name === "t3_thread_wait" && fake.resets > 0) {
				fake.resets--;
				call.ended = "reset";
				req.socket.destroy();
				return;
			}
			if (params.name === "t3_thread_wait") {
				// As t3 does: the response comes when the run ends or the wait's timeout passes, not before.
				const wait = Math.max(0, Math.min(Number(params.arguments.timeoutMs), fake.doneAt - Date.now()));
				const timer = setTimeout(() => {
					call.ended = "answered";
					const over = Date.now() >= fake.doneAt;
					answer(res, { threadId: params.arguments.threadId, status: over ? "completed" : "running", timedOut: !over });
				}, wait);
				res.on("close", () => {
					clearTimeout(timer);
					call.ended ??= "cut";
				});
				return;
			}
			call.ended = "answered";
			answer(res, params.name === "task_status" ? { taskId: params.arguments.taskId, summary: "done" } : { ok: true });
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	fake.server = server;
	fake.port = (server.address() as AddressInfo).port;
	fake.close = async () => {
		server.closeAllConnections();
		await new Promise((r) => server.close(r));
	};
	return fake;
}

/** A t3 call as the bridge makes it (fetch through Pi's dispatcher) and run.ts reports it (`t3 <name>: <message>`). */
function bridge(port: () => number, headersTimeout = HEADERS_TIMEOUT_MS): T3Call {
	const dispatcher = new Agent({ headersTimeout, bodyTimeout: headersTimeout });
	return async (name, args, signal) => {
		let response: Response;
		try {
			response = (await fetch(`http://127.0.0.1:${port()}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), signal, dispatcher } as RequestInit)) as Response;
		} catch (error) {
			// Pi turns the bridge's thrown fetch error into an error result with its message.
			if (signal.aborted) throw signal.reason;
			throw new Error(`t3 ${name}: ${(error as Error).message}`);
		}
		const { result } = (await response.json()) as { result: { structuredContent: Record<string, unknown> } };
		return result.structuredContent;
	};
}

/** A child whose run is known: reattach() waits for that run (as a resume after a crash does). */
function child(t3: T3): T3Child {
	const c = new T3Child(t3, {});
	c.restore({ taskId: "task-1", threadId: "thread-1", runId: "run-1" });
	return c;
}

const fast: T3Options = { backoffMs: 20 };

describe("wait slices fit Pi's HTTP idle timeout", () => {
	test("waitSliceMs: a margin below the timeout, at most MAX_WAIT_MS, at least 1 s; no timeout: MAX_WAIT_MS", () => {
		assert.equal(MAX_WAIT_MS, 240_000);
		assert.equal(waitSliceMs(300_000), 240_000, "Pi's default 300 s: 4 min, below it");
		assert.equal(waitSliceMs(600_000), 240_000);
		assert.equal(waitSliceMs(120_000), 90_000);
		assert.equal(waitSliceMs(60_000), 45_000);
		assert.equal(waitSliceMs(30_000), 22_500);
		assert.equal(waitSliceMs(1_000), 1_000, "never below 1 s");
		assert.equal(waitSliceMs(0), MAX_WAIT_MS, "disabled");
		assert.equal(waitSliceMs(Number.NaN), MAX_WAIT_MS);
		for (const timeout of [30_000, 60_000, 120_000, 300_000]) assert.ok(waitSliceMs(timeout) < timeout, `${timeout}: the slice ends before the timeout`);
	});

	test("the failure itself: one wait longer than the headers timeout is cut with 'fetch failed', and t3 sees the client hang up", async () => {
		const t3 = await fakeT3(5_000);
		const started = Date.now();
		await assert.rejects(bridge(() => t3.port)("t3_thread_wait", { threadId: "thread-1", timeoutMs: 2_000 }, new AbortController().signal), /t3 t3_thread_wait: fetch failed/);
		const took = Date.now() - started;
		assert.ok(took >= HEADERS_TIMEOUT_MS && took < 1_500, `cut at the timeout (${took} ms), not at the wait's end`);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(t3.calls[0]!.ended, "cut");
		assert.ok(isTransportFailure(new Error("t3 t3_thread_wait: fetch failed")));
	});

	test("a run that takes several timeouts: slices below the timeout wait it out without a single failure", async () => {
		const t3 = await fakeT3(1_500);
		const c = child(new T3(bridge(() => t3.port), { ...fast, retryDeadlineMs: 0, waitMs: 300 }));
		await c.reattach("ignored", "req-1", "run-1", new AbortController().signal, () => undefined);
		assert.equal(c.status, "completed");
		const waits = t3.calls.filter((call) => call.name === "t3_thread_wait");
		assert.ok(waits.length >= 4, `waited in slices (${waits.length})`);
		assert.ok(waits.every((call) => call.ended === "answered" && call.args.timeoutMs === 300), "every slice answered, none cut");
		assert.equal(t3.calls.at(-1)!.name, "task_status", "the result is marked delivered");
	});

	test("slices longer than the timeout: each cut is repeated, and the run still ends", async () => {
		const t3 = await fakeT3(2_500);
		const c = child(new T3(bridge(() => t3.port), { ...fast, retryDeadlineMs: 10_000, waitMs: 5_000 }));
		await c.reattach("ignored", "req-1", "run-1", new AbortController().signal, () => undefined);
		assert.equal(c.status, "completed");
		const waits = t3.calls.filter((call) => call.name === "t3_thread_wait");
		assert.ok(waits.filter((call) => call.ended === "cut").length >= 2, "cut at the timeout");
		assert.equal(waits.at(-1)!.ended, "answered");
	});
});

describe("transport failures are repeated; t3 gone for good interrupts", () => {
	test("connection resets during the wait: repeated with backoff, the run ends normally", async () => {
		const t3 = await fakeT3(300);
		t3.resets = 3;
		const c = child(new T3(bridge(() => t3.port), { ...fast, retryDeadlineMs: 10_000, waitMs: 200 }));
		await c.reattach("ignored", "req-1", "run-1", new AbortController().signal, () => undefined);
		assert.equal(c.status, "completed");
		assert.deepEqual(
			t3.calls.filter((call) => call.name === "t3_thread_wait").slice(0, 3).map((call) => call.ended),
			["reset", "reset", "reset"],
		);
	});

	test("t3 restarts (connection refused for a while): the wait goes on once it is back, same thread and run", async () => {
		const first = await fakeT3(10_000);
		const port = first.port;
		let current = first;
		const c = child(new T3(bridge(() => port), { ...fast, retryDeadlineMs: 10_000, waitMs: 200 }));
		const running = c.reattach("ignored", "req-1", "run-1", new AbortController().signal, () => undefined);
		await new Promise((r) => setTimeout(r, 250));
		await first.close();
		await new Promise((r) => setTimeout(r, 400));
		current = await fakeT3(200, port);
		await running;
		assert.equal(c.status, "completed");
		assert.ok(current.calls.some((call) => call.name === "t3_thread_wait" && call.args.threadId === "thread-1" && call.args.runId === "run-1"));
	});

	test("t3 unreachable past the deadline: T3Unreachable, an interruption, reported once to the hook, with what to do", async () => {
		const t3 = await fakeT3(10_000);
		const port = t3.port;
		await t3.close();
		const reported: unknown[] = [];
		const c = child(new T3(bridge(() => port), { ...fast, retryDeadlineMs: 300, waitMs: 200, unreachable: (error) => reported.push(error) }));
		const started = Date.now();
		const error = await c.reattach("ignored", "req-1", "run-1", new AbortController().signal, () => undefined).then(
			() => assert.fail("resolved"),
			(e: unknown) => e,
		);
		assert.ok(error instanceof T3Unreachable);
		assert.ok(isInterruption(error), "the run stops resumable");
		assert.match((error as Error).message, /t3 did not answer t3_thread_wait for 0 s \(\d+ attempts; last: t3 t3_thread_wait: fetch failed\)\. Its child threads keep running; resume the workflow to reattach to them\./);
		assert.deepEqual(reported, [error]);
		assert.ok(Date.now() - started < 2_000, "gave up near the deadline");
	});

	test("t3's own errors are not repeated", async () => {
		let calls = 0;
		const t3 = new T3(
			async (name) => {
				calls++;
				throw new Error(`t3 ${name}: Thread 'thread-1' was not found.`);
			},
			{ ...fast, retryDeadlineMs: 10_000 },
		);
		await assert.rejects(t3.call("t3_thread_wait", {}, new AbortController().signal), /was not found/);
		assert.equal(calls, 1);
	});

	test("a stop during the backoff ends the call at once with the stop's reason; a call aborted in flight is not repeated", async () => {
		const controller = new AbortController();
		let calls = 0;
		const t3 = new T3(
			async () => {
				calls++;
				throw new Error("t3 t3_thread_wait: fetch failed");
			},
			{ backoffMs: 5_000, retryDeadlineMs: 60_000 },
		);
		const started = Date.now();
		const pending = t3.call("t3_thread_wait", {}, controller.signal);
		setTimeout(() => controller.abort(new Error("stopped")), 50);
		await assert.rejects(pending, /stopped/);
		assert.ok(Date.now() - started < 1_000);
		assert.equal(calls, 1);
	});

	test("which failures are the transport's", () => {
		for (const message of ["t3 t3_thread_wait: fetch failed", "read ECONNRESET", "connect ECONNREFUSED 127.0.0.1:1", "socket hang up", "other side closed", "terminated", "UND_ERR_HEADERS_TIMEOUT", "MCP tools/call failed (503): unavailable"]) {
			assert.ok(isTransportFailure(new Error(message)), message);
		}
		for (const message of ["t3 delegate_task: Unknown model", "MCP tools/call failed (400): bad request", "MCP tools/call failed (404): session"]) {
			assert.ok(!isTransportFailure(new Error(message)), message);
		}
	});
});
