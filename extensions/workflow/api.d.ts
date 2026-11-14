// The globals of a workflow script. This file is the model-facing reference (the `workflow` tool's
// description embeds everything below the marker line) and the declarations saved workflows are
// type-checked against (workflows/tsconfig.json). Keep it short: it is sent with every request.
// ---

/*
 * Runs are durable: every call below (tools, shell, llm, agent().run, workflows, changes) is
 * journaled, and a run whose process died is resumed by running the script again, with recorded
 * calls answered from the journal. So keep the script deterministic: act on the outside only
 * through these calls (Date.now(), new Date() and Math.random() are recorded too). A shell or tool
 * call that was running at the crash is not repeated unless marked `idempotent: true`. A resume with
 * edited code answers the calls it makes as before from the journal and runs live from its first
 * other call.
 */

/**
 * The session's tools, called as you call them (same validation, hooks, permissions). A tool with a
 * structured result resolves to it, also when it fails (bash: `{ output, exit_code }`); others
 * resolve to their text and reject with their error.
 */
declare const tools: Record<string, (args: Record<string, unknown>, options?: { idempotent?: boolean }) => Promise<any>>;

/** Run a bash command in `cwd`; resolves also for non-zero exits. Output is stdout and stderr interleaved. Build commands from values with `sh`. */
declare function shell(command: string, options?: { cwd?: string; timeoutSeconds?: number; idempotent?: boolean }): Promise<{ exitCode: number | null; output: string; timedOut: boolean }>;

/**
 * Template tag: the command with each `${value}` (string, number, or an array of them) inserted as
 * one quoted shell word, so values never become shell syntax. Write values unquoted and put `--`
 * before values that could start with `-`: shell(sh`grep -rn -- ${pattern} ${dirs}`).
 */
declare function sh(strings: TemplateStringsArray, ...values: unknown[]): string;

/**
 * One model request without tools. Resolves to the answer's text, or with `schema` (JSON Schema of an
 * object) to an object valid against it (invalid answers are retried twice). Results are cached for
 * the session by exact input, so rerunning an edited script repeats only changed calls; `cache: false`
 * samples again. Default model anthropic/claude-haiku-5-5.
 */
declare function llm(prompt: string, options?: { model?: string; system?: string; schema?: object; thinking?: Thinking; cache?: boolean }): Promise<any>;

/**
 * A child agent that sees only what you send it, not this conversation. In T3 Code it is a delegated
 * task with a thread under this one, which the user can watch, steer and stop; elsewhere an
 * in-process session. Started on its first run(); each run() sends one message (later ones resume
 * the same conversation) and resolves once the agent stops: `text` its final message, `changed` the
 * files the working tree changed meanwhile (other agents' too), `cost` the run's USD.
 * Default model anthropic/claude-sonnet-5-5, tools read, bash, edit, write (names only); `system`
 * replaces its default role prompt. `schema` (JSON Schema of an object): the agent must submit an
 * object matching it, returned as `result`, or the run fails. `files`: told to the agent as the
 * files to change, not enforced. Agents run in parallel in the same working tree.
 */
declare function agent(options?: { model?: string; system?: string; tools?: string[]; files?: string[]; schema?: object; thinking?: Thinking }): {
	run(message: string): Promise<{ text: string; result?: any; changed: string[]; cost: number; sessionId?: string; threadId?: string }>;
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
 * A saved workflow is a file `<repo>/.pi/workflows/<name>.ts` that becomes the tool `<name>` from the
 * next turn, also in later sessions. Its top level only declares; imports are not available. E.g. a
 * command you keep running with different arguments:
 *   export const meta: WorkflowMeta = { description: "Run one test file; failures only.", budget: 0.01,
 *     parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } };
 *   export default async function ({ file }: { file: string }) {
 *     const r = await shell(sh`npm test -- ${file}`);
 *     return r.exitCode === 0 ? "passed" : r.output.split("\n").filter((l) => /FAIL|Error/.test(l)).join("\n");
 *   }
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
