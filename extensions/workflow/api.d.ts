// The globals of a workflow script. This file is the model-facing reference (the `workflow` tool's
// description embeds everything below the marker line) and the declarations saved workflows are
// type-checked against (workflows/tsconfig.json). Keep it short: it is sent with every request.
// ---

/*
 * Runs are durable: every call below (tools, shell, llm, delegates, workflows, changes) is
 * journaled, and a run whose process died is resumed by running the script again, with recorded
 * calls answered from the journal. So keep the script deterministic: act on the outside only
 * through these calls (Date.now(), new Date() and Math.random() are recorded too). A shell or tool
 * call that was running at the crash is not repeated unless marked `idempotent: true`. A resume
 * runs failed delegate runs, llm() calls and workflows.* again (a failed run can be resumed);
 * failed shell and tool calls throw their recorded error again. A resume with edited code answers
 * the calls it makes as before from the journal and runs live from its first other call.
 */

/**
 * The session's tools, called as you call them (same validation, hooks, permissions), each awaited
 * until its answer exists. A tool with a structured result resolves to it, also when it fails
 * (bash: `{ output, exit_code }`); others resolve to their text and reject with their error.
 * `ask_user` resolves to the answers (it waits until answered or the run stops); t3's
 * `delegate_task` is `delegate`.
 */
declare const tools: Record<string, (args: Record<string, unknown>, options?: { idempotent?: boolean }) => Promise<any>> & {
	ask_user(args: { questions: { title: string; options?: { label: string; description?: string }[] }[] }, options?: { idempotent?: boolean }): Promise<(string | undefined)[]>;
	"mcp__t3-code__delegate_task": typeof delegate;
};

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
 * A child agent that sees only what you send it, not this conversation: t3's delegate_task, awaited
 * (in T3 Code a task with a thread under this one, which the user can watch, steer and stop;
 * elsewhere an in-process session). Same parameters, without the task. Without `target`, `system`
 * or `tools` the child has your model and the default prompt and tools. `schema` (JSON Schema of
 * an object): the child must submit a matching object, returned as `result`. The child starts on
 * its first run(); later runs continue its conversation; each resolves once it stops, with `text`
 * (its final message), `changed` (files the working tree changed meanwhile, other agents' too),
 * `wrote` (the files the child's own tool calls changed: edit and write paths, and files a bash
 * command changed and names) and `cost`. `compact` is Pi's /compact, `warm` the harness's /warm ("2h", "until 18:00", "off": hold
 * the child's prompt cache warm until its next run); `fork` starts a new child from this one's conversation.
 * `template` (a name from .pi/templates/ or `/template list`) starts the child from that prepared
 * session (role, files read, examples) on its model, cached once for every task: use one when a
 * template exists for the kind of task.
 * `onAsk` gets the child's ask_user questions: return answers (in order, or by question id), which
 * the child receives as its tool result, or undefined to pass them up to whoever runs you; throw to
 * stop the run. Answers are journaled and replayed on resume.
 */
declare function delegate(params?: {
	target?: { model?: string; providerInstanceId?: string; options?: Record<string, unknown> };
	title?: string;
	role?: "implementation" | "research" | "review" | "design" | "test" | "general";
	isolation?: "shared" | "worktree";
	system?: string;
	tools?: string[];
	schema?: object;
	template?: string;
	fork?: boolean;
	forkThreadId?: string;
	onAsk?: (questions: { id: string; title: string; options?: { label: string; description?: string }[] }[]) => Promise<string[] | Record<string, string> | undefined>;
}): Delegate;

interface DelegateRun {
	text: string;
	result?: any;
	changed: string[];
	wrote: string[];
	cost: number;
	sessionId?: string;
	threadId?: string;
}

interface Delegate {
	/** Inside a phase the message starts with a short header (phase path, plan) unless `header: false`. */
	run(message: string, options?: { header?: boolean }): Promise<DelegateRun>;
	compact(instructions?: string): Promise<void>;
	warm(duration: string): Promise<void>;
	steer(text: string): Promise<void>;
	stop(): Promise<void>;
	fork(message: string): Promise<DelegateRun & { handle: Delegate }>;
	/** USD so far. */
	readonly cost: number;
	readonly threadId: string | undefined;
}

/**
 * Run `fn` as a named phase: nestable and repeatable (iterations are numbered: "review · round 2").
 * The run's page and `workflow { status }` show the phase tree with time and cost. Over its
 * `budget` (USD) the phase throws PhaseBudgetExceeded, which you can catch; its calls are aborted.
 */
declare function phase<T>(name: string, fn: () => Promise<T>, options?: { budget?: number }): Promise<T>;

/** The phases expected next in the current scope, shown as expected until they start; change it any time. Display only. */
declare const plan: { expect(names: string[]): void };

type Thinking = "off" | "minimal" | "low" | "medium" | "high";

/**
 * Map over items with at most `concurrency` (default 4) calls at once. A failing item does not stop
 * the others: all run, then a MapError lists the failed ones (`.failed` indexes, `.results`), and a
 * resume runs only those again. With `settle: true` it never throws for an item and returns each
 * one's outcome. A budget used up or a stop ends it at once.
 */
declare function map<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>, options: { concurrency?: number; settle: true }): Promise<({ ok: true; value: R } | { ok: false; error: Error })[]>;
declare function map<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>, options?: { concurrency?: number; settle?: false }): Promise<R[]>;

/** A progress line (console.log does the same). The last lines are returned when the script fails. */
declare function log(...values: unknown[]): void;

/** The files changed since this run started (only those `paths` name, files or directories, when given), with their unified diff (git repositories only). */
declare function changes(paths?: string[]): Promise<{ files: string[]; diff: string }>;

/** This run's spending limit in USD and what llm() and delegates spent so far. Exceeding it aborts the run. */
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
