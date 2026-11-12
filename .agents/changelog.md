# Harness changelog

Every change to the harness with its evidence, the metric that judges it, and how to revert it.

## 2026-11-12 — prompt: batch independent tool calls

**Change:** `prompt/base.md`, section "During a turn": independent operations (reads, searches, `git status`/`git diff`, listing) go out as tool calls in the same response; only calls that do not depend on each other's results are batched.

**Evidence:**

- Pi and the API already allow parallel tool calls: Pi does not set `disable_parallel_tool_use`, and runs the calls of one response concurrently (`toolExecution` defaults to `"parallel"`; no tool is `executionMode: "sequential"`).
- The model still sends one call per turn: law-formalization 12.11. rot-main-7 had one call in 319 of 322 turns, stufe-11a in 267 of 271; Claude Code in the same project has one call in 94% of 27k responses.
- Every turn re-reads the whole context from cache: $0.064 per turn in rot-main-7 (Ø 322k context, 70% of its cost), $0.094 in stufe-11a (Ø 472k, 54%). A third of the turns were small reads and searches (< 300 output tokens, one call: `sed`, `grep`, `git`).
- Model time per turn is ~2 s fixed plus ~8 s per 1k output tokens, independent of context size, so batching mainly saves cost, not time.
- Anthropic recommends exactly this system-prompt instruction for Claude 4+ in coding loops (https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use).

**Expected effect:** about 10% less cost per package; little effect on wall time (tool execution dominates).

**Judged by:** tool calls per turn (from ~1.01), turns and cache-read cost per package; guardrail: tool error rate (dependent steps batched wrongly). Compare by harness version (`requests.version`); this is a before/after comparison, not a randomized A/B.

**Revert:** remove the bullet from `prompt/base.md`.

## 2026-11-13 — harness: randomized A/B experiments; parallel-tools runs as the first one

**Change:**

- A/B mechanism (`extensions/lib/experiments.ts`): an experiment is a file `prompt/experiments/<name>.md` (frontmatter `status: running|stopped`, `started`, `stopped`; body = the variant). Every session gets an arm per running experiment, 50/50 from a hash of session id and experiment name: stable when the session resumes, independent across experiments, and a delegated child draws its own. The arm is written into the session file as a `harness-experiment` custom entry (also when the experiment later ends for the session).
- `extensions/prompt` adds the body in arm B as its own section `<experiment-<name>>` after the other sections; arm A gets nothing, so the two arms' harness versions differ exactly in that section and share the cached prefix before it.
- Metrics: `experiment_arms` and `requests.tool_calls` in the index (schema 9, a one-time re-index), `queries/experiments.ts` compares the arms (only random sessions, only projects with both arms, only turns while the session was in the experiment) with a 95% bootstrap interval of B − A over sessions.
- `/harness experiment` shows the running experiments, this session's arm and the interim results; `/harness experiment <name> on|off` forces this session's arm (it then leaves the random comparison); `/harness experiment <name> stop` marks the file stopped and appends the result here.
- The batching rule moved from `prompt/base.md` to `prompt/experiments/parallel-tools.md`: only arm B gets it.

**Evidence:** the before/after comparison by harness version is confounded: package costs spread from $2 to $147, the task mix changes by day, and edits to a project's `AGENTS.md` make new versions too. Randomizing per session over the same days and projects removes that.

**Judged by:** `parallel-tools`: tool calls per turn (from ~1.01) and the share of turns with 2+ calls; then turns per package and per session, cost and cache-read cost per session and per turn; guardrail: tool error rate (dependent steps batched wrongly).

**Revert:** `/harness experiment parallel-tools stop` (or delete the file) ends the experiment; promoting it means moving the text back into `prompt/base.md`. Reverting the mechanism: revert this commit.

**Non-prompt variants** (for example the compaction threshold 200k vs 300k): same file and arm entries; the frontmatter names the setting and value, and the extension owning the setting applies it after reading the session's arm. Not built yet (see `extensions/lib/experiments.ts`).

## 2026-11-13 — experiment: single-edit

**Change:** new experiment `prompt/experiments/single-edit.md` (arm B only): plan all changes to a file and send them in one `edit` call (several `edits[]`); split only when a later change needs feedback (check, test) from an earlier one.

**Evidence:** law-formalization, 863 Claude Code sessions ($11.2k): 3,725 times the next call edited the same file again in a new turn with nothing in between ($315, 2.8% of cost); only 272 times were several edits to one file already in one turn. Pi's `edit` already takes several replacements. Scripts: `/tmp/subx/edits/` (`cycles.py`, `detail.py`).

**Judged by:** turns and cost per package, edit calls per edited file; guardrail: edit error rate (`oldText` not found), tool error rate. Note: in law-formalization Pi agents edit almost only through `bash` (python heredocs, `cat >`, `sed -i`), which this rule does not reach.

**Revert:** `/harness experiment single-edit stop`, or delete the file.

## 2026-11-13 — experiment: edit-tool

**Change:** new experiment `prompt/experiments/edit-tool.md` (arm B only): change files with `edit`/`write` instead of shell commands (heredocs, `cat >`, `sed -i`, inline scripts); the shell only for bulk mechanical replacements, generated output, moves and deletes.

**Evidence:** Pi sessions so far route almost every file change through `bash`: law-formalization 15 of 216 mutating calls through `edit`/`write` (7%), other projects 101 of 557 (18%). rot-main-7 changed files with 34 Python heredocs, 27× `cat >`, 6× `sed -i` and no `edit` call. pi-lens checks files after `edit`/`write` and sees shell writes only for files it already tracks, so its diagnostics never reached those agents; `single-edit` cannot act either.

**Judged by:** share of mutating calls through `edit`/`write` (from 7–18%); then first check run after edits failing (law-formalization Claude Code baseline 34%), cost of repair chains, turns and cost per package; guardrails: edit error rate, tool error rate. Interacts with `single-edit` (independent arms; the 2×2 cells can be compared).

**Revert:** `/harness experiment edit-tool stop`, or delete the file.

## 2026-11-13 — experiments: crossed comparison (interacts)

**Change:** an experiment file can declare `interacts: <name>` (or a list). `/harness experiment` then also compares the crossed cells AA/AB/BA/BB over the time a session was in both experiments, with the interaction (BB − BA) − (AB − AA) and a bootstrap interval; the stop entry includes it. `edit-tool` declares `interacts: single-edit`. Two metrics added to every comparison: share of file changes via `edit`/`write`, and edit calls per edited file.

**Why:** `single-edit` can only act on `edit` calls, which `edit-tool` adds; their effects are not independent, so the per-experiment B − A alone would hide that.

**Revert:** remove `interacts` from the file (the comparison code stays harmless), or revert the commit.

## 2026-11-13 — experiments can switch tools; metrics follow tool children

**Change:**

- An experiment file may name tools in its frontmatter (`tools: fix_loop` or a list); the body becomes optional. Arm B gets the tools active, arm A not (`toolSwitches` in `extensions/lib/experiments.ts`, applied by `extensions/prompt` to `selectedTools` on every run). The tools are registered inactive; a forced arm switches them from the next run, a stopped experiment turns them off for everyone. The arms' harness versions differ exactly in these tool definitions.
- Comparisons add, per tool an experiment switches: share of sessions and of turns calling it, share of calls reaching their goal (tools reporting `details.ok`), share of file-changing calls after which the agent read a changed file again. A session's cost includes the child sessions its tools ran (`childCostPerSession` shows that part), so an arm that moves work into cheaper children is not counted as saving all of it.
- Index (schema 10): tool results add what they report beyond their arguments: nested calls (codemode scripts, defined tools) and `details.changedFiles` count as the call's files, `details.ok` as `tool_results.ok`, `details.childSession` as a `delegations` row of kind `tool`. `sessions.parent_session` is the parent's id (Pi records a file path; forks were not linked before).
- Fix: a schema rebuild dropped the imported Claude Code sessions (2,158) and the rebuilt index did not import them again until a view asked for that source. The store now remembers the import in `meta` across rebuilds (and recognises older stores by their rows), and the next index imports them again.

**Revert:** revert the commit; experiments without `tools` behave as before.

## 2026-11-13 — experiment: fix-loop (`fix_loop` tool)

**Change:** new tool `fix_loop` (`extensions/fix-loop`) and experiment `prompt/experiments/fix-loop.md` (arm B: the tool and one paragraph on when to hand a failing check to it). `fix_loop(goal, files, check, context?, maxRounds = 6, model = anthropic/claude-sonnet-5-5)` runs the check, then a child session in the same process (SDK, read/bash/edit/write, no parent history, own session file naming the parent) until the check exits 0 or the rounds run out; the tool runs the check itself after each round, so green is the exit code. edit/write outside `files` are refused; other changes outside `files` (shell) are put back after each round and named to the child and the parent. Returns green or not, rounds, the diff of the changed files (cut, full diff in a temp file), the last failure when not green, and the child's cost and tokens.

**Evidence:** law-formalization, 863 Claude Code sessions ($11.3k): repair chains (failed check → … → green) cost 17% ($1,944): 59% cache reads, 23% output, 18% writes and input; median context per chain turn 379k. A cheaper model with a short context could save up to ~12% of the project's cost (upper bound). First live run (probe repo, two bugs in one function): green after 1 round, child $0.028 (Sonnet 5.5, 15k cache read), parent $0.13 + $0.01 for the two turns around it.

**Judged by:** cost per session and per package with the children included (from `costPerSession`), `fix_loop` usage, its goal rate (`fix_loop:ok`) and how often the parent rereads the changed files afterwards (`fix_loop:reread`: high means the diff in the result is not enough); guardrails: tool error rate, turns per package.

**Revert:** `/harness experiment fix-loop stop`, or delete the file (the tool then stays inactive).

## 2026-11-13 — experiment: define-tool (`define_tool` tool)

**Change:** new tool `define_tool` (`extensions/define-tool`) and experiment `prompt/experiments/define-tool.md`. The agent defines a named tool from a shell template with `{{parameter}}` placeholders (string or number parameters, optional defaults, output filter, last-lines limit, cwd); each value is inserted as one single-quoted shell word, placeholders inside quotes are refused. The tool is registered at once and runs through the session's bash tool. Definitions are custom entries (`harness-defined-tool`) and come back when the session resumes; `scope: project` also writes `<repo>/.pi/tools/<name>.json` for later sessions. Names of other tools are refused, redefinition replaces. Defined tools are active exactly when `define_tool` is, so arm A never sees project tools from arm B.

**Evidence:** 16% of long bash commands resemble an earlier one of the same session, but they are only ~0.6% of the cost: the expected gain is reliability (quoting, the same output filter every time), not cost. Live-SWE-agent (arXiv 2511.13646): tools created at runtime raised SWE-bench Verified from 70.6% to 75.4%.

**Judged by:** `define_tool` usage per arm, tool error rate, turns per package; then calls of defined tools (by name in the session's tool results).

**Revert:** `/harness experiment define-tool stop`, or delete the file; remove `.pi/tools/` from projects to drop shared tools.

## 2026-11-13 — experiment: codemode

**Change:** experiment `prompt/experiments/codemode.md` activates Pi's built-in `codemode` tool in arm B (`codemode.mode` stays `on`: the other tools stay declared) with one paragraph on when to script several calls. Declares `interacts: parallel-tools`, which targets the same batching.

**Evidence:** 94–99% of turns carry one tool call while every turn re-reads the whole context (see the parallel-tools entry); a script runs several calls and returns only their filtered result.

**Judged by:** turns per package, cost and cache-read cost per session, `codemode` usage; guardrail: tool error rate. File effects of calls made from scripts count through Pi's nested-call records.

**Revert:** `/harness experiment codemode stop`, or delete the file.

## 2026-11-13 — t3 patch: Pi dialogs outlive the turn that showed them

**Change:** `scripts/patch-t3.ts` now holds a list of patches, each skipped once its marker is in the bundle. The new `dialogs` patch (t3code branch `pi-dialogs-outlive-turns`) stops t3's Pi adapter from cancelling open dialogs when a turn ends, cancels a card when Pi reports `dismiss` for it, and counts open dialogs as background work. vendor/pi's RPC mode sends `{"type":"extension_ui_request","id":…,"method":"dismiss"}` when it closes a dialog itself (abort signal or timeout).

**Evidence:** the user saw every `ask_user` card appear briefly and disappear, and the agent received "(dismissed without an answer)". `finalizeTurn` in t3's Pi adapter called `cancelPendingPrompts`; `ask_user` returns at once, so the turn ended seconds after asking and the cancel reached Pi as the answer. Stop had the same effect and woke the agent again with "dismissed".

**Judged by:** `ask_user` answers that are not "dismissed" (user_messages of custom type `ask_user`); no dialog cards left that Pi no longer waits for.

**Revert:** restore `app.asar.pre-pi-harness` and run `node scripts/patch-t3.ts` without the `dialogs` entry; revert the `dismiss` lines in `vendor/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts`.

## 2026-11-13 — experiment: workflow (`workflow` tool, saved workflows; fix_loop becomes one)

**Change:** new extension `extensions/workflow` and experiment `prompt/experiments/workflow.md` (`interacts: codemode`, which keeps running). The agent writes a TypeScript script (an async function body) that runs in-process in a `node:vm` context (compiled by jiti with line numbers kept) and does a task's procedure in code, calling a model only where a judgment is needed:

- `tools.*` (the session's tools through `ctx.executeTool`: same hooks, permissions, nested-call records), `shell()` (exit codes), `llm()` (one request; with a JSON Schema the answer comes from a `respond` tool call, validated and coerced, invalid answers retried twice; results cached per session by exact input so reruns of an edited script repeat only changed calls), `agent()` (a child Pi session with its own session file naming the parent; `files` refuses edit/write elsewhere and reverts other changes after each run; agents with `files` run in parallel and never revert each other's files, unguarded writers run alone: `lock.ts`), `map()` (bounded concurrency), `changes()` (diff since the run started), `log()`, `budget`, `workflows.*`.
- Every run has a USD budget (llm() and agent() costs); exceeding it aborts everything in flight. Only the returned value reaches the conversation (strings verbatim, data as YAML), with cost, calls, changed files; `ok: false` in the value marks the goal missed (`details.ok`).
- Saved workflows: `<repo>/.pi/workflows/<name>.ts` and the harness's `workflows/<name>.ts` export `meta` (description, JSON Schema parameters, budget, guidelines) and a default function, and become the tool `<name>`; a file saved during a turn is a tool from the next turn. Saved workflows follow the `workflow` experiment unless an experiment names them. `extensions/workflow/api.d.ts` is both the model-facing reference (embedded in the tool description) and the declarations `npm run check` type-checks saved workflows against (`workflows/tsconfig.json`).
- `fix_loop` is now the harness workflow `workflows/fix_loop.ts` (same parameters and behaviour, budget $5); `extensions/fix-loop` is removed, its git snapshot code moved to `extensions/lib/workspace.ts`. The `fix-loop` experiment is unchanged.
- Index (schema 11): `details.childSessions` (a list) replaces `details.childSession`; each child is a `delegations` row of kind `tool` with `call_id` `<tool call id>/<n>`.

**Evidence:** every agent turn re-reads the whole context (median request 144k), while many tasks are procedures whose steps need no conversation: the same check over many items, loops until a command passes, independent subtasks. A script holds the procedure and spends tokens only on the judgments, with cheap models where they suffice. Live check through the gateway: three Haiku classifications with a schema, one cache hit and a read-only Sonnet child cost $0.0068 in 5.6 s.

**Judged by:** turns and cost per session (children included), `workflow` usage and goal rate, saved workflows created and called; guardrails: tool error rate, corrections. Crossed with `codemode`.

**Revert:** `/harness experiment workflow stop`; saved workflows then stay inactive. `fix_loop` follows its own experiment.

## 2026-11-13 — harness: releases and hot reload of running sessions

**Change:**

- Pi loads the harness from `~/.pi/agent/harness/current`, a link to a snapshot of one commit of this repository's deployed branch (`main`): `git archive` without `vendor/`, with links back to `vendor/` (Pi itself and pi-lens, not hot-swappable), `node_modules` and `dashboard/node_modules`, and `.release.json` (commit, source, branch). `extensions/lib/release.ts`.
- `extensions/release`: every Pi process running a release watches the branch (ref file times every 3 s). A new commit is deployed by the first process that sees it, under a lock, after every extension entry point imports in a fresh Node process; a commit that does not load is reported once per session and stays undeployed, the running release keeps running. The link switches atomically; the current release and the five newest others are kept (going back is switching the link). Each session reloads into the deployed release when idle (`ctx.reload()` through the `/harness-reload` command; a busy session after its run settles), says `Harness reloaded: old → new subject`, and once per process when a release changed `vendor/pi` (needs a restart). The process that deployed restarts a running dashboard of an older release.
- Writes go to the repository, not the release: the harness backlog, the changelog, a stopped experiment's file (`SOURCE_ROOT`, `inSource`). Running a release, `/harness experiment <name> stop` commits its two files (`git commit --only`), so the stop is deployed like any commit.
- The metrics index refuses to be opened by older code than the one that built it (`cf0aedf38`), so a session that has not reloaded yet cannot downgrade it.
- `scripts/install.mjs` deploys the current branch and points `packages` at the link.

**Why:** running sessions kept the code they started with for hours (an old process could rebuild the metrics index at an old schema), and reloading from the working tree would hand half-finished edits of any agent to every session: during this change the working tree had a broken `fix_loop` import for a while.

**Verified:** `test/release.test.ts` (committed content only, uncommitted and other-branch commits stay out, broken import / syntax error / throwing module refused once, lock and stale lock, pruning and going back, `commitToSource` leaves other staged work, the extension reloads idle sessions at once and busy ones after settling, reports failures once, announces reloads and Pi changes once). Live in RPC mode with Haiku against a clone: an idle session reloaded 3.5 s after a commit, a commit during a turn reloaded 2 s after it settled, the new prompt text reached the next request as an appended section update (cached prefix kept), a broken commit gave one warning and no reload.

**Effect:** uncommitted edits to prompts, experiments and extensions no longer reach sessions; they take effect on commit (seconds later, at the next idle moment).

**Revert:** point `packages` in `~/.pi/agent/settings.json` back at the repository (the release extension then does nothing), or revert the commit.

## 2026-11-13 — define_tool merged into workflows

**Change:** `define_tool` and its experiment are removed. A command the agent keeps running with different arguments is now a saved workflow (`<repo>/.pi/workflows/<name>.ts`): its parameters are the tool's parameters, and the new script global `sh` builds the command with every interpolated value as one quoted shell word (template taken raw; values inside quotes, NUL and other types refused), the guarantee `define_tool` had. Output filtering and line limits are plain code in the workflow. The `workflow` tool carries `define_tool`'s guideline, and `api.d.ts` shows such a workflow as its example. Session-only definitions are gone: saved workflows are files of the repository, callable from the next turn and in later sessions.

**Why:** a shell-template tool is a one-line saved workflow; two mechanisms for agent-defined tools meant two experiments, two registries and two persistence schemes. No `.pi/tools/*.json` definitions existed in the user's repositories to migrate.

**Judged by:** the `workflow` experiment (saved workflows created and called, tool error rate). The `define-tool` experiment ends without a logged comparison (it started the same day); the sessions' recorded arms stay in their files and the index.

**Revert:** revert the commit.

## 2026-11-13 — releases reload sessions mid-run

**Change:** vendored Pi gets `pi.requestReload()`: at once when idle, at the next turn boundary of a running agent run (after the turn's tool results, before the next model request), else when the run settles; repeated requests are one. After a turn-boundary reload, `before_agent_start` runs again with `reloaded: true`, so the reloaded handlers rebuild the run's prompt sections and tool selection, and the run's remaining turns use the new tools and prompt (sent as an appended prompt update, so the cache stays). A tool call executing at the time finishes on the old code. `extensions/release` now calls it instead of sending itself `/harness-reload` when idle and again on `agent_settled`; the command is removed.

**Why:** a session picked up a new release only after its run, and a long autonomous run (or an agent improving the harness during its own run) never did.

**Verified:** Pi tests (`agent-session-request-reload.test.ts`): idle reload; mid-run reload where the requesting tool call finishes on v1, the next turn's call runs v2 and the next request carries v2's prompt section; a request in the last turn reloads after settling, once; a request from an `agent_settled` handler waits for the handlers; a reloaded handler's tool selection applies; `reload()` itself still refuses during a run. The other Pi tests are unchanged (27 failures in cache warming, config schemas, package commands and `find` fail the same without this patch). Harness: 287 tests pass.

**Needs:** a Pi restart once (Pi itself changed). Until then the new release extension's reload request fails in old processes and the session reports it.

**Revert:** revert the commit and restart Pi.

## 2026-11-13 — the dashboard runs whenever Pi runs, and follows releases

**Change:** `ensureDashboard` (`dashboard/server/launch.ts`) replaces `launch` and `restartOutdated`: it starts the dashboard detached when none answers and replaces one on another release than the deployed one, under a lock shared by all Pi processes (`~/.pi/agent/dashboard.lock`); the new release's frontend is built before the old server is stopped. Every Pi process running the installed harness calls it at session start and every 30 s (`extensions/metrics`), and the release extension right after deploying. A failure is shown once per distinct message. The deploy lock's code moved to `extensions/lib/lock.ts` (pid + heartbeat, takeover of abandoned locks) and is shared.

**Why:** the dashboard ran only after `/harness dashboard`, and a deploy only restarted a server that still answered. A server that crashed, or was stopped by a deploy whose Pi process then died (seen 2026-11-12, pid 60330), stayed down until someone asked for it.

**Verified:** `test/dashboard-keeper.test.ts` with real servers on a free port: start, reuse, restart after SIGKILL, replacement of a server on another release, a held lock, three concurrent checks start one server; the extension checks at start and periodically, stops on shutdown, never overlaps checks and reports each failure once. Harness: 295 tests pass.

**Revert:** revert the commit.
