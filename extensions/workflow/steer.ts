// Steering a run's running delegates (`workflow { steer }`), from any session or process: a new
// rule or correction reaches the children while they work, without stopping the run.
//
// As a stop (stop.ts), the request is a file in the run's directory (`steer/<nonce>.json`: the text
// and which delegates). The process that runs the run polls for requests (`watchSteer`), steers each
// matching delegate whose run is in flight with its handle's transport (t3: a steer message to its
// task's thread; in-process: Pi's steering of the child's turn), and answers in
// `steer/<nonce>.answer.json`, which `steerRun` waits for. Delegates are named by their title (the
// t3 task title `workflow { status }` lists; a part of it is enough), thread id or label
// (`delegate 2`, `#2`); none names every running one. A steer is not journaled: it is no call of
// the script, so a resume must not expect it.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SteerTarget } from "./delegate.ts";
import { runDir, runState } from "./journal.ts";
import { lockHeld, until } from "./stop.ts";

export interface SteerRequest {
	text: string;
	/** Titles (or parts of them), thread ids or labels; absent: every running delegate. */
	delegates?: string[];
}

export interface SteerAnswer {
	ok: boolean;
	text: string;
}

const STEER_DIR = "steer";
const POLL_MS = 200;
/** How long `workflow { steer }` waits for the run's process to answer. */
const STEER_WAIT_MS = 30_000;
const ANSWER = ".answer.json";

const steerDir = (dir: string) => join(dir, STEER_DIR);

/** How a delegate is named in answers: `delegate 2 "title" (thread …)`. */
const describe = (target: SteerTarget) => [target.label, target.title && JSON.stringify(target.title), target.threadId && `(thread ${target.threadId})`].filter(Boolean).join(" ");

/** The running delegates a selector names: exact names first (thread id, title, label, `#n`), else titles containing it. */
function selected(running: readonly SteerTarget[], selector: string): SteerTarget[] {
	const wanted = selector.trim();
	const exact = running.filter((t) => [t.threadId, t.title, t.label, `#${t.label.split(" ").at(-1)}`].includes(wanted));
	if (exact.length) return exact;
	const lower = wanted.toLowerCase();
	return lower ? running.filter((t) => t.title?.toLowerCase().includes(lower)) : [];
}

/** Steer the running delegates the request names; nothing is steered when a name matches none. */
export async function steerTargets(targets: readonly SteerTarget[], request: SteerRequest, signal: AbortSignal): Promise<SteerAnswer> {
	const running = targets.filter((t) => t.running);
	const list = running.length ? `Running: ${running.map(describe).join("; ")}.` : "No delegate of the run is running.";
	if (!running.length) return { ok: false, text: list };
	let chosen = running;
	if (request.delegates?.length) {
		const unmatched = request.delegates.filter((selector) => !selected(running, selector).length);
		if (unmatched.length) return { ok: false, text: `No running delegate matches ${unmatched.map((s) => JSON.stringify(s)).join(", ")}; nothing was steered. ${list}` };
		chosen = running.filter((t) => request.delegates!.some((selector) => selected(running, selector).includes(t)));
	}
	const outcomes = await Promise.allSettled(chosen.map((t) => t.steer(request.text, signal)));
	const failed = outcomes.flatMap((outcome, i) => (outcome.status === "rejected" ? [`${describe(chosen[i]!)}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`] : []));
	const steered = chosen.filter((_, i) => outcomes[i]!.status === "fulfilled");
	const text = [steered.length ? `Steered ${steered.length} delegate${steered.length === 1 ? "" : "s"}: ${steered.map(describe).join("; ")}.` : "", failed.length ? `Failed: ${failed.join("; ")}.` : ""].filter(Boolean).join(" ");
	return { ok: failed.length === 0, text };
}

/** Answer each steer request of the run in `dir` with `targets()`, until closed; `log` notes each steer for the run's progress. */
export function watchSteer(dir: string, targets: () => readonly SteerTarget[], signal: AbortSignal, log: (line: string) => void): { close: () => void } {
	const taken = new Set<string>();
	const timer = setInterval(() => {
		let names: string[];
		try {
			names = readdirSync(steerDir(dir));
		} catch {
			return;
		}
		for (const name of names.filter((n) => n.endsWith(".json") && !n.endsWith(ANSWER) && !taken.has(n))) {
			taken.add(name);
			const file = join(steerDir(dir), name);
			let request: SteerRequest;
			try {
				request = JSON.parse(readFileSync(file, "utf8")) as SteerRequest;
			} catch {
				// Written by rename, so whole; unreadable means it is no request.
				continue;
			}
			void steerTargets(targets(), request, signal)
				.catch((error: unknown): SteerAnswer => ({ ok: false, text: error instanceof Error ? error.message : String(error) }))
				.then((answer) => {
					if (answer.ok) log(`steer: ${answer.text}`);
					const out = join(steerDir(dir), name.replace(/\.json$/, ANSWER));
					writeFileSync(`${out}.tmp`, JSON.stringify(answer));
					renameSync(`${out}.tmp`, out);
					rmSync(file, { force: true });
				});
		}
	}, POLL_MS);
	timer.unref();
	return { close: () => clearInterval(timer) };
}

/** `workflow { steer }`: ask the running run's process to steer its delegates; resolves to its answer, throws when it cannot. */
export async function steerRun(agentDir: string, id: string, request: SteerRequest, waitMs = STEER_WAIT_MS): Promise<string> {
	if (!request.text.trim()) throw new Error("steer needs a non-empty text");
	const { end } = runState(agentDir, id);
	if (end) throw new Error(`workflow run ${id} already ended (${end.status}); its delegates take no steering through it.${end.status === "stopped" ? " Agents a stop left running are t3 threads: send them a message with t3_thread_send." : ""}`);
	if (!lockHeld(agentDir, id)) throw new Error(`workflow run ${id} is not running: its process ended. Resume it with workflow { resume: "${id}" } first.`);
	const dir = steerDir(runDir(agentDir, id));
	mkdirSync(dir, { recursive: true });
	const nonce = randomUUID();
	const file = join(dir, `${nonce}.json`);
	writeFileSync(`${file}.tmp`, JSON.stringify(request));
	renameSync(`${file}.tmp`, file);
	const answerFile = join(dir, `${nonce}${ANSWER}`);
	const answered = await until(() => existsSync(answerFile) || runState(agentDir, id).end !== undefined, waitMs);
	if (!existsSync(answerFile)) {
		rmSync(file, { force: true });
		throw new Error(answered ? `workflow run ${id} ended before it took the steer.` : `workflow run ${id} did not take the steer within ${waitMs / 1000} s.`);
	}
	const answer = JSON.parse(readFileSync(answerFile, "utf8")) as SteerAnswer;
	rmSync(answerFile, { force: true });
	if (!answer.ok) throw new Error(`workflow run ${id}: ${answer.text}`);
	return `Workflow run ${id}: ${answer.text}`;
}
