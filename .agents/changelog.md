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
