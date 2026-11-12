// The globals of a workflow script. This file is the model-facing reference (the `workflow` tool's
// description embeds everything below the marker line) and the declarations saved workflows are
// type-checked against (workflows/tsconfig.json). Keep it short: it is sent with every request.
// ---

/**
 * The session's tools, called as you call them (same validation, hooks, permissions). A tool with a
 * structured result resolves to it, also when it fails (bash: `{ output, exit_code }`); others
 * resolve to their text and reject with their error.
 */
declare const tools: Record<string, (args: Record<string, unknown>) => Promise<any>>;

/** Run a bash command in `cwd`; resolves also for non-zero exits. Output is stdout and stderr interleaved. */
declare function shell(command: string, options?: { cwd?: string; timeoutSeconds?: number }): Promise<{ exitCode: number | null; output: string; timedOut: boolean }>;

/**
 * One model request without tools. Resolves to the answer's text, or with `schema` (JSON Schema of an
 * object) to an object valid against it (invalid answers are retried twice). Results are cached for
 * the session by exact input, so rerunning an edited script repeats only changed calls; `cache: false`
 * samples again. Default model anthropic/claude-haiku-5-5.
 */
declare function llm(prompt: string, options?: { model?: string; system?: string; schema?: object; thinking?: Thinking; cache?: boolean }): Promise<any>;

/**
 * A child agent: a fresh session with tools that sees only what you send it, not this conversation.
 * Created on its first run(); each run() sends one message and resolves with the agent's final text
 * once it stops. Default model anthropic/claude-sonnet-5-5, tools read, bash, edit, write.
 * `files`: the only files or directories it may change. Edits elsewhere are refused, other changes
 * are reverted after each run and listed in `reverted` (needs a git repository). Agents that may
 * write without `files` run one at a time; agents with `files` run in parallel.
 */
declare function agent(options?: { model?: string; system?: string; tools?: string[]; files?: string[]; thinking?: Thinking }): {
	run(message: string): Promise<{ text: string; reverted: string[] }>;
	/** Cost in USD so far. */
	readonly cost: number;
};

type Thinking = "off" | "minimal" | "low" | "medium" | "high";

/** Map over items with at most `concurrency` (default 4) calls at once. On the first error it starts no more items and rejects once running ones settle. */
declare function map<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>, options?: { concurrency?: number }): Promise<R[]>;

/** A progress line (console.log does the same). The last lines are returned when the script fails. */
declare function log(...values: unknown[]): void;

/** The files changed since this run started, with their unified diff (git repositories only). */
declare function changes(): Promise<{ files: string[]; diff: string }>;

/** This run's spending limit in USD and what llm() and agent() spent so far. Exceeding it aborts the run. */
declare const budget: { readonly limit: number; readonly spent: number };

/** Saved workflows, called with their input. They share this run's budget. */
declare const workflows: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;

/** The session's working directory. */
declare const cwd: string;

/**
 * A saved workflow is a file `<repo>/.pi/workflows/<name>.ts` that becomes the tool `<name>`:
 *   export const meta: WorkflowMeta = { description, parameters, budget };
 *   export default async function (input) { ...; return result; }
 * Its top level only declares; imports are not available.
 */
interface WorkflowMeta {
	/** What it does and when to call it: the tool's description. */
	description: string;
	/** JSON Schema of the input object: the tool's parameters. */
	parameters: object;
	/** Spending limit of one run in USD. */
	budget: number;
	/** When to use it, added to the system prompt while the tool is active. */
	guidelines?: string[];
}
