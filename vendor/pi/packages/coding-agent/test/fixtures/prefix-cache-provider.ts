/**
 * Provider "simcache" for real-process tests: Anthropic's prompt cache simulated in a directory
 * shared by every pi process ($SIM_CACHE_DIR). A request writes an entry at its last message and
 * reads the longest live entry among the 20 positions ending there (one position per message).
 * Requests are logged to $SIM_CACHE_DIR/requests.jsonl. Summary-model requests take
 * $SIM_SUMMARY_DELAY_MS, so parallel forks overlap while one compacts.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../src/index.ts";

const dir = process.env.SIM_CACHE_DIR!;
const ttlSeconds = Number(process.env.SIM_TTL_SECONDS ?? "300");

function live(key: string, now: number): boolean {
	try {
		return Number(readFileSync(join(dir, "entries", key), "utf8")) > now;
	} catch {
		return false;
	}
}

function simulate(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
	mkdirSync(join(dir, "entries"), { recursive: true });
	const now = Date.now();
	const wire = context.messages.map((message) => ({ role: message.role, content: message.content }));
	const start = wire[0]?.role === "system" ? 1 : 0;
	const prefixes = wire.slice(start).map((_, index) => {
		const text = JSON.stringify(wire.slice(0, start + index + 1));
		return {
			key: createHash("sha256").update(`${model.id}\n${text}`).digest("hex"),
			tokens: Math.ceil(text.length / 4),
		};
	});
	const last = prefixes.at(-1)!;
	let read: (typeof prefixes)[number] | undefined;
	for (let index = prefixes.length - 1; index >= Math.max(0, prefixes.length - 20); index--) {
		if (live(prefixes[index]!.key, now)) {
			read = prefixes[index];
			break;
		}
	}
	const expiresAt = String(now + ttlSeconds * 1000);
	if (read) writeFileSync(join(dir, "entries", read.key), expiresAt);
	writeFileSync(join(dir, "entries", last.key), expiresAt);
	const cacheRead = read?.tokens ?? 0;
	const usage = { input: 0, output: 1, cacheRead, cacheWrite: last.tokens - cacheRead };
	appendFileSync(
		join(dir, "requests.jsonl"),
		`${JSON.stringify({ pid: process.pid, model: model.id, at: now, maxTokens: options?.maxTokens, ...usage })}\n`,
	);
	return usage;
}

function stream(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
	const out = createAssistantMessageEventStream();
	void (async () => {
		if (model.id === "summary") {
			await new Promise((resolve) => setTimeout(resolve, Number(process.env.SIM_SUMMARY_DELAY_MS ?? "0")));
		}
		const usage = simulate(model, context, options);
		const text = model.id === "summary" ? "## Goal\nsummary" : "ok";
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				...usage,
				totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		out.push({ type: "start", partial: { ...message, content: [] } });
		out.push({ type: "done", reason: "stop", message });
	})();
	return out;
}

export default function (pi: ExtensionAPI) {
	const model = (id: string, cost: { input: number; output: number; cacheRead: number; cacheWrite: number }) => ({
		id,
		name: id,
		reasoning: false,
		input: ["text" as const],
		cost,
		contextWindow: 200_000,
		maxTokens: 8_000,
		promptCache: { short: ttlSeconds, long: ttlSeconds },
	});
	pi.registerProvider("simcache", {
		baseUrl: "http://localhost.invalid",
		apiKey: "sim",
		api: "simcache-api",
		models: [
			model("main", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }),
			model("summary", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }),
		],
		streamSimple: stream,
	});
}
