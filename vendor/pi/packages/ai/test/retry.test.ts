import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import {
	isRetryableAssistantError,
	type RetryPolicy,
	retryAssistantCall,
	retryDelayMs,
	type ScheduledRetry,
	SLOW_RETRY_DELAYS_MS,
	scheduleRetry,
	transportErrorClass,
} from "../src/utils/retry.ts";

const connectTimeoutMessage =
	"Connection error.: Connect Timeout Error (attempted address: api.anthropic.com:443, timeout: 30000ms) (UND_ERR_CONNECT_TIMEOUT)";

function errorMessage(text: string) {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage: text });
}

const openAIExplicitRetryMessage =
	"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_******** in your message.";
const bedrockExplicitRetryMessage =
	'{"message":"The system encountered an unexpected error during processing. Try your request again."}';
const nvidiaNIMResourceExhaustedMessage = "ResourceExhausted: Worker local total request limit reached (288/48)";
const bunFetchSocketClosedMessage =
	"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const openAIResponsesEarlyEofMessage = "OpenAI Responses stream ended before a terminal response event";
const wrappedDnsLookupError =
	"The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com)";
const azurePeakLoadError =
	"The system is currently experiencing high demand and cannot process your request. Your request exceeds the maximum usage size allowed during peak load. For improved capacity reliability, consider switching to Provisioned Throughput.";
const codexConnectionLimitError =
	"Codex error: Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.";

describe("provider retry classification", () => {
	// Regression for #12124: the Codex WebSocket lifetime limit is recoverable on a fresh connection.
	it.each([codexConnectionLimitError, "Codex error: websocket_connection_limit_reached"])(
		"matches the Codex websocket connection lifetime limit: %s",
		(errorMessage) => {
			expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
		},
	);

	it("does not match a generic connection limit", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "connection limit reached" }),
			),
		).toBe(false);
	});

	it("matches explicit provider retry guidance", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bedrockExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: nvidiaNIMResourceExhaustedMessage }),
			),
		).toBe(true);
	});

	it("matches Bun fetch socket drop wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bunFetchSocketClosedMessage }),
			),
		).toBe(true);
	});

	it("matches upstream request buffer exhaustion wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Error: exceeded request buffer limit while retrying upstream",
				}),
			),
		).toBe(true);
	});

	it.each([
		wrappedDnsLookupError,
		"connect ENOTFOUND api.example.com",
		"EAI_AGAIN api.example.com",
		"getaddrinfo failed for api.example.com",
	])("matches DNS transport failure wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each([
		// Regression for #12128: bare Node socket error codes.
		"read ECONNRESET",
		"connect ETIMEDOUT 140.82.113.3:443",
		"write EPIPE",
		"connect ECONNREFUSED 127.0.0.1:443",
		"ECONNABORTED",
		"Connection reset by peer",
	])("matches Node socket error codes: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each(["Invalid value EXECONNRESET", "Unknown field ETIMEDOUTX", "Invalid key ERR_EPIPE_ID"])(
		"does not match socket error codes inside longer identifiers: %s",
		(errorMessage) => {
			expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
		},
	);

	it.each(["The pending stream has been canceled", "The pending stream has been canceled (caused by: socket closed)"])(
		"matches HTTP/2 pending stream cancellation: %s",
		(errorMessage) => {
			// Regression for #10379.
			expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
		},
	);

	it.each([
		// Regression for #10965 (provider unknown, no status code in the message).
		"The service is temporarily unavailable. Please retry later.",
		// Bedrock ServiceUnavailableException as formatted by formatBedrockError.
		"Service unavailable: The service is temporarily unavailable.",
	])("matches service unavailable wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each([
		// Regression for #10996: node-fetch errors from the google-vertex OAuth token refresh.
		"request to https://oauth2.googleapis.com/token failed, reason:",
		"request to https://oauth2.googleapis.com/token failed, reason: connect ECONNREFUSED 127.0.0.1:9",
	])("matches node-fetch request failure wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each([
		// Regression for #10920: gateway upstream failures sent as `response.failed` error codes.
		"unknown: Unable to forward upstream stream",
		"upstream_error: Upstream request failed",
		"upstream_stream_read_error: Upstream response stream was interrupted",
		"Upstream HTTP/2 stream failed",
	])("matches gateway upstream failure wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it("matches gateway wording for a stream cut short mid-reply", () => {
		// Regression for #11879.
		const errorMessage = "Claude Code's stream from Anthropic was cut short after the reply had begun";
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each([
		// Regression for #12227: gateway mid-stream `event: error` frames without a status code.
		"The provider is temporarily unavailable. Retry shortly.",
		"The upstream provider is temporarily unavailable. Try again shortly.",
		"The provider ended the response before it was complete.",
		"The connection to the provider was reset. Retry shortly.",
		"The provider reported a failure while generating the response.",
	])("matches gateway provider failure wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each(["Provider unavailable for this model", "The provider is unavailable in your region"])(
		"does not match lasting provider unavailable wording: %s",
		(errorMessage) => {
			expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
		},
	);

	it("matches gateway wording for a closed connection", () => {
		// Regression for #12064.
		const errorMessage = '{"type":"error","error":{"type":"api_error","message":"Connection closed."}}';
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it("matches OpenAI Responses streams that end before terminal events", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIResponsesEarlyEofMessage }),
			),
		).toBe(true);
	});

	it("matches Azure peak-load capacity errors", () => {
		// Regression for #9669.
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: azurePeakLoadError })),
		).toBe(true);
	});

	it("keeps provider limit errors non-retryable", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 quota exceeded" }),
			),
		).toBe(false);
	});

	it("keeps the ChatGPT subscription usage limit non-retryable", () => {
		const errorMessage =
			'OpenAI API error (429): {"code":"subscription_sharing_usage_limit_exceeded","message":"Usage limit reached."}';
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});

	it("keeps the ChatGPT Business workspace usage limit non-retryable", () => {
		const errorMessage =
			'OpenAI API error (429): {"code":"subscription_sharing_workplace_individual_usage_limit_exceeded","message":"Usage limit reached."}';
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});

	it.each([
		"subscription_sharing_usage_unavailable: Usage cannot be checked.",
		"subscription_sharing_user_unavailable: User cannot be loaded.",
	])("retries temporary ChatGPT subscription errors: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it("classifies assistant error messages", () => {
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })),
		).toBe(true);
		// Regression for #9627.
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "520 status code (no body)" }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "524 status code (no body)" }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "525 <!DOCTYPE html><title>SSL handshake failed</title>",
				}),
			),
		).toBe(true);
		expect(isRetryableAssistantError(fauxAssistantMessage("not an error"))).toBe(false);
	});

	it.each([
		// Regression for #11057: status codes inside ids or other numbers are not status codes.
		'401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011CU503xyz"}',
		"400 image exceeds 5 MB maximum: 5316784 bytes > 5242880 bytes",
	])("does not match status codes inside ids or longer numbers: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});

	it.each([
		"Unable to process request. Repeat the request later.",
		"waited 73.4s in queue, reaching this model's admission ceiling of 60s; retry after the hinted delay",
		'{"type":"error","error":{"details":null,"type":"api_error","message":"Unable to complete this request right now. Please try again."},"request_id":"req_011CgfE1bTgPTDsor4TsApFv"}',
		"Provider finish_reason: error",
		"Provider returned an empty response",
		"Upstream error from Relace: The model stopped before completing the response.",
	])("retries temporary provider failures: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each([
		// A cancellation, usually the user's.
		"The operation was aborted",
		// Only Anthropic's internal error is retried, not other error types.
		'{"type":"error","error":{"type":"invalid_request_error","message":"messages: at least one message is required"}}',
		// A refusal ends the stream with a finish reason other than `error`.
		"Provider finish_reason: content_filter",
		// The quota exclusions are checked before the retryable patterns.
		'{"type":"error","error":{"type":"api_error","message":"Monthly quota exceeded"}}',
	])("does not retry: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});

	it.each([
		"400 upstream request timed out while validating the image",
		'401 {"error":{"message":"network error while verifying key"}}',
		"404 model overloaded_model not found",
		"409 conflict: connection reset by peer",
		"413 request too large, fetch failed",
		"OpenAI API error (403): server error forwarding credentials",
	])("never retries a client error other than 408 and 429: %s", (text) => {
		expect(isRetryableAssistantError(errorMessage(text))).toBe(false);
	});

	it.each(["408 Request Timeout", "429 Too Many Requests", "OpenAI API error (429): rate limit reached"])(
		"retries 408 and 429: %s",
		(text) => {
			expect(isRetryableAssistantError(errorMessage(text))).toBe(true);
		},
	);

	it("does not mistake a 4xx number inside the text for a status", () => {
		expect(isRetryableAssistantError(errorMessage("503 service unavailable, retry 404 times"))).toBe(true);
		expect(isRetryableAssistantError(errorMessage("overloaded (request 4001)"))).toBe(true);
	});
});

describe("transportErrorClass", () => {
	it.each([
		[connectTimeoutMessage, "UND_ERR_CONNECT_TIMEOUT"],
		["Connection error.: other side closed (UND_ERR_SOCKET)", "UND_ERR_SOCKET"],
		["read ECONNRESET", "ECONNRESET"],
		["request to https://x/token failed, reason: connect ECONNREFUSED 127.0.0.1:9", "ECONNREFUSED"],
		["getaddrinfo ENOTFOUND api.example.com", "ENOTFOUND"],
		["getaddrinfo EAI_AGAIN api.example.com", "EAI_AGAIN"],
		["connect ETIMEDOUT 1.2.3.4:443", "ETIMEDOUT"],
		["The pending stream has been canceled (ERR_HTTP2_STREAM_CANCEL)", "ERR_HTTP2_STREAM_CANCEL"],
	])("names the transport error in %s", (text, errorClass) => {
		expect(transportErrorClass(text)).toBe(errorClass);
	});

	it.each(["529 overloaded", "terminated", "XECONNRESETX", "UND_ERR"])("names none in %s", (text) => {
		expect(transportErrorClass(text)).toBeUndefined();
	});

	it.each(["read ECONNRESET", "connect EHOSTUNREACH 10.0.0.1:443", "UND_ERR_SOCKET", "write EPIPE"])(
		"makes a bare transport error retryable: %s",
		(text) => {
			expect(isRetryableAssistantError(errorMessage(text))).toBe(true);
		},
	);
});

describe("scheduleRetry", () => {
	const policy: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };

	function tiers(text: string): Array<Pick<ScheduledRetry, "attempt" | "tier" | "delayMs" | "maxAttempts">> {
		const retries: Array<Pick<ScheduledRetry, "attempt" | "tier" | "delayMs" | "maxAttempts">> = [];
		for (let attempt = 1; ; attempt++) {
			const retry = scheduleRetry(policy, attempt, errorMessage(text));
			if (!retry) return retries;
			retries.push({
				attempt: retry.attempt,
				tier: retry.tier,
				delayMs: retry.delayMs,
				maxAttempts: retry.maxAttempts,
			});
		}
	}

	it("follows the fast retries with the slow tier for network and server errors", () => {
		const expected = [
			{ attempt: 1, tier: "fast", delayMs: 2000, maxAttempts: 8 },
			{ attempt: 2, tier: "fast", delayMs: 4000, maxAttempts: 8 },
			{ attempt: 3, tier: "fast", delayMs: 8000, maxAttempts: 8 },
			{ attempt: 4, tier: "slow", delayMs: 30_000, maxAttempts: 8 },
			{ attempt: 5, tier: "slow", delayMs: 60_000, maxAttempts: 8 },
			{ attempt: 6, tier: "slow", delayMs: 120_000, maxAttempts: 8 },
			{ attempt: 7, tier: "slow", delayMs: 300_000, maxAttempts: 8 },
			{ attempt: 8, tier: "slow", delayMs: 300_000, maxAttempts: 8 },
		];
		for (const text of [connectTimeoutMessage, "529 overloaded", "503 Service Unavailable", "terminated"]) {
			expect(tiers(text)).toEqual(expected);
		}
		// About 15 minutes in total, counting the failed attempts.
		expect(SLOW_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBe(810_000);
	});

	it("gives rate limits the fast retries only", () => {
		for (const text of [
			"429 Too Many Requests",
			"rate_limit_error",
			"ResourceExhausted: limit",
			"Server requested 120s retry delay (max: 60s)",
		]) {
			expect(tiers(text).map((retry) => retry.tier)).toEqual(["fast", "fast", "fast"]);
			expect(tiers(text)[0]?.maxAttempts).toBe(3);
		}
	});

	it("schedules nothing for non-retryable errors, a disabled policy or zero retries", () => {
		expect(scheduleRetry(policy, 1, errorMessage("400 invalid request: timeout must be positive"))).toBeUndefined();
		expect(scheduleRetry(policy, 1, errorMessage("insufficient_quota"))).toBeUndefined();
		expect(scheduleRetry(policy, 1, fauxAssistantMessage("ok"))).toBeUndefined();
		expect(scheduleRetry(policy, 1, fauxAssistantMessage("", { stopReason: "aborted" }))).toBeUndefined();
		expect(scheduleRetry({ ...policy, enabled: false }, 1, errorMessage("terminated"))).toBeUndefined();
		expect(scheduleRetry({ ...policy, maxRetries: 0 }, 1, errorMessage("terminated"))).toBeUndefined();
	});

	it("starts the slow tier right after a single fast retry", () => {
		const single: RetryPolicy = { ...policy, maxRetries: 1 };
		expect(scheduleRetry(single, 2, errorMessage("terminated"))).toMatchObject({
			tier: "slow",
			delayMs: 30_000,
			maxAttempts: 6,
		});
		expect(scheduleRetry(single, 7, errorMessage("terminated"))).toBeUndefined();
	});

	it("reports the error message and its transport error class", () => {
		expect(scheduleRetry(policy, 4, errorMessage(connectTimeoutMessage))).toEqual({
			attempt: 4,
			maxAttempts: 8,
			delayMs: 30_000,
			tier: "slow",
			errorMessage: connectTimeoutMessage,
			errorClass: "UND_ERR_CONNECT_TIMEOUT",
		});
		expect(scheduleRetry(policy, 1, errorMessage("529 overloaded"))?.errorClass).toBeUndefined();
	});
});

describe("retryDelayMs", () => {
	it("caps agent retry delay", () => {
		// Regression for #8826.
		expect(retryDelayMs({ baseDelayMs: 2000 }, 6)).toBe(60000);
		expect(retryDelayMs({ baseDelayMs: 2000, maxAgentDelayMs: 5000 }, 5)).toBe(5000);
		expect(retryDelayMs({ baseDelayMs: 2000, maxAgentDelayMs: 0 }, 5)).toBe(0);
	});
});

describe("retryAssistantCall", () => {
	const disabled: RetryPolicy = { enabled: false, maxRetries: 3, baseDelayMs: 0 };
	const enabled: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 0 };
	// Fast tier waits 1s, 2s, 4s: 7s before the first slow wait.
	const timed: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 1000 };

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns a successful response immediately without retrying", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("ok"));
		const res = await retryAssistantCall(produce, enabled, undefined);
		expect(res.content).toEqual([{ type: "text", text: "ok" }]);
		expect(produce).toHaveBeenCalledTimes(1);
	});

	it("does not retry an aborted message", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "aborted" }));
		const onRetryScheduled = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled });
		expect(res.stopReason).toBe("aborted");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
	});

	it("does not retry a non-retryable error (quota/billing)", async () => {
		const produce = vi.fn(async () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }),
		);
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
		expect(onRetryFinished).not.toHaveBeenCalled();
	});

	it("retries a rate limit up to maxRetries then returns the final error", async () => {
		const produce = vi.fn(async () => errorMessage("429 Too Many Requests"));
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
		expect(onRetryScheduled).toHaveBeenCalledTimes(3);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 3, "429 Too Many Requests");
	});

	it("waits out a network outage through the slow tier, reporting every wait", async () => {
		vi.useFakeTimers();
		const produce = vi.fn(async () => errorMessage(connectTimeoutMessage));
		const scheduled: ScheduledRetry[] = [];
		const onRetryFinished = vi.fn();
		const result = retryAssistantCall(produce, timed, undefined, {
			onRetryScheduled: (retry) => {
				scheduled.push(retry);
			},
			onRetryFinished,
		});

		await vi.advanceTimersByTimeAsync(7_000);
		expect(produce).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(29_999);
		expect(produce).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(1);
		expect(produce).toHaveBeenCalledTimes(5);
		await vi.advanceTimersByTimeAsync(780_000);

		const res = await result;
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(9); // 1 initial + 3 fast + 5 slow
		expect(scheduled.map((retry) => [retry.attempt, retry.tier, retry.delayMs])).toEqual([
			[1, "fast", 1000],
			[2, "fast", 2000],
			[3, "fast", 4000],
			[4, "slow", 30_000],
			[5, "slow", 60_000],
			[6, "slow", 120_000],
			[7, "slow", 300_000],
			[8, "slow", 300_000],
		]);
		expect(
			scheduled.every((retry) => retry.maxAttempts === 8 && retry.errorClass === "UND_ERR_CONNECT_TIMEOUT"),
		).toBe(true);
		expect(onRetryFinished).toHaveBeenCalledOnce();
		expect(onRetryFinished).toHaveBeenCalledWith(false, 8, connectTimeoutMessage);
	});

	it("succeeds after a slow retry", async () => {
		vi.useFakeTimers();
		let n = 0;
		const produce = vi.fn(async () =>
			++n <= 5 ? errorMessage("529 overloaded") : fauxAssistantMessage("recovered"),
		);
		const onRetryFinished = vi.fn();
		const result = retryAssistantCall(produce, timed, undefined, { onRetryFinished });

		await vi.advanceTimersByTimeAsync(7_000 + 30_000 + 59_999);
		expect(produce).toHaveBeenCalledTimes(5);
		await vi.advanceTimersByTimeAsync(1);

		const res = await result;
		expect(res.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(produce).toHaveBeenCalledTimes(6);
		expect(onRetryFinished).toHaveBeenCalledWith(true, 5);
	});

	it("aborts a slow-tier wait", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const produce = vi.fn(async () => errorMessage("ECONNRESET"));
		const onRetryFinished = vi.fn();
		const result = retryAssistantCall(produce, timed, controller.signal, { onRetryFinished });

		await vi.advanceTimersByTimeAsync(10_000);
		expect(produce).toHaveBeenCalledTimes(4);
		expect(vi.getTimerCount()).toBe(1);
		controller.abort();

		const res = await result;
		expect(res.stopReason).toBe("aborted");
		expect(res.errorMessage).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
		expect(produce).toHaveBeenCalledTimes(4);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 4, "ECONNRESET");
	});

	it("does not retry a client error", async () => {
		const produce = vi.fn(async () => errorMessage("400 invalid_request_error: connection field is invalid"));
		const onRetryScheduled = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
	});

	it("reports capped retry delays", async () => {
		// Regression for #8826.
		let n = 0;
		const policy: RetryPolicy = { enabled: true, maxRetries: 4, baseDelayMs: 10, maxAgentDelayMs: 15 };
		const produce = vi.fn(async () => {
			n++;
			return n < 5
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryScheduled = vi.fn();

		await retryAssistantCall(produce, policy, undefined, { onRetryScheduled });

		expect(onRetryScheduled.mock.calls.map(([retry]) => retry.delayMs)).toEqual([10, 15, 15, 15]);
	});

	// Regression for #10506.
	it("stops retrying once a call succeeds and removes backoff abort listeners", async () => {
		const controller = new AbortController();
		let n = 0;
		const produce = vi.fn(async () => {
			n++;
			return n < 4
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, controller.signal, { onRetryFinished });
		expect(res.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(produce).toHaveBeenCalledTimes(4);
		expect(onRetryFinished).toHaveBeenCalledWith(true, 3);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("reports an aborted retried call as unsuccessful", async () => {
		let n = 0;
		const produce = vi.fn(async () => {
			n++;
			return n === 1
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("", { stopReason: "aborted" });
		});
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryFinished });
		expect(res.stopReason).toBe("aborted");
		expect(produce).toHaveBeenCalledTimes(2);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 1);
	});

	it("does not retry when policy is disabled", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, disabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
		expect(onRetryFinished).not.toHaveBeenCalled();
	});

	it("emits onRetryAttemptStart after backoff before each retried call", async () => {
		const events: string[] = [];
		let n = 0;
		const produce = vi.fn(async () => {
			events.push(`produce:${n}`);
			n++;
			return n < 3
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryScheduled = vi.fn((retry: ScheduledRetry) => {
			events.push(`retry:${retry.attempt}`);
		});
		const onRetryAttemptStart = vi.fn(() => {
			events.push("attempt-start");
		});
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryAttemptStart });
		expect(res.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(onRetryScheduled).toHaveBeenCalledTimes(2);
		expect(onRetryAttemptStart).toHaveBeenCalledTimes(2);
		expect(events).toEqual([
			"produce:0",
			"retry:1",
			"attempt-start",
			"produce:1",
			"retry:2",
			"attempt-start",
			"produce:2",
		]);
	});

	it("aborts backoff sleep via signal, returns an aborted message, and emits onRetryFinished(false)", async () => {
		const controller = new AbortController();
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const policy: RetryPolicy = { enabled: true, maxRetries: 5, baseDelayMs: 10_000 };
		const onRetryFinished = vi.fn();
		const p = retryAssistantCall(produce, policy, controller.signal, { onRetryFinished });
		// Let one error call resolve and the first backoff sleep start, then abort.
		await vi.waitFor(() => expect(produce).toHaveBeenCalled());
		controller.abort();
		const res = await p;
		expect(res.stopReason).toBe("aborted");
		expect(res.errorMessage).toBeUndefined();
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 1, "terminated");
	});
});
