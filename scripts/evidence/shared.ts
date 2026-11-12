// Shared pieces of the context evidence scripts: the read-only metrics index and the message labels.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { metricsPath } from "../../extensions/metrics/stats.ts";

export const openIndex = () => new DatabaseSync(metricsPath(), { readOnly: true });

export const LABELS = ["correction", "forgot_context", "process", "quality", "failure_report", "new_task", "question", "answer", "approval", "other"] as const;
export type Label = (typeof LABELS)[number];

/** Labels that mean the agent fell short: the user had to correct, remind, complain or report breakage. */
export const NEGATIVE: readonly Label[] = ["correction", "forgot_context", "process", "quality", "failure_report"];

/** Labels by `${session_id} ${entry_id}`. */
export type Labels = Record<string, { label: Label; rule: string | null; model: string }>;
export const LABELS_FILE = join(homedir(), ".pi", "agent", "cache", "user-message-labels.json");

let credentials: { apiKey: string; baseUrl: string } | undefined;

/**
 * Ask an Anthropic model through the user's gateway (Pi's anthropic provider) and parse the JSON
 * value in its reply. `validate` throws on a malformed answer; the call is retried up to 3 times.
 * The reply is streamed, so a long answer keeps the connection busy past the gateway's idle timeout.
 */
export async function askJson<T>(model: string, system: string, user: string, validate: (value: unknown) => T, maxTokens = 8000): Promise<T> {
	credentials ??= {
		apiKey: execFileSync("pi", ["auth", "print-api-key", "--provider", "anthropic"], { encoding: "utf8" }).trim(),
		baseUrl: (JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8")) as { providers: { anthropic: { baseUrl: string } } }).providers.anthropic.baseUrl.replace(/\/$/, ""),
	};
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await fetch(`${credentials.baseUrl}/v1/messages`, {
				method: "POST",
				headers: { "x-api-key": credentials.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
				body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, system, messages: [{ role: "user", content: user }] }),
			});
			if (!response.ok || !response.body) throw new Error(`${response.status}: ${(await response.text()).slice(0, 200)}`);
			let text = "";
			let buffer = "";
			for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.startsWith("data:")) continue;
					const event = JSON.parse(line.slice(5)) as { type: string; delta?: { type: string; text?: string }; error?: { message: string } };
					if (event.type === "error") throw new Error(event.error?.message);
					if (event.type === "content_block_delta" && event.delta?.type === "text_delta") text += event.delta.text ?? "";
				}
			}
			const start = text.search(/[[{]/);
			const end = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
			return validate(JSON.parse(text.slice(start, end + 1)));
		} catch (error) {
			if (attempt >= 3) throw error;
			await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
		}
	}
}
