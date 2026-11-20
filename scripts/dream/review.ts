// Dreaming, quality review: a model grades sampled sessions of both arms of an experiment, blind to
// the arm, as the judge's (judge.ts) direct quality measure next to the labels and tool metrics.
// A saving that shows up in cost but makes the work worse must not pass.
//
// The reviewer sees a digest of the session while it was in the experiment: what the user wrote,
// what the agent said, its tool calls (with a short input) and which of them failed, never the
// system prompt, the model, settings or arm. It grades the outcome from 1 to 10. Reviews are kept
// in `.agents/dreams/reviews.jsonl` (local state) per experiment and session, so every session is
// graded once and the sample grows run by run.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendJsonl, readJsonl } from "../../extensions/lib/jsonl.ts";
import { summarizeToolInput } from "../../extensions/metrics/blocks.ts";
import { clip } from "../../extensions/metrics/format.ts";
import { type Ask, askJson } from "../lib/labels.ts";
import { dreamsDir } from "./ledger.ts";

export const REVIEW_MODEL = "claude-opus-5-5";
/** Reviews per arm the judge needs before it promotes. */
export const REVIEWS_PER_ARM = 30;
/** Reviews per arm at most: more sessions narrow the review interval when it is still open at REVIEWS_PER_ARM. */
export const MAX_REVIEWS_PER_ARM = 60;
/** A session must have been idle this long before it is reviewed, so its outcome is known. */
export const SETTLED_MS = 2 * 3_600_000;
const MAX_DIGEST_CHARS = 60_000;
const CONCURRENCY = 4;

export interface Review {
	experiment: string;
	session: string;
	arm: string;
	score: number;
	reason: string;
	model: string;
	at: string;
}

const reviewsFile = (source: string) => join(dreamsDir(source), "reviews.jsonl");
export const readReviews = (source: string): Review[] =>
	readJsonl(reviewsFile(source), (r) => typeof (r as Review).session === "string" && typeof (r as Review).score === "number" && typeof (r as Review).arm === "string");
export const appendReviews = (source: string, reviews: readonly Review[]) => appendJsonl(reviewsFile(source), reviews);

interface Part {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
}

const partsOf = (content: unknown): Part[] => (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Part[]) : []);

/**
 * The blinded digest of a session file between `from` and `to` (ms; `to` undefined: open): user
 * messages, the agent's text, its tool calls and their failures. Long digests keep their start
 * (the task) and their end (the outcome).
 */
export function digest(content: string, from: number, to?: number): string {
	const lines: string[] = [];
	for (const raw of content.split("\n")) {
		if (!raw.trim()) continue;
		let entry: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown; isError?: boolean; toolName?: string } };
		try {
			entry = JSON.parse(raw);
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const ts = Date.parse(entry.timestamp ?? "");
		if (!(ts >= from) || (to !== undefined && ts >= to)) continue;
		const { role } = entry.message;
		const parts = partsOf(entry.message.content);
		if (role === "user") {
			const text = parts.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("").trim();
			if (text) lines.push(`USER: ${clip(text, 4000)}`);
		} else if (role === "assistant") {
			for (const p of parts) {
				if (p.type === "text" && p.text?.trim()) lines.push(`AGENT: ${clip(p.text.trim(), 3000)}`);
				else if (p.type === "toolCall") lines.push(`TOOL ${p.name}: ${clip(summarizeToolInput(p.arguments), 200)}`);
			}
		} else if (role === "toolResult" && entry.message.isError) {
			const text = parts.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("").trim();
			lines.push(`TOOL FAILED (${entry.message.toolName ?? "tool"}): ${clip(text, 300)}`);
		}
	}
	const text = lines.join("\n");
	if (text.length <= MAX_DIGEST_CHARS) return text;
	const head = Math.floor(MAX_DIGEST_CHARS * 0.3);
	const tail = MAX_DIGEST_CHARS - head;
	return `${text.slice(0, head)}\n[… ${text.length - MAX_DIGEST_CHARS} characters of the middle left out …]\n${text.slice(-tail)}`;
}

const INSTRUCTIONS = `You grade one working session of an AI coding agent for its user, from a digest: USER lines are what the user wrote, AGENT lines what the agent said, TOOL lines its tool calls (with a short input), TOOL FAILED lines calls that failed. A session may be a subagent working on a task its parent agent gave it; then the first USER message is that task.

Grade the quality of the outcome from 1 (useless or harmful) to 10 (excellent): did the agent do what was asked, correctly and completely, following the user's instructions; did it verify its work; how often did the user have to correct, repeat or rescue it; did it claim success it did not reach. Do not grade cost, speed or length unless they hurt the result. When the digest leaves the outcome unclear, grade what it shows and say so.

Reply with only JSON: {"score": <integer 1-10>, "reason": "<one or two sentences>"}.`;

export function parseReview(value: unknown): { score: number; reason: string } {
	const { score, reason } = (value ?? {}) as { score?: unknown; reason?: unknown };
	if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 10) throw new Error(`score must be an integer 1-10, got ${JSON.stringify(score)}`);
	return { score, reason: typeof reason === "string" ? reason : "" };
}

export interface ReviewCandidate {
	session: string;
	arm: string;
	/** The session file. */
	file: string;
	/** When the session was in the experiment. */
	from: number;
	to?: number;
}

/** A stable pseudo-random order of an experiment's sessions, so the sample does not depend on the run. */
const order = (experiment: string, session: string) => createHash("sha256").update(`${experiment}\0${session}`).digest("hex");

/** The sessions to review next: per arm, the unreviewed ones in a stable random order, up to `perArm` reviews in all. */
export function sample(experiment: string, candidates: readonly ReviewCandidate[], reviewed: ReadonlySet<string>, perArm = MAX_REVIEWS_PER_ARM): ReviewCandidate[] {
	const arms = [...new Set(candidates.map((c) => c.arm))].sort();
	return arms.flatMap((arm) => {
		const inArm = candidates.filter((c) => c.arm === arm);
		const done = inArm.filter((c) => reviewed.has(c.session)).length;
		return inArm
			.filter((c) => !reviewed.has(c.session))
			.sort((a, b) => order(experiment, a.session).localeCompare(order(experiment, b.session)))
			.slice(0, Math.max(0, perArm - done));
	});
}

/** Review the sampled sessions of an experiment; sessions without a readable digest are skipped. */
export async function reviewSessions(experiment: string, candidates: readonly ReviewCandidate[], { ask = askJson, now = new Date() }: { ask?: Ask; now?: Date } = {}): Promise<Review[]> {
	const reviews: Review[] = [];
	let next = 0;
	const worker = async () => {
		while (next < candidates.length) {
			const c = candidates[next++]!;
			const text = existsSync(c.file) ? digest(readFileSync(c.file, "utf8"), c.from, c.to) : "";
			if (!text) continue;
			const { score, reason } = await ask(REVIEW_MODEL, INSTRUCTIONS, `<session>\n${text}\n</session>`, parseReview, 1000);
			reviews.push({ experiment, session: c.session, arm: c.arm, score, reason, model: REVIEW_MODEL, at: now.toISOString() });
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));
	return reviews.sort((a, b) => a.session.localeCompare(b.session));
}
