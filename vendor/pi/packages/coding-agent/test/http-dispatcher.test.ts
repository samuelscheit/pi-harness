import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join } from "node:path";
import tls from "node:tls";
import { withCauseDetail } from "@earendil-works/pi-ai/utils/error-body";
import { transportErrorClass } from "@earendil-works/pi-ai/utils/retry";
import * as undici from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyHttpProxySettings,
	configureHttpDispatcher,
	HTTP_CONNECT_TIMEOUT_MS,
} from "../src/core/http-dispatcher.ts";

// Undici's connect timeout runs on its own timer module; the dispatcher's undici shares this
// CommonJS instance, so a spy on it sees the timeout the connector arms.
const require = createRequire(import.meta.url);
const undiciTimers = require(join(dirname(require.resolve("undici")), "lib/util/timers.js")) as {
	setFastTimeout: (callback: () => void, delay: number) => unknown;
};

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY"] as const;
const DISPATCHER_PROXY_ENV_KEYS = [...PROXY_ENV_KEYS, "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"] as const;

describe("http proxy settings", () => {
	let savedEnv: Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof PROXY_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of PROXY_ENV_KEYS) {
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of PROXY_ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("applies httpProxy to HTTP_PROXY and HTTPS_PROXY", () => {
		applyHttpProxySettings("http://127.0.0.1:7890");

		expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
		expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
	});

	it("does not override existing proxy env vars", () => {
		process.env.HTTP_PROXY = "http://env-http:8080";
		process.env.HTTPS_PROXY = "http://env-https:8080";

		applyHttpProxySettings("http://settings:7890");

		expect(process.env.HTTP_PROXY).toBe("http://env-http:8080");
		expect(process.env.HTTPS_PROXY).toBe("http://env-https:8080");
	});

	it("ignores empty values", () => {
		applyHttpProxySettings("   ");

		expect(process.env.HTTP_PROXY).toBeUndefined();
		expect(process.env.HTTPS_PROXY).toBeUndefined();
	});
});

describe("http dispatcher", () => {
	const originalDispatcher = undici.getGlobalDispatcher();
	const originalFetch = globalThis.fetch;
	let savedProxyEnv: Record<(typeof DISPATCHER_PROXY_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedProxyEnv = Object.fromEntries(DISPATCHER_PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof DISPATCHER_PROXY_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of DISPATCHER_PROXY_ENV_KEYS) {
			delete process.env[key];
		}
	});

	afterEach(async () => {
		const dispatcher = undici.getGlobalDispatcher();
		if (dispatcher !== originalDispatcher) {
			await dispatcher.close();
			undici.setGlobalDispatcher(originalDispatcher);
		}
		for (const key of DISPATCHER_PROXY_ENV_KEYS) {
			const value = savedProxyEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("tunnels proxied HTTP origins", async () => {
		const origin = http.createServer((_request, response) => {
			response.end("origin");
		});
		await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
		const originAddress = origin.address();
		if (!originAddress || typeof originAddress === "string") {
			throw new Error("Origin did not bind to a TCP port");
		}

		const proxyRequestLines: string[] = [];
		const proxy = net.createServer((client) => {
			client.once("data", (data) => {
				const [requestLine = ""] = data.toString().split("\r\n");
				proxyRequestLines.push(requestLine);
				if (!requestLine.startsWith("CONNECT ")) {
					client.end("HTTP/1.1 501 Not Implemented\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
					return;
				}

				const upstream = net.connect(originAddress.port, "127.0.0.1", () => {
					client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					client.pipe(upstream).pipe(client);
				});
				upstream.on("error", () => client.destroy());
				client.on("error", () => upstream.destroy());
			});
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const proxyAddress = proxy.address();
		if (!proxyAddress || typeof proxyAddress === "string") {
			throw new Error("Proxy did not bind to a TCP port");
		}

		process.env.HTTP_PROXY = `http://127.0.0.1:${proxyAddress.port}`;
		configureHttpDispatcher();
		const dispatcher = undici.getGlobalDispatcher();
		try {
			const originUrl = `http://127.0.0.1:${originAddress.port}/v1/chat/completions`;
			await expect(undici.fetch(originUrl).then((response) => response.text())).resolves.toBe("origin");
			await expect(undici.fetch(originUrl).then((response) => response.text())).resolves.toBe("origin");
			expect(proxyRequestLines).not.toHaveLength(0);
			expect(proxyRequestLines).toEqual(
				expect.arrayContaining([
					expect.stringMatching(`^CONNECT 127\\.0\\.0\\.1:${originAddress.port} HTTP/1\\.1$`),
				]),
			);
		} finally {
			await dispatcher.close();
			undici.setGlobalDispatcher(originalDispatcher);
			await Promise.all([
				new Promise<void>((resolve) => proxy.close(() => resolve())),
				new Promise<void>((resolve) => origin.close(() => resolve())),
			]);
		}
	});

	it("allows two seconds for HTTPS connection attempts without changing the Node default", async () => {
		// Preserve a deliberate host fetch override while testing the dispatcher itself.
		globalThis.fetch = async () => {
			throw new Error("Unexpected global fetch");
		};
		const originalAttemptTimeoutMs = net.getDefaultAutoSelectFamilyAttemptTimeout();
		const connectSpy = vi.spyOn(tls, "connect").mockImplementation(() => {
			throw new Error("Connection captured");
		});

		configureHttpDispatcher();
		await expect(undici.fetch("https://example.invalid")).rejects.toThrow();

		expect(connectSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				autoSelectFamilyAttemptTimeout: 2_000,
			}),
		);
		expect(connectSpy.mock.calls[0]?.[0]).not.toHaveProperty("autoSelectFamily");
		expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(originalAttemptTimeoutMs);
	});

	it("gives connections 30 seconds to open and reports a timeout as UND_ERR_CONNECT_TIMEOUT", async () => {
		globalThis.fetch = async () => {
			throw new Error("Unexpected global fetch");
		};
		const timers = vi.spyOn(undiciTimers, "setFastTimeout");
		// A socket that never connects, as on the route that timed out on 2026-11-12.
		const socket = new net.Socket();
		vi.spyOn(tls, "connect").mockReturnValue(socket as tls.TLSSocket);

		configureHttpDispatcher();
		const response = undici.fetch("https://api.example.test/v1/messages");
		const rejection = response.catch((error: unknown) => error);

		await vi.waitFor(() => expect(tls.connect).toHaveBeenCalled());
		expect(HTTP_CONNECT_TIMEOUT_MS).toBe(30_000);
		const connectTimeouts = timers.mock.calls.filter(([, delay]) => delay === HTTP_CONNECT_TIMEOUT_MS);
		expect(connectTimeouts).toHaveLength(1);
		// No timer of undici's 10s default connect timeout is armed.
		expect(timers.mock.calls.some(([, delay]) => delay === 10_000)).toBe(false);

		// Fire the connect timeout instead of waiting 30 seconds.
		connectTimeouts[0]![0]();
		const error = await rejection;

		expect(error).toBeInstanceOf(TypeError);
		const cause = (error as TypeError).cause as Error & { code?: string };
		expect(cause.code).toBe("UND_ERR_CONNECT_TIMEOUT");
		expect(cause.message).toContain("timeout: 30000ms");
		expect(socket.destroyed).toBe(true);
		// Provider errors carry the class through withCauseDetail; the retry policy reads it back.
		const message = withCauseDetail(new Error("Connection error.", { cause: error }));
		expect(message).toContain("(UND_ERR_CONNECT_TIMEOUT)");
		expect(transportErrorClass(message)).toBe("UND_ERR_CONNECT_TIMEOUT");
	});
});
