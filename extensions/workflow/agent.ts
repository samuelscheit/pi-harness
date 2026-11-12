// agent(): a child agent for a workflow, a fresh Pi session with built-in tools that sees only the
// messages the script sends it. Each child is a session file of its own next to the parent's,
// naming the parent, so the metrics index counts its cost and links it to the calling tool
// (details.childSessions).
//
// `files` guards the working tree (see lock.ts): edit and write outside the files are refused
// before they run; after each run, other changes outside them (shell commands) are found by
// comparing the tree with its state before the run, put back, and returned as `reverted`.

import { relative, resolve } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { absolutePaths, canonical, changedPaths, isAllowed, restore, type Snapshot, snapshot } from "../lib/workspace.ts";
import { type Lease, type LeaseMode, workspaceLock } from "./lock.ts";
import { resolveModel, type Thinking, thinkingOption } from "./models.ts";

export const DEFAULT_AGENT_MODEL = "anthropic/claude-sonnet-5-5";
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
/** Tools that can change files: an agent with one of them and without `files` takes the tree exclusively. */
const WRITING_TOOLS = new Set(["bash", "edit", "write"]);

export interface AgentOptions {
	model: string;
	system?: string;
	tools: string[];
	files?: string[];
	thinking: Thinking;
}

export interface AgentEnv {
	cwd: string;
	/** The repository root; undefined outside a git repository. */
	root: string | undefined;
	runtime: ModelRuntime;
	agentDir: string;
	/** Where child sessions are stored (next to the parent's), and the parent's file; in memory without. */
	sessionDir?: string;
	parentSessionFile?: string;
	signal: AbortSignal;
	/** Each response's cost in USD. */
	spend: (usd: number) => void;
	/** A child session was created. */
	started: (sessionId: string) => void;
	/** A run finished. */
	ran: () => void;
	progress: (line: string) => void;
	warn: (line: string) => void;
	/** Register cleanup for the end of the workflow run. */
	onDispose: (dispose: () => void) => void;
}

export interface AgentHandle {
	run(message: string): Promise<{ text: string; reverted: string[] }>;
	readonly cost: number;
}

const stringList = (value: unknown, name: string): string[] | undefined => {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v.trim())) {
		throw new TypeError(`agent(): ${name} must be a non-empty array of non-empty strings`);
	}
	return value as string[];
};

/** The options a script passed, checked; throws with what is wrong. */
export function agentOptions(raw: unknown): AgentOptions {
	if (raw === undefined || raw === null) return { model: DEFAULT_AGENT_MODEL, tools: DEFAULT_TOOLS, thinking: "medium" };
	if (typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("agent(options?): options must be an object");
	const options = raw as Record<string, unknown>;
	const known = new Set(["model", "system", "tools", "files", "thinking"]);
	const unknown = Object.keys(options).find((key) => !known.has(key));
	if (unknown) throw new TypeError(`agent(): unknown option ${unknown} (use ${[...known].join(", ")})`);
	for (const key of ["model", "system"] as const) {
		if (options[key] !== undefined && typeof options[key] !== "string") throw new TypeError(`agent(): ${key} must be a string`);
	}
	return {
		model: (options.model as string | undefined) ?? DEFAULT_AGENT_MODEL,
		system: options.system as string | undefined,
		tools: stringList(options.tools, "tools") ?? DEFAULT_TOOLS,
		files: stringList(options.files, "files"),
		thinking: options.thinking === undefined ? "medium" : thinkingOption(options.thinking, "agent()"),
	};
}

function systemPrompt(options: AgentOptions, cwd: string): string {
	const role =
		options.system?.trim() ??
		[
			"You are an agent started by a workflow script. You start without the conversation that led here: everything you need is in the messages you get or in the files.",
			"Do what each message asks. When done, answer briefly: your final message is returned to the script as text.",
		].join("\n");
	const files = options.files
		? `\n\nFiles you may change: ${options.files.join(", ")} (paths or directories). edit and write refuse other files, and other changes are reverted.`
		: "";
	return `${role}${files}\n\nWorking directory: ${cwd}`;
}

/** One short line for a child's tool call. */
function callLine(tool: string, args: unknown): string {
	const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const value = [record.command, record.path].find((v): v is string => typeof v === "string") ?? "";
	return `${tool} ${value.split("\n")[0]!.slice(0, 120)}`.trim();
}

async function createChild(options: AgentOptions, allowed: string[] | undefined, env: AgentEnv): Promise<AgentSession> {
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 3 } });
	const guard = (pi: ExtensionAPI) => {
		if (!allowed) return;
		pi.on("tool_call", (event) => {
			if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
			const path = (event.input as { path?: unknown }).path;
			if (typeof path !== "string" || isAllowed(canonical(resolve(env.cwd, path)), allowed)) return undefined;
			return { block: true, reason: `${path} is not one of the files you may change: ${options.files!.join(", ")}` };
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
		systemPrompt: systemPrompt(options, env.cwd),
		extensionFactories: [{ name: "workflow-agent-guard", factory: guard }],
	});
	await resourceLoader.reload();
	const sessionManager = env.sessionDir
		? SessionManager.create(env.cwd, env.sessionDir, { parentSession: env.parentSessionFile })
		: SessionManager.inMemory(env.cwd);
	const { session } = await createAgentSession({
		cwd: env.cwd,
		agentDir: env.agentDir,
		model: resolveModel(env.runtime, options.model),
		thinkingLevel: options.thinking,
		modelRuntime: env.runtime,
		resourceLoader,
		tools: options.tools,
		sessionManager,
		settingsManager,
	});
	return session;
}

/**
 * Put back what a guarded run changed outside the files of its lease; returns the reverted paths
 * relative to cwd, and warns about what could not be put back and a moved HEAD.
 */
async function revertOutside(before: Snapshot, lease: Lease, label: string, env: AgentEnv): Promise<string[]> {
	const after = await snapshot(before.root);
	const outside = (await changedPaths(before, after)).filter((path) => !isAllowed(path, lease.allowed()));
	const failed = await restore(before, outside);
	if (failed.length) env.warn(`${label} changed files outside its files that could not be restored (too large to keep): ${failed.join(", ")}`);
	if (after.head !== before.head) env.warn(`${label}: HEAD moved during its run (${before.head ?? "none"} → ${after.head ?? "none"}); it committed or switched branches`);
	return outside.filter((path) => !failed.includes(path)).map((path) => relative(canonical(env.cwd), path));
}

let agentCount = 0;

/** agent(options): checked at once, the session is created on the first run. */
export function createAgent(raw: unknown, env: AgentEnv): AgentHandle {
	const options = agentOptions(raw);
	resolveModel(env.runtime, options.model);
	if (options.files && !env.root) throw new Error(`agent(): files needs a git repository to tell changes apart; ${env.cwd} is not in one`);
	const allowed = options.files && absolutePaths(options.files, env.cwd);
	const mode: LeaseMode | undefined = allowed ? "shared" : options.tools.some((t) => WRITING_TOOLS.has(t)) ? "exclusive" : undefined;
	const label = `agent ${++agentCount}`;
	let cost = 0;
	let child: Promise<AgentSession> | undefined;
	let disposed = false;
	env.onDispose(() => {
		disposed = true;
		void child?.then((session) => session.dispose(), () => undefined);
	});

	const open = () =>
		(child ??= createChild(options, allowed, env).then((session) => {
			env.started(session.sessionId);
			session.subscribe((event) => {
				if (event.type === "tool_execution_start") env.progress(`${label} · ${callLine(event.toolName, event.args)}`);
				if (event.type === "message_end" && event.message.role === "assistant") {
					cost += event.message.usage.cost.total;
					env.spend(event.message.usage.cost.total);
				}
			});
			return session;
		}));

	// Runs of one agent are one conversation: they go one after the other.
	let queue: Promise<unknown> = Promise.resolve();
	const runOnce = async (message: string) => {
		if (env.signal.aborted) throw env.signal.reason;
		if (disposed) throw new Error(`${label} was used after its workflow ended`);
		const session = await open();
		const lease = mode && (await workspaceLock(env.root ?? env.cwd).acquire(mode, allowed ?? [], env.signal));
		const abort = () => void session.abort();
		const before = allowed && (await snapshot(env.root!));
		let reverted: string[] = [];
		try {
			// No await between this check and prompt(): an abort fired earlier (while the session was
			// created, the lease or the snapshot awaited) would reach a session not running yet and be lost.
			if (env.signal.aborted) throw env.signal.reason;
			env.signal.addEventListener("abort", abort, { once: true });
			env.progress(`${label} · running`);
			await session.prompt(message);
		} finally {
			env.signal.removeEventListener("abort", abort);
			if (before && lease) reverted = await revertOutside(before, lease, label, env);
			lease?.release();
			env.ran();
		}
		if (env.signal.aborted) throw env.signal.reason;
		const last = session.messages.findLast((m) => m.role === "assistant");
		if (last?.role === "assistant" && last.stopReason === "error") throw new Error(`${label}: ${last.errorMessage ?? "the request failed"}`);
		return { text: session.getLastAssistantText() ?? "", reverted };
	};

	return {
		run(message: unknown) {
			if (typeof message !== "string" || !message.trim()) return Promise.reject(new TypeError("agent().run(message): message must be a non-empty string"));
			const result = queue.then(() => runOnce(message));
			queue = result.catch(() => undefined);
			return result;
		},
		get cost() {
			return cost;
		},
	};
}
