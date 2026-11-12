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
