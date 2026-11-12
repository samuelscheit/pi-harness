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
