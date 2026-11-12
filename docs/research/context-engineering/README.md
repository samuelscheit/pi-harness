# Context engineering and agent flows for LLM harnesses: overview

Researched 2026-11-12. This file condenses six detailed reports, which together cite about 300 sources: vendor engineering posts, papers, official docs, and harness source code read at pinned commits. Each claim below is cited in the report it points to, and the reports mark second-hand evidence as such.

| # | Report | Covers |
|---|---|---|
| 01 | [Foundations and failure modes](01-foundations-and-failure-modes.md) | definitions, taxonomies, context rot, prompt design and placement, cache economics |
| 02 | [In-session context lifecycle](02-in-session-context-lifecycle.md) | truncation, masking, compaction, server-side compaction, reasoning tokens, triggers |
| 03 | [Selection, retrieval, tools, skills](03-selection-retrieval-tools-skills.md) | grep vs embeddings vs repo maps vs LSP, tool loading, code mode, skills, instruction files, reminders |
| 04 | [Flows, loops, multi-agent](04-flows-loops-multi-agent.md) | ReAct, plan/act, verify loops, workflow patterns, subagents, long-horizon harnesses, best-of-N |
| 05 | [Memory and self-improvement](05-memory-and-self-improvement.md) | Letta, mem0, Zep, memory files, ACE playbooks, Reflexion/ExpeL, skill learning, prompt optimisation, memory security |
| 06 | [Harness implementations](06-harness-implementations.md) | source-level comparison of Pi, Codex, Claude Code, Gemini CLI, opencode, OpenHands, Aider, Cline/Roo, Goose, Continue, Amp, Cursor, Factory, (mini-)SWE-agent, smolagents |
| 07 | [Evidence from our sessions](07-evidence-from-our-sessions.md) | each candidate measured on 1,616 of our own sessions ($21k): simulations, labelled corrections, recurring rules. **Overrides the ranking below where they disagree.** |
| 08 | [Thinking and cache-loss events](08-thinking-and-cache-loss.md) | replayed thinking is 8–11% of Pi spend (the metrics overstate it ~2×); 77% of cache-loss waste came from pi-lens's in-memory injection ledger (fixed) |

## The model in one paragraph

Context is a finite attention budget, not storage. Every model tested degrades as input grows, even with perfect retrieval (01 §3). A model's effective window is often less than half of what it advertises. Every step should therefore see the smallest set of high-signal tokens. There are four ways to get there: **write** state outside the window, **select** what comes in, **compress** what is already there, and **isolate** work into separate windows (LangChain's taxonomy). Production systems add two more design concerns. One is **cache stability**: cached input costs about 0.1× normal price, and agents read about 100 input tokens per output token. The other is **attention shaping**: what goes at the end of the context and what gets restated. The harness's control flow decides when each of these happens.

## Map of every approach

### 1. Write: keep state outside the window

| Approach | Use when | Main cost | Report |
|---|---|---|---|
| Scratchpad / notes / progress files (`NOTES.md`, `progress.txt`, `feature_list.json`) | tasks longer than one window | the agent must keep them current | 04 §6, 01 |
| Spill large tool outputs to files, keep a preview and the path | any output above a size threshold (Claude Code 50K chars, Deep Agents 20K tokens) | an extra read when the agent needs it | 02 §4 |
| Git as checkpoint and state log | coding; long tasks; rewinding | none worth noting | 04 §6 |
| Handoff document to a fresh thread (Amp) | context full, or the goal changes | user or agent has to steer it | 02, 04 §7 |
| Persistent memory files (index loaded every session, topic files on demand) | facts about the user and project across sessions | stale entries, poisoning | 05 §2 |
| Playbook of procedural lessons (ACE) | the same mistakes recur | needs verified outcomes and curation | 05 §4 |

### 2. Select: what enters the window

| Approach | Use when | Main cost | Report |
|---|---|---|---|
| Just-in-time agentic search (grep, glob, bounded read) | the default everywhere | more turns | 03 §1 |
| Embedding or semantic index (Cursor, Augment, Cody) | repos of 1,000+ files, conceptual queries | index upkeep; Cursor measured only +12.5% on top of grep | 03 §1 |
| Repo map (Aider: tree-sitter + PageRank) | fast orientation on mid-size repos | tokens always loaded | 03 §1 |
| LSP / AST navigation | definitions, references, type errors | per-language setup | 03 §1 |
| Search subagent (Cognition SWE-grep: parallel, returns file:line) | heavy exploration | an extra model call | 03, 04 |
| Bounded observations (100-line viewer, summarised search, lint-gated edits) | always; SWE-agent ablations measure +3 to +6 pts | none worth noting | 03 §1 |
| Hierarchical instruction files (AGENTS.md / CLAUDE.md), closest file wins, size cap | always | instruction overload past ~150–200 rules | 03 §3 |
| Nested instruction files loaded when a tool touches that folder | monorepos | not loaded until touched | 03 §3, 06 |
| Progressive disclosure through skills (~100 tokens of metadata, body on demand, listing capped at 1–2% of window) | workflows that are triggered explicitly | the model often doesn't trigger them (56% unused in Vercel's eval) | 03 §3 |
| Always-loaded pointers / doc index in AGENTS.md | knowledge that applies across the whole codebase | fixed tokens | 03 §3 |
| Tool search / deferred schemas | more than ~30 tools or MCP sprawl | one extra search step | 03 §2 |
| Code mode / programmatic tool calling (results stay in the sandbox) | many tools, data-heavy chains | needs a sandbox; harder to debug | 03 §2 |
| Tool design (consolidated, namespaced, `response_format`, input examples, errors that say what to do next) | always | design effort | 03 §2, 01 §5 |
| Mid-conversation injection (`<system-reminder>`, hook `additionalContext`, env and git facts, date) | state that changes, late-session steering | reminder spam | 03 §4 |
| Doc retrieval (llms.txt, Context7, a small model summarising web fetches) | external APIs | the summariser can drop details | 03 §5 |

### 3. Compress: shrink what is already in the window

In order of cost and of how much they lose. Production harnesses stack them in this order.

1. **Truncate at write time**: head/tail truncation, caps around 2,000 lines / 50 KB / 10K tokens, with a truncation message that says what to do next (02 §3, 06).
2. **Restorable compression**: drop the content, keep the path or URL (Manus) (02 §4).
3. **Observation masking / tool-result clearing**: replace old tool results with a placeholder (Claude Code, Gemini protecting the newest 50K tokens and acting in 30K batches, SWE-agent `last_n_observations`, Anthropic `clear_tool_uses`). JetBrains found this **as good as LLM summarisation at about half the cost** (02 §2).
4. **LLM summarisation / compaction**: a structured schema (goal, constraints, decisions, done/active/blocked, files, next step, exact identifiers), updated in steps rather than rewritten. It keeps recent user messages verbatim (Codex 20K tokens) and re-attaches what was recently touched (Claude Code: 5 files, skills, plan, instruction files). Optionally a second pass checks the summary for omissions (Gemini) (02 §5, 06).
5. **Server-side compaction**: Anthropic `compact_20260112`, OpenAI `/responses/compact`. The result is opaque and tied to one model (02 §6).
6. **Context controlled by the agent**: tools such as `get_context_remaining` / `new_context`, context folding, compression as a tool (Codex experimental, Context-Folding, ACON, MEM1) (02 §9).

Rules that cut across all of these:

- **Batch the edits** so cache misses are rare (`clear_at_least`, amortised forgetting).
- **Run the summary request on the same cached prefix**, prepare it in the background (Codex from 65%, opencode 60K tokens before the limit), or compact when the cache has already gone cold (Pi's cost-based trigger).
- **Size triggers to the effective window**, not the advertised one. Claude Code compacts a 1M window at about 967K, which is too late for quality.

### 4. Isolate: split work across windows

| Approach | Use when | Main cost | Report |
|---|---|---|---|
| Read-only subagent that returns a 1–2K summary plus file references | search, exploration, review | tokens; summaries can lose detail | 04 §4 |
| Reviewer with a clean context (Cognition: ~2 bugs per PR, ~58% severe) | before finishing or merging | one extra pass | 04 §4 |
| Orchestrator-workers / parallel research (Anthropic +90.2%, about 15× tokens) | broad research, not writing code | about 15× tokens | 04 §3–4 |
| Best-of-N in separate worktrees, selected by tests (Sonnet 3.7 SWE-bench 63.7 → 70.3) | a verifier exists | N× cost | 04 §8 |
| Parallel writers coordinating through git locks (Carlini's C compiler) | very large work that splits cleanly | needs strong tests | 04 §6 |
| Fresh session per feature (initializer + coder; the Ralph loop) | long-horizon builds | setup per session | 04 §6 |
| Sandboxed code execution (CodeAct, code mode) | heavy data in tool chains | sandbox | 03, 04 |

Where sources now agree: **many agents may contribute intelligence, but only one writes code** (Cognition's April 2026 revision, Codex docs, Anthropic).

### 5. Cache-aware design (cuts across all of the above)

These rules come from 01 §8 and 06 §3:

- Keep the prefix stable and history append-only.
- Serialise JSON and order tools deterministically.
- Never switch tools or models mid-session; mask or defer tools instead.
- Send state changes as appended "section X is now…" messages (Codex, opencode and Pi all converged on this) instead of editing the system prompt.
- Place cache breakpoints explicitly (mind Anthropic's 20-block lookback).
- Treat cache hit rate as a monitored metric.

Measured savings: 41–80% lower cost and 13–31% faster time to first token.

### 6. Attention shaping

- **Placement**: Claude and Gemini want long data first and the question last (up to +30%). OpenAI wants instructions at both ends.
- **Recitation**: todo/plan rewriting (Manus, TodoWrite, `update_plan`) is popular but has **no published ablation**. Report 01 says Manus later dropped `todo.md` because it consumed about a third of all actions. Zechner prefers a plain `PLAN.md` file.
- **Prompt altitude**: keep the prompt minimal and add rules only for observed failures, each with its reason. Use diverse canonical examples, not lists of edge cases. Cursor cut its prompt by 66% by removing "MUST / DO NOT" wording. Base prompts are shrinking (opencode about 750 bytes, Pi about 2.5 KB).
- **Avoid the few-shot rut**: vary serialisation slightly so the agent doesn't copy its own repetitive history (Manus).
- **Show the model its own budget**: tokens or turns remaining (Codex, Goose, Claude Code's token reminder).

### 7. Flows: control loops

All production harnesses run the same core: **call the model → run tool calls → append results → repeat until no tool calls**. Every flow below is a policy on top of that loop (04 §2–3).

| Flow | Context each step sees | Evidence | Fit for coding |
|---|---|---|---|
| ReAct / plain tool loop | everything so far | the default | base |
| Plan → act (plan mode) | the plan carried into execution | widely shipped, not measured | good for large changes |
| Plan-and-execute / ReWOO | planner sees the goal; executors see one step each | fewer tokens; brittle | weak |
| Verify loop (tests, lint, types as feedback; stop hook forces continuation, capped) | the failure output | **strongest evidence** (SWE-agent 18.0 vs 15.0; Reflexion's gains depend on tests) | essential |
| Self-critique without an outside signal | its own output | can hurt (Huang et al., ICLR 2024) | avoid |
| Reflexion / evaluator-optimizer | a written reflection plus the verifier result | good when a verifier exists | good |
| Tree search (LATS) | multiple branches | expensive | avoid inside the loop |
| Prompt chaining / routing / parallelisation (Anthropic workflows) | fixed per step | predictable | for sub-workflows |
| Orchestrator-workers / subagents | condensed results | see Isolate | reading only |
| Long-horizon: initializer + one feature per fresh session; the Ralph loop | files + git | Anthropic, Huntley, Carlini | for big builds |
| Handoff vs auto-compaction | new thread with a goal note vs a summary | disputed | offer both |
| Human-in-the-loop interrupts and approval gates; checkpoints and rewind | — | — | UX |
| Background / scheduled agents (memory consolidation, "dreaming") | session logs | Codex, Letta, Claude Code | memory |

### 8. Memory and self-improvement across sessions

- **Form**: Markdown files in git with a small index loaded every session (Claude Code `MEMORY.md` first 200 lines, Codex `memory_summary.md`, Letta MemFS). No coding harness uses a vector database by default (05 §2).
- **When to write**: in the background, when idle (Codex, Letta sleep-time agents, Claude Code auto dream), not mid-task.
- **How to update**: as **itemised deltas** (ADD / UPDATE / DOWNVOTE / REMOVE / NOOP; ACE, mem0, ExpeL), never a whole-file rewrite by the model. In ACE, a whole rewrite collapsed 18,282 tokens to 122 and scored below having no memory.
- **Sources**: lessons need verified outcomes. Letta's skill learning gained +21% from session traces and +36.8% with verifier feedback. Off-the-shelf memory products failed to beat memory-off in 11 of 12 pairings (VibeMemBench).
- **Safety**: memory poisoning is real (MINJA >95%, SpAIware). Gate lessons from sessions that read web or MCP content. Keep the evaluator outside what the agent can write: DGM gamed its own markers.
- **Metric**: recurrence, i.e. whether the same class of correction comes back after a rule exists for it. Track it alongside steps, cost, rule-following rate and playbook size.

ACE's two numbers measure different things. +10.6% is the average gain over the selected baselines (+8.6% on finance). "Up to +17.1 points" is ReAct+ACE compared with base ReAct on AppWorld (59.5 vs 42.4). Source: [arXiv 2510.04618](https://arxiv.org/html/2510.04618v1).

## Where the field agrees and where it doesn't

**Agrees:**

- short base prompts with hierarchical AGENTS.md;
- just-in-time retrieval;
- bounded tool output;
- cheap reduction before summarisation;
- append-only, cache-stable context;
- skills as progressive disclosure;
- verifiers as the main lever;
- read-only subagents;
- one writer;
- memory as files, consolidated in the background.

**Disputed:**

- grep vs embeddings (Claude Code's evidence is "just vibes"; Cursor measured a modest gain);
- handoff vs compaction;
- todo recitation;
- keeping failed actions in context (Manus) vs hiding resolved errors (12-factor);
- full-context multi-agent vs single thread;
- query placement across model families.

## What this means for this harness (Pi)

Pi already has:

- a ~2.5 KB base prompt;
- XML-sectioned context with **append-only section patches**;
- cache breakpoints plus a lookback bridge;
- cache warming;
- **cost-based compaction when the cache is cold**, which no other harness has;
- an iteratively updated structured summary with file tracking;
- `context_edit` entries;
- skills;
- an opt-in `tool_search`;
- a code-mode extension;
- handoff/reset primitives;
- loop hooks (`prepareNextTurn`, `finishTurn`).

> **Read [07](07-evidence-from-our-sessions.md) first.** Measured on our own sessions, observation masking (item 1 below) *loses* 5–27% of spend once prompt caching is priced; the JetBrains result priced its Qwen runs without caching. Compacting earlier (items 2–3) saves a simulated 20–28% with no measurable quality harm. Verify-at-stop (5) shows no observational link to user-reported failures. Tool search and skill budgets (10) cost ≤4% combined. The most repeated correction calls for a turn-end guard: ending while background work runs (22 sessions).

Gaps as the literature ranks them (details in 02 §12, 03 §0, 04 §10, 06 §gaps):

1. **Observation masking** of old tool results, built on `context_edit`, applied in batches, keeping the newest N tokens. This is the strongest measured win for the least work.
2. **A compaction trigger as a fraction of the effective window or an absolute cap.** Today `window − 16384` fires at 98.4% of a 1M window.
3. **Summary calls that reuse the warm cache, plus background compaction**, so the summary is ready before it is needed.
4. **What survives compaction**: re-attach recent files, invoked skills and plan; tell the summariser not to restate AGENTS.md or environment; keep recent user messages verbatim.
5. **A verify-at-stop loop**: lint, types and tests fed back as the next instruction, capped. The `fix-loop` experiment currently in progress in this repo covers this.
6. **Nested AGENTS.md loaded when touched**, plus a size cap.
7. **A reminder channel and environment facts**: date, git status snapshot, token budget left.
8. **Read-only scout and reviewer subagents** that return summaries and file:line references (through t3 `delegate_task`).
9. **Dreaming as ACE-style deltas** on a versioned playbook, gated by A/B arms, with recurrence as the key metric and lessons from untrusted-input sessions gated.
10. Smaller items, to do once the above are done:
    - tool search on by default once MCP tool count passes ~30;
    - per-model edit format (`apply_patch` for GPT models);
    - loop detection;
    - an optional repo map or LSP tool;
    - optional native provider compaction.

Each item fits the existing experiment framework (`extensions/lib/experiments.ts`). Ship it as an experiment arm and keep it if the metrics improve.
