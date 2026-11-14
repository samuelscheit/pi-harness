# Tools

The harness adds or replaces these tools on top of Pi's built-ins (`read`, `edit`, `write`, `grep`, `find`, `ls`). Optional tools are registered inactive and switched on by a [rule or an experiment](prompt.md).

## No tool call blocks for more than two minutes

[`extensions/background`](../extensions/background/index.ts) wraps the execution of every tool call the model makes, whatever the tool: built-in, harness (`bash`, `workflow`, `fix_loop`) or MCP (`mcp__t3-code__delegate_task`, `t3_thread_wait`). A call moves to the background, without being stopped, after two minutes, or as soon as a user message arrives while it runs. The tool returns at once with the output so far and the path of a log of the latest output. When the call ends, its normal result (images included) arrives as a message that names the tool and its arguments and wakes the session, even after the turn has ended. So waiting loops (`until grep …; do sleep 5; done`) are never needed: the tool guideline says so.

- Calls a tool makes itself (`ctx.executeTool` in a workflow script, `tool` inside bash) stay in the foreground of their caller, which needs the result. Only the model's call moves.
- A few tools always run in the background, from the start of the model's call: `BACKGROUND_TOOLS` in [`index.ts`](../extensions/background/index.ts), today `workflow`. The call returns at its first progress update (at most `START_GRACE_MS`, 5 s), with that update, so the result names what it started (a workflow's run id and live view); a call that ends sooner, such as a refused resume, returns its result directly. The final result arrives as a message. Called nested, they stay in the foreground, and so do `workflow { show }` and `workflow { stop }` (`foregroundCall`).
- To start anything else in the background at once: `cmd > log 2>&1 &` in bash, `tool <name> … > out 2>&1 &` in bash for any tool (below), or `delegate_task` in async mode. The guideline says so.
- The turn's abort stops a call in the foreground, not one in the background. A background call stops when the session ends (through its AbortSignal; bash's then kills its process group), not on a harness reload.
- While calls run in the background, the session reports background work (`pi.setBackgroundWork`), so T3 keeps it loaded and keeps a delegated child's run open. The jobs live in process state (`sessionJobs(sessionId).jobs`), so a reload mid-call still delivers the result.
- Calls that end within the limit are untouched.

The seam is Pi's `pi.wrapToolExecution` (added in `vendor/pi`): a wrapper around the execution of model-issued calls only, which may run the tool with its own signal and return before it ends.

Why: agents sat 37 and 40 minutes in a single build command; on one day child agents sat in `workflow` calls of 233, 76 and 62 minutes, a 19-minute `fix_loop` and several 5-minute `delegate_task` waits, about 7 hours in which they could do nothing else and the user's messages could not reach them.

## bash

[`extensions/bash`](../extensions/bash) owns the `bash` tool. Each feature was added after a measured failure in real sessions. A long command moves to the background as every tool call does (above); its message adds the command's process group (`kill -- -<pgid>`).

### Processes a command leaves running are tracked

[`index.ts`](../extensions/bash/index.ts) records each command's process group. When a call ends, [`leftovers.ts`](../extensions/bash/leftovers.ts) lists the live processes of that group whose parent is gone: the jobs the command left running (`./server > server.log 2>&1 &`, parallel jobs, a script's daemon). Each one is adopted, named in the call's result with its pid, and counted as background work. A check every second notices when each one ends and sends its own message that wakes the session, also after the turn. If it left children running in turn, they are adopted then. Leftovers stop when the session ends, not on a harness reload.

A plain `&` job is not the tool's child, so its exit code is unknown: the message says that it ended, and its output is wherever the command redirected it. Output a job writes to the tool's own pipe after the command returned is lost, so the tool guideline says to redirect it to a file.

[`detach.ts`](../extensions/bash/detach.ts) refuses only `setsid` (parsed with a Bash parser, also behind `nohup`, `env` or `sudo` and inside `bash -c '…'`): it moves a job into its own process group, out of tracking, and on macOS it does not exist, so the job never starts.

Why: the most repeated correction in the author's sessions was an agent ending its turn "waiting" on a background job that nothing would ever report (22 sessions over 10 days). Instructions alone did not stop it, and refusing `&` (briefly, on 2026-11-14) made ordinary shell scripting impossible.

### `tool` inside bash

[`bridge.ts`](../extensions/bash/bridge.ts) gives every bash call a `tool` command that runs any tool the agent can call, through the session's normal tool pipeline (validation, hooks, permissions), recorded as a nested call:

```sh
npm run build && ./app --screenshot shot.png && tool read shot.png
tool web_fetch --url https://example.com
tool lens_diagnostics --args '{"source":"lsp","scope":"paths","paths":["src/a.ts"]}'
```

- Required parameters are positional. Others are passed as `--name value`, with repeated options for arrays, JSON for objects, or as one object with `--args <json|->`.
- Text goes to stdout. Failures go to stderr with exit code 1, and usage errors exit with 2, so `&&` and `set -e` work. Images are attached to the bash result.
- Transport: one Unix socket per bash call. A client that dies (`timeout 5 tool …`, `kill`) aborts its call.

`tool <name> … > out 2>&1 &` runs any tool in the background, e.g. `tool workflow --code '…' > wf.out 2>&1 &` followed by more work in the same command. A client the command leaves running keeps its call: the socket stays open while the call's process group lives, so a client still starting when the command returns connects too. The client is a leftover process like any other (listed in the result as `tool …`, counted as background work, stopped at the session's end, kept on a reload), but its end is reported by the bridge: one message with its exit code and the tool's result, images included. Its stdout and stderr still go where the command sent them. Whoever takes a process out of the leftovers reports its end (the bridge when the call answers or its client dies, the leftover check otherwise), so nothing is reported twice. A client that ends before the command returns (`tool x & wait`, a fast call) leaves nothing to track. Only a client the command's shell started directly counts: in `a && tool x &` the job is the subshell running both, reported as a plain leftover.

Why: tool calls in one response run in parallel, so dependent steps cost one model request each. A script expresses the order. Pi's JavaScript code-mode tool saw 4 calls against 4,841 bash calls, so bash became the one way to script.

### `tool edit -`

[`edit-blocks.ts`](../extensions/bash/edit-blocks.ts) accepts SEARCH/REPLACE blocks (aider's format) for several files on stdin, checks every block with Pi's own matching before writing any file, then applies each file as one `edit` call. That way pi-lens checks it and the metrics count it.

```sh
tool edit - <<'EOF' && npm test
src/a.ts
<<<<<<< SEARCH
old
=======
new
>>>>>>> REPLACE
EOF
```

Why: agents edited files with inline Python scripts almost twice as often as with `edit` (813 against 451), mostly to edit several files and then run a check in the same step.

## workflow and fix_loop

[`extensions/workflow`](../extensions/workflow) lets the agent write a TypeScript script that does a procedure in code and calls a model only where a judgment is needed. Only the script's return value reaches the conversation. The full API, as the model sees it, is in [`api.d.ts`](../extensions/workflow/api.d.ts):

| Global | Purpose |
| --- | --- |
| `tools.<name>(args)` | call any session tool |
| `shell(cmd)`, `` sh`…` `` | run shell commands, with values quoted safely |
| `llm(prompt, { schema })` | one model request; JSON answers validated against a schema; cached per session |
| `agent({ system, tools, schema }).run(msg)` | a child agent with tools; in T3 Code a delegated task with its own thread; with `schema` it returns a validated `result` |
| `map(items, fn)` | bounded concurrency |
| `changes()` | the files and diff changed during the run |
| `budget` | the run's USD limit and what it has spent |

### Child agents

`agent()` children ([`agent.ts`](../extensions/workflow/agent.ts)) run as T3 Code delegated tasks when the session has T3's tools ([`t3.ts`](../extensions/workflow/t3.ts)): each child is a thread under the calling one, which the user can watch, steer and stop. The first run is `delegate_task` in wait mode for at most 5 s, so the task, thread and run ids reach the workflow's journal at once, and the wait continues in code with `t3_thread_wait`. Later runs resume the same thread with `t3_thread_send` (warm context and cache). Parallel agents are parallel tasks. Outside T3 (terminal, tests) each child is an in-process Pi session.

Both paths share one protocol ([`delegation.ts`](../extensions/workflow/delegation.ts)). `agent()` writes a spec to `~/.pi/agent/delegations/<id>.json` (system prompt, tool names, result schema, files, caller session), and the child's first message starts with `harness-delegation: <id>` and a readable summary. In the child, the workflow extension ([`child.ts`](../extensions/workflow/child.ts)) reads the marker from the session's first user message, so the spec survives a resume and a restart of the child's Pi. It replaces the base prompt with the spec's system prompt and makes the listed tools the active set; an unknown tool name fails the run before any request.

With a `schema`, the child gets a `submit_result` tool whose parameters are the schema, so Pi validates the result and a wrong shape goes back to the child as an error. A run cannot end without a result: `agent_before_settle` reminds the child, at most twice, then the run fails. The child writes its state (session, cost after every response, each run's text, result or error) to `<id>.result.json`. The parent counts the cost against the workflow's budget while the child runs, cancels the T3 task when the run is aborted or over budget, and returns the run's text, result, cost, thread and the files the working tree changed meanwhile. Spec and state are deleted when the workflow ends; files older than a day are swept at startup.

`files` is only told to the child ("Change only these files"), not enforced: children run in parallel in one working tree, as T3 tasks do. Why: on 2026-11-14 a workflow with six in-process children ran 233 minutes for $107, and the user could not see, steer or stop any of them.

### Durable runs

Every run is durable ([`durable.ts`](../extensions/workflow/durable.ts), [`journal.ts`](../extensions/workflow/journal.ts)). It gets an id and an append-only journal, `~/.pi/agent/workflows/<id>/journal.jsonl`, next to a snapshot of the working tree at its start (for `changes()`) and its page. Every call to the outside (`shell`, `tools.*`, `llm`, `agent().run`, `workflows.*`, `changes`) has a key: its kind, a hash of its canonical arguments, and its occurrence among calls with the same kind and hash (`shell:3fa2c9d1e0b4#2`). It is not a global sequence, because parallel calls (`map`, `Promise.all`) finish in varying order. The journal records `start` before a call and `done` or `failed` after it, fsynced. Agent runs add `meta` entries as soon as they know their spec, t3 task, thread and run, or their child session file. A nested workflow's calls have keys inside its own (`workflow:…#1/shell:…#1`), so a replayed one skips them and they do not shift the numbering outside.

**Resume** runs the same script from its start. A call with an outcome runs nothing and returns or throws it. The first call without an entry runs live. Calls started without an outcome were in flight when the process died:

- `agent().run` reattaches. In t3 it waits for the recorded run. When the run id is unknown (the start was in flight), it waits for the child's report in its state file if the child started the run. Otherwise it repeats `delegate_task` (or `t3_thread_send`) with the same `clientRequestId`. t3 dedupes that only within one MCP session, that is one Pi process: on 2026-11-14 a real crash and resume got a new task for the same id, and the agent's work ran twice. That is why the ids are journaled within seconds and the state file is checked first. An in-process child reopens its session file. A child whose own run was cut off gets a message, numbered as the same run, to continue.
- `llm`, `changes()` and `workflows.*` run again. A nested workflow has no effects of its own: its calls are journaled one by one.
- `shell` and `tools.*` do not rerun blindly. The resume does not start and names them; the agent checks and resumes with `inFlight: "rerun"` or `inFlight: "fail"` (they throw `InterruptedCallError`, which the script can catch). A call made with `{ idempotent: true }` reruns without asking.

`Date.now()`, `new Date()` and `Math.random()` in the script return recorded values on replay, by occurrence (a prelude in the script's vm realm, [`compile.ts`](../extensions/workflow/compile.ts)). While recorded calls remain that the script has not asked for again, a new call waits, since in parallel code a recorded one may still come. When nothing can bring one any more (no call or script timer runs), the script took another path. The resume then stops as `diverged`, with an error naming the recorded call and the new one, and nothing of the new path runs. Costs replay with the calls, so the budget covers the whole run. `resume` with `budget` sets a new limit, kept for later resumes.

**Stop.** `workflow { stop: "<id>" }` stops a running run from any session: it writes `stop.json` into the run's directory, which the process holding the run polls ([`stop.ts`](../extensions/workflow/stop.ts)). The script's pending calls reject, and the run ends as `stopped`, which can be resumed. Shell calls in flight are killed with their process group, and tool calls are aborted. They record no outcome, so a resume asks for `inFlight` as after a crash. A killed command has certainly stopped, but it may have done part of its work (a commit without its push), so running it again is still the agent's decision. Calls made with `idempotent: true` run again without asking.

By default `agent()` children keep running. Their work runs under a signal of its own, which a plain stop does not abort. The process keeps the run's lock and journal until they end, records their outcomes, and the end entry lists them (`lingering`). A resume in the same process adopts them: it waits for their outcome instead of reattaching. A resume elsewhere is refused while they run. `stopChildren: true` cancels them (`task_cancel`, or an abort in-process), also later for a stopped run whose children still run. A resume then asks a cancelled child to continue. Stopping a run that ended, or an unknown id, is an error. The stopped run's result message says how to resume or edit it.

**Edited code.** `workflow { resume: "<id>", code: "<new code>" }` continues a run with changed code, also one that failed or completed. It costs nothing again for the calls the new code repeats. An `edit` entry records the code (its hash, and the source), which is the run's code from then on. A recorded call answers when the new code asks for it with the same key, and only after every recorded call that had finished before it started. So an equal call added or removed before it does not take its result through the occurrence number. Where strict replay would stop as `diverged`, the new code takes over. A `takeover` entry records the position (the call, how many calls were replayed) and the recorded calls left unused, and from then on every call runs live. The result names the unused calls ("3 recorded calls not used by the new code"). An agent run in flight at the stop is adopted only when the new code asks for the same call. An unused one is cancelled, unless it already finished, in which case its result stays recorded but unused. Effects of the old code before the edit (commits, files) stay. Without `code`, a resume stays strict, because the same code taking another path means non-determinism.

**Interruptions.** A run stops as `interrupted` (resumable) when its session ends (background calls stop with `SessionEnded`) or when its tool context goes stale: a harness release reloads the extensions, and the old context can no longer call tools (`ContextStale`). Calls stopped by the run's own abort record no outcome; they stay in flight. A t3 child keeps working through an interruption, so the resume reattaches to it. The session records each run's start and end (`workflow-run` entries). When a session starts, every run it started that died with its process, or ended interrupted, and that no process runs (a lock in the run's directory) is offered once in a message that wakes the agent. The agent resumes it with `workflow { resume: "<id>" }`. A resume needs the session's tools (t3's for agents), which only a tool call has, so it goes through the agent. The final result arrives, as always, as the message ending the resuming call.

**What the journal cannot protect.** Effects outside these calls are not journaled: a script that writes through a side channel, a shell command whose effect depends on time, or a command a crash cut off mid-way. A shell command keeps running after its Pi process died (its own process group), so check before choosing `rerun`. A saved workflow whose file changes between the start and a resume diverges or replays what the old one recorded. The journal holds the code (the start's and every edit), so runs resume as they were.

**Cleanup.** Journals of ended runs are deleted a day after they end. Interrupted and stopped ones are kept for a week, for a resume (`sweepRuns` at startup).

### Seeing a run

[`render.ts`](../extensions/workflow/render.ts) turns a journal into a self-contained page: `renderWorkflow(entries)` is pure, so the same journal gives byte-identical HTML (snapshot test). Calls that overlap in time form a parallel group drawn as lanes side by side, and groups follow each other. Each node shows the kind, a short label, the status (running, done, failed, replayed, interrupted, stopped, unused), duration and cost. An agent node also shows its model and t3 thread link. The header has the total time, cost against budget, and open against done calls. A run resumed with edited code shows a "new code from here" marker where each version took over, and lists every version with its hash and source. It uses only t3's theme variables and html_render's layout rules.

- **In the thread** ([`runs.ts`](../extensions/workflow/runs.ts)): the harness calls t3's `html_render` itself, as a nested call of the workflow's own tool call, at the start (in the calling run) and at the end, in the run the result message wakes (at its first finished assistant message). t3 accepts a page only while a run of the thread is active. A real-thread experiment on 2026-11-14 got it rendered from an earlier run's call while a later run was active, and refused with `parent_not_active` while the thread was idle. At the woken run's `turn_start`, t3 had not adopted the run yet, so a refused end page is tried again at the next messages (3 times). When the call's context went stale, the result asks the agent to show the page at its path. `workflow { show: "<id>" }` shows it on request. Outside t3, nothing is rendered.
- **Live in the dashboard** ([`dashboard/server/workflows.ts`](../dashboard/server/workflows.ts)): `/workflows/<id>` serves the same page, updated through server-sent events on every journal append, and `/workflows` lists recent runs. The workflow's immediate result names the URL, and in t3 the harness opens it in the preview panel (`preview_open`).

Why: on 2026-11-14 a workflow had run 130 minutes ($15.87, one Opus agent) when a t3 restart would have lost it, and no one could see its progress.

Saved workflows become tools of their own: `<repo>/.pi/workflows/<name>.ts` for a project, [`workflows/`](../workflows) for every session. They are read on every run, so a workflow the agent saves can be called from its next turn.

[`fix_loop`](../workflows/fix_loop.ts) is the shipped workflow. It hands a failing check with a clear error and a known set of files to a cheaper child agent (Sonnet) with a short context. The workflow runs the check itself before the first round and after every round, so "green" means the check's exit code, not the child's claim, and no change outside `files`. A change outside them is sent back to the child to undo and reported as `outside` while it remains.

Why: in one large project, repair chains (failed check → … → green) cost 17% of all spend, 59% of it cache reads of a median 379k-token context per turn.

## ask_user

[`extensions/ask-user`](../extensions/ask-user/index.ts) implements Codex's asynchronous `request_user_input` contract on Pi's dialogs. It shows the questions and returns `{"accepted":true}` at once. The answers arrive later as a message that steers the running turn or starts a new one. One call is one dialog: in T3 a single card with every question, each also accepting typed text; in the terminal, one question after another. Calls do not queue behind each other.

The tool description is taken from Codex CLI (Apache-2.0, see [NOTICE](../NOTICE)). In T3 it needs the [patches](install.md#t3-code-integration).

## web_search and web_fetch

[`extensions/web`](../extensions/web/index.ts). Pi keeps no server-tool blocks in its messages, so, as in Claude Code's WebSearch, each call is its own small Messages request to Haiku with Anthropic's `web_search_20250305` or `web_fetch_20250910` server tool. It returns the findings as text and reports its usage, so the cost counts toward the session and shows in the metrics. This works whatever model the session runs on.

## goal

[`extensions/goal`](../extensions/goal/index.ts): set, show or finish the session's goal (`set`, `achieved`, `blocked`, `wait`, `show`). While a goal is active, the run cannot end until the goal is achieved (its check must exit 0) or blocked, or until every remaining step depends on a running background job. See [goal.md](goal.md).

## /warm and keep_warm

[`extensions/warm`](../extensions/warm/index.ts) holds the session's prompt cache warm until a time, so the next request reads the cache instead of writing the whole context again.

Pi's warmer stops early on its own: an idle refresh must save at least $0.05 assuming a 15% chance that the user returns, and warming ends 60 minutes after the last request while the agent runs, or after `cacheWarmingIdleMinutes` when idle. When the user says they will be back, or a coordinator waits for its children, those guesses are wrong. A hold (`pi.setCacheWarmingHold`, added in `vendor/pi`) tells Pi that the user returns. Until it ends, every refresh is sent, also past those limits and with the `cacheWarming` setting `"off"`. Pi's own checks stay: a request that cannot be replayed safely, a model without a known cache lifetime, a changed conversation, and a failed refresh end warming.

| Command | |
| --- | --- |
| `/warm 3h`, `/warm 90m`, `/warm 2h30m` | hold for that long (at most 24 hours) |
| `/warm until 18:00` | until a local time, the next day if already past (an ISO date-time works too) |
| `/warm on` | until the next real request, at most 4 hours |
| `--max $2` | with any of them: a budget for the refreshes |
| `/warm off` | end the hold |
| `/warm` | show the hold, its spend and its estimate |

The agent's `keep_warm` tool takes `{ for?, until?, off?, max_usd? }`. Without `for` or `until`, it holds until the next request. Its guideline: use it when the user says they will be back later, or when results arrive later.

- **Storage:** each change appends a custom entry `harness-warm` holding the whole hold (or `null` with the reason it ended). So it survives reloads and restarts: `session_start` sets a hold that is still in the future again. After a restart Pi no longer has the last request to replay, so warming resumes with the next request.
- **End:** at its time; with `off`; with the next real request for the default hold (an explicit hold outlives requests); when the next refresh would take the spend over the budget; or with the session. Spend is the cost of the session's `cache_warm` usage entries since the hold started. A refresh is priced at what the last one cost, or at Pi's estimate from the model's prices if that is more.
- **Cost:** setting a hold reports the price of a refresh (Pi's `warmCost`), the refresh interval (90% of the cache lifetime), and the total until the end. The status line shows the end, the next refresh and the spend.
- **Five-minute cache:** with it, a long hold refreshes every 4.5 minutes, which adds up to about what the misses would cost. The message then says how to switch to the one-hour cache. Retention comes from the request (none sets it today), else the `cacheRetention` setting (the project's `.pi/settings.json` over `~/.pi/agent/settings.json`, read at start and on `/reload`), else `PI_CACHE_RETENTION=long`, else short. The installer sets `"long"`, so this applies to models with only a five-minute tier, or where a setting chose `"short"`.

## note_improvement

[`extensions/improvements`](../extensions/improvements/index.ts). The agent records friction (a correction, a missing or wrong instruction, a misleading tool) with an observation and a proposal. It only appends to a backlog, so it costs almost nothing during the task. See [self-improvement.md](self-improvement.md).

## pi-lens

[pi-lens](https://github.com/apmantza/pi-lens) adds LSP diagnostics, linters, formatters, autofix, a read guard, structural rules, and code-navigation tools (`lens_diagnostics`, `symbol_search`, `module_report`, `read_symbol`, ast-grep tools behind `pi_lens_activate_tools`).

[`extensions/lens`](../extensions/lens/index.ts) makes every pi-lens setting configurable at two levels:

- **Global:** [`config/pi-lens.json`](../config/pi-lens.json), versioned in this repository.
- **Project:** `<repo>/.pi/pi-lens.json`, any key.

Objects merge key by key, other values replace, and `null` removes a global key. The merged file is written to `~/.pi/agent/pi-lens/<hash>.json` and passed to pi-lens through `PI_LENS_CONFIG_PATH` before pi-lens loads. pi-lens's own `.pi-lens.json` still applies on top.

The one global deviation from pi-lens's defaults is `contextInjection.retain: true`. Without it, an injected finding rides on one request only, so the next request's prefix differs from the cached one and the cache is rebuilt.
