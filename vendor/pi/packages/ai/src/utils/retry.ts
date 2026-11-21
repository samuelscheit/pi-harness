import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	"Monthly usage limit reached",
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",

	// Sign in with ChatGPT: the subscription's shared usage limit, which resets
	// after hours rather than seconds.
	"subscription_sharing_usage_limit_exceeded",
	// Sign in with ChatGPT on a ChatGPT Business plan: a usage limit set by the
	// workspace admin. Only the admin can raise it.
	"subscription_sharing_workplace_individual_usage_limit_exceeded",

	// Zhipu/Z.ai (open.bigmodel.cn) error code 1308: the plan's usage limit is
	// reached, sent as HTTP 429. It resets after hours, not seconds (#11537).
	'"code"\\s*:\\s*"?1308(?![0-9])',
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"server_busy",
	"servers are currently busy",
	"currently experiencing high demand",
	"model is at capacity",
	// A request that waited too long in the provider's queue, e.g. sference's "waited 73.4s in
	// queue, reaching this model's admission ceiling of 60s; retry after the hinted delay".
	"admission ceiling",
	"rate.?limit",
	"too many requests",
	// Status codes must not be part of a longer word or number, e.g. a request id or byte count (#11057).
	// 520, 524 and 525 are Cloudflare's: an unknown error, a timeout, and a failed TLS
	// handshake between Cloudflare and the provider's origin, usually while it restarts.
	"(?<![a-z0-9])(?:429|500|502|503|504|520|524|525)(?![a-z0-9])",
	// Also matches "The service is temporarily unavailable" (#10965).
	"service.?(?:is.?)?(?:temporarily.?)?unavailable",
	// Gateway wording such as "The provider is temporarily unavailable. Retry shortly." (#12227).
	// "temporarily" is required: a plain "provider unavailable" is often a lasting routing error.
	"provider.?(?:is.?)?temporarily.?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264) and gateway wording such as
	// "The upstream provider returned an error" (#10842).
	"provider.?returned.?(?:an.?)?error",
	// Anthropic's internal error, which it sends as HTTP 500 before streaming and as an event
	// without a status once the stream has started, e.g. {"type":"error","error":{"type":
	// "api_error","message":"Unable to complete this request right now. Please try again."}}.
	// Gateways that copy Anthropic's format use it for their own upstream failures as well.
	'"type"\\s*:\\s*"api_error"',
	"exceeded request buffer limit while retrying upstream",
	// Gateway failure relaying the upstream response stream, sent as an OpenAI
	// Responses `response.failed` event without an error code (#10920).
	"unable to forward upstream",
	// Other gateway upstream failures relayed as `response.failed` error codes (#10920).
	"upstream.?request.?failed",
	"upstream_stream_read_error",
	"stream was interrupted",
	"http/?2 stream failed",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	// A gateway's mid-stream drop, e.g. "Connection closed." (#12064).
	"connection.?closed",
	"other side closed",
	"fetch failed",
	// node-fetch system errors, e.g. the Google ADC OAuth token refresh used by
	// google-vertex. The reason is often empty (#10996).
	"request to \\S+ failed, reason:",
	"getaddrinfo",
	// Bare Node socket error codes, e.g. "read ECONNRESET", "write EPIPE", or
	// "connect ETIMEDOUT 1.2.3.4:443" when a transport reports only the code (#12128).
	// The codes must not be part of a longer identifier.
	"(?<![a-z0-9_])(?:ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|EPIPE)(?![a-z0-9_])",
	"connection reset by peer",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",
	// Codex 60-minute WebSocket lifetime limit, as code `websocket_connection_limit_reached` or as
	// text "Responses websocket connection limit reached". A retry opens a fresh connection (#12124).
	"websocket.?connection.?limit.?reached",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",
	// An OpenAI-compatible stream that ended with `finish_reason: "error"`, which OpenRouter
	// sends when its provider fails mid-stream; see `mapStopReason` in openai-completions.ts.
	"provider finish_reason: error",
	// OpenRouter: "Provider returned an empty response", and its wrapper for a provider that
	// gave up, e.g. "Upstream error from Relace: The model stopped before completing the response."
	"returned an empty response",
	"stopped before completing the response",
	// Codex CLI mid-stream disconnect, relayed by proxies that wrap the Codex CLI,
	// e.g. "stream disconnected before completion: stream closed before response.completed" (#11057).
	"stream disconnected before completion",
	// Magpie gateway relaying a dropped upstream Anthropic stream, e.g.
	// "Claude Code's stream from Anthropic was cut short after the reply had begun" (#11879).
	"cut short after the reply had begun",
	// Gateway mid-stream failures relayed as SSE `event: error` frames without a
	// status code, e.g. "The provider ended the response before it was complete." (#12227).
	"ended the response before it was complete",
	"connection to the provider was reset",
	"reported a failure while generating the response",
	// Node ERR_HTTP2_STREAM_CANCEL: the HTTP/2 session died before the request was
	// sent, e.g. after the Bedrock SDK's 5-minute session timeout (#10379).
	"pending stream has been canceled",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",
	// recursive: "Unable to process request. Repeat the request later."
	"repeat the request later",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",

	// Sign in with ChatGPT: usage or user data temporarily unavailable. Usage
	// failures can arrive mid-stream without an HTTP 503 in the message.
	"subscription_sharing_usage_unavailable",
	"subscription_sharing_user_unavailable",
]);

// Errors whose cause is the provider's request budget. They get the fast retries only:
// waiting out a slow tier would hide a limit the caller should see.
const RATE_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	"rate.?limit",
	"too many requests",
	"(?<![a-z0-9])429(?![a-z0-9])",
	"ResourceExhausted",
	"retry delay",
]);

// A client error (4xx) other than 408 Request Timeout and 429 Too Many Requests means the
// request itself is wrong; repeating it cannot help, whatever the rest of the text says.
// SDK errors start with the status ("400 {...}"); `formatProviderError` writes "Prefix (400): ...".
const NON_RETRYABLE_CLIENT_STATUS_PATTERN = /^4(?!08|29)\d\d(?![0-9])|\(4(?!08|29)\d\d\):/;

// Transport error codes Node and undici attach to a failed connection; `withCauseDetail`
// appends them to provider error messages, e.g. "Connection error.: ... (UND_ERR_CONNECT_TIMEOUT)".
const TRANSPORT_ERROR_CLASS_PATTERN =
	/\b(UND_ERR_[A-Z_]+|ERR_HTTP2_[A-Z_]+|E(?:CONNRESET|CONNREFUSED|CONNABORTED|NOTFOUND|AI_AGAIN|TIMEDOUT|PIPE|NETUNREACH|NETDOWN|HOSTUNREACH|PROTO))\b/;

/**
 * Retry policy: bounded attempts with exponential backoff (`baseDelayMs * 2^(attempt-1)`).
 * `maxAgentDelayMs` caps each computed delay and defaults to 60 seconds.
 * After these fast retries, transient network and server errors get the slow tier
 * ({@link SLOW_RETRY_DELAYS_MS}); see {@link scheduleRetry}.
 * Matches `settings.retry` (`enabled`, `maxRetries`, `baseDelayMs`, `maxAgentDelayMs`) in coding-agent; kept
 * here so the classifier and the policy-driven retry loop live together and stay reusable
 * by the SDK and other callers.
 */
export interface RetryPolicy {
	enabled: boolean;
	/** Max retry attempts (0 = no retries). The initial call never counts as a retry. */
	maxRetries: number;
	/** Base delay in ms. Per-attempt delay is `baseDelayMs * 2^(attempt-1)` before jitter. */
	baseDelayMs: number;
	/** Optional cap for agent-level retry delays in ms. Defaults to 60 seconds. */
	maxAgentDelayMs?: number;
}

export const DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000;

export function retryDelayMs(policy: Pick<RetryPolicy, "baseDelayMs" | "maxAgentDelayMs">, attempt: number): number {
	const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
	return Math.min(safeDelay, policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
}

/**
 * Waits of the slow tier, which follows the fast retries for transient network and server
 * errors (not rate limits). Outages of a provider or a network path often last minutes, longer
 * than the fast tier's seconds; these waits add up to 13.5 minutes, about 15 with the fast tier
 * and the failed attempts, before the caller sees the error.
 */
export const SLOW_RETRY_DELAYS_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000, 300_000];

/** A retry decided by {@link scheduleRetry}: which attempt, how long to wait first, and why. */
export interface ScheduledRetry {
	/** 1-indexed retry number; the initial call is not a retry. */
	attempt: number;
	/** Retries this error can get in total, fast and slow tier together. */
	maxAttempts: number;
	delayMs: number;
	/** `fast`: exponential backoff under the policy. `slow`: the waits of {@link SLOW_RETRY_DELAYS_MS}. */
	tier: "fast" | "slow";
	errorMessage: string;
	/** Transport error code the message names, e.g. `UND_ERR_CONNECT_TIMEOUT` or `ECONNRESET`. */
	errorClass?: string;
}

/**
 * Decide whether a failed assistant call gets retry number `attempt` (1-indexed) and how long to
 * wait first. Undefined when the message is not a retryable error, the policy is disabled or
 * allows no retries, or the tiers are used up. Context overflow is the caller's to exclude.
 */
export function scheduleRetry(
	policy: RetryPolicy,
	attempt: number,
	message: AssistantMessage,
): ScheduledRetry | undefined {
	if (!policy.enabled || policy.maxRetries <= 0 || !isRetryableAssistantError(message)) return undefined;
	// isRetryableAssistantError guarantees a non-empty message.
	const errorMessage = message.errorMessage!;
	const slowAttempts = RATE_LIMIT_ERROR_PATTERN.test(errorMessage) ? 0 : SLOW_RETRY_DELAYS_MS.length;
	const maxAttempts = policy.maxRetries + slowAttempts;
	if (attempt > maxAttempts) return undefined;
	const fast = attempt <= policy.maxRetries;
	return {
		attempt,
		maxAttempts,
		delayMs: fast ? retryDelayMs(policy, attempt) : SLOW_RETRY_DELAYS_MS[attempt - policy.maxRetries - 1]!,
		tier: fast ? "fast" : "slow",
		errorMessage,
		errorClass: transportErrorClass(errorMessage),
	};
}

/** The transport error code (`UND_ERR_*`, `ECONNRESET`, `ENOTFOUND`, ...) an error message names, if any. */
export function transportErrorClass(errorMessage: string): string | undefined {
	return TRANSPORT_ERROR_CLASS_PATTERN.exec(errorMessage)?.[1];
}

/** Optional callbacks emitted by {@link retryAssistantCall} around each retry. */
export interface RetryCallbacks {
	/** Emitted before the backoff sleep of each retry. */
	onRetryScheduled?: (retry: ScheduledRetry) => void | Promise<void>;
	/** Emitted after the backoff sleep, immediately before the retried call starts. */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** Emitted once when the loop ends: success if a later call completed normally. */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new RetrySleepAbortError());
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Run a single assistant-producing call with bounded retry on transient errors.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - A non-retryable error (per {@link isRetryableAssistantError}, including quota/
 *   billing exhaustion) is returned immediately so deterministic errors fail fast.
 * - Otherwise retries as {@link scheduleRetry} decides (fast tier, then slow tier), emitting
 *   `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep before
 *   the retried call starts, and `onRetryFinished` once at the end (whether the loop
 *   ends in success, exhausted retries, or an aborted backoff).
 *
 * When `policy` is undefined or disabled, the first response is returned unchanged
 * (equivalent to calling `produce()` directly).
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	let lastRetry: ScheduledRetry | undefined;
	for (;;) {
		const response = await produce();

		// Abort: terminal but not successful. Never retry an aborted message.
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// Success: non-error, non-abort responses return as-is.
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		// Non-retryable, or tiers used up: return the final error message.
		const retry = policy && scheduleRetry(policy, (lastRetry?.attempt ?? 0) + 1, response);
		if (!retry) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		lastRetry = retry;
		await callbacks?.onRetryScheduled?.(retry);

		// Normalize aborts during retry backoff to the same AssistantMessage shape as
		// provider stream aborts, so callers do not need to care when cancellation happened.
		try {
			await sleep(retry.delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, retry.attempt, retry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				const { errorMessage: _errorMessage, ...rest } = response;
				return { ...rest, stopReason: "aborted" };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_CLIENT_STATUS_PATTERN.test(errorMessage)) return false;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage) || transportErrorClass(errorMessage) !== undefined;
}
