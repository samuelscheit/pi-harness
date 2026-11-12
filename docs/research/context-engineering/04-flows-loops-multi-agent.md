# 04 — Flows, loops and multi-agent context isolation

Slice: control flow and loop architectures, and how context is isolated or shared across agents.
Research date: this document was written against sources fetched in one session. Every claim cites a URL, and dates are given where the source states them. Benchmarks are vendor self-reports unless noted otherwise.

## TL;DR

1. The dominant production architecture is a single append-only tool loop: call the model, run its tool calls, append results, repeat until no tool calls are left. Codex, Claude Code, Pi and smolagents all use it. Everything else is a policy layered on top: plan mode, todos, subagents, compaction, hooks. ([OpenAI, Jan 2026](https://openai.com/index/unrolling-the-codex-agent-loop/), [Anthropic, Dec 2024](https://www.anthropic.com/engineering/building-effective-agents))
2. External verification is the best-supported way to improve a loop. Self-critique without an outside signal does not reliably help reasoning and can hurt it ([Huang et al., ICLR 2024](https://arxiv.org/abs/2310.01798)). Tests, linters, type checkers and browser checks do help. For example, SWE-agent drops from 18.0% to 15.0% without its lint-on-edit guardrail ([SWE-agent](https://arxiv.org/html/2405.15793v3)).
3. Subagents with clean context are worth using for read-heavy work: search, exploration, review. They return about 1–2k-token summaries ([Anthropic, Sep 2025](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Parallel writers are where systems still fail. Cognition (2025 and again in Apr 2026), Codex docs, Claude Code docs and Anthropic's research post all agree.
4. Multi-agent costs a lot of tokens. Agents use about 4× the tokens of chat and multi-agent systems about 15×, and token usage alone explains 80% of BrowseComp variance. The 90.2% gain Anthropic reports is for breadth-first research, not coding ([Anthropic, Jun 2025](https://www.anthropic.com/engineering/multi-agent-research-system)).
5. Cognition's Apr 2026 revision reframes the multi-agent question. Multiple agents may contribute intelligence (review, a "smart friend" model, a manager doing map-reduce), but only one agent writes. A clean-context reviewer catches about 2 bugs per PR, ~58% of them severe ([Cognition](https://cognition.com/blog/multi-agents-working)).
6. Long-horizon work is solved with state outside the context window, not bigger windows: a feature list, a progress file, git commits, init.sh, fresh sessions each round. The forms vary: Anthropic's initializer/coder split ([Nov 2025](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)), Ralph's `while :; do cat PROMPT.md | agent; done` ([Huntley, Jul 2025](https://ghuntley.com/ralph/)), and 16 parallel Claudes building a C compiler for about $20k ([Anthropic, Feb 2026](https://www.anthropic.com/engineering/building-c-compiler)).
7. Handoff vs. compaction is a real disagreement. Amp removed compaction in favour of a goal-directed handoff into a new thread ([Oct 2025](https://ampcode.com/news/handoff)). Claude Code and Codex auto-compact. Pi ships both as primitives ([vendored `handoff.ts`, `pi-durable` `reset(handoffNote)`](#pi-in-this-repo)).
8. Attention steering by recitation (todo.md, TodoWrite, `update_plan`) is widespread but unmeasured. Manus treats it as deliberate attention manipulation ([Jul 2025](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). Mario Zechner says built-in todos "confuse models more than they help" and prefers a TODO.md or PLAN.md file ([Nov 2025](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)).
9. Parallel attempts with selection work when a verifier exists. Claude 3.7 Sonnet goes from 63.7% to 70.3% on SWE-bench Verified ([Anthropic](https://www.anthropic.com/news/claude-3-7-sonnet)), and Factory's pass@1 of 31.7% becomes 42.7% at pass@6 on Lite ([Factory](https://factory.ai/news/code-droid-technical-report)). The cost scales linearly with N.
10. For Pi: keep the single loop and add capabilities as composable policies. These are subagent-as-tool with summary return, a stop/`onYield` continuation hook driven by verifiers, file-backed plans and progress, handoff/reset, and best-of-N in worktrees. The vendored Pi already has the loop hooks (`prepareNextTurn`, `finishTurn → continue|end`, steering/follow-up queues) and durable child tasks to build on.

---

## Contents

1. [Taxonomy](#1-taxonomy)
2. [Single-loop patterns](#2-single-loop-patterns)
3. [Anthropic workflow patterns](#3-anthropic-building-effective-agents-workflow-patterns)
4. [Multi-agent systems and context isolation](#4-multi-agent-systems-and-context-isolation)
5. [Long-horizon flows](#5-long-horizon-flows)
6. [Harness architecture notes from the field](#6-harness-architecture-notes-from-the-field)
7. [Comparison table](#7-comparison-table)
8. [Disagreements and open questions](#8-disagreements-and-open-questions)
9. [Recommendations for this harness](#9-recommendations-for-the-pi-harness)
10. [Sources](#10-sources)

---

## 1. Taxonomy

The patterns below differ along two axes, and it helps to keep them apart:

- **Who decides the next step.** It can be code (a workflow) or the model (an agent). Anthropic draws the line exactly here: workflows are "predefined code paths", agents "dynamically direct their own processes" ([Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)). smolagents turns this into an agency ladder: processor → router → tool call → multi-step loop → multi-agent → code agent ([smolagents](https://huggingface.co/docs/smolagents/conceptual_guides/intro_agents)).
- **What context each step sees.** The options are a shared, growing transcript (single loop, swarm, OpenAI handoffs by default), an isolated context with a summary return (subagents, agents-as-tools), a fresh context rebuilt from files (Ralph, long-running harness), or a fork of the full context (Claude Code forks, Cognition's "smart friend").

The second axis is the context-engineering question this slice is about. Cognition's first principle ("share context, and share full agent traces") and Anthropic's subagent advice ("returns only a condensed, distilled summary") pull in opposite directions. Section 8 reconciles them.

---

## 2. Single-loop patterns

### 2.1 Plain tool loop ("while tool_calls")

```
user msg ──► [model] ──tool_calls?──yes──► run tools ──► append results ──┐
                 ▲                                                        │
                 └────────────────────────────────────────────────────────┘
                 no ──► final assistant message, end turn
```

- **Control flow.** Codex describes it exactly this way. The model returns either a final message or tool calls. The harness executes the calls, appends `function_call_output`, and re-queries until no tool call is emitted. The old prompt is an exact prefix of the new one, which is what makes prompt caching work ([Unrolling the Codex agent loop, 2026-01-23](https://openai.com/index/unrolling-the-codex-agent-loop/)).
- **Context per step.** The full history, every step. Codex says outright that the JSON sent grows quadratically, but with cache hits "sampling the model is linear rather than quadratic" (same source). Mid-session config changes are appended as new developer/user messages rather than edited in place, to keep the cache intact.
- **Who uses it.** Codex CLI, Claude Code ("gather context → take action → verify work → repeat", [Claude Agent SDK, 2025-09-29](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)), Pi, smolagents `MultiStepAgent` ([smolagents ReAct guide](https://huggingface.co/docs/smolagents/conceptual_guides/react)), Terminus-2. Huntley's view is that a coding agent is "roughly 300 lines of code running in a loop" ([ghuntley.com/loop, 2026-01-17](https://ghuntley.com/loop/)).
- **Pi.** `runLoop` in `vendor/pi/packages/agent/src/agent-loop.ts` has two loops. The inner one runs while there are tool calls or pending steering messages. The outer one runs while follow-up messages exist or `finishTurn` returns `{action:"continue"}`. It also has `prepareNextTurn` (swap model, context or thinking level between turns, e.g. after compaction) and `prepareRequest` hooks, and it fails every tool call in a `stopReason === "length"` message instead of running truncated arguments.
- **Costs.** One model call per step. Input tokens dominate: Manus reports a ~100:1 input:output ratio, and cached input at $0.30 vs uncached at $3/MTok on Sonnet ([Manus, 2025-07-18](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
- **Fit.** This is the base for everything else. Keep the prefix append-only and stable, which means no tool-list churn: "mask, don't remove" (Manus), and Codex reports cache misses from non-deterministic MCP tool order.

### 2.2 ReAct (reason + act)

- **Control flow.** Thought → Action → Observation, interleaved, until the model chooses Finish ([Yao et al., 2022-10-06](https://arxiv.org/abs/2210.03629)).
- **Measured.** +34 points absolute on ALFWorld and +10 on WebShop over imitation and RL baselines, with 1–2 in-context examples (same source).
- **Today.** Native tool calling plus reasoning models absorbed ReAct. The "Thought" is now a thinking block and the "Action" is a structured tool call. smolagents still calls its loop "a ReAct loop of Reflection → Action → Observation" ([smolagents](https://huggingface.co/docs/smolagents/conceptual_guides/intro_agents)).
- **Fit.** This is the plain tool loop. Nothing extra is needed beyond letting the model think between calls (2.9).

### 2.3 Plan-and-execute, ReWOO and LLMCompiler (plan first, observe later)

```
Plan-and-execute:   planner ─► step1 ─► step2 ─► … ─► replanner ─┬─► answer
                                                                 └─► new plan
ReWOO:              planner (#E1..#En with variables) ─► workers fill #E ─► solver
LLMCompiler:        planner streams DAG ─► task-fetching unit runs ready tasks in parallel ─► joiner (answer | replan)
```

- **Context per step.** The planner sees the task only. Executors see their step plus the variables they reference. ReWOO's solver sees the plans and the evidence. ReWOO's core claim is that tool observations never re-enter the planner's prompt ([ReWOO HTML](https://arxiv.org/html/2305.18323v1)).
- **Measured.** ReWOO on HotpotQA with gpt-3.5: 42.4% vs ReAct's 40.8% accuracy, 1,986 vs 9,795 tokens per question (~5× fewer), $3.97 vs $19.59 per 1k questions. When every tool returns "No evidence", ReAct falls to ~0% and burns more tokens by looping between tools, while ReWOO falls to ~13% (same source). LLMCompiler reports a 3.6× speedup ([LangChain planning agents, 2024-02-13](https://blog.langchain.com/planning-agents/)).
- **Downsides.** The plan is made blind to observations. That robustness cuts both ways: ReWOO cannot react to surprises without a replan step. Plan-and-execute still calls tools serially (LangChain).
- **Fit for coding.** Weak as a strict pipeline, because code exploration is observation-driven. Strong as a phase: plan in a read-only phase, then execute in the normal loop.

### 2.4 Plan mode vs act mode

```
[PLAN: read-only tools] ──user approves plan──► [ACT: full tools]  ◄──back to plan on surprise
```

- **Cline.** In Plan mode it can read and search but cannot modify files or run commands. Act mode gets full tools. You can configure a different model per mode (e.g. Opus to plan, Sonnet to act). Conversation history carries across the switch. Cline recommends Act-only for trivial tasks, Plan→Act for medium ones, and `/deep-planning` plus a markdown plan file for large ones ([Cline docs](https://docs.cline.bot/features/plan-and-act)).
- **Claude Code.** `--permission-mode plan` or Shift+Tab. Claude reads and proposes, with no edits until you approve. Best practice is explore → plan → implement → commit, skipping the plan "when you could describe the diff in one sentence" ([common workflows](https://code.claude.com/docs/en/common-workflows), [best practices](https://www.anthropic.com/engineering/claude-code-best-practices)). There is also a built-in read-only **Plan** subagent for research during plan mode ([subagents docs](https://code.claude.com/docs/en/sub-agents)).
- **Devin 2.0** answers in seconds with relevant files and a preliminary plan that you edit before it runs autonomously ([Devin 2.0](https://cognition.com/blog/devin-2)). Devin's 2025 review says it "handles clear upfront scoping well, but not mid-task requirement changes", which is an argument for front-loading the plan ([Cognition, 2025-11-14](https://cognition.com/blog/devin-annual-performance-review-2025)).
- **Dissent (Pi).** Zechner ships no plan mode. Telling the model to think with you without editing is enough, and a `PLAN.md` is visible, editable, versionable and shareable across sessions ([Zechner, 2025-11-30](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)). The vendored Pi has a *plan-mode example extension*: write tools disabled, a bash allowlist, extraction of numbered `Plan:` steps, `[DONE:n]` markers and a progress widget (`vendor/pi/packages/coding-agent/examples/extensions/plan-mode/README.md`).
- **Cost.** One extra exploration phase. It is usually cheaper overall because it prevents wrong-direction edits.
- **Fit.** High. Implement it as a *tool-permission policy* plus a plan *file*, not a separate agent.

### 2.5 Tree search: LATS and Tree-of-Thoughts style

- **Control flow.** MCTS over agent trajectories. The LM proposes actions and acts as a value function, and self-reflections are added on failure ([LATS, 2023-10-06](https://arxiv.org/abs/2310.04406)).
- **Measured.** 92.7% pass@1 on HumanEval with GPT-4, and 75.9 on WebShop with GPT-3.5 (same source).
- **Context.** Each node sees its path from the root plus any reflections. Siblings are isolated.
- **Costs.** Many rollouts per answer, and it needs an environment that can be *reset* to a node state. That is cheap for HumanEval and expensive for a real repository.
- **Fit.** Low as an inner loop. The practical coding equivalent is best-of-N at the trajectory level with a verifier (4.10), plus git-checkpoint "rewind and retry" (5.4).

### 2.6 Reflexion, Self-Refine and self-critique

- **Reflexion.** After a failed trial, the agent writes a verbal reflection into episodic memory and retries. It reports 91% pass@1 on HumanEval vs GPT-4's 80% ([Shinn et al., 2023-03-20](https://arxiv.org/abs/2303.11366)).
- **Self-Refine.** Generate → self-feedback → refine with the same model. It reports ~20% absolute average improvement across 7 tasks ([Madaan et al., 2023-03-30](https://arxiv.org/abs/2303.17651)).
- **Counter-evidence.** "Large Language Models Cannot Self-Correct Reasoning Yet": without *external* feedback, LLMs struggle to self-correct reasoning, and performance sometimes degrades ([Huang et al., ICLR 2024](https://arxiv.org/abs/2310.01798)). Reflexion's coding gains rely on test execution, which *is* external feedback.
- **Fit.** Reflect only on a real signal: a failing test, a lint error, or a reviewer finding. Manus's "keep the wrong stuff in" is the cheap version. Leaving the failed action and stack trace in context lets the model update ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).

### 2.7 Verify loops (tests, linters, type checks, browsers as feedback)

```
edit ─► run checks ─► fail? ──yes──► feed concise error back ─► edit …
                        └─no──► done (or next feature)
```

- **Evidence.**
  - SWE-agent ablations on SWE-bench Lite: lint-gated edit 18.0% vs no linting 15.0% vs no edit command 10.3%; 100-line viewer 18.0% vs full file 12.7%; collapsing observations older than the last 5 gives 18.0% vs 15.0% with full history ([SWE-agent v3](https://arxiv.org/html/2405.15793v3)).
  - Anthropic's think-tool post and Claude Agent SDK list verification as rules (lint), visual feedback (screenshots via Playwright) and LLM-as-judge, the last being "generally not very robust" ([Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)).
  - The long-running harness found Claude marked features done after unit tests or curl. It improved once told to test end-to-end with Puppeteer "as a human user would" ([Anthropic, 2025-11-26](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)).
  - Ralph calls this "backpressure": tests, type systems and static analysers that reject bad output ([ghuntley.com/ralph](https://ghuntley.com/ralph/)).
  - OpenAI's harness-engineering team writes lint error messages *with remediation instructions aimed at the agent*, and promotes rules from docs into code when docs fail ([OpenAI, 2026-02-11](https://openai.com/index/harness-engineering/)).
- **Context hygiene.** Carlini says verifier output must not flood context: print a few lines, log the rest to a file, put `ERROR` plus the reason on one line so it is greppable, and pre-compute summary statistics. Add a `--fast` deterministic 1–10% test sample because the model is "time-blind" ([C compiler](https://www.anthropic.com/engineering/building-c-compiler)).
- **Fit.** Highest. This is the single most valuable addition to a coding harness. It can be driven by the agent (it runs tests) or by the harness (a post-edit hook or stop hook runs checks; see 5.5).

### 2.8 The "think" tool

- **What it is.** A no-op tool with a `thought: string` parameter, used as a scratchpad *between* tool calls ([Anthropic, 2025-03-20](https://www.anthropic.com/engineering/claude-think-tool)).
- **Measured.** τ-bench airline pass^1 rose from 0.370 to 0.570 with an optimized prompt; the text and table disagree slightly. Retail went from 0.783 to 0.812. SWE-bench gained +1.6% (p<.001) (same source).
- **Superseded.** A callout dated 2025-12-15 on the same page says to use extended thinking instead in most cases.
- **Fit.** Not needed with models that interleave thinking. It can still help non-reasoning models.

### 2.9 Interleaved / adaptive thinking

- **What it is.** The model thinks between tool calls within one assistant turn and reasons about each result before the next call. On Claude 4/4.5 it is enabled with beta header `interleaved-thinking-2025-05-14`. On 4.6+ it is automatic with `thinking: {type:"adaptive"}` and an `effort` setting ([Anthropic docs](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)).
- **Context.** Opus 4.5+ and 4.6+ keep prior turns' thinking blocks in context, billed as input. Older models strip them (same source). Anthropic's research subagents rely on interleaved thinking to evaluate tool results ([multi-agent research](https://www.anthropic.com/engineering/multi-agent-research-system)).
- **Fit.** Required. The harness must round-trip thinking blocks (or encrypted reasoning items on OpenAI) unchanged, or the cache and reasoning continuity break. Codex keeps the Responses API stateless and resends `encrypted_content` ([Codex loop](https://openai.com/index/unrolling-the-codex-agent-loop/)). Pi converts Anthropic thinking to `<thinking>` text when switching providers, best effort ([Zechner](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)).

### 2.10 Todo lists and recitation (attention steering)

- **Manus.** A typical task is ~50 tool calls. The agent writes and rewrites `todo.md`, "reciting its objectives into the end of the context" to avoid lost-in-the-middle and goal drift. Manus calls this "a deliberate mechanism to manipulate attention" ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
- **Claude Code.** TodoWrite has pending → in_progress → completed states ([SDK todo tracking](https://docs.anthropic.com/en/docs/claude-code/sdk/todo-tracking)). Extracted prompts push frequent use ("When in doubt, use this tool"), and tool results remind the model to keep using it ([extracted prompt gist](https://gist.github.com/wong2/e0f34aac66caf890a332f7b6f9e2ba8f), [Klaas analysis](https://jannesklaas.github.io/ai/2025/07/20/claude-code-agent-design.html)). These are third-party extractions, so treat the exact wording as unverified.
- **Codex** exposes an `update_plan(plan, explanation)` tool ([Codex loop](https://openai.com/index/unrolling-the-codex-agent-loop/)).
- **Pi (dissent).** "To-do lists generally confuse models more than they help." Use a checkbox `TODO.md` instead ([Zechner](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)). The vendored Pi has a `todo.ts` example extension that keeps state in tool-result details, so the todo state stays correct when you branch the session tree (`vendor/pi/packages/coding-agent/examples/extensions/todo.ts`).
- **Measured.** No published ablation found. The evidence is practitioner consensus.
- **Costs.** A few hundred tokens per update. Every rewrite appends, so the cache prefix is preserved.
- **Fit.** Medium-high for long tasks (>20 calls), and unnecessary for short ones. Prefer an append-only tool whose result echoes the current list, so the list is always near the tail. Store it in session entries so it survives branching.

---

## 3. Anthropic "Building effective agents" workflow patterns

Source for all of 3.1–3.6: [Building effective agents, 2024-12-19](https://www.anthropic.com/engineering/building-effective-agents). The guiding rule is to find "the simplest solution possible, and only increasing complexity when needed". The ACI (agent-computer interface) deserves as much effort as an HCI. In their SWE-bench agent, requiring absolute file paths eliminated a whole error class.

| # | Pattern | Control flow | Context each step sees | Use when | Coding-harness fit |
|---|---|---|---|---|---|
| 3.1 | **Prompt chaining** | `A → gate → B → C` | Previous step's output only | Fixed decomposition and accuracy over latency | Commit message → PR body; spec → plan → tasks. Use as harness commands, not inside the loop |
| 3.2 | **Routing** | `classify → {handler_i}` | Input only, then a specialised prompt | Distinct categories, or cheap vs expensive model | Model routing (small model for trivial edits), Cline per-mode models |
| 3.3a | **Parallelization: sectioning** | `fan-out(independent parts) → join` | Each part sees only its slice | Independent subtasks and speed | Parallel read-only subagents (search, review aspects) |
| 3.3b | **Parallelization: voting** | `N × same task → vote/aggregate` | Identical input, diverse samples | Confidence, e.g. multiple vulnerability reviewers | Best-of-N patches and multi-reviewer review |
| 3.4 | **Orchestrator-workers** | Orchestrator plans dynamically → workers → synthesize | Workers see the orchestrator's brief, not its history | Subtasks not knowable in advance (e.g. "coding products that change multiple files") | Subagents/Task tool. Note Cognition's caveat about writers |
| 3.5 | **Evaluator-optimizer** | `generate ↔ evaluate` until pass | Generator sees feedback; evaluator sees output plus criteria | Clear criteria where iteration measurably helps | Coder ↔ reviewer loop (Devin Review, Codex agent review), test-driven loops |
| 3.6 | **Autonomous agent** | Tool loop with environment feedback and stop conditions | Growing transcript | Open-ended, unpredictable step count, trusted sandbox | The core loop (2.1). Needs max-iteration guards |

Equivalents in other frameworks:

- OpenAI Agents SDK patterns: chaining, parallel via `asyncio.gather`, a `while` evaluator loop, and structured-output routing ([OpenAI orchestration](https://openai.github.io/openai-agents-python/multi_agent/)).
- Google ADK patterns: coordinator/dispatcher, sequential pipeline, parallel fan-out/gather, hierarchical decomposition, generate-and-review, iterative refinement (`LoopAgent` stops on `escalate=True` or `max_iterations`), and human-in-the-loop. ADK now marks `SequentialAgent`, `ParallelAgent` and `LoopAgent` as deprecated in favour of graph workflows ([ADK patterns](https://adk.dev/workflows/patterns/)).
- **Agentless** is the extreme "workflow, not agent" case: a fixed localize → repair → validate pipeline that scored 32% on SWE-bench Lite for $0.70 per issue, the best open-source result at the time ([Agentless, 2024-07-01](https://arxiv.org/abs/2407.01489)). This is evidence that fixed flows compete when the task shape is known.

---

## 4. Multi-agent systems and context isolation

### 4.1 Subagents with clean context and a condensed return (Claude Code Task/Agent tool)

```
main ctx ──Task(prompt)──► [subagent: own window, own system prompt, own tools]
   ▲                               │  (tens of k tokens of exploration)
   └──────── summary (~1–2k) ◄─────┘
```

- **What the child sees.** In Claude Code: its own system prompt (not Claude Code's), the delegation prompt, CLAUDE.md (except Explore/Plan), a git status snapshot, and preloaded skills. It does *not* see the parent conversation, files already read, invoked skills or auto memory. Only the summary returns; tool calls stay in the child. **Forks** are the exception and inherit the full conversation. Built-ins are **Explore** (read-only, thoroughness level, one-shot), **Plan** (read-only) and **general-purpose**. Subagents cannot spawn subagents at the depth limit, cannot ask the user, and cannot enter plan mode ([subagents docs](https://code.claude.com/docs/en/sub-agents)).
- **Return size.** "Often 1,000–2,000 tokens" after "tens of thousands" spent exploring ([Effective context engineering, 2025-09-29](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- **Why.** Parallelism plus context management: "only send relevant information back to the orchestrator" ([Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)).
- **Cognition on Claude Code (Jun 2025).** Subtasks are "purposefully simple". They answer well-defined questions rather than write code, and they keep investigative work out of the main history ([Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents)).
- **Codex (2026).** Subagents are on by default: built-in `default`, `worker` and `explorer` agents, TOML custom agents, `agents.max_concurrent_threads_per_session`, and they inherit the parent's sandbox. The docs say: "subagent workflows consume more tokens than comparable single-agent runs". They are a good fit for read-heavy parallel work, and the docs advise "more caution" for parallel write-heavy work. They return summaries instead of raw logs to fight "context pollution" and "context rot" ([Codex subagents](https://developers.openai.com/codex/subagents), [config reference](https://developers.openai.com/codex/config-reference)).
- **Amp.** Task subagents start with only what the main agent gives them, cannot talk to each other, return a final summary, can receive follow-up tasks while keeping their context, and auto-compact. Oracle (advisor, never edits), Librarian (external repos) and Finder (workspace search) are specialised subagents ([Amp models & subagents](https://ampcode.com/docs/models-and-subagents)).
- **Pi (dissent).** Zechner objects that subagents are a black box, that context transfer is poor because the orchestrator chooses what the child sees, and that they are hard to debug. Mid-session context gathering via subagent "is a sign you didn't plan ahead". Parallel implementation subagents are "an anti-pattern". The exception is code review via `pi --print` ([Zechner](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)). Pi's vendored subagent example spawns separate `pi` processes with streaming output, parallel and chained modes (scout → planner → worker, worker → reviewer → worker), and usage display, which addresses the visibility complaint (`vendor/pi/packages/coding-agent/examples/extensions/subagent/README.md`).
- **Cost.** The child pays its own exploration tokens, and the parent saves them. It is a net token increase but keeps the parent's context, cache and quality intact.
- **Fit.** High for scout, search, review and "answer this question". Medium-low for writing code.

### 4.2 Anthropic multi-agent research system

```
LeadResearcher (Opus 4) ─plan→Memory─► spawn 3–5 subagents (Sonnet 4) in parallel
     ▲                                    each: 3+ parallel tools, interleaved thinking
     └── condensed findings ◄─────────────┘
     → CitationAgent → final report
```

All points below are from [the post, 2025-06-13](https://www.anthropic.com/engineering/multi-agent-research-system).

- **Results.** Beat single-agent Opus 4 by **90.2%** on an internal research eval.
- **Tokens.** Agents use ~4× chat tokens and multi-agent ~15×. On BrowseComp, three factors explain 95% of variance, and **token usage alone explains 80%**. Upgrading the model beat doubling the token budget. Parallelism cut research time by "up to 90%".
- **Context tricks.**
  - The plan is saved to Memory because context over 200k gets truncated.
  - Completed phases are summarised into external storage.
  - Fresh subagents are spawned with clean contexts.
  - Subagents write artefacts to the filesystem and pass *references* back ("lightweight references"), which avoids the "game of telephone".
- **Delegation must specify** the objective, output format, tools and sources, and boundaries. Effort is scaled by complexity: 1 agent and 3–10 calls for simple tasks, more than 10 subagents for complex ones.
- **Failure modes.** 50 subagents spawned for simple queries, duplicated work from vague briefs, and subagents distracting each other.
- **Explicit caveat.** "Most coding tasks involve fewer truly parallelizable tasks than research", and domains where agents must share context are poor fits. Subagents were synchronous at the time, and the post lists that as a bottleneck.

### 4.3 Cognition: "Don't Build Multi-Agents" (Jun 2025) and "What's Actually Working" (Apr 2026)

- **2025-06-12 ([post](https://cognition.ai/blog/dont-build-multi-agents)).**
  - Principle 1: *share context, and share full agent traces, not just individual messages*.
  - Principle 2: *actions carry implicit decisions, and conflicting decisions carry bad results*.
  - In the Flappy Bird example, parallel subagents produce a Mario-style background and a mismatched bird.
  - The recommendation is a single-threaded linear agent, plus a dedicated (even fine-tuned) **compression model** for long histories.
  - It was published about a day before Anthropic's research post, and the two are often read as a debate.
- **2026-04-22 ([post](https://cognition.com/blog/multi-agents-working)).** Swarms of parallel writers still fail. What works is "multiple agents contribute intelligence while writes stay single-threaded":
  1. **Coder ↔ clean-context reviewer.** Devin Review finds ~2 bugs per PR, ~58% severe. The reviewer works best with *no* shared prior context because it re-derives intent from code and avoids the coder's context rot. It still needs a bridge back to user intent so the coder can triage findings without looping or scope creep.
  2. **"Smart friend".** A primary model calls a stronger model as a tool, with a *fork of full context* ("80/20"). This failed when the primary was too weak (SWE-1.5 + Sonnet 4.5) and gave "real gains" cross-frontier (Claude + GPT).
  3. **Manager Devin spawning child Devins** via an internal MCP, described as "map-reduce-and-manage". Problems: managers over-prescribe, children assume shared state, children don't report back by default.
- **Takeaway.** Isolation helps *evaluation* (fresh eyes). Sharing helps *generation* (consistent implicit decisions).

### 4.4 OpenAI Agents SDK: handoffs vs agents-as-tools

```
Handoff:          triage ──transfer_to_refund_agent()──► refund agent owns the rest of the turn
Agent-as-tool:    manager ──refund_agent.as_tool(input)──► result ──► manager answers
```

- **Handoffs.** A handoff is a tool named `transfer_to_<agent>`. By default the new agent "takes over the conversation" and **sees the full previous history**. `input_filter` (e.g. `remove_all_tools`) prunes what it receives. `nest_handoff_history` (beta, off by default) collapses prior history into a `<CONVERSATION HISTORY>` summary message. `on_handoff` callbacks and a `RECOMMENDED_PROMPT_PREFIX` round this out ([handoffs](https://openai.github.io/openai-agents-python/handoffs/)).
- **Agents-as-tools.** The manager keeps ownership and can combine several specialists. Handoffs suit routing where the specialist answers directly ([orchestration](https://openai.github.io/openai-agents-python/multi_agent/)).
- **Fit.** Handoffs are a customer-support pattern. For coding, agents-as-tools (= subagents) is the relevant one.

### 4.5 LangGraph supervisor vs swarm (and the benchmark)

- **Supervisor.** A central agent delegates through handoff tools. `output_mode` is `full_history` or `last_message`. `create_forward_message_tool` passes a worker's answer through without paraphrasing. The README now recommends building the supervisor "directly via tools", because that "gives you more control over context engineering". The repo is archived ([langgraph-supervisor](https://github.com/langchain-ai/langgraph-supervisor-py)).
- **Benchmark ([LangChain, 2025-06-10](https://blog.langchain.com/benchmarking-multi-agent-architectures/)).** τ-bench retail plus up to 6 distractor domains (19 tools each):
  - The single agent degrades sharply with ≥2 distractor domains, and its tokens grow.
  - Swarm and supervisor stay flat.
  - Swarm slightly beats supervisor because the supervisor "translates" (telephone effect).
  - Removing handoff messages from sub-agent state plus `forward_message` improved the supervisor by "nearly 50%".
- **Lesson.** Multi-agent wins come from *scoping tools and context per agent*. Paraphrasing relays lose information, so return raw output or references.

### 4.6 Google ADK

- **Primitives.** LLM-driven delegation via `transfer_to_agent(agent_name=…)` chosen from sub-agent `description`s. Explicit `AgentTool` wrapping. Shared session state via `output_key` and `{key}` placeholders in later agents' instructions. Parallel branches write distinct state keys. `LoopAgent` + `escalate` handles iterative refinement. Human-in-the-loop uses tool confirmation, `RequestInput` events, or a policy engine that returns CONFIRM ([ADK patterns](https://adk.dev/workflows/patterns/), [ADK workflows](https://adk.dev/workflows/)).
- **Context model.** A shared state blackboard rather than shared transcripts. This is a middle ground: explicit, named and small.

### 4.7 CrewAI, AutoGen, Magentic-One and MetaGPT

- **CrewAI.** `sequential` (each task's output becomes the next task's context, configurable per task via `context`) or `hierarchical` (a manager LLM or agent plans, delegates and validates) ([CrewAI processes](https://docs.crewai.com/en/concepts/processes)).
- **AutoGen AgentChat.**
  - Team types: `RoundRobinGroupChat` (all agents share one context, and every message is broadcast), `SelectorGroupChat` (a model picks the next speaker), `Swarm` (`HandoffMessage`) and `MagenticOneGroupChat`.
  - Termination conditions include `TextMentionTermination("APPROVE")` and `ExternalTermination`, composable with `|` ([AutoGen teams](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html)).
  - AutoGen reportedly entered maintenance mode on 2025-10-02. The successor is Microsoft Agent Framework, GA around April 2026 ([secondary: Atlan](https://atlan.com/know/ai-agent/what-is-autogen/)). I did not fetch a primary source for this.
- **Magentic-One.**
  - The Orchestrator runs an outer loop with a **Task Ledger** (facts, guesses, plan) and an inner loop with a **Progress Ledger** (task complete? progress made? next agent and instruction).
  - It replans when the stall count exceeds 2.
  - Workers are WebSurfer, FileSurfer, Coder and ComputerTerminal.
  - It is "statistically competitive" with SOTA on GAIA, AssistantBench and WebArena ([MSR article](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/), [paper 2024-11-07](https://arxiv.org/abs/2411.04468)).
  - The ledger is a strong pattern: explicit, structured progress state that the orchestrator re-reads every step.
- **MetaGPT.** SOPs are encoded as prompt sequences in an assembly line of roles (PM, architect, engineer…) to curb cascading hallucination ([MetaGPT, 2023-08-01](https://arxiv.org/abs/2308.00352)). It is historically important. Role-play pipelines have since lost ground to single strong agents.

### 4.8 Agent teams (peer agents with a mailbox and task list)

- **Claude Code agent teams** (experimental).
  - Structure: a lead plus teammates, each with its own context. Teammates load CLAUDE.md, MCP and skills but **not** the lead's history.
  - Coordination: direct messaging through JSON mailboxes, and a shared task list with dependencies and file-locked claiming.
  - Hooks: `TeammateIdle` and `TaskCompleted` hooks can force continuation.
  - Docs: "significantly more tokens". Start with 3–5 teammates. Good for research, review, competing-hypothesis debugging and separate modules. Bad for same-file or sequential work ([agent teams](https://code.claude.com/docs/en/agent-teams)).
- **Carlini's C compiler (2026-02-05).** 16 Opus 4.6 agents, each in its own container in a `while true; claude -p "$(cat AGENT_PROMPT.md)"` loop.
  - Coordination: a shared bare git upstream with `current_tasks/*.txt` lock files. There is **no orchestrator** and no inter-agent messaging.
  - Results: ~2,000 sessions, ~2B input and 140M output tokens, just under $20k, and a ~100k-line Rust compiler that builds Linux 6.9 on 3 architectures.
  - Key lessons: the test harness is everything; GCC as an oracle so agents can fix *different* bugs in parallel (otherwise all 16 hit the same kernel bug); specialised roles (dedupe, perf, docs, Rust-style critic); keep READMEs and progress files current for fresh agents ([C compiler](https://www.anthropic.com/engineering/building-c-compiler)).

### 4.9 Worktree-parallel and async background agents

- **Claude Code.**
  - `claude --worktree <name>` runs isolated parallel checkouts, and the Desktop app gives each session its own worktree.
  - Background subagents report on completion.
  - Headless `claude -p` supports fan-out over files ([common workflows](https://code.claude.com/docs/en/common-workflows), [best practices](https://www.anthropic.com/engineering/claude-code-best-practices)).
- **Codex cloud.** Each task gets its own workspace and "can keep working while your computer is asleep" ([Codex cloud](https://developers.openai.com/codex/cloud)). The App Server runs the same harness in a cloud container, and the browser can reconnect to a persistent thread ([Unlocking the Codex harness, 2026-02-04](https://openai.com/index/unlocking-the-codex-harness/)).
- **Devin.** "Infinitely parallelizable". A fleet of Devins runs per-repo migrations or test writing from a shared playbook ([Devin review](https://cognition.com/blog/devin-annual-performance-review-2025)).
- **Amp** "Orbs": per-thread machines, so you can close the laptop and the agent continues ([Amp manual](https://ampcode.com/manual)).
- **Fit.** High. Worktree isolation removes the write-conflict problem by giving each writer its own branch. Merge or select afterwards.

### 4.10 Best-of-N / parallel attempts with selection

```
task ─► N independent trajectories (worktrees/containers) ─► filter (tests) ─► rank (model/human) ─► pick 1
```

- **Claude 3.7 Sonnet "high compute".** Sample parallel attempts, discard patches that break visible regression tests, and rank the rest with a scoring model. This gives 70.3% vs 63.7% on the SWE-bench Verified subset ([Anthropic](https://www.anthropic.com/news/claude-3-7-sonnet)).
- **Factory Code Droid.** Multiple trajectories, multi-model sampling, and tests for validation. SWE-bench Lite 31.67% pass@1 → 37.67% pass@2 → 42.67% pass@6 ([Factory, 2024-06-18](https://factory.ai/news/code-droid-technical-report)).
- **Codex best-of-N.** Generates multiple responses for one task so you can pick the best ([OpenAI Devs on X](https://x.com/OpenAIDevs/status/1933617093938692164)). `codex cloud exec --attempts 1..4` is documented only in third-party guides ([secondary](https://codex.danielvaughan.com/2026/04/01/codex-cloud-exec-best-of-n-attempts/)).
- **Cost.** N× tokens and wall-clock ≈ 1×. The selector is cheap if it is tests and expensive if it is a human.
- **Fit.** High for well-specified tasks with tests. Isolate with worktrees, apply the winner.

---

## 5. Long-horizon flows

### 5.1 Anthropic "Effective harnesses for long-running agents" (2025-11-26)

```
Session 0 (initializer prompt): write feature_list.json (200+ features, all "passes": false),
                                init.sh, claude-progress.txt, initial git commit
Session k (coding prompt):      read progress + git log ─► run init.sh + smoke e2e test ─►
                                pick ONE failing feature ─► implement ─► browser-verify ─►
                                flip "passes" ─► commit ─► update progress file ─► exit
```

All points from [the post](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents):

- The initializer and coder share the same system prompt, tools and harness. **Only the first user prompt differs.**
- **Failure modes addressed.**
  - "One-shotting": running out of context mid-feature and leaving undocumented half-work. Compaction does not reliably fix this.
  - "Declaring victory early".
  - Marking features done without e2e testing.
  - Wasting time working out how to run the app.
- **Feature list in JSON, not Markdown**, because models are less likely to tamper with it. Removing or editing tests is "unacceptable".
- **No quantitative results.** Open question: would specialised QA or cleanup agents beat a single general agent?

### 5.2 The Ralph Wiggum loop (Geoffrey Huntley)

```
while :; do cat PROMPT.md | claude-code ; done
   PROMPT.md: study specs/*, fix_plan.md, AGENT.md → pick ONE most important item →
              search before assuming unimplemented → implement → run tests for that unit →
              update fix_plan.md / AGENT.md → commit
```

- **Principles** ([ghuntley.com/ralph, 2025-07-14](https://ghuntley.com/ralph/)):
  - One item per loop.
  - A fresh context every loop, with ~170k usable tokens.
  - The primary context acts as a scheduler. Subagents do expensive search and summarisation; up to 500 parallel subagents are allowed for search but only 1 for build/test, to keep backpressure sane.
  - `fix_plan.md` is regenerated often.
  - "No placeholders".
- **Caveats (the author's own).** Greenfield only, and roughly 90% done. Nondeterminism is "the Achilles' heel". Broken builds may need `git reset --hard`. It is wasteful because specs are re-read every loop. The evidence is anecdotal: CURSED is a compiler built by Ralph, and there was a YC hackathon headline.
- **Follow-up ([ghuntley.com/loop, 2026-01-17](https://ghuntley.com/loop/)).** "Everything is a ralph loop". He calls Ralph a monolith and says multi-agent "microservices" made of non-deterministic agents would be "a red hot mess".
- **Adoption.** OpenAI's harness-engineering team calls its agent-to-agent review iteration "effectively a Ralph Wiggum Loop" ([OpenAI](https://openai.com/index/harness-engineering/)). Carlini's C compiler is a parallel Ralph.

### 5.3 Handoff documents vs compaction

- **Amp Handoff (2025-10-23).**
  - "We have removed compaction from Amp."
  - Compaction is lossy and "encourages long, meandering threads… stacking summary on top of summary".
  - Handoff takes a *goal*, extracts the relevant context and files into a new-thread draft prompt, and lets the user edit it before sending ([Amp](https://ampcode.com/news/handoff)).
- **Pi in this repo.**
  - The vendored `examples/extensions/handoff.ts` implements the same idea ("Instead of compacting (which is lossy), handoff extracts what matters for your next task").
  - `pi-durable` has `reset(handoffNote)`, and a tool can return `control: {handoff: "..."}` to restart context mid-run while the run continues. It also has compaction with `reserveTokens`, `keepRecentTokens` and *background* pre-compaction (`backgroundTokens`) (`vendor/pi/packages/durable/README.md`).
- **Others.**
  - Claude Code: compaction keeps decisions and bugs, plus the 5 most recently accessed files; "tool result clearing" is the lightest form ([context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
  - Codex: `/responses/compact` returns an opaque encrypted compaction item ([Codex loop](https://openai.com/index/unrolling-the-codex-agent-loop/)).
  - OpenHands: the condenser gives up to 2× per-turn cost reduction with no loss on SWE-bench Verified ([OpenHands blog](https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents)).
  - Anthropic research: spawn fresh subagents and hand off via memory near limits ([multi-agent research](https://www.anthropic.com/engineering/multi-agent-research-system)).
  - Zechner originally shipped no compaction and ran "hundreds of exchanges" in one session ([Zechner](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)).
- **Spec-first variant.** Interview the user, write SPEC.md, then start a fresh session to implement it ([Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices)). Pi's "gather context in its own session and save an artifact" is the same idea.

### 5.4 Session resumption, checkpoints, rewind and branching

- **Claude Code.**
  - `--continue`, `--resume`, `/resume`, `--fork-session` and `/branch`.
  - Checkpoints are taken automatically before each prompt. Only file-tool edits are tracked: Bash changes are not, and most subagent edits are not.
  - Rewind options: code, conversation, both, or *summarize from here / up to here*, which is a targeted compaction.
  - 30-day retention ([checkpointing](https://code.claude.com/docs/en/checkpointing)).
- **Codex App Server.** Thread / turn / item primitives. Threads are persisted, resumable, forkable and archivable. Approvals are server→client JSON-RPC requests that pause the turn ([Codex harness](https://openai.com/index/unlocking-the-codex-harness/)).
- **Pi.** Sessions are trees: `/tree` navigates to any earlier point and continues from there ([pi.dev](https://pi.dev/)). The vendored examples include `git-checkpoint.ts` and `bookmark.ts`. `pi-durable` commits everything to storage before display, so a crashed process resumes mid-turn. A model request that killed the process counts as a failed attempt (`vendor/pi/packages/durable/README.md`).
- **Anthropic research.** Durable execution and resuming from checkpoints is required because restarts are expensive and frustrating ([multi-agent research](https://www.anthropic.com/engineering/multi-agent-research-system)).

### 5.5 Human-in-the-loop, approval gates and stop hooks

- **Approval gates.**
  - Claude Code `PreToolUse` hooks return `allow | deny | ask | defer`, with precedence deny > defer > ask > allow ([hooks](https://code.claude.com/docs/en/hooks)).
  - The Codex App Server sends `item/commandExecution/requestApproval` and pauses the turn ([Codex harness](https://openai.com/index/unlocking-the-codex-harness/)).
  - ADK has tool confirmation and a policy engine ([ADK](https://adk.dev/workflows/patterns/)).
  - The OpenHands CLI offers per-action confirmation, `--always-approve` and `--llm-approve` ([OpenHands CLI](https://docs.all-hands.dev/usage/how-to/cli-mode)).
  - Pi defaults to YOLO and calls most permission systems "security theater". It sandboxes with containers instead ([Zechner](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)), and the vendored examples include `permission-gate.ts`, `confirm-destructive.ts` and `protected-paths.ts`.
- **Stop hooks that force continuation.**
  - Claude Code `Stop` / `SubagentStop` return `{decision:"block", reason}` or exit 2, and the reason becomes the next instruction. `stop_hook_active` guards against loops, and a built-in cap overrides the block after 8 consecutive blocks without a tool call.
  - **Prompt-based** stop hooks let an LLM judge `{ok, reason, impossible}`.
  - Agent teams add `TeammateIdle` and `TaskCompleted` exit-2 hooks ([hooks](https://code.claude.com/docs/en/hooks), [agent teams](https://code.claude.com/docs/en/agent-teams)).
  - **Pi equivalents:** `finishTurn` returns `{action:"continue"}` in `agent-loop.ts`, and `pi-durable` has `hook(GenerationTask, { onYield: answer => needsMoreWork(answer) ? {continue:"Keep going."} : undefined })`.
  - This is the harness-level way to build a verify loop: on stop, run tests, and if they fail, block with the failure summary.
- **Steering.** Pi's loop polls steering messages (injected mid-run, before the next model call) and follow-up messages (delivered when the agent would stop) separately (`agent-loop.ts`). Claude Code's Esc interrupts while keeping context. Devin's review shows mid-task requirement changes degrade performance, so steering is a recovery tool, not a substitute for scoping.

### 5.6 Sleep, scheduled and recurring agents

- Claude Code offers cloud Routines (cron, API or GitHub-event triggers), desktop scheduled tasks, GitHub Actions, and `/loop` for in-session polling. Scheduled prompts must state what success looks like because the agent cannot ask questions ([common workflows](https://code.claude.com/docs/en/common-workflows)).
- OpenAI's harness team runs recurring background "garbage collection" and "doc-gardening" Codex tasks. They scan for deviations from golden principles and open small auto-merged refactor PRs ([harness engineering](https://openai.com/index/harness-engineering/)).
- `pi-durable` tasks have `sleeping` (until, signals) and `waiting` (on child tasks, with `allSettled | failFast | any`) states, plus background tasks that survive the parent's abort (`vendor/pi/packages/durable/README.md`).

---

## 6. Harness architecture notes from the field

- **Claude Agent SDK ("give Claude a computer", 2025-09-29).**
  - The agent gets the programmer's tools: bash, file editing, search.
  - Prefer agentic search (grep/tail over a folder structure) to semantic search to start with.
  - Subagents serve parallelism and context isolation. Compaction keeps long runs going.
  - Verification uses rules, visual checks and LLM-as-judge ([post](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)).
  - The hybrid context model is CLAUDE.md up front plus glob/grep just-in-time ([context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- **OpenAI Codex.**
  - The loop and prompt assembly order: permissions developer msg → developer_instructions → AGENTS.md chain (32 KiB cap) → environment_context → user message.
  - Stateless Responses API (no `previous_response_id`) for ZDR, and append-only for caching ([Unrolling the loop, 2026-01-23](https://openai.com/index/unrolling-the-codex-agent-loop/)).
  - The App Server is a JSON-RPC-over-stdio "harness as a service" with thread / turn / item primitives, shared by the CLI, VS Code, the desktop app, web and Xcode ([Unlocking the harness, 2026-02-04](https://openai.com/index/unlocking-the-codex-harness/)).
  - Harness engineering: "Humans steer. Agents execute." AGENTS.md is a ~100-line map to a `docs/` tree, and execution plans are checked in. Invariants are enforced by linters with agent-targeted fix messages. Agent-to-agent review happens in a Ralph loop. ~1M LOC and ~1,500 PRs in 5 months with 3–7 engineers. Single runs last over 6 hours ([2026-02-11](https://openai.com/index/harness-engineering/)).
- **Amp.** Handoff instead of compaction. Task subagents plus Oracle, Librarian and Finder. Multi-model "system models" handle side jobs such as images, titles and compaction ([handoff](https://ampcode.com/news/handoff), [subagents](https://ampcode.com/docs/models-and-subagents)).
- **Factory Droids.** HyperCode codebase graph plus ByteRank retrieval, planning and decomposition, multi-model trajectories selected by tests ([2024-06-18](https://factory.ai/news/code-droid-technical-report)).
- **Devin.**
  - A single-threaded agent with a compression model (2025).
  - Interactive planning plus parallel Devins (2.0).
  - A merged-PR rate of 34%→67% year over year, self-reported. It is best at 4–8h junior tasks with clear requirements and verifiable outcomes ([review](https://cognition.com/blog/devin-annual-performance-review-2025)).
  - 2026: single-writer multi-agent ([Cognition](https://cognition.com/blog/multi-agents-working)).
- **Manus.** KV-cache hit rate is the top metric. Mask tools via logits rather than removing them. The filesystem is unlimited, restorable memory: drop content, keep the URL or path. todo.md recitation. Keep errors in context. Vary serialization to avoid few-shot mimicry ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
- **Pi (Mario Zechner, 2025-11-30).**
  - "If I don't need it, it won't be built."
  - The system prompt plus tools come to under 1k tokens, with 4 tools (read, write, edit, bash) and YOLO by default.
  - No MCP: Playwright plus Chrome DevTools MCP cost 7–9% of context up front, so it uses CLI tools with READMEs instead.
  - No background bash (use tmux). No built-in todos or plan mode (use files). No subagents except review via `pi --print`.
  - Session continue, resume and branch, plus cross-provider context handoff.
  - The Terminal-Bench 2.0 run had pi + Opus 4.5 competing with native harnesses. The page says Terminus 2, a minimal agent, "is holding its own" ([post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)).
  - Pi moved to `@earendil/pi` in April 2026 ([Zechner, 2026-04-08](https://mariozechner.at/posts/2026-04-08-ive-sold-out/)).
- **Code as action (CodeAct / smolagents / OpenHands).**
  - CodeAct: executable Python as the unified action space, "up to 20% higher success rate" across 17 LLMs ([CodeAct, ICML 2024](https://arxiv.org/abs/2402.01030)).
  - smolagents `CodeAgent` vs `ToolCallingAgent`. Code actions add composability, variables for objects, and training-data familiarity ([smolagents](https://huggingface.co/docs/smolagents/conceptual_guides/intro_agents)).
  - OpenHands is built on CodeAct. Its V1 SDK is event-sourced, with a condenser and multi-LLM routing ([OpenHands SDK, 2025-11-05](https://arxiv.org/abs/2511.03690)).
  - In this repo, `pi-codemode` runs model-written JS in a QuickJS sandbox where "nested tool calls never enter the LLM context; only the script's output and return value do". It is used by the coding agent's built-in `codemode` tool (`vendor/pi/packages/codemode/README.md`). This is CodeAct used as a *context-isolation* mechanism: N tool calls cost one observation.

<a id="pi-in-this-repo"></a>
### What the vendored Pi already provides (for this slice)

| Capability | Where | Status |
|---|---|---|
| Two-level tool loop with steering and follow-up queues, `prepareNextTurn`, `prepareRequest`, `finishTurn → continue/end` | `packages/agent/src/agent-loop.ts` | Core |
| Code-as-action with hidden nested tool calls | `packages/codemode` | Core tool |
| Durable conversations, crash resume, child conversations owned by tasks, background tasks, `waiting`/`sleeping`, task graph, `reset(handoff)`, background compaction, `onYield` continue hooks, `beforeTool` block hooks | `packages/durable/README.md` | Experimental |
| Subagent (process-isolated, parallel, chained scout→planner→worker, worker→reviewer) | `examples/extensions/subagent` | Example |
| Plan mode (read-only, bash allowlist, `[DONE:n]`) | `examples/extensions/plan-mode` | Example |
| Todo (state in session entries, branch-safe) | `examples/extensions/todo.ts` | Example |
| Handoff, custom compaction, git checkpoint, permission gate, protected paths | `examples/extensions/*.ts` | Example |

---

## 7. Comparison table

Cost is relative to a single plain loop at 1×. "Coding fit" means fit for an interactive coding-agent harness.

| Pattern | Decides next step | Context each step sees | Token cost | Latency | Best measured evidence | Main users | Coding fit |
|---|---|---|---|---|---|---|---|
| Plain tool loop / ReAct | Model | Full append-only transcript | 1× (quadratic input, linear with cache) | Serial | ReAct +34 ALFWorld | Codex, Claude Code, Pi, smolagents | ★★★★★ base |
| Plan-and-execute / ReWOO / LLMCompiler | Planner once, executors | Planner: task only; executor: its step | 0.2–0.5× (ReWOO ~5× fewer tokens) | Lower; LLMCompiler 3.6× faster | ReWOO 42.4 vs 40.8 HotpotQA | LangGraph | ★★ (as a phase only) |
| Plan mode → act mode | Human gate | Shared transcript, read-only tools in plan | ~1.1–1.3× | +1 human round | No ablation published | Claude Code, Cline, Devin, Codex | ★★★★ |
| Tree search (LATS) | Search algorithm | Path from root plus reflections | 5–50× | High | HumanEval 92.7% | Research | ★ |
| Reflexion / self-refine | Model plus feedback | Transcript plus reflections | 1.5–3× | Serial | HumanEval 91%; but [Huang] no gain without external signal | Research | ★★★ only with tests |
| Verify loop (tests/lint/type/browser) | Environment | Concise check output | +check output | +check runtime | SWE-agent lint +3 pts; Anthropic e2e qualitative | Everyone | ★★★★★ |
| Think tool | Model | Transcript | +small | Small | τ-bench airline +54% rel (3.7 Sonnet) | Superseded by interleaved thinking | ★ (legacy) |
| Interleaved/adaptive thinking | Model | Transcript plus prior thinking | +thinking tokens | Moderate | Used by Anthropic research subagents | Claude 4+, OpenAI reasoning | ★★★★★ |
| Todo / recitation | Model | Tail of transcript holds the plan | +100s of tokens per update | Negligible | None published | Manus, Claude Code, Codex `update_plan` | ★★★★ long tasks |
| Prompt chaining / routing | Code | Previous output / input only | ≤1× | Serial | — | Workflows, Agentless (32% Lite @ $0.70) | ★★★ for fixed pipelines |
| Sectioning / voting | Code | Slice or same input | N× | ≈1× | Multi-reviewer voting | Review bots | ★★★★ review |
| Orchestrator–subagents (summary return) | Orchestrator | Child: brief only; parent: summary | ~4–15× | Lower if parallel | +90.2% research eval | Claude Code, Codex, Amp, Anthropic research | ★★★★ read-heavy; ★★ writes |
| Evaluator–optimizer / coder–reviewer | Code loop | Reviewer: clean context plus diff | +1 review per round | Serial | Devin Review ~2 bugs per PR, 58% severe | Devin, Codex, Claude Code `/code-review` | ★★★★★ |
| Handoff (control transfer) | Model | Full history (filterable) | 1× | — | — | OpenAI Agents SDK, Swarm | ★ (support bots) |
| Supervisor / swarm | Supervisor / peer | Scoped tools per agent | Supervisor > swarm | — | Supervisor +~50% after fixes; single agent fails with ≥2 distractors | LangGraph | ★★ |
| Group chat (shared broadcast) | Selector / round-robin | Everything | High | High | Magentic-One competitive on GAIA | AutoGen, Magentic-One | ★★ |
| Agent teams (mailbox + task list) | Peers | Own context; messages | "Significantly more" | Parallel | C compiler: 100k LOC, $20k | Claude Code (exp.), Carlini | ★★★ big greenfield |
| Best-of-N plus selector | Code | Independent full runs | N× | ≈1× | 63.7→70.3% SWE-V; 31.7→42.7% Lite pass@6 | Anthropic evals, Codex, Factory | ★★★★ with tests |
| Worktree-parallel / background | Human or orchestrator | Separate repo copy per agent | N× | Async | 1,500 PRs / 5 months (OpenAI) | Claude Code, Codex cloud, Devin, Amp | ★★★★ |
| Initializer + progress files | Harness | Fresh per session plus files plus git | 1× per session plus re-orientation | Many sessions | Qualitative | Anthropic | ★★★★★ long tasks |
| Ralph loop | Bash `while` | Fresh each loop plus specs and plan files | Re-reads specs every loop | Unbounded | Anecdotal (CURSED, YC) | Huntley, OpenAI harness team | ★★★★ greenfield |
| Handoff doc vs compaction | User or model | New thread with an extracted brief | 1 summarisation call | Low | OpenHands condenser 2× cheaper per turn | Amp (handoff), Claude Code / Codex (compact) | ★★★★ |
| Stop hook continuation | Harness / LLM judge | Hook reason injected as next message | +1 turn per block | +checks | — | Claude Code, Pi `finishTurn`, durable `onYield` | ★★★★★ |
| Code-as-action (CodeAct) | Model writes program | Only script output enters context | Fewer turns | Fewer round trips | Up to +20% success | smolagents, OpenHands, Pi codemode | ★★★★ |

---

## 8. Disagreements and open questions

1. **Share context vs isolate context.** Cognition 2025 says share full traces. Anthropic says isolate and return 1–2k summaries. The reconciliation, consistent across sources:
   - **Generation** (decisions that must cohere) wants one writer with full context.
   - **Information gathering** wants isolation with a summary or reference return.
   - **Evaluation** wants a *clean* context and is better without the writer's history, plus a channel back to intent. That is Cognition 2026 and Claude Code's adversarial review "in a fresh context against PLAN.md" ([best practices](https://www.anthropic.com/engineering/claude-code-best-practices)).
   - **Escalation to a stronger model** wants a full-context fork (Cognition "smart friend").
2. **Built-in todo/plan tools vs files.** Claude Code, Codex and Manus use tools or files actively. Pi says files only. Nobody has published an ablation.
3. **Compaction vs handoff vs fresh-session-from-files.** Amp removed compaction. Anthropic says compaction "does not reliably" fix one-shotting and uses progress files plus fresh sessions. Codex keeps auto-compaction, now with opaque server-side items. Long autonomous runs (Ralph, Carlini, Anthropic harness) all converge on **fresh context plus externalised state**.
4. **Subagents in a coding harness at all.** Pi's original stance was none except review, as black boxes. Claude Code, Codex and Amp default them on. The vendored Pi example now shows them as visible, streamed child processes, which answers the visibility objection without answering the "plan ahead" objection.
5. **Multi-agent for coding vs research.** Anthropic's 90.2% is for research. Anthropic itself says coding parallelises less. LangChain shows multi-agent helps mainly by *scoping tools*, which a single agent with fewer tools may also get.
6. **Self-critique.** Self-Refine and Reflexion report gains. Huang et al. say intrinsic self-correction fails on reasoning. The gap is explained by whether feedback is external.
7. **Measurement gap.** Few of the harness-level patterns have controlled ablations: plan mode, todos, handoff, stop hooks, agent teams. The numbers available are model-vendor evals, SWE-agent ablations (2024, GPT-4T), ReWOO (2023), and self-reported production metrics.

---

## 9. Recommendations for the Pi harness

In priority order. Each one builds on primitives that already exist in `vendor/pi`.

1. **Keep one append-only loop as the only executor.** Express every other "flow" as a policy over it, using `prepareNextTurn`, `prepareRequest`, `finishTurn`, steering and follow-up. Never mutate the prefix: append permission or mode changes as messages (as Codex does), and mask tools rather than removing them (as Manus does).
2. **A first-class verify loop.** Provide a stop-time `finishTurn`/`onYield` policy that runs project checks (tests, typecheck, lint). On failure it returns `continue` with a *compressed* failure summary: errors on one line each, full log in a file. Add a block cap like Claude Code's 8 plus a "stop_hook_active"-style guard. This is the single biggest measured win.
3. **Subagent = agent-as-tool with summary or reference return.** Use the existing process-isolated example, or durable owned conversations. Default to read-only scout and reviewer roles. Writers get their own worktree. Return ≤2k tokens plus file references. Make child transcripts inspectable to keep Pi's visibility principle.
4. **Clean-context reviewer loop.** After implementation, a reviewer with no parent history reads the diff plus PLAN.md or the spec. Findings go back to the single writer, which triages them against user intent (Cognition 2026).
5. **File-backed long-horizon mode.** Provide an `initializer` prompt that writes `features.json` (JSON, append-only "passes"), `progress.md` and `init.sh`, then commits. A `session` prompt orients, smoke-tests, does one feature, verifies e2e, commits, and updates progress. Drive it with a Ralph-style outer loop, using `reset(handoff)` in durable or a new session per iteration.
6. **Handoff as the default for "context full" in interactive use, with compaction as a fallback.** The handoff should be goal-directed, user-editable and list files. Keep durable's background compaction for unattended runs.
7. **Plans and todos as files or session entries, not hidden state.** Keep them branch-safe like the todo example. Echo the current list at the tail on update.
8. **Best-of-N in worktrees** for well-tested tasks: N attempts, filter by tests, rank by a model, apply the winner. Expose it as a command, not a default (N× cost).
9. **Avoid** group-chat broadcast, supervisor paraphrasing, LATS-style tree search in the inner loop, and parallel writers sharing one checkout.

---

## 10. Sources

Primary unless marked *(secondary)*.

**Anthropic**
- Building effective agents (2024-12-19) — https://www.anthropic.com/engineering/building-effective-agents
- The "think" tool (2025-03-20; superseded note 2025-12-15) — https://www.anthropic.com/engineering/claude-think-tool
- How we built our multi-agent research system (2025-06-13) — https://www.anthropic.com/engineering/multi-agent-research-system
- Building agents with the Claude Agent SDK (2025-09-29) — https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk
- Effective context engineering for AI agents (2025-09-29) — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Effective harnesses for long-running agents (2025-11-26) — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Building a C compiler with a team of parallel Claudes (2026-02-05) — https://www.anthropic.com/engineering/building-c-compiler
- Claude 3.7 Sonnet announcement (SWE-bench scaffold) — https://www.anthropic.com/news/claude-3-7-sonnet
- Claude Code best practices — https://www.anthropic.com/engineering/claude-code-best-practices
- Claude Code docs: subagents — https://code.claude.com/docs/en/sub-agents
- Claude Code docs: agent teams — https://code.claude.com/docs/en/agent-teams
- Claude Code docs: hooks — https://code.claude.com/docs/en/hooks
- Claude Code docs: checkpointing — https://code.claude.com/docs/en/checkpointing
- Claude Code docs: common workflows — https://code.claude.com/docs/en/common-workflows
- Claude Code SDK todo tracking — https://docs.anthropic.com/en/docs/claude-code/sdk/todo-tracking
- Extended / interleaved / adaptive thinking — https://platform.claude.com/docs/en/build-with-claude/extended-thinking

**OpenAI**
- Unrolling the Codex agent loop (2026-01-23) — https://openai.com/index/unrolling-the-codex-agent-loop/
- Unlocking the Codex harness: App Server (2026-02-04) — https://openai.com/index/unlocking-the-codex-harness/
- Harness engineering: leveraging Codex in an agent-first world (2026-02-11) — https://openai.com/index/harness-engineering/
- Codex subagents — https://developers.openai.com/codex/subagents
- Codex config reference — https://developers.openai.com/codex/config-reference
- Codex cloud — https://developers.openai.com/codex/cloud
- Codex best-of-N announcement — https://x.com/OpenAIDevs/status/1933617093938692164
- Agents SDK: handoffs — https://openai.github.io/openai-agents-python/handoffs/
- Agents SDK: orchestration — https://openai.github.io/openai-agents-python/multi_agent/

**Cognition**
- Don't Build Multi-Agents (2025-06-12) — https://cognition.ai/blog/dont-build-multi-agents
- Multi-Agents: What's Actually Working (2026-04-22) — https://cognition.com/blog/multi-agents-working
- Devin 2.0 — https://cognition.com/blog/devin-2
- Devin's 2025 Performance Review (2025-11-14) — https://cognition.com/blog/devin-annual-performance-review-2025

**Other vendors and practitioners**
- Manus: Context Engineering for AI Agents (2025-07-18) — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Amp: Handoff (2025-10-23) — https://ampcode.com/news/handoff
- Amp: Models & Subagents — https://ampcode.com/docs/models-and-subagents
- Amp manual — https://ampcode.com/manual
- Factory: Code Droid technical report (2024-06-18) — https://factory.ai/news/code-droid-technical-report
- Cline: Plan & Act — https://docs.cline.bot/features/plan-and-act
- Mario Zechner: What I learned building an opinionated and minimal coding agent (2025-11-30) — https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
- Mario Zechner: I've sold out (2026-04-08) — https://mariozechner.at/posts/2026-04-08-ive-sold-out/
- pi.dev — https://pi.dev/
- Geoffrey Huntley: Ralph Wiggum as a "software engineer" (2025-07-14) — https://ghuntley.com/ralph/
- Geoffrey Huntley: everything is a ralph loop (2026-01-17) — https://ghuntley.com/loop/
- LangChain: Planning agents (2024-02-13) — https://blog.langchain.com/planning-agents/
- LangChain: Benchmarking multi-agent architectures (2025-06-10) — https://blog.langchain.com/benchmarking-multi-agent-architectures/
- langgraph-supervisor README — https://github.com/langchain-ai/langgraph-supervisor-py
- Google ADK workflow patterns — https://adk.dev/workflows/patterns/ ; overview https://adk.dev/workflows/
- CrewAI processes — https://docs.crewai.com/en/concepts/processes
- AutoGen AgentChat teams — https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html
- AutoGen maintenance mode *(secondary)* — https://atlan.com/know/ai-agent/what-is-autogen/
- Magentic-One (MSR article) — https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/
- Hugging Face smolagents: intro to agents — https://huggingface.co/docs/smolagents/conceptual_guides/intro_agents ; ReAct guide https://huggingface.co/docs/smolagents/conceptual_guides/react
- OpenHands condenser blog — https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents
- OpenHands CLI docs — https://docs.all-hands.dev/usage/how-to/cli-mode
- Claude Code prompt extraction *(secondary)* — https://gist.github.com/wong2/e0f34aac66caf890a332f7b6f9e2ba8f ; analysis https://jannesklaas.github.io/ai/2025/07/20/claude-code-agent-design.html
- Codex cloud `--attempts` *(secondary)* — https://codex.danielvaughan.com/2026/04/01/codex-cloud-exec-best-of-n-attempts/

**Papers**
- ReAct (2022-10-06) — https://arxiv.org/abs/2210.03629
- Reflexion (2023-03-20) — https://arxiv.org/abs/2303.11366
- Self-Refine (2023-03-30) — https://arxiv.org/abs/2303.17651
- ReWOO (2023-05-23) — https://arxiv.org/abs/2305.18323 ; full text https://arxiv.org/html/2305.18323v1
- MetaGPT (2023-08-01) — https://arxiv.org/abs/2308.00352
- LLMs Cannot Self-Correct Reasoning Yet (2023-10-03, ICLR 2024) — https://arxiv.org/abs/2310.01798
- LATS (2023-10-06) — https://arxiv.org/abs/2310.04406
- CodeAct (2024-02-01, ICML 2024) — https://arxiv.org/abs/2402.01030
- SWE-agent (2024-05-06) — https://arxiv.org/abs/2405.15793 ; ablations https://arxiv.org/html/2405.15793v3
- Agentless (2024-07-01) — https://arxiv.org/abs/2407.01489
- Magentic-One (2024-11-07) — https://arxiv.org/abs/2411.04468
- OpenHands Software Agent SDK (2025-11-05) — https://arxiv.org/abs/2511.03690

**Local source (this repo)**
- `vendor/pi/packages/agent/src/agent-loop.ts` (loop, steering/follow-up, `finishTurn`)
- `vendor/pi/packages/durable/README.md` (durable conversations, child tasks, reset/handoff, compaction, hooks)
- `vendor/pi/packages/codemode/README.md` (code-as-action sandbox)
- `vendor/pi/packages/coding-agent/examples/extensions/{subagent,plan-mode}/README.md`, `handoff.ts`, `todo.ts`
