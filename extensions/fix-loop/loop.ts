// fix_loop's work: make a failing check pass with a cheap model in a child session with a short
// context, and report back only what the parent needs.
//
// The tool runs the check itself before and after every round, so "green" is the check's exit
// code, never the child's claim. A round is one prompt to the child (it may run the check itself
// in between). The child gets read, bash, edit and write, the goal, the files it may change, the
// check and the failure, without the parent's conversation. edit and write are refused outside the
// allowed files; changes made otherwise (shell commands) are found after each round by comparing
// the working tree with its state before the loop, put back, and named to the child and the
// parent. The child runs as its own session (a file next to the parent's, naming it as parent),
// so the metrics index counts its cost and links it to the parent (details.childSession).

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { runShell, type ShellResult } from "../lib/process.ts";
import { absolutePaths, canonical, changedPaths, diffSince, gitRoot, isAllowed, restore, type Snapshot, snapshot } from "./workspace.ts";

export const DEFAULT_MODEL = "anthropic/claude-sonnet-5-5";
export const DEFAULT_ROUNDS = 6;
export const MAX_ROUNDS = 20;
const DEFAULT_CHECK_TIMEOUT_S = 600;
const CHILD_TOOLS = ["read", "bash", "edit", "write"];
// Check output the child sees per round, and what the parent gets back.
const CHILD_OUTPUT = { maxLines: 200, maxBytes: 20_000 };
const PARENT_OUTPUT = { maxLines: 40, maxBytes: 4_000 };
const PARENT_DIFF = { maxLines: 150, maxBytes: 8_000 };
const SUMMARY_CHARS = 600;

export interface FixLoopParams {
	goal: string;
	files: string[];
	check: string;
	context?: string;
	maxRounds?: number;
	model?: string;
	checkTimeoutSeconds?: number;
}

export interface Tokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface FixLoopDetails {
	/** The check passed at the end (details.ok for the metrics index). */
	ok: boolean;
	phase: "check" | "round" | "done";
	rounds: number;
	maxRounds: number;
	initialExit: number | null;
	finalExit: number | null;
	/** Files the loop changed and kept (absolute; details.changedFiles for the metrics index). */
	changedFiles: string[];
	/** Changes outside the allowed files that were put back, and those that could not be. */
	reverted: string[];
	unrestorable: string[];
	headMoved: boolean;
	aborted: boolean;
	error?: string;
	model: string;
	/** The child session (details.childSession for the metrics index) and its file when persisted. */
	childSession?: string;
	childSessionFile?: string;
	cost: number;
	tokens: Tokens;
	diffFile?: string;
	/** Progress lines while running. */
	log: string[];
}

export interface FixLoopEnv {
	cwd: string;
	modelRuntime: ModelRuntime;
	agentDir: string;
	/** Where to store the child session (next to the parent's), and the parent's file; in memory without. */
	sessionDir?: string;
	parentSessionFile?: string;
	signal?: AbortSignal;
	onUpdate?: (details: FixLoopDetails) => void;
}

const systemPrompt = (params: FixLoopParams, cwd: string) =>
	[
		"You make a failing check pass in a code repository. You start without the conversation that led here; everything you need is below or in the files.",
		"",
		`Goal: ${params.goal}`,
		`Check: \`${params.check}\` (run with bash in ${cwd}; exit code 0 means it passes)`,
		`Files you may change: ${params.files.join(", ")} (paths or directories; edit and write refuse other files, and changes to other files are reverted)`,
		...(params.context?.trim() ? ["", `Context from the caller:\n${params.context.trim()}`] : []),
		"",
		"Read the failure, find its cause, change the allowed files, run the check, repeat until it passes. Fix the cause: do not weaken, skip or delete tests or the check, and do not commit.",
		"When the check passes, or you cannot make progress, stop and answer in one or two sentences: what you changed and why.",
	].join("\n");

const fence = (text: string) => `\`\`\`\n${text.replaceAll("```", "``\u200b`")}\n\`\`\``;

function tail(output: string, limits: { maxLines: number; maxBytes: number }): string {
	const cut = truncateTail(output.trimEnd(), limits);
	return cut.truncated ? `[… ${cut.totalLines - cut.outputLines} earlier lines cut]\n${cut.content}` : cut.content;
}

const exitText = (result: ShellResult) => (result.timedOut ? "timed out" : result.aborted ? "aborted" : `exit ${result.exitCode}`);

/** Resolve "provider/model" with the runtime; throws when unknown or without credentials. */
function resolveModel(runtime: ModelRuntime, spec: string) {
	const slash = spec.indexOf("/");
	if (slash <= 0) throw new Error(`model must be "provider/id", got "${spec}"`);
	const model = runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1));
	if (!model) throw new Error(`unknown model ${spec}`);
	if (!runtime.hasConfiguredAuth(model.provider)) throw new Error(`no credentials for ${model.provider}`);
	return model;
}

async function childSession(params: FixLoopParams, env: FixLoopEnv, allowed: string[]): Promise<AgentSession> {
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 3 } });
	// Refuse edit and write outside the allowed files before they run.
	const guard = (pi: ExtensionAPI) => {
		pi.on("tool_call", (event) => {
			if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
			const path = (event.input as { path?: unknown }).path;
			if (typeof path !== "string" || isAllowed(canonical(resolve(env.cwd, path)), allowed)) return undefined;
			return { block: true, reason: `${path} is not one of the files you may change: ${params.files.join(", ")}` };
		});
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd: env.cwd,
		agentDir: env.agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: systemPrompt(params, env.cwd),
		extensionFactories: [{ name: "fix-loop-guard", factory: guard }],
	});
	await resourceLoader.reload();
	const sessionManager = env.sessionDir
		? SessionManager.create(env.cwd, env.sessionDir, { parentSession: env.parentSessionFile })
		: SessionManager.inMemory(env.cwd);
	const { session } = await createAgentSession({
		cwd: env.cwd,
		agentDir: env.agentDir,
		model: resolveModel(env.modelRuntime, params.model ?? DEFAULT_MODEL),
		thinkingLevel: "medium",
		modelRuntime: env.modelRuntime,
		resourceLoader,
		tools: CHILD_TOOLS,
		sessionManager,
		settingsManager,
	});
	return session;
}

/** One short line for a child's tool call. */
function callLine(tool: string, args: unknown): string {
	const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const value = [record.command, record.path].find((v): v is string => typeof v === "string") ?? "";
	return `${tool} ${value.split("\n")[0]!.slice(0, 120)}`.trim();
}

/** Run the loop; throws only for invalid input (no repository, no files, unknown model). */
export async function runFixLoop(params: FixLoopParams, env: FixLoopEnv): Promise<{ text: string; details: FixLoopDetails }> {
	const root = await gitRoot(env.cwd);
	if (!root) throw new Error(`fix_loop needs a git repository to tell its changes apart; ${env.cwd} is not in one`);
	if (params.files.length === 0) throw new Error("files must name at least one file or directory the loop may change");
	const allowed = absolutePaths(params.files, env.cwd);
	const maxRounds = Math.min(MAX_ROUNDS, Math.max(1, Math.floor(params.maxRounds ?? DEFAULT_ROUNDS)));
	const modelSpec = params.model ?? DEFAULT_MODEL;
	resolveModel(env.modelRuntime, modelSpec);
	const timeoutMs = (params.checkTimeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_S) * 1000;

	const details: FixLoopDetails = {
		ok: false,
		phase: "check",
		rounds: 0,
		maxRounds,
		initialExit: null,
		finalExit: null,
		changedFiles: [],
		reverted: [],
		unrestorable: [],
		headMoved: false,
		aborted: false,
		model: modelSpec,
		cost: 0,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		log: [],
	};
	const progress = (line: string) => {
		details.log = [...details.log, line].slice(-8);
		env.onUpdate?.({ ...details });
	};
	const check = async () => runShell(params.check, { cwd: env.cwd, signal: env.signal, timeoutMs });

	progress("running the check");
	let result = await check();
	details.initialExit = result.exitCode;
	details.finalExit = result.exitCode;
	if (result.aborted) return finish(details, result, undefined, root);
	if (result.exitCode === 0) {
		details.ok = true;
		return finish(details, result, undefined, root);
	}

	const before = await snapshot(root);
	let session: AgentSession | undefined;
	const abort = () => void session?.abort();
	env.signal?.addEventListener("abort", abort, { once: true });
	try {
		session = await childSession({ ...params, model: modelSpec }, env, allowed);
		details.childSession = session.sessionId;
		details.childSessionFile = session.sessionFile;
		details.phase = "round";
		session.subscribe((event) => {
			if (event.type === "tool_execution_start") progress(`round ${details.rounds}/${maxRounds} · ${callLine(event.toolName, event.args)}`);
			if (event.type === "message_end" && event.message.role === "assistant") {
				const usage = event.message.usage;
				details.cost += usage.cost.total;
				details.tokens.input += usage.input;
				details.tokens.output += usage.output;
				details.tokens.cacheRead += usage.cacheRead;
				details.tokens.cacheWrite += usage.cacheWrite;
			}
		});
		let message = `The check fails (${exitText(result)}):\n${fence(tail(result.output, CHILD_OUTPUT))}`;
		while (details.rounds < maxRounds && !env.signal?.aborted) {
			details.rounds += 1;
			progress(`round ${details.rounds}/${maxRounds} · ${details.childSession}`);
			try {
				await session.prompt(message);
			} catch (error) {
				details.error = error instanceof Error ? error.message : String(error);
			}
			// Put back changes outside the allowed files, also when aborted mid-round.
			const outside = (await changedPaths(before, await snapshot(root))).filter((path) => !isAllowed(path, allowed));
			const failed = await restore(before, outside);
			details.reverted = [...new Set([...details.reverted, ...outside.filter((p) => !failed.includes(p))])];
			details.unrestorable = [...new Set([...details.unrestorable, ...failed])];
			if (env.signal?.aborted) break;
			progress(`round ${details.rounds}/${maxRounds} · running the check`);
			result = await check();
			details.finalExit = result.exitCode;
			if (result.exitCode === 0 || result.aborted || details.error) break;
			const reverted = outside.length ? `\nYour changes to ${outside.map((p) => relative(canonical(env.cwd), p)).join(", ")} were reverted: change only ${params.files.join(", ")}.` : "";
			message = `The check still fails (${exitText(result)}, round ${details.rounds} of ${maxRounds}):\n${fence(tail(result.output, CHILD_OUTPUT))}${reverted}`;
		}
		details.aborted = result.aborted || env.signal?.aborted === true;
		details.ok = !details.aborted && result.exitCode === 0;
		return await finish(details, result, { before, summary: session.getLastAssistantText() ?? "" }, root);
	} finally {
		env.signal?.removeEventListener("abort", abort);
		session?.dispose();
	}
}

/** Final details and the parent's compact report. */
async function finish(details: FixLoopDetails, result: ShellResult, run: { before: Snapshot; summary: string } | undefined, root: string): Promise<{ text: string; details: FixLoopDetails }> {
	details.phase = "done";
	details.aborted = result.aborted || details.aborted;
	const lines: string[] = [];
	if (!run) {
		lines.push(details.ok ? `The check already passes (exit 0); nothing to fix.` : `Aborted while running the check.`);
		if (!details.ok && !result.aborted) lines.push(tail(result.output, PARENT_OUTPUT));
		return { text: lines.join("\n"), details };
	}
	const after = await snapshot(root);
	details.headMoved = after.head !== run.before.head;
	details.changedFiles = await changedPaths(run.before, after);
	const state = details.ok
		? `green after ${details.rounds} round${details.rounds === 1 ? "" : "s"}`
		: details.aborted
			? `aborted in round ${details.rounds}`
			: `not green after ${details.rounds} round${details.rounds === 1 ? "" : "s"} (${exitText(result)})`;
	lines.push(`fix_loop: ${state}.`);
	if (details.error) lines.push(`Child session error: ${details.error}`);
	const tokens = details.tokens;
	lines.push(
		`Child: ${details.model}, $${details.cost.toFixed(4)}, tokens in ${tokens.input} / out ${tokens.output} / cache read ${tokens.cacheRead} / cache write ${tokens.cacheWrite}${details.childSessionFile ? `, session ${details.childSessionFile}` : ""}.`,
	);
	const rel = (paths: string[]) => paths.map((p) => relative(root, p)).join(", ");
	if (details.reverted.length) lines.push(`Reverted changes outside the allowed files: ${rel(details.reverted)}.`);
	if (details.unrestorable.length) lines.push(`Changed outside the allowed files and NOT restored (too large to keep): ${rel(details.unrestorable)}.`);
	if (details.headMoved) lines.push(`HEAD moved during the loop (${run.before.head ?? "none"} → ${after.head ?? "none"}): the child committed or switched branches.`);
	if (details.changedFiles.length) {
		const diff = await diffSince(run.before, details.changedFiles);
		const dir = join(tmpdir(), "pi-fix-loop");
		mkdirSync(dir, { recursive: true });
		details.diffFile = join(dir, `${details.childSession ?? Date.now()}.diff`);
		writeFileSync(details.diffFile, diff);
		const cut = truncateHead(diff, PARENT_DIFF);
		lines.push(`Changed files: ${rel(details.changedFiles)}.`, `Diff${cut.truncated ? ` (cut; full diff in ${details.diffFile})` : ""}:`, fence(cut.content.trimEnd()));
	} else {
		lines.push("No files changed.");
	}
	if (!details.ok && !details.aborted) lines.push(`Last check output:\n${fence(tail(result.output, PARENT_OUTPUT))}`);
	const summary = run.summary.trim();
	if (summary) lines.push(`Child's summary: ${summary.length > SUMMARY_CHARS ? `${summary.slice(0, SUMMARY_CHARS)}…` : summary}`);
	return { text: lines.join("\n"), details };
}
