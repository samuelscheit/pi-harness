#!/usr/bin/env node
// Patch the installed t3 app's bundled Pi adapter with fixes prepared in ../t3code that t3 has not
// shipped yet. Each patch up to background-items-caller mirrors a t3code commit; the later ones are
// written against the installed bundle only (../t3code's main has moved on, e.g. it already completes
// a run whose turn was interrupted by a workspace move, which the installed build lacks):
//
// - cache-warming (branch pi-cache-warming-keeps-session, "fix(provider-pi): keep a Pi session loaded
//   while its prompt cache warming is pending"): t3 unloads a provider session after 30 idle minutes
//   unless its runtime reports background work; its Pi adapter only reported native wakes, so the
//   refresh Pi schedules before a one-hour cache expires (54 min) never ran. Pi (vendor/pi) emits
//   `cache_warming` events.
// - dialogs (branch pi-dialogs-outlive-turns, "fix(provider-pi): keep Pi dialogs open past the turn
//   that showed them"): t3 cancelled every open Pi dialog when a turn ended, so an `ask_user`
//   question (which returns at once and is answered later) vanished moments after it appeared and
//   reached the agent as dismissed. Dialogs now live until answered, until Pi reports closing one
//   itself (`dismiss`, sent by vendor/pi), or until the process exits; an open dialog keeps the
//   session loaded.
// - session-questions (same branch, "fix(provider-pi): a Pi question belongs to the session, so a
//   turn's end leaves it open"): the orchestrator also closes a turn's pending questions when the
//   turn ends (ProviderEventIngestor.dismissNativeUserInputs, matched by the request's turn), so the
//   card still vanished, silently: Pi never heard of it and kept the dialog open. A select, input or
//   editor dialog's runtime request now carries no turn; its card keeps the turn for display.
//   Approvals (confirm) stay the turn's: that sweep never closes them.
// - background-work (same branch, "fix(provider-pi): keep a Pi session loaded while its extensions
//   have background work"): a bash command the harness moved to the background wakes the session
//   when it ends, so the session must outlive t3's 30-minute idle unload and the run must not
//   settle early (a delegated child would report done while its build still runs). Pi (vendor/pi)
//   emits `background_work` with the pending count (`pi.setBackgroundWork`).
// - questions (same branch, "feat(provider-pi): show a Pi questions dialog as one card"): Pi's
//   dialogs carried one question each, so an `ask_user` call with four questions became four cards
//   shown one after another. Pi (vendor/pi) now has a `questions` dialog (`ctx.ui.questions`): one
//   card holding every question, each with its options or free text, answered as `values` in order.
// - questions-capability (same branch, "feat(provider-pi): tell Pi which dialogs t3 renders"): t3
//   starts Pi with `PI_RPC_DIALOGS=questions`. Pi (vendor/pi) sends a questions dialog only to a
//   client that declares it, and otherwise one select or input per question. A t3 still running
//   code from before its `questions` patch (patches take effect on restart) dropped the unknown
//   dialog silently, so `ask_user` reported its questions shown while no card appeared
//   (2026-11-14, three reports).
// - background-caller (same branch, "fix(provider-pi): an idle Pi thread with background work stays
//   a live MCP caller"): t3 takes MCP tool calls from a thread only while it has an active run or a
//   pending `subagent` background task. A harness workflow runs in the background after its run
//   ended, so its agent() calls (`delegate_task`, `t3_thread_wait`) and its page (`html_render`)
//   failed with `parent_not_active` (2026-11-14, a real thread). While Pi reports background work,
//   the thread now lists the pending subagent task `pi-background-work`.
// - background-items, background-items-contract, background-items-caller (same branch,
//   "feat(provider-pi): list each Pi background job as a pending task"): Pi reported only a count,
//   so t3 showed one opaque "Pi background work" task, which hid a git fsmonitor daemon and a wait
//   loop on a dead run that kept a coordinator waiting for hours (2026-11-14). Pi (vendor/pi) now
//   sends the items of `background_work` (`pi.setBackgroundWork(key, items)`), and the adapter lists
//   one awaited task per item instead of the fixed one: a `command` (with its shell command) or a
//   `background_task`, described by its label, start, pid or process group, log and live view, with
//   its tool call's turn item. The contract takes `command` and `itemId` (the installed build
//   predates them) and `providerInstanceId` on every kind; derived pending work sets the instance on
//   every task a provider thread reports, and a thread stays a live MCP caller while any such task
//   runs, not only a subagent (a Pi command or workflow that calls t3 tools after its run). The patch
//   edits background-caller's result, so the markers of background-work and background-caller name
//   what survives it.
// - delegate-fork-schema, delegate-fork-tool, delegate-fork-runtime (same branch, "feat(orchestrator):
//   delegate_task can fork a Pi conversation into its child"): `delegate_task({ fork: true, task })`
//   starts the child from a copy of the calling Pi thread's conversation so far, and with
//   `forkThreadId` from a thread the caller delegated (directly or through its tasks; a workflow's
//   handles fork their own threads), so its first request reads the shared history from the prompt
//   cache. The child takes the source run's exact model selection; `target`, a worktree, a non-Pi
//   source or one without a session file are refused. The child's first turn start runs the
//   adapter's existing native fork (`pi --fork <source session file>` in the child's checkout, no
//   turn boundary: the whole branch up to now, mid-turn included), and a failed fork fails the run
//   instead of starting without the history. The task message starts "Forked from <source link>".
//   The patch spans three chunks of t3's server bundle: the contracts, the MCP service, and the
//   orchestrator with the Pi adapter.
// - delegate-template-schema, delegate-template-tool, delegate-template-runtime (same branch,
//   "feat(orchestrator): delegate_task can start a Pi child from a session template"):
//   `delegate_task({ forkSessionFile, task })` starts the child from a copy of a Pi session file,
//   only a real `.jsonl` file under Pi's `templates/` directory (`$PI_CODING_AGENT_DIR` or
//   `~/.pi/agent`, symlinks resolved), on a Pi target, not with `fork` and not in another
//   environment. The harness's `delegate_task({ template })` passes the template's built session
//   (extensions/template). The orchestrator records the file on the child's pending `subagent_spawn`
//   transfer (`sourcePoint.sessionFile`), and the child's first turn start runs the Pi adapter's
//   existing native fork on it (`pi --fork <file>`, no source thread or turn).
// - handoff-waits-for-run, handoff-ends-turn (a worktree handoff inside a turn lets its call return
//   and the turn end): `t3_worktree_handoff` re-points the thread
//   (`thread.metadata.update`), and t3 detached the provider session at once. That killed the Pi
//   process still waiting for the call's answer: the call aborted, the run failed with "The provider
//   event stream closed unexpectedly", the failure held the queue, and the queued continuation never
//   started (2026-11-14, Myrodex). A move while the thread has an active run now leaves a
//   single-thread session alone; the next turn start restarts a session whose checkout is not the
//   thread's (`workspaceMovedSessionRestarts`), resuming the conversation in the new checkout. Pi ends
//   its turn as soon as a top-level `t3_worktree_handoff` call returned successfully (abort, settled as
//   completed), so the queue goes on and the continuation runs in the worktree.
// - thread-identity-search (t3_thread_search resolves threads by id, task id and delegated title):
//   the search ranked titles of top-level threads and message text only, so a
//   coordinator holding part of a child's id found nothing and paged 11,714 activity items with
//   t3_thread_read instead (2026-11-14). It now first matches any part of a thread id (also a
//   `t3-thread://` link or an encoded id), a delegated task's `taskId`, and the titles of delegated
//   children, as `source: "id"` or `"title"` matches ahead of the rest.
// - connection-failure-resumable (a turn lost to the provider connection is interrupted, not
//   failed): Pi gave up on "Request timed out." after its retries, and t3 marked the
//   delegated child's run failed although its conversation could go on, so the coordinator started a
//   second agent in the same worktree (2026-11-12). A turn ending on a transport failure (timeouts,
//   connection and socket errors, gateway 502/504/52x; not a client, auth, quota or context error) is
//   now interrupted with the cause as its reason, its error shown as a retryable `transport_error`.
// - background-released, background-released-contract (mirror t3code's branch pi-dialogs-outlive-turns,
//   "feat(orchestrator): background work marked `awaited: false` holds no result"): every Pi job held a
//   delegated child's result until it ended, so a child that submitted its result and left a 3-hour
//   Miri run going never reached its parent (2026-11-15). The harness marks a child's jobs
//   `awaited: false` once it submitted its run's result; the adapter takes the flag (default still
//   awaited), the contract's `awaited` is a boolean, and `backgroundWorkHoldsCompletion` lets an
//   explicit `false` hold nothing, whatever the kind. The jobs still wake the child; a delivered
//   result is not delivered again.
// - between-turns-ordinal (mirrors t3code's branch pi-dialogs-outlive-turns, "fix(client-runtime,
//   provider-pi): a question asked between turns shows at once in a long thread"): a dialog Pi shows
//   while no turn runs (an `ask_user` from a workflow or after its turn returned) got ordinal 0,
//   before the whole thread. A long thread's renderer holds a bounded window and drops a streamed
//   run-less item at or below its newest ordinal as unloaded history, so the desktop showed the card
//   only after its next snapshot, minutes later, while the phone that had just connected showed it
//   (2026-11-16). The adapter now remembers its newest turn and orders such a dialog after its
//   items. t3code also keeps an open question's row in the renderer whatever its ordinal; that half
//   is in the minified client, which this script does not patch.
//
// Usage: node scripts/patch-t3.ts [path/to/T3 Code.app]   (default: T3 Code (Nightly))
// Idempotent per patch: one already applied (its marker present) is skipped. The original archive
// is kept next to it as app.asar.pre-pi-harness. A patch takes effect when t3 restarts.
//
// Kept applied automatically: t3 updates through Squirrel (ShipIt swaps in the new bundle and
// relaunches it), which drops every patch. The installer adds a LaunchAgent (`launchAgent`) that runs
// this whenever /Applications changes and at login. The relaunched t3 usually starts before the
// patch lands; then it is restarted at once when it launched less than RESTART_WINDOW_S ago (the
// updater just started it, nothing is in flight), and otherwise asked to restart by a notification.
// A t3 update that breaks a patch is reported by a notification too.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { packedFiles, readFile, readHeader, replaceFiles } from "./lib/asar.ts";

export interface Patch {
	name: string;
	/** Text only the bundled server file this patch edits contains (t3 splits its server into chunks); default: the Pi adapter's. */
	file?: string;
	/** Present in that file once the patch is applied. */
	marker: string;
	/** [anchor, replacement]: each anchor must occur exactly once when the patch is applied. */
	edits: [anchor: string, replacement: string][];
}

/** In order: a later patch's anchors may contain an earlier one's result. */
export const PATCHES: Patch[] = [
	{
		name: "cache-warming",
		marker: "cacheWarmingPending",
		edits: [
			["let pendingWake = null;", "let pendingWake = null;\n\t\t\tlet cacheWarmingPending = false;"],
			[
				'if (event["type"] === "extension_ui_request" && event["method"] === "setStatus") {',
				'if (event["type"] === "cache_warming") {\n\t\t\t\t\tconst warmingState = piRecordString(event, "state");\n\t\t\t\t\tcacheWarmingPending = warmingState === "scheduled" || warmingState === "refreshing";\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tif (event["type"] === "extension_ui_request" && event["method"] === "setStatus") {',
			],
			["hasPendingBackgroundWork: sync(() => pendingWake !== null),", "hasPendingBackgroundWork: sync(() => pendingWake !== null || cacheWarmingPending),"],
			[
				"hasPendingBackgroundWorkForThread: (providerThread) => sync(() => pendingWake !== null && pendingWake.state.providerThread.id === providerThread.id),",
				"hasPendingBackgroundWorkForThread: (providerThread) => sync(() => pendingWake !== null && pendingWake.state.providerThread.id === providerThread.id || cacheWarmingPending && threadState?.providerThread.id === providerThread.id),",
			],
		],
	},
	{
		name: "dialogs",
		marker: "closedByPi",
		edits: [
			[
				'const cancelPrompt = fn("PiAdapter.cancelPrompt")(function* (pending, resolvedAt) {',
				'const cancelPrompt = fn("PiAdapter.cancelPrompt")(function* (pending, resolvedAt, closedByPi = false) {',
			],
			[
				'yield* connection.send({\n\t\t\t\t\ttype: "extension_ui_response",\n\t\t\t\t\tid: pending.nativeRequestId,\n\t\t\t\t\tcancelled: true\n',
				'if (!closedByPi) yield* connection.send({\n\t\t\t\t\ttype: "extension_ui_response",\n\t\t\t\t\tid: pending.nativeRequestId,\n\t\t\t\t\tcancelled: true\n',
			],
			[
				'if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") {',
				'if (method === "dismiss") {\n\t\t\t\t\tconst entry = Array.from(pendingPrompts).find(([, pending]) => pending.nativeRequestId === nativeRequestId);\n\t\t\t\t\tif (entry === void 0) return;\n\t\t\t\t\tpendingPrompts.delete(entry[0]);\n\t\t\t\t\tyield* cancelPrompt(entry[1], yield* now, true);\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tif (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") {',
			],
			["\t\t\t\tyield* cancelPendingPrompts(completedAt);\n", ""],
			['"editor"\n\t\t\t\t].includes(String(event["method"]));', '"editor",\n\t\t\t\t\t"dismiss"\n\t\t\t\t].includes(String(event["method"]));'],
			[
				"hasPendingBackgroundWork: sync(() => pendingWake !== null || cacheWarmingPending),",
				"hasPendingBackgroundWork: sync(() => pendingWake !== null || cacheWarmingPending || pendingPrompts.size > 0),",
			],
		],
	},
	{
		name: "background-work",
		// What survives background-items, which replaces the pending flag.
		marker: 'event["type"] === "background_work"',
		edits: [
			["let cacheWarmingPending = false;", "let cacheWarmingPending = false;\n\t\t\tlet backgroundWorkPending = false;"],
			[
				'cacheWarmingPending = warmingState === "scheduled" || warmingState === "refreshing";\n\t\t\t\t\treturn;\n\t\t\t\t}',
				'cacheWarmingPending = warmingState === "scheduled" || warmingState === "refreshing";\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tif (event["type"] === "background_work") {\n\t\t\t\t\tconst pending = event["pending"];\n\t\t\t\t\tbackgroundWorkPending = typeof pending === "number" && pending > 0;\n\t\t\t\t\treturn;\n\t\t\t\t}',
			],
			["cacheWarmingPending || pendingPrompts.size > 0", "cacheWarmingPending || backgroundWorkPending || pendingPrompts.size > 0"],
			[
				"cacheWarmingPending && threadState?.providerThread.id === providerThread.id",
				"(cacheWarmingPending || backgroundWorkPending) && threadState?.providerThread.id === providerThread.id",
			],
		],
	},
	{
		name: "questions",
		marker: "piQuestions",
		edits: [
			[
				'if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") {',
				'if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor" && method !== "questions") {',
			],
			[
				"questions: [piQuestion(nativeRequestId, method, title, event)]",
				'questions: method === "questions" ? piQuestions(nativeRequestId, event) : [piQuestion(nativeRequestId, method, title, event)]',
			],
			['"dismiss"\n\t\t\t\t].includes(String(event["method"]));', '"dismiss",\n\t\t\t\t\t"questions"\n\t\t\t\t].includes(String(event["method"]));'],
			[
				"function piUiResponse(pending, decision, answers) {",
				[
					"function piQuestions(nativeRequestId, event) {",
					'\tconst questions = piRecordField(event, "questions");',
					"\treturn (Array.isArray(questions) ? questions : []).map((question, index) => {",
					'\t\tconst options = piRecordField(question, "options");',
					"\t\treturn {",
					"\t\t\tid: `${nativeRequestId}:${index}`,",
					'\t\t\theader: "Question",',
					'\t\t\tquestion: piRecordString(question, "title")?.trim() || "Question",',
					'\t\t\toptions: Array.isArray(options) ? options.filter((option) => typeof option === "string").map((option) => ({ label: option || "Empty value", description: option || "Empty value", value: option })) : []',
					"\t\t};",
					"\t});",
					"}",
					"function piUiResponse(pending, decision, answers) {",
					'\tif (pending.method === "questions") {',
					'\t\tif (answers === void 0 || pending.turnItem.type !== "user_input_request") return { cancelled: true };',
					'\t\treturn { values: pending.turnItem.questions.map((question) => typeof answers[question.id] === "string" ? answers[question.id] : null) };',
					"\t}",
				].join("\n"),
			],
		],
	},
	{
		name: "questions-capability",
		marker: "PI_RPC_DIALOGS",
		edits: [["\treturn {\n\t\targs,\n\t\tenv: {\n\t\t\t...environment,\n", '\treturn {\n\t\targs,\n\t\tenv: {\n\t\t\t...environment,\n\t\t\tPI_RPC_DIALOGS: "questions",\n']],
	},
	{
		name: "background-caller",
		// What survives background-items, which replaces the fixed task.
		marker: "const publishBackgroundWork",
		edits: [
			[
				'const PI_INHERIT_MODEL_SLUG = "default";',
				'const PI_INHERIT_MODEL_SLUG = "default";\nconst PI_BACKGROUND_WORK_TASK = {\n\ttaskId: "pi-background-work",\n\tkind: "subagent",\n\tdescription: "Pi background work (a workflow or a command that moved to the background)"\n};',
			],
			[
				"const updateProviderThread = fnUntraced(function* (state, patch, retainedNativeTurnIds) {",
				[
					"const publishBackgroundWork = fnUntraced(function* () {",
					"\t\t\t\tif (threadState === null) return;",
					"\t\t\t\tconst current = threadState.providerThread.pendingBackgroundTasks ?? [];",
					"\t\t\t\tif (current.some((task) => task.taskId === PI_BACKGROUND_WORK_TASK.taskId) === backgroundWorkPending) return;",
					"\t\t\t\tconst others = current.filter((task) => task.taskId !== PI_BACKGROUND_WORK_TASK.taskId);",
					"\t\t\t\tyield* updateProviderThread(threadState, { pendingBackgroundTasks: backgroundWorkPending ? [...others, PI_BACKGROUND_WORK_TASK] : others });",
					"\t\t\t});",
					"\t\t\tconst updateProviderThread = fnUntraced(function* (state, patch, retainedNativeTurnIds) {",
				].join("\n"),
			],
			[
				'backgroundWorkPending = typeof pending === "number" && pending > 0;\n\t\t\t\t\treturn;',
				'backgroundWorkPending = typeof pending === "number" && pending > 0;\n\t\t\t\t\tyield* publishBackgroundWork();\n\t\t\t\t\treturn;',
			],
			[
				"forkedFrom: null,\n\t\t\t\t\tpendingBackgroundTasks: [],\n\t\t\t\t\tcreatedAt,\n\t\t\t\t\tupdatedAt: createdAt\n\t\t\t\t};\n\t\t\t\tthreadState = {",
				"forkedFrom: null,\n\t\t\t\t\tpendingBackgroundTasks: backgroundWorkPending ? [PI_BACKGROUND_WORK_TASK] : [],\n\t\t\t\t\tcreatedAt,\n\t\t\t\t\tupdatedAt: createdAt\n\t\t\t\t};\n\t\t\t\tthreadState = {",
			],
		],
	},
	{
		name: "delegate-fork-runtime",
		marker: "forkProjection",
		edits: [
			[
				"cause: `Parent node ${command.parentNodeId} is not part of active run ${parentRun.id}.`\n\t\t});",
				[
					"cause: `Parent node ${command.parentNodeId} is not part of active run ${parentRun.id}.`",
					"\t\t});",
					"\t\tconst forkSource = command.forkSource;",
					"\t\tconst forkProjection = forkSource === void 0 || forkSource.threadId === command.parentThreadId ? parentProjection : yield* projectionStore.getThreadRecords(forkSource.threadId, [",
					'\t\t\t"runs",',
					'\t\t\t"providerThreads",',
					'\t\t\t"providerTurns",',
					'\t\t\t"attempts"',
					"\t\t]).pipe(mapError((cause) => new OrchestratorProjectionError({",
					"\t\t\tthreadId: forkSource.threadId,",
					"\t\t\tcause",
					"\t\t})));",
					"\t\tconst forkRun = forkSource === void 0 ? void 0 : forkProjection.runs.find((candidate) => candidate.id === forkSource.runId);",
					"\t\tif (forkSource !== void 0) {",
					"\t\t\tconst source = forkRun === void 0 ? void 0 : providerThreadForRun(forkProjection, forkRun);",
					"\t\t\tconst refusal = command.workspaceStrategy !== void 0 ? \"A forked task works in its parent's checkout.\" : source?.nativeThreadRef == null ? `Run ${forkSource.runId} of thread ${forkSource.threadId} has no native conversation to fork.` : source.providerInstanceId !== command.modelSelection.instanceId ? `A forked task runs on its source's provider ${source.providerInstanceId}.` : void 0;",
					"\t\t\tif (refusal !== void 0) return yield* new OrchestratorDispatchError({",
					"\t\t\t\tcommandId: command.commandId,",
					"\t\t\t\tcommandType: command.type,",
					"\t\t\t\tcause: refusal",
					"\t\t\t});",
					"\t\t}",
				].join("\n"),
			],
			[
				"\t\t\tsourcePoint: {\n\t\t\t\t...contextSourcePointForRun(parentProjection, parentRun),\n\t\t\t\tturnItemId: taskTurnItemId\n\t\t\t},",
				"\t\t\tsourcePoint: forkRun !== void 0 && forkProjection !== parentProjection ? contextSourcePointForRun(forkProjection, forkRun) : {\n\t\t\t\t...contextSourcePointForRun(parentProjection, parentRun),\n\t\t\t\tturnItemId: taskTurnItemId\n\t\t\t},",
			],
			['\t\t\ttargetRunId: childRun.id,\n\t\t\tstatus: "consumed",', '\t\t\ttargetRunId: childRun.id,\n\t\t\tstatus: forkSource === void 0 ? "consumed" : "pending",'],
			["\t\t\tconsumedAt: now$56\n\t\t};", "\t\t\tconsumedAt: forkSource === void 0 ? now$56 : null\n\t\t};"],
			[
				'const nativeForkTransfer = projection.contextTransfers.find((transfer) => transfer.type === "fork" && transfer.targetThreadId',
				'const nativeForkTransfer = projection.contextTransfers.find((transfer) => (transfer.type === "fork" || transfer.type === "subagent_spawn") && transfer.targetThreadId',
			],
			["projectionStore.getThreadRecords(nativeForkTransfer.sourceThreadId, [", "projectionStore.getThreadRecords(nativeForkTransfer.sourcePoint.threadId, ["],
			[
				"if (!sourceProjection.runs.some((candidate) => candidate.ordinal > sourceRun.ordinal && isActiveRun$1(candidate))) {",
				'if (nativeForkTransfer.type === "subagent_spawn" || !sourceProjection.runs.some((candidate) => candidate.ordinal > sourceRun.ordinal && isActiveRun$1(candidate))) {',
			],
			[
				"...sourceProviderTurn === void 0 ? {} : { providerTurnId: sourceProviderTurn.id }",
				'...nativeForkTransfer.type === "subagent_spawn" || sourceProviderTurn === void 0 ? {} : { providerTurnId: sourceProviderTurn.id }',
			],
		],
	},
	{
		name: "delegate-fork-schema",
		file: "const ORCHESTRATOR_MCP_RUNNING_TASK_NEXT = ",
		marker: "forkThreadId: optional(ThreadId",
		edits: [
			[
				"\tinteractionMode: optional(OrchestratorMcpInteractionMode)\n});\nconst ORCHESTRATOR_MCP_RUNNING_TASK_NEXT = ",
				[
					"\tinteractionMode: optional(OrchestratorMcpInteractionMode),",
					"\tfork: optional(Boolean$2.annotate({ description: \"Start the child from a copy of this conversation so far, with this thread's model, options and checkout (Pi only; no `target` or worktree).\" })),",
					'\tforkThreadId: optional(ThreadId.annotate({ description: "With `fork:true`: fork this thread instead of yours. Only a thread you delegated, directly or through your tasks." }))',
					"});",
					"const ORCHESTRATOR_MCP_RUNNING_TASK_NEXT = ",
				].join("\n"),
			],
			[
				'\t\tcompletionWake: optional(Literals(["always", "settled_only"])),\n\t\tcreatedAt: optional(DateTimeUtc)\n\t}),\n\tStruct({\n\t\ttype: Literal("delegated_task.wake-policy"),',
				'\t\tcompletionWake: optional(Literals(["always", "settled_only"])),\n\t\tforkSource: optional(Struct({\n\t\t\tthreadId: ThreadId,\n\t\t\trunId: RunId\n\t\t})),\n\t\tcreatedAt: optional(DateTimeUtc)\n\t}),\n\tStruct({\n\t\ttype: Literal("delegated_task.wake-policy"),',
			],
		],
	},
	{
		name: "delegate-fork-tool",
		file: 'fn("OrchestratorMcpService.delegateTask")',
		marker: "resolveForkSource",
		edits: [
			[
				'description: "Start one child agent with only `task`. No parent history. Separate checkout',
				'description: "Start one child agent with only `task`. No parent history, unless `fork:true` starts it from a copy of this conversation (Pi only). Separate checkout',
			],
			[
				'function taskPrompt(input) {\n\treturn input.role === void 0 || input.role === "general" ? input.task : `Act as the ${input.role} sub-agent for this task.\\n\\n${input.task}`;\n}',
				'function taskPrompt(input, forkedFrom) {\n\tconst task = input.role === void 0 || input.role === "general" ? input.task : `Act as the ${input.role} sub-agent for this task.\\n\\n${input.task}`;\n\treturn forkedFrom === void 0 ? task : `Forked from ${forkedFrom}.\\n\\n${task}`;\n}',
			],
			[
				"\tconst resolveProjectTarget = (parent, projectId) =>",
				[
					'\tconst resolveForkSource = fn("OrchestratorMcpService.resolveForkSource")(function* (callerThreadId, callerRun, forkThreadId) {',
					"\t\tconst sourceThreadId = forkThreadId ?? callerThreadId;",
					'\t\tconst notOwned = failure$2("invalid_request", `Thread ${sourceThreadId} is not a thread you delegated, directly or through your tasks, so you cannot fork it.`);',
					"\t\tfor (let threadId = sourceThreadId; threadId !== callerThreadId;) {",
					"\t\t\tconst shell = yield* threadManagement.getThreadShell(threadId).pipe(mapError(threadManagementFailure));",
					'\t\t\tif (shell === null || shell.deletedAt !== null || shell.lineage.relationshipToParent !== "subagent" || shell.lineage.parentThreadId === null) return yield* notOwned;',
					"\t\t\tthreadId = shell.lineage.parentThreadId;",
					"\t\t}",
					'\t\tconst source = yield* loadThreadRecords(sourceThreadId, ["runs", "providerThreads"]);',
					'\t\tconst run = sourceThreadId === callerThreadId ? callerRun : source.runs.filter((candidate) => candidate.providerThreadId !== null && candidate.status !== "queued" && candidate.status !== "preparing").toSorted((left, right) => right.ordinal - left.ordinal)[0];',
					"\t\tconst providerThread = source.providerThreads.find((candidate) => candidate.id === run?.providerThreadId);",
					'\t\tconst which = forkThreadId === void 0 ? "This thread" : `Thread ${sourceThreadId}`;',
					'\t\tif (run === void 0 || providerThread === void 0) return yield* failure$2("invalid_request", `${which} has not started a conversation yet, so there is nothing to fork.`);',
					'\t\tif (providerThread.driver !== "pi") return yield* failure$2("invalid_request", `Only a Pi thread can be forked into a delegated task; ${which.toLowerCase()} runs on ${providerThread.driver}. Delegate without \\`fork\\` and put the context the child needs into \\`task\\`.`);',
					'\t\tif (providerThread.nativeThreadRef?.nativeId == null) return yield* failure$2("invalid_request", `${which} has no Pi session file yet, so there is no conversation to fork. Delegate without \\`fork\\`.`);',
					"\t\treturn {",
					"\t\t\tthread: source.thread,",
					"\t\t\trun",
					"\t\t};",
					"\t});",
					"\tconst resolveProjectTarget = (parent, projectId) =>",
				].join("\n"),
			],
			[
				'delegateTask: fn("OrchestratorMcpService.delegateTask")(function* (callerScope, input) {\n\t\t\tconst environmentId =',
				[
					'delegateTask: fn("OrchestratorMcpService.delegateTask")(function* (callerScope, input) {',
					"\t\t\tconst fork = input.fork === true;",
					'\t\t\tif (!fork && input.forkThreadId !== void 0) return yield* failure$2("invalid_request", "`forkThreadId` names the thread to fork; pass it with `fork:true`.");',
					"\t\t\tif (fork && input.target !== void 0) return yield* failure$2(\"invalid_request\", \"A fork runs on this thread's provider, model and options, the only way its first request reads this conversation from the prompt cache. Omit `target`.\");",
					"\t\t\tif (fork && input.isolation === \"worktree\") return yield* failure$2(\"invalid_request\", \"A fork works in this thread's checkout: its history names this checkout's paths, and Pi's system prompt names the working directory, so another checkout misses the prompt cache. Omit `isolation` or use 'shared'.\");",
					"\t\t\tconst environmentId =",
				].join("\n"),
			],
			[
				'"Delegated tasks require an active run owned by this MCP provider session.");\n\t\t\tconst providers = yield* loadProviders;',
				'"Delegated tasks require an active run owned by this MCP provider session.");\n\t\t\tconst forkSource = fork ? yield* resolveForkSource(parent.thread.id, parentRun, input.forkThreadId) : void 0;\n\t\t\tconst providers = yield* loadProviders;',
			],
			[
				"\t\t\tconst target = yield* resolveTargetRechecking({\n\t\t\t\tparent,\n\t\t\t\ttarget: input.target,\n\t\t\t\tproviders,\n\t\t\t\tskipProjectEnablementFilter: isRetryOfAcceptedDelegation\n\t\t\t});",
				[
					"\t\t\tconst resolved = yield* resolveTargetRechecking({",
					"\t\t\t\tparent: forkSource === void 0 ? parent : {",
					"\t\t\t\t\t...parent,",
					"\t\t\t\t\tthread: {",
					"\t\t\t\t\t\t...parent.thread,",
					"\t\t\t\t\t\tmodelSelection: forkSource.run.modelSelection",
					"\t\t\t\t\t}",
					"\t\t\t\t},",
					"\t\t\t\ttarget: input.target,",
					"\t\t\t\tproviders,",
					"\t\t\t\tskipProjectEnablementFilter: isRetryOfAcceptedDelegation",
					"\t\t\t});",
					"\t\t\tconst target = forkSource === void 0 ? resolved : {",
					"\t\t\t\t...resolved,",
					"\t\t\t\tmodelSelection: forkSource.run.modelSelection",
					"\t\t\t};",
				].join("\n"),
			],
			[
				"\t\t\t\ttask: taskPrompt(input),\n",
				"\t\t\t\ttask: taskPrompt(input, forkSource === void 0 ? void 0 : formatThreadLink({\n\t\t\t\t\tenvironmentId: scope.environmentId,\n\t\t\t\t\tthreadId: forkSource.thread.id\n\t\t\t\t}, forkSource.thread.title)),\n",
			],
			[
				'\t\t\t\t...workspaceStrategy === void 0 ? {} : { workspaceStrategy },\n\t\t\t\tcompletionWake: input.mode === "wait" ? "settled_only" : "always"\n',
				'\t\t\t\t...workspaceStrategy === void 0 ? {} : { workspaceStrategy },\n\t\t\t\t...forkSource === void 0 ? {} : { forkSource: {\n\t\t\t\t\tthreadId: forkSource.thread.id,\n\t\t\t\t\trunId: forkSource.run.id\n\t\t\t\t} },\n\t\t\t\tcompletionWake: input.mode === "wait" ? "settled_only" : "always"\n',
			],
		],
	},
	{
		name: "delegate-template-schema",
		file: "const ORCHESTRATOR_MCP_RUNNING_TASK_NEXT = ",
		marker: "forkSessionFile: optional(",
		edits: [
			[
				'\tforkThreadId: optional(ThreadId.annotate({ description: "With `fork:true`: fork this thread instead of yours. Only a thread you delegated, directly or through your tasks." }))\n});',
				[
					'\tforkThreadId: optional(ThreadId.annotate({ description: "With `fork:true`: fork this thread instead of yours. Only a thread you delegated, directly or through your tasks." })),',
					'\tforkSessionFile: optional(TrimmedNonEmptyString.annotate({ description: "Start the child from a copy of this Pi session file: a session template under the Pi agent directory\'s `templates/` (Pi only; not with `fork`)." }))',
					"});",
				].join("\n"),
			],
			[
				"\t\tforkSource: optional(Struct({\n\t\t\tthreadId: ThreadId,\n\t\t\trunId: RunId\n\t\t})),\n\t\tcreatedAt: optional(DateTimeUtc)",
				"\t\tforkSource: optional(Struct({\n\t\t\tthreadId: ThreadId,\n\t\t\trunId: RunId\n\t\t})),\n\t\tforkSessionFile: optional(String$2),\n\t\tcreatedAt: optional(DateTimeUtc)",
			],
			[
				"\tproviderThreadRef: optional(OrchestrationV2ProviderRef),\n\tproviderTurnRef: optional(OrchestrationV2ProviderRef)\n});\nconst OrchestrationV2ThreadForkSourcePoint",
				"\tproviderThreadRef: optional(OrchestrationV2ProviderRef),\n\tproviderTurnRef: optional(OrchestrationV2ProviderRef),\n\tsessionFile: optional(String$2)\n});\nconst OrchestrationV2ThreadForkSourcePoint",
			],
		],
	},
	{
		name: "delegate-template-tool",
		file: 'fn("OrchestratorMcpService.delegateTask")',
		marker: "resolveTemplateSessionFile",
		edits: [
			// The check below uses the chunk's own node imports.
			['import * as NodeFS from "node:fs";\nimport * as NodePath from "node:path";\nimport * as NodeOS from "node:os";\n', 'import * as NodeFS from "node:fs";\nimport * as NodePath from "node:path";\nimport * as NodeOS from "node:os";\n'],
			[
				"unless `fork:true` starts it from a copy of this conversation (Pi only).",
				"unless `fork:true` starts it from a copy of this conversation, or `forkSessionFile` from a Pi session template (Pi only).",
			],
			[
				"function taskPrompt(input, forkedFrom) {",
				[
					"function piTemplatesDir(env = process.env) {",
					"\tconst agentDir = env.PI_CODING_AGENT_DIR?.trim();",
					'\treturn NodePath.join(agentDir === void 0 || agentDir === "" ? NodePath.join(NodeOS.homedir(), ".pi", "agent") : agentDir.replace(/^~(?=$|\\/)/, NodeOS.homedir()), "templates");',
					"}",
					"function resolveTemplateSessionFile(file, templatesDir = piTemplatesDir()) {",
					"\tconst outside = { problem: `\\`forkSessionFile\\` must be a Pi session template file under ${templatesDir}${NodePath.sep}, not ${file}.` };",
					'\tif (!NodePath.isAbsolute(file) || !file.endsWith(".jsonl")) return outside;',
					"\tlet root;",
					"\tlet real;",
					"\ttry {",
					"\t\troot = NodeFS.realpathSync(templatesDir);",
					"\t\treal = NodeFS.realpathSync(file);",
					"\t} catch {",
					"\t\treturn { problem: `The session template ${file} does not exist.` };",
					"\t}",
					'\tif (!real.startsWith(`${root}${NodePath.sep}`) || !real.endsWith(".jsonl")) return outside;',
					"\tif (!NodeFS.statSync(real).isFile()) return { problem: `The session template ${file} is not a file.` };",
					"\treturn { file: real };",
					"}",
					"function taskPrompt(input, forkedFrom) {",
				].join("\n"),
			],
			[
				"Omit `isolation` or use 'shared'.\");\n\t\t\tconst environmentId = input.target === void 0 ? void 0 : remoteTarget(callerScope, input.target.environmentId);",
				[
					"Omit `isolation` or use 'shared'.\");",
					'\t\t\tif (fork && input.forkSessionFile !== void 0) return yield* failure$2("invalid_request", "`fork` copies a thread\'s conversation and `forkSessionFile` a session template: pass one of them.");',
					"\t\t\tconst templateFile = input.forkSessionFile === void 0 ? void 0 : resolveTemplateSessionFile(input.forkSessionFile);",
					'\t\t\tif (templateFile !== void 0 && "problem" in templateFile) return yield* failure$2("invalid_request", templateFile.problem);',
					"\t\t\tconst environmentId = input.target === void 0 ? void 0 : remoteTarget(callerScope, input.target.environmentId);",
					'\t\t\tif (templateFile !== void 0 && environmentId !== void 0) return yield* failure$2("invalid_request", "A session template is a file on this machine: a task starting from one runs here. Omit `target.environmentId`.");',
				].join("\n"),
			],
			[
				"\t\t\tconst target = forkSource === void 0 ? resolved : {\n\t\t\t\t...resolved,\n\t\t\t\tmodelSelection: forkSource.run.modelSelection\n\t\t\t};",
				[
					"\t\t\tconst target = forkSource === void 0 ? resolved : {",
					"\t\t\t\t...resolved,",
					"\t\t\t\tmodelSelection: forkSource.run.modelSelection",
					"\t\t\t};",
					"\t\t\tconst targetDriver = providers.find((provider) => provider.instanceId === target.modelSelection.instanceId)?.driver;",
					'\t\t\tif (templateFile !== void 0 && targetDriver !== "pi") return yield* failure$2("invalid_request", `A session template is a Pi session: the child must run on Pi, not ${targetDriver ?? target.modelSelection.instanceId}.`);',
				].join("\n"),
			],
			[
				"\t\t\t\t\trunId: forkSource.run.id\n\t\t\t\t} },\n\t\t\t\tcompletionWake:",
				"\t\t\t\t\trunId: forkSource.run.id\n\t\t\t\t} },\n\t\t\t\t...templateFile === void 0 ? {} : { forkSessionFile: templateFile.file },\n\t\t\t\tcompletionWake:",
			],
		],
	},
	{
		name: "delegate-template-runtime",
		marker: "nativeForkTransfer?.sourcePoint.sessionFile",
		edits: [
			[
				"\t\t\tcause\n\t\t})));\n\t\tconst now$56 = command.createdAt ?? (yield* now);",
				[
					"\t\t\tcause",
					"\t\t})));",
					"\t\tconst forkSessionFile = command.forkSessionFile;",
					"\t\tif (forkSessionFile !== void 0) {",
					'\t\t\tconst refusal = forkSource !== void 0 ? "A delegated task forks either a thread\'s run or a session template, not both." : targetAdapter.driver !== "pi" ? `A session template is a Pi session; provider ${command.modelSelection.instanceId} runs ${targetAdapter.driver}.` : void 0;',
					"\t\t\tif (refusal !== void 0) return yield* new OrchestratorDispatchError({",
					"\t\t\t\tcommandId: command.commandId,",
					"\t\t\t\tcommandType: command.type,",
					"\t\t\t\tcause: refusal",
					"\t\t\t});",
					"\t\t}",
					"\t\tconst now$56 = command.createdAt ?? (yield* now);",
				].join("\n"),
			],
			[
				"\t\t\t\t...contextSourcePointForRun(parentProjection, parentRun),\n\t\t\t\tturnItemId: taskTurnItemId\n\t\t\t},",
				"\t\t\t\t...contextSourcePointForRun(parentProjection, parentRun),\n\t\t\t\tturnItemId: taskTurnItemId,\n\t\t\t\t...forkSessionFile === void 0 ? {} : { sessionFile: forkSessionFile }\n\t\t\t},",
			],
			['\t\t\tstatus: forkSource === void 0 ? "consumed" : "pending",', '\t\t\tstatus: forkSource === void 0 && forkSessionFile === void 0 ? "consumed" : "pending",'],
			["\t\t\tconsumedAt: forkSource === void 0 ? now$56 : null", "\t\t\tconsumedAt: forkSource === void 0 && forkSessionFile === void 0 ? now$56 : null"],
			[
				"\t\tconst loadedProviderThread = yield* gen$1(function* () {\n\t\t\tif (nativeForkTransfer !== void 0) {",
				[
					"\t\tconst loadedProviderThread = yield* gen$1(function* () {",
					"\t\t\tconst templateFile = nativeForkTransfer?.sourcePoint.sessionFile;",
					"\t\t\tif (templateFile !== void 0) return yield* loadFromProvider(session.forkThread({",
					"\t\t\t\tsourceProviderThread: {",
					"\t\t\t\t\t...providerThread,",
					"\t\t\t\t\tnativeThreadRef: {",
					"\t\t\t\t\t\tdriver: session.driver,",
					"\t\t\t\t\t\tnativeId: templateFile,",
					'\t\t\t\t\t\tstrength: "strong"',
					"\t\t\t\t\t},",
					"\t\t\t\t\tforkedFrom: null",
					"\t\t\t\t},",
					"\t\t\t\ttargetThreadId: projection.thread.id,",
					"\t\t\t\tmodelSelection: run.modelSelection,",
					"\t\t\t\truntimePolicy: resolvedRuntimePolicy",
					"\t\t\t}));",
					"\t\t\tif (nativeForkTransfer !== void 0) {",
				].join("\n"),
			],
		],
	},
	{
		name: "session-questions",
		marker: "questionOwnedBySession",
		edits: [
			[
				'nodeId,\n\t\t\t\t\tproviderTurnId,\n\t\t\t\t\tnativeRequestRef: providerRef(nativeRequestId),\n\t\t\t\t\tkind: method === "confirm" ? "command" : "user_input",',
				'nodeId,\n\t\t\t\t\tproviderTurnId: method === "confirm" ? providerTurnId : null /* questionOwnedBySession */,\n\t\t\t\t\tnativeRequestRef: providerRef(nativeRequestId),\n\t\t\t\t\tkind: method === "confirm" ? "command" : "user_input",',
			],
		],
	},
	{
		name: "background-items",
		marker: "piBackgroundTasks",
		edits: [
			[
				'const PI_BACKGROUND_WORK_TASK = {\n\ttaskId: "pi-background-work",\n\tkind: "subagent",\n\tdescription: "Pi background work (a workflow or a command that moved to the background)"\n};',
				[
					'const piBackgroundClock = new Intl.DateTimeFormat(void 0, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });',
					"function piSameFlatRecords(left, right) {",
					"\treturn left.length === right.length && left.every((record, index) => {",
					"\t\tconst other = right[index];",
					"\t\tconst entries = Object.entries(record);",
					"\t\treturn other !== void 0 && entries.length === Object.keys(other).length && entries.every(([key, value]) => other[key] === value);",
					"\t});",
					"}",
					"function piBackgroundTasks(items, itemIdOf) {",
					"\tif (!Array.isArray(items)) return [];",
					"\treturn items.flatMap((item) => {",
					'\t\tconst taskId = piRecordString(item, "id")?.trim();',
					'\t\tconst label = piRecordString(item, "label")?.trim();',
					"\t\tif (!taskId || !label) return [];",
					'\t\tconst command = piRecordString(item, "command")?.trim() || void 0;',
					'\t\tconst startedAt = piRecordNumber(item, "startedAt");',
					'\t\tconst pid = piRecordNumber(item, "pid");',
					'\t\tconst group = piRecordNumber(item, "processGroup");',
					'\t\tconst logPath = piRecordString(item, "logPath")?.trim();',
					'\t\tconst url = piRecordString(item, "url")?.trim();',
					'\t\tconst toolCallId = piRecordString(item, "toolCallId")?.trim();',
					"\t\tconst details = [",
					"\t\t\tstartedAt === void 0 || !Number.isFinite(startedAt) ? void 0 : `started ${piBackgroundClock.format(startedAt)}`,",
					'\t\t\tpid === void 0 ? group === void 0 ? void 0 : `process group ${group}` : `pid ${pid}${group === void 0 ? "" : ` (group ${group})`}`,',
					"\t\t\tlogPath ? `log ${logPath}` : void 0,",
					"\t\t\turl || void 0",
					"\t\t].filter((detail) => detail !== void 0);",
					"\t\treturn [{",
					"\t\t\ttaskId,",
					'\t\t\tkind: command === void 0 ? "background_task" : "command",',
					'\t\t\tdescription: [label, ...details].join(" · "),',
					"\t\t\t...command === void 0 ? {} : { command },",
					"\t\t\t...toolCallId ? { itemId: itemIdOf(toolCallId) } : {},",
					"\t\t\tawaited: true",
					"\t\t}];",
					"\t});",
					"}",
				].join("\n"),
			],
			["let backgroundWorkPending = false;", "let backgroundWork = [];"],
			[
				[
					"const publishBackgroundWork = fnUntraced(function* () {",
					"\t\t\t\tif (threadState === null) return;",
					"\t\t\t\tconst current = threadState.providerThread.pendingBackgroundTasks ?? [];",
					"\t\t\t\tif (current.some((task) => task.taskId === PI_BACKGROUND_WORK_TASK.taskId) === backgroundWorkPending) return;",
					"\t\t\t\tconst others = current.filter((task) => task.taskId !== PI_BACKGROUND_WORK_TASK.taskId);",
					"\t\t\t\tyield* updateProviderThread(threadState, { pendingBackgroundTasks: backgroundWorkPending ? [...others, PI_BACKGROUND_WORK_TASK] : others });",
					"\t\t\t});",
				].join("\n"),
				[
					"const publishBackgroundWork = fnUntraced(function* (previous) {",
					"\t\t\t\tif (threadState === null || piSameFlatRecords(previous, backgroundWork)) return;",
					"\t\t\t\tconst replaced = new Set(previous.map((task) => task.taskId));",
					"\t\t\t\tconst others = (threadState.providerThread.pendingBackgroundTasks ?? []).filter((task) => !replaced.has(task.taskId));",
					"\t\t\t\tyield* updateProviderThread(threadState, { pendingBackgroundTasks: [...others, ...backgroundWork] });",
					"\t\t\t});",
					"\t\t\tconst turnItemOfToolCall = (toolCallId) => idAllocator.derive.turnItemFromProviderItem({",
					"\t\t\t\tdriver: PI_PROVIDER,",
					"\t\t\t\tnativeItemId: toolCallId",
					"\t\t\t});",
				].join("\n"),
			],
			[
				// Within background-caller's own output (`const pending` above it stays, unused).
				'backgroundWorkPending = typeof pending === "number" && pending > 0;\n\t\t\t\t\tyield* publishBackgroundWork();',
				'const previous = backgroundWork;\n\t\t\t\t\tbackgroundWork = piBackgroundTasks(event["items"], turnItemOfToolCall);\n\t\t\t\t\tyield* publishBackgroundWork(previous);',
			],
			["pendingBackgroundTasks: backgroundWorkPending ? [PI_BACKGROUND_WORK_TASK] : [],", "pendingBackgroundTasks: backgroundWork,"],
			[
				'\t\t\t\t\tstatus: "idle",\n\t\t\t\t\tupdatedAt: createdAt\n\t\t\t\t} : {\n\t\t\t\t\tid: idAllocator.derive.providerThread({',
				'\t\t\t\t\tstatus: "idle",\n\t\t\t\t\tpendingBackgroundTasks: backgroundWork,\n\t\t\t\t\tupdatedAt: createdAt\n\t\t\t\t} : {\n\t\t\t\t\tid: idAllocator.derive.providerThread({',
			],
			["cacheWarmingPending || backgroundWorkPending || pendingPrompts.size > 0", "cacheWarmingPending || backgroundWork.length > 0 || pendingPrompts.size > 0"],
			["(cacheWarmingPending || backgroundWorkPending) && threadState", "(cacheWarmingPending || backgroundWork.length > 0) && threadState"],
		],
	},
	{
		name: "background-items-contract",
		file: "const ORCHESTRATOR_MCP_RUNNING_TASK_NEXT = ",
		marker: "work a provider runs itself keeps its idle thread a live MCP caller",
		edits: [
			[
				'\tawaited: optional(Literal(true))\n};\nconst OrchestrationV2PendingBackgroundTask = kindUnionWithFallback([\n\tStruct({\n\t\t...PendingBackgroundTaskFields,\n\t\tkind: Literal("subagent"),\n\t\t/** The owning provider thread\'s instance, populated in derived pending work. */\n\t\tproviderInstanceId: optional(ProviderInstanceId),\n',
				[
					"\tawaited: optional(Literal(true)),",
					"\t/** The shell command the work runs, when it is one. */",
					"\tcommand: optional(String$2),",
					"\t/** The turn item that started the work. */",
					"\titemId: optional(TurnItemId),",
					"\t/** The instance of the provider thread that reports this work, populated in derived pending work: work a provider runs itself keeps its idle thread a live MCP caller. */",
					"\tproviderInstanceId: optional(ProviderInstanceId)",
					"};",
					"const OrchestrationV2PendingBackgroundTask = kindUnionWithFallback([",
					"\tStruct({",
					"\t\t...PendingBackgroundTaskFields,",
					'\t\tkind: Literal("subagent"),',
					"",
				].join("\n"),
			],
			[
				'...task.kind === "subagent" ? { providerInstanceId: providerThread.providerInstanceId } : {},',
				"...providerThread.providerInstanceId === void 0 ? {} : { providerInstanceId: providerThread.providerInstanceId },",
			],
		],
	},
	{
		name: "background-items-caller",
		file: 'fn("OrchestratorMcpService.delegateTask")',
		marker: "providerOwnedWorkIsLive",
		edits: [
			[
				'(task) => task.kind === "subagent" && task.providerInstanceId === providerInstanceId',
				"(task) => task.providerInstanceId === providerInstanceId /* providerOwnedWorkIsLive */",
			],
		],
	},
	{
		name: "handoff-waits-for-run",
		marker: "workspaceMoveWaitsForRun",
		edits: [
			[
				"const detachSessionIds = new Set(",
				'const workspaceMoveWaitsForRun = command.type === "thread.metadata.update" && command.worktreePath !== void 0 && command.worktreePath !== thread.worktreePath && (yield* loadProjectionForCommand(command, ["runs"], { turnItemTypes: [] })).runs.some(isActiveRun$1);\n\t\tconst detachSessionIds = new Set(',
			],
			[
				"command.worktreePath !== thread.worktreePath ? (providerContext?.providerSessions ?? []).map((session) => session.id)",
				"command.worktreePath !== thread.worktreePath ? (providerContext?.providerSessions ?? []).filter((session) => !workspaceMoveWaitsForRun || session.capabilities.sessions.supportsMultipleProviderThreadsPerSession).map((session) => session.id)",
			],
			[
				"\t\tconst existingSessionProjection = projection.providerSessions.find((candidate) => candidate.id === providerSessionId);\n",
				[
					"\t\tconst existingSessionProjection = projection.providerSessions.find((candidate) => candidate.id === providerSessionId);",
					"\t\tif (existingSessionProjection !== void 0 && !existingSessionProjection.capabilities.sessions.supportsMultipleProviderThreadsPerSession && existingSessionProjection.cwd !== resolvedRuntimePolicy.cwd) yield* providerSessions.detach({",
					"\t\t\tproviderSessionId,",
					"\t\t\tthreadId: projection.thread.id,",
					'\t\t\tdetail: "Workspace changed."',
					'\t\t}).pipe(ignoreCause({ log: true, message: "Failed to restart a provider session in its new workspace." })) /* workspaceMovedSessionRestarts */;',
					"",
				].join("\n"),
			],
		],
	},
	{
		name: "handoff-ends-turn",
		marker: "piHandoffEndsTurn",
		edits: [
			[
				'const PI_INHERIT_MODEL_SLUG = "default";',
				[
					'const PI_INHERIT_MODEL_SLUG = "default";',
					"/** A top-level tool call that moved this thread into a worktree and returned: its turn ends there, and the next one runs in the worktree. */",
					"function piHandoffEndsTurn(event) {",
					'\tconst toolName = event["toolName"];',
					'\treturn typeof toolName === "string" && /(?:^|__)t3_worktree_handoff$/.test(toolName) && event["isError"] !== true && typeof event["parentToolCallId"] !== "string";',
					"}",
				].join("\n"),
			],
			[
				'case "tool_execution_end":\n\t\t\t\t\t\tif (turn !== null) yield* emitToolItem(turn, event, "end");\n\t\t\t\t\t\treturn;',
				[
					'case "tool_execution_end":',
					'\t\t\t\t\t\tif (turn !== null) yield* emitToolItem(turn, event, "end");',
					"\t\t\t\t\t\tif (turn !== null && !turn.interrupted && piHandoffEndsTurn(event)) {",
					"\t\t\t\t\t\t\tturn.endedByHandoff = true;",
					'\t\t\t\t\t\t\tyield* request({ type: "abort" }).pipe(ignore, forkIn(scope$5));',
					"\t\t\t\t\t\t}",
					"\t\t\t\t\t\treturn;",
				].join("\n"),
			],
			["const interrupted = turn.interrupted || turn.nativeAborted;", "const interrupted = (turn.interrupted || turn.nativeAborted) && turn.endedByHandoff !== true;"],
		],
	},
	{
		name: "thread-identity-search",
		file: 'fn("OrchestratorMcpService.delegateTask")',
		marker: "threadIdentityMatches",
		edits: [
			[
				"\tconst titleCandidates = findAll({",
				[
					"\tconst threadIdentityQuery = (query, projectId) => {",
					"\t\tconst text = query.trim().toLowerCase();",
					"\t\tconst linked = /t3-thread:\\/\\/v(?:1|2\\/[^/\\s)>]+)\\/([^\\s)>]+)/.exec(text)?.[1] ?? text;",
					'\t\tconst needle = linked.replaceAll("%25", "%").replaceAll("%25", "%").replaceAll("%3a", ":");',
					"\t\treturn {",
					'\t\t\tneedle: needle.length >= 6 && /\\d/.test(needle) && !/\\s/.test(needle) ? needle : "",',
					'\t\t\ttitle: text.length >= 3 ? text : "",',
					"\t\t\tprojectId",
					"\t\t};",
					"\t};",
					"\tconst threadIdentityMatches = findAll({",
					"\t\tRequest: Struct({",
					"\t\t\tneedle: String$1,",
					"\t\t\ttitle: String$1,",
					"\t\t\tprojectId: NullOr(ProjectId)",
					"\t\t}),",
					"\t\tResult: Struct({",
					"\t\t\tthreadId: ThreadId,",
					"\t\t\tprojectId: ProjectId,",
					"\t\t\ttitle: String$1,",
					"\t\t\tsource: String$1",
					"\t\t}),",
					"\t\texecute: ({ needle, title, projectId }) => sql`",
					"      WITH tasks AS (",
					"        SELECT child_thread_id AS thread_id FROM orchestration_v2_projection_subagents",
					"        WHERE ${needle} <> '' AND child_thread_id IS NOT NULL",
					"          AND instr(replace(replace(replace(lower(subagent_id), '%25', '%'), '%25', '%'), '%3a', ':'), ${needle}) > 0",
					"      ), matched AS (",
					"        SELECT threads.thread_id AS \"threadId\", threads.project_id AS \"projectId\", threads.title AS title, threads.updated_at AS \"updatedAt\",",
					"          CASE WHEN threads.thread_id IN (SELECT thread_id FROM tasks)",
					"            OR (${needle} <> '' AND instr(replace(replace(replace(lower(threads.thread_id), '%25', '%'), '%25', '%'), '%3a', ':'), ${needle}) > 0)",
					"            THEN 'id' ELSE 'title' END AS source",
					"        FROM orchestration_v2_projection_threads AS threads",
					"        WHERE threads.deleted_at IS NULL",
					"      )",
					"      SELECT matched.\"threadId\", matched.\"projectId\", matched.title, matched.source",
					"      FROM matched",
					"      INNER JOIN orchestration_v2_projection_threads AS threads ON threads.thread_id = matched.\"threadId\"",
					"      WHERE matched.source = 'id'",
					"        OR (${title} <> ''",
					"          AND json_extract(threads.payload_json, '$.lineage.relationshipToParent') = 'subagent'",
					"          AND threads.archived_at IS NULL",
					"          AND (${projectId} IS NULL OR threads.project_id = ${projectId})",
					"          AND instr(lower(threads.title), ${title}) > 0)",
					"      ORDER BY matched.source = 'id' DESC, matched.\"updatedAt\" DESC",
					"      LIMIT 20",
					"    `",
					"\t});",
					"\tconst titleCandidates = findAll({",
				].join("\n"),
			],
			[
				"\t\tconst shown = new Set(titleHits.map((hit) => hit.threadId));",
				[
					"\t\tconst identity = threadIdentityQuery(input.query, input.projectId ?? null);",
					'\t\tconst identityHits = identity.needle === "" && identity.title === "" ? [] : yield* read(threadIdentityMatches(identity));',
					"\t\tconst identified = new Set(identityHits.map((hit) => hit.threadId));",
					"\t\tconst shown = new Set([...identified, ...titleHits.map((hit) => hit.threadId)]);",
				].join("\n"),
			],
			[
				"\t\treturn { matches: [...titleHits.slice(0, limit - messageSlots), ...messageHits].slice(0, limit) };",
				[
					"\t\treturn { matches: [",
					'\t\t\t...identityHits.filter((hit) => hit.source === "id"),',
					"\t\t\t...titleHits.filter((hit) => !identified.has(hit.threadId)).slice(0, limit - messageSlots),",
					'\t\t\t...identityHits.filter((hit) => hit.source !== "id"),',
					"\t\t\t...messageHits",
					"\t\t].slice(0, limit) };",
				].join("\n"),
			],
			[
				'source: Literals([\n\t\t\t"title",\n\t\t\t"user",\n\t\t\t"assistant"\n\t\t]),',
				'source: Literals([\n\t\t\t"id",\n\t\t\t"title",\n\t\t\t"user",\n\t\t\t"assistant"\n\t\t]),',
			],
			[
				'description: "Search active threads by title, branch, PR, project, then message text. Skips subagent threads. ',
				'description: "Find threads by any part of their id (e.g. 8 characters of it, or a thread link), a delegated `taskId`, or a delegated child\'s title (`source:\'id\'` or `\'title\'`), then search active threads by title, branch, PR, project, then message text. ',
			],
		],
	},
	{
		name: "connection-failure-resumable",
		marker: "piConnectionFailure",
		edits: [
			[
				'const PI_INHERIT_MODEL_SLUG = "default";',
				[
					'const PI_INHERIT_MODEL_SLUG = "default";',
					"/** A failure of the connection to the model provider (Pi already retried it): the conversation is intact and can go on. */",
					"function piConnectionFailure(message) {",
					"\treturn /timed? ?out|timeout|\\bE(?:TIMEDOUT|CONNRESET|CONNREFUSED|CONNABORTED|PIPE|NOTFOUND|AI_AGAIN|NETUNREACH|HOSTUNREACH|NETDOWN)\\b|UND_ERR_|socket hang up|other side closed|fetch failed|connection (?:error|refused|reset|closed|lost)|network (?:error|connection)|\\bterminated\\b|stream (?:was interrupted|disconnected)|ended without|upstream connect|reset before headers|bad gateway|gateway time-?out|(?<![\\w.])(?:502|504|52[0-4])(?![\\w.])/i.test(message) && !/(?<![\\w.])(?:400|401|402|403|404|413|422)(?![\\w.])|invalid.request|authenticat|unauthori[sz]ed|forbidden|permission|quota|billing|usage limit|context (?:window|length)|too long|safeguard/i.test(message);",
					"}",
				].join("\n"),
			],
			[
				"const failure = interrupted ? null : turn.rejectedPromptFailure ?? turn.failure;",
				[
					"const reportedFailure = interrupted ? null : turn.rejectedPromptFailure ?? turn.failure;",
					"\t\t\t\tconst connectionFailure = reportedFailure !== null && reportedFailure === turn.failure && piConnectionFailure(reportedFailure.message) ? {",
					"\t\t\t\t\t...reportedFailure,",
					'\t\t\t\t\tclass: "transport_error",',
					"\t\t\t\t\tretryable: true",
					"\t\t\t\t} : null;",
					"\t\t\t\tconst failure = connectionFailure === null ? reportedFailure : null;",
					"\t\t\t\tconst shownFailure = failure ?? connectionFailure;",
				].join("\n"),
			],
			[
				'status: interrupted ? "interrupted" : failure !== null ? "failed" : "completed",',
				'status: interrupted || connectionFailure !== null ? "interrupted" : failure !== null ? "failed" : "completed",',
			],
			[
				'yield* updateProviderSession(failure !== null ? "error" : "ready", failure?.message ?? null);\n\t\t\t\tif (failure !== null) {\n\t\t\t\t\tconst failureItemId = `terminal-failure:${turn.providerTurn.id}`;\n\t\t\t\t\tif (turn.activeProviderRetry !== null) yield* emitProviderRetry(turn, {\n\t\t\t\t\t\t...turn.activeProviderRetry,\n\t\t\t\t\t\tfailure\n\t\t\t\t\t}, "failed", completedAt);',
				'yield* updateProviderSession(failure !== null ? "error" : "ready", failure?.message ?? null);\n\t\t\t\tif (shownFailure !== null) {\n\t\t\t\t\tconst failureItemId = `terminal-failure:${turn.providerTurn.id}`;\n\t\t\t\t\tif (turn.activeProviderRetry !== null) yield* emitProviderRetry(turn, {\n\t\t\t\t\t\t...turn.activeProviderRetry,\n\t\t\t\t\t\tfailure: shownFailure\n\t\t\t\t\t}, "failed", completedAt);',
			],
			[
				'\t\t\t\t\t\t\ttype: "error",\n\t\t\t\t\t\t\tfailure\n\t\t\t\t\t\t}\n\t\t\t\t\t});\n\t\t\t\t\tyield* emit({\n\t\t\t\t\t\ttype: "turn.terminal",',
				'\t\t\t\t\t\t\ttype: "error",\n\t\t\t\t\t\t\tfailure: shownFailure\n\t\t\t\t\t\t}\n\t\t\t\t\t});\n\t\t\t\t}\n\t\t\t\tif (failure !== null) {\n\t\t\t\t\tconst failureItemId = `terminal-failure:${turn.providerTurn.id}`;\n\t\t\t\t\tyield* emit({\n\t\t\t\t\t\ttype: "turn.terminal",',
			],
			[
				'\t\t\t\t\tstatus: interrupted ? "interrupted" : "completed",\n\t\t\t\t\tfailure: null,\n\t\t\t\t\tthreadDisposition: "reusable"\n\t\t\t\t});\n\t\t\t});',
				'\t\t\t\t\tstatus: interrupted || connectionFailure !== null ? "interrupted" : "completed",\n\t\t\t\t\tfailure: null,\n\t\t\t\t\t...connectionFailure === null ? {} : { reason: `The connection to the model provider failed (${connectionFailure.message}). The conversation is intact: send a message to continue.` },\n\t\t\t\t\tthreadDisposition: "reusable"\n\t\t\t\t});\n\t\t\t});',
			],
		],
	},
	{
		name: "background-released",
		// Within background-items' output.
		marker: "releasedByItem",
		edits: [["\t\t\tawaited: true\n\t\t}];", '\t\t\tawaited: piRecordField(item, "awaited") !== false /* releasedByItem */\n\t\t}];']],
	},
	{
		name: "background-released-contract",
		file: "const ORCHESTRATOR_MCP_RUNNING_TASK_NEXT = ",
		marker: "releasedWorkHoldsNothing",
		edits: [
			[
				// Within background-items-contract's output.
				"\t/**\n\t* The agent declared it resumes when this work ends, so the thread holds like it does for a\n\t* subagent. Only the agent knows whether a command is a wait or a dev server it left running.\n\t*/\n\tawaited: optional(Literal(true)),\n\t/** The shell command the work runs, when it is one. */",
				[
					"\t/**",
					"\t* Whether the agent's result waits for this work: `true` holds the thread like a subagent,",
					"\t* `false` holds nothing whatever the kind (a child submitted its result while its jobs run),",
					"\t* absent lets the kind decide. Only the agent knows whether a command is a wait.",
					"\t*/",
					"\tawaited: optional(Boolean$2),",
					"\t/** The shell command the work runs, when it is one. */",
				].join("\n"),
			],
			[
				"return tasks.some((task) => task.awaited === true || backgroundWorkKindHoldsCompletion(task.kind));",
				"return tasks.some((task) => task.awaited ?? backgroundWorkKindHoldsCompletion(task.kind)) /* releasedWorkHoldsNothing */;",
			],
		],
	},
	{
		name: "between-turns-ordinal",
		marker: "betweenTurnsOrdinal",
		edits: [
			["state.activeTurn = activeTurn;", "state.activeTurn = activeTurn;\n\t\t\t\t\t\tstate.lastTurn = activeTurn;"],
			[
				"ordinal: turn === null ? 0 : itemOrdinal(turn, nativeRequestId),",
				"ordinal: (turn ?? state?.lastTurn ?? null) === null ? 0 : itemOrdinal(turn ?? state.lastTurn, nativeRequestId) /* betweenTurnsOrdinal */,",
			],
		],
	},
];

/** Identifies the bundled Pi adapter, patched or not. */
const ADAPTER = '"PiAdapter.cancelPrompt"';

/** The text that identifies the bundled file a patch edits. */
export const patchFile = (patch: Patch): string => patch.file ?? ADAPTER;

const count = (text: string, anchor: string): number => text.split(anchor).length - 1;

/** The bundle with every missing patch applied, and the names applied; throws when an anchor is missing or ambiguous. */
export function patchBundle(text: string, patches: Patch[] = PATCHES): { text: string; applied: string[] } {
	const applied: string[] = [];
	for (const patch of patches) {
		if (text.includes(patch.marker)) continue;
		for (const [anchor] of patch.edits) {
			const found = count(text, anchor);
			if (found !== 1) throw new Error(`t3 changed (${patch.name} patch): expected the anchor once, found it ${found} times: ${anchor}`);
		}
		text = patch.edits.reduce((patched, [anchor, replacement]) => patched.replace(anchor, () => replacement), text);
		if (!text.includes(patch.marker)) throw new Error(`${patch.name} patch: its marker ${patch.marker} is missing after applying it`);
		applied.push(patch.name);
	}
	return { text, applied };
}

/** The bundled server files of an archive by path, and the one each patch edits; throws unless exactly one file holds a patch's identifying text. */
export function serverBundles(archive: string): { texts: Map<string, string>; fileOf: (patch: Patch) => string } {
	const texts = new Map(
		packedFiles(readHeader(archive).header)
			.map((f) => f.path)
			.filter((path) => path.startsWith("apps/server/dist/") && path.endsWith(".mjs"))
			.map((path) => [path, readFile(archive, path).toString("utf8")] as const),
	);
	const paths = new Map<string, string>();
	for (const id of new Set(PATCHES.map(patchFile))) {
		const found = [...texts].filter(([, text]) => text.includes(id)).map(([path]) => path);
		if (found.length !== 1) throw new Error(`t3 changed: expected one bundled server file containing ${id}, found ${found.length}; nothing patched`);
		paths.set(id, found[0]!);
	}
	return { texts, fileOf: (patch) => paths.get(patchFile(patch))! };
}

/** Applies the missing patches to the app's archive; `applied` names them (empty when there were none). */
export function patchApp(app: string): { applied: string[]; message: string } {
	const archive = join(app, "Contents/Resources/app.asar");
	if (!existsSync(archive)) throw new Error(`${archive}: not found`);
	const { texts, fileOf } = serverBundles(archive);
	// Every file is patched before anything is written: a broken anchor leaves the archive as it was.
	const patched = new Map<string, string>();
	const applied = new Set<string>();
	for (const patch of PATCHES) {
		const path = fileOf(patch);
		const result = patchBundle(patched.get(path) ?? texts.get(path)!, [patch]);
		patched.set(path, result.text);
		for (const name of result.applied) applied.add(name);
	}
	if (applied.size === 0) return { applied: [], message: "already patched" };
	const changed = [...patched].filter(([path, text]) => text !== texts.get(path));
	const backup = `${archive}.pre-pi-harness`;
	// The backup is t3's own archive: taken when none of the patches is applied yet (a fresh install
	// or update), kept when an earlier run already patched this archive.
	if (PATCHES.every((patch) => !texts.get(fileOf(patch))!.includes(patch.marker))) copyFileSync(archive, backup);
	// Written to a new file and renamed over the archive: a running t3 keeps reading the old one.
	replaceFiles(archive, Object.fromEntries(changed.map(([path, text]) => [path, Buffer.from(text, "utf8")])));
	const names = PATCHES.map((patch) => patch.name).filter((name) => applied.has(name));
	return { applied: names, message: `patched ${changed.map(([path]) => path).join(", ")} (${names.join(", ")}; original kept as ${backup})` };
}

/** A t3 launched this recently was started by its updater: restarting it loses no work. */
export const RESTART_WINDOW_S = 120;

/**
 * What the running t3 needs after a patch run, given how long ago its main process started (undefined:
 * not running), measured right after patching. Running then, it may have loaded the old bundle.
 */
export function afterPatch(applied: string[], startedAgoS: number | undefined): "none" | "restart" | "notify" {
	if (applied.length === 0 || startedAgoS === undefined) return "none";
	return startedAgoS < RESTART_WINDOW_S ? "restart" : "notify";
}

/** Seconds in a `ps` elapsed time, `[[dd-]hh:]mm:ss`. */
export function elapsedSeconds(etime: string): number {
	const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
	return clock!.split(":").reduce((total, part) => total * 60 + Number(part), 0) + Number(days) * 86_400;
}

/** The app's main executable (bundle name without `.app`). */
const executable = (app: string) => join(app, "Contents/MacOS", basename(app, ".app"));

/** An extended regular expression matching `text` literally. */
const literal = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

/**
 * Seconds since a process started from `main` without arguments did (an app's main process; its
 * helpers carry arguments), or undefined when none runs. `pgrep` compares the command lines, and `ps`
 * reports only the matches: listing every command line exceeds child_process's output limit when many
 * processes run (ENOBUFS). `-a`: macOS's pgrep skips its own ancestors otherwise, and a run from a t3
 * session (an agent applying a new patch) descends from t3's main process, which then looked stopped:
 * no restart notification, and a restart that did not wait for the old process to exit.
 */
export function startedAgoS(main: string): number | undefined {
	// Exit 1: no match.
	const pids = spawnSync("pgrep", ["-a", "-x", "-f", literal(main)], { encoding: "utf8" }).stdout.trim().split(/\s+/).filter(Boolean);
	if (pids.length === 0) return undefined;
	// Exit 1 when the match exited meanwhile.
	const etime = spawnSync("ps", ["-o", "etime=", "-p", pids.join(",")], { encoding: "utf8" }).stdout.trim().split("\n")[0]?.trim();
	return etime ? elapsedSeconds(etime) : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function notify(message: string): void {
	const quoted = (text: string) => JSON.stringify(text);
	execFileSync("osascript", ["-e", `display notification ${quoted(message)} with title "pi-harness" sound name "Funk"`]);
}

/** Quits the app and opens it again; false when it did not quit within a minute. */
async function restart(app: string): Promise<boolean> {
	const id = execFileSync("defaults", ["read", join(app, "Contents/Info"), "CFBundleIdentifier"], { encoding: "utf8" }).trim();
	execFileSync("osascript", ["-e", `tell application id ${JSON.stringify(id)} to quit`]);
	for (let waited = 0; startedAgoS(executable(app)) !== undefined; waited += 500) {
		if (waited >= 60_000) return false;
		await sleep(500);
	}
	execFileSync("open", [app]);
	return true;
}

/** Patches the app (waiting out an update that is still swapping the bundle) and brings the running t3 onto the patches. */
export async function keepPatched(app: string): Promise<string> {
	const archive = join(app, "Contents/Resources/app.asar");
	// ShipIt moves the old bundle out before moving the new one in.
	for (let waited = 0; !existsSync(archive); waited += 1_000) {
		if (waited >= 60_000) return `${app} not installed; nothing to patch`;
		await sleep(1_000);
	}
	let result: ReturnType<typeof patchApp>;
	try {
		result = patchApp(app);
	} catch (error) {
		notify(notPatchedMessage(error, process.execPath));
		throw error;
	}
	switch (afterPatch(result.applied, startedAgoS(executable(app)))) {
		case "none":
			return result.message;
		case "restart":
			if (await restart(app)) return `${result.message}; restarted t3, which its update had just started`;
			break;
		case "notify":
			break;
	}
	notify(`t3 was patched for the harness (${result.applied.join(", ")}). Restart t3 to apply.`);
	return `${result.message}; asked to restart t3`;
}

/**
 * The notification for a failed patch run. macOS's App Management permission refuses writes into
 * another app's bundle with EPERM to a process launchd started (2026-11-15: the LaunchAgent never
 * wrote a patch; runs inside t3 or a terminal inherit their app's permission), so that one names the fix.
 */
export function notPatchedMessage(error: unknown, node: string): string {
	if ((error as NodeJS.ErrnoException | undefined)?.code === "EPERM") {
		return `t3 is not patched for the harness: macOS blocked ${node} (App Management). Allow it in System Settings › Privacy & Security › App Management, or run \`npm run patch-t3\` in a terminal.`;
	}
	const message = error instanceof Error ? error.message : String(error);
	return `t3 is not patched for the harness: ${message.slice(0, 160)}`;
}

export const LAUNCH_AGENT = "com.pi-harness.patch-t3";

/** The LaunchAgent that runs `keepPatched` at login and whenever the app's folder changes (an update swaps the bundle). */
export function launchAgent(options: { node: string; script: string; app: string; log: string }): string {
	const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	const string = (text: string) => `<string>${xml(text)}</string>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>${string(LAUNCH_AGENT)}
	<key>ProgramArguments</key>
	<array>${[options.node, options.script, options.app].map(string).join("")}</array>
	<key>WatchPaths</key>
	<array>${string(dirname(options.app))}</array>
	<key>RunAtLoad</key><true/>
	<key>StandardOutPath</key>${string(options.log)}
	<key>StandardErrorPath</key>${string(options.log)}
</dict>
</plist>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const app = process.argv[2] ?? "/Applications/T3 Code (Nightly).app";
	console.log(`${new Date().toISOString()} ${await keepPatched(app)}`);
}
