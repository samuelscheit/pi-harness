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
