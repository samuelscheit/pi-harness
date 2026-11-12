# 02 — In-session context lifecycle: compress, reduce, offload

Research slice: how a coding-agent harness keeps one long session inside the context window. Research date: **2026-11-12**. Repos were cloned at their `HEAD` on that date (codex `openai/codex` 2026-11-12, OpenHands `software-agent-sdk` 2026-11-12, opencode `sst/opencode` 2026-11-12, cline `cline/cline` 2026-11-12). Pi is the vendored copy at `vendor/pi` (HEAD 2026-11-12).

Evidence labels used below:
- **[src]** I read the source code.
- **[doc]** Vendor documentation or an engineering blog.
- **[paper]** arXiv or peer-reviewed.
- **[2nd]** Secondary source, such as a blog analysis, a GitHub issue or a reverse-engineering write-up. Treat these as unverified.

## TL;DR

1. Every production harness now stacks **cheap, deterministic reduction first** (tool-output truncation at write time, then clearing or masking old tool results) and uses **LLM summarization second** (compaction). Claude Code says this outright: "clears older tool outputs first, then summarizes" ([doc](https://code.claude.com/docs/en/how-claude-code-works)).
2. **Observation masking is as good as summarization** on SWE-bench Verified. JetBrains measured roughly −50% cost against the raw agent, with equal or better solve rates. Summarization made trajectories 13–15% longer, and summary calls cost 3–7% of total spend. A hybrid (mask first, summarize late) saved another 7–11% ([paper](https://arxiv.org/html/2508.21433v3)).
3. **Compaction breaks the prompt cache** at the point where history is rewritten. There are three cache-friendly patterns. (a) Send the summarize request as a fork of the *same* cached prefix (Claude Code, Cline). (b) Clear content in large, infrequent batches (`clear_at_least`, amortized forgetting). (c) Put a cache breakpoint after the system prompt so only the summary is rewritten ([doc](https://code.claude.com/docs/en/prompt-caching), [doc](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)).
4. **Providers now ship compaction server-side.** Anthropic has `compact_20260112` (default trigger 150k, minimum 50k) plus an on-demand `compaction:{type:"summarize"}` that returns a signed `compaction` block. OpenAI has `context_management:[{type:"compaction",compact_threshold}]` and the stateless `/responses/compact`, which return an *encrypted* compaction item. opencode already supports a "native" mode that uses these ([src](https://github.com/sst/opencode/blob/dev/packages/core/src/session/compaction.ts)).
5. **Codex CLI is the most elaborate implementation.** It triggers at 90% of the window (with a 95% "effective window"), runs speculative **background compaction from 65%**, keeps recent *user* messages verbatim (20k tokens locally, 64k for remote v2), and re-injects fresh initial context. An experimental `TokenBudget` mode gives the model `new_context` and `get_context_remaining` tools so it can reset its own window without a summary ([src](https://github.com/openai/codex/tree/main/codex-rs/core/src)).
6. **Restorable compression and offloading** consistently beat lossy summarization when they apply. The pattern is: keep the path or URL, drop the body, spill large outputs to files, and re-read the most recently touched files after compaction (Manus, Claude Code's 50K-char spill and 5-file restore, Pi's bash `fullOutputPath`).
7. **Reasoning tokens** have their own rules. Anthropic thinking blocks must be passed back unmodified within a tool loop. Newer Claude models keep prior thinking, which costs input tokens. `clear_thinking_20251015` can drop it, at the price of a cache miss. OpenAI reasoning items should be replayed via `encrypted_content` (about +3% on SWE-bench, per OpenAI). Prefix edits make the API silently drop later reasoning ([doc](https://developers.openai.com/api/docs/guides/preserved-reasoning)).
8. **A 1M window does not remove the need to manage context.** Accuracy degrades with length even with perfect retrieval: −13.9% to −85% ([paper](https://arxiv.org/abs/2510.05381)), and NoLiMa shows most models under 50% of baseline at 32K. Large windows mostly move the *trigger*. Claude Code compacts 1M models at about 967K by default, which is arguably too late for quality.
9. **Research is moving to agent-controlled context**: folding/branch-return, `compress` as a tool, learned compressors (Context-Folding about 10× smaller active context, CAT/SWE-Compressor 57.6% SWE-bench Verified, ACON −26–54% peak tokens, MEM1 3.7× less memory). Amp removed compaction entirely in favour of user-driven **handoff** to a fresh thread.
10. **Pi's gaps.** Pi already has a sound core: threshold compaction, a structured iterative summary, file-op tracking, append-only `context_edit` entries, economic/cold-cache compaction, and cache warming. It lacks five things: (a) built-in tool-result masking (the `context_edit` primitive could implement it), (b) a %-of-window or absolute-cap trigger for 1M models, (c) background or speculative compaction, (d) a cache-reading fork for the summary call, and (e) optional native provider compaction.

---

## 1. Problem framing: why in-session context management exists

- **Context rot.** Chroma tested 18 models (2025-07-14). Performance fell with input length on every task, including trivial ones such as repeating words. On LongMemEval, focused prompts of about 300 tokens did much better than full prompts of about 113k tokens, in every model family ([doc](https://research.trychroma.com/context-rot)).
- **Length alone hurts.** Du et al. (EMNLP Findings 2025) found that even with perfect retrieval, and even when irrelevant tokens were whitespace or fully masked, performance dropped 13.9–85% as input grew within the claimed window. Their mitigation, "recite-then-solve", turns long context into short context ([paper](https://arxiv.org/abs/2510.05381)).
- **NoLiMa** (Adobe, 2025-02) removes literal overlap between question and needle. At 32K, 10 of 12 models fell below half their short-context score. GPT-4o went from 99.3% to 69.7% ([paper](https://arxiv.org/abs/2502.05167v2)).
- **Attention budget.** Anthropic's guidance (2025-09-29) is to find "the smallest set of high-signal tokens". It calls compaction the "first lever" and tool-result clearing "one of the safest lightest touch forms of compaction" ([doc](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- **Cost.** Agents are input-dominated. Manus reports an input:output ratio of about 100:1, and a 10× price gap between cached and uncached Claude Sonnet input ($0.30 vs $3/MTok) ([doc](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). OpenHands describes raw-agent cost as growing quadratically with turns ([doc](https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents)).
- **"Context anxiety".** Cognition found Sonnet 4.5 cutting work short as it believed it was nearing its limit ([doc](https://cognition.com/blog/devin-sonnet-4-5-lessons-and-challenges), 2025-09-29). Anthropic's Labs team needed full context *resets* for Sonnet 4.5 because "compaction alone wasn't sufficient". With Opus 4.5 they dropped resets and relied on Agent SDK auto-compaction ([doc](https://www.anthropic.com/research/harness-design-long-running-apps), 2026-03-24).

Taxonomy used here, following Lance Martin's write/select/compress/isolate ([doc](https://rlancemartin.github.io/2025/06/23/context_engineering/), 2025-06-23). This slice covers **compress** (summarize, mask, clear, truncate) and the in-session part of **write** (offload to files). Isolation via sub-agents and cross-session memory belong to other slices.

---

## 2. Reduction ladder (cheapest → most lossy)

| Level | Technique | Lossy? | Cache impact | Section |
|---|---|---|---|---|
| 0 | Truncate or spill tool output **at write time** | Restorable if spilled | None, because it happens before first send | §3 |
| 1 | Clear or mask **old tool results** (observation masking) | Restorable if the call and its args are kept | One miss per clearing event | §4 |
| 2 | Clear **old thinking** blocks | Yes, but the reasoning is usually re-derivable | One miss | §8 |
| 3 | **LLM summarization** of a prefix (compaction) | Yes | Full rewrite of the message layer | §5 |
| 4 | **Handoff / reset**: new thread seeded from a goal-directed brief | Yes, but user-curated | New cache | §5.9 |
| 5 | **Agent-controlled folding** (branch/return, `compress` tool) | Learned | Varies | §7 |

---

## 3. Tool-output truncation, head/tail and spill-to-file (level 0)

**Mechanism.** Cap each tool result before it enters history. Keep the head, the tail, or both, add a marker with the original size, and optionally write the full output to a file whose path is included ("restorable compression").

**Implementations**
- **Pi** [src]. `DEFAULT_MAX_LINES = 2000` and `DEFAULT_MAX_BYTES = 50KB` ([truncate.ts:11](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/tools/truncate.ts:11)). `bash` keeps the *tail* and saves the full output to a temp file, appending `[Showing lines X-Y of N … Full output: <path>]` ([bash.ts:380](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/tools/bash.ts:380)). `find` and `grep` keep the head (`truncateHead`), and grep also truncates long lines.
- **Codex CLI** [src]. Per-model `truncation_policy` (for example `bytes(10_000)` in `openai_models.rs`), plus a user-configurable `tool_output_token_limit`. `formatted_truncate_text` prefixes `Warning: truncated output (original token count: N)\nTotal output lines: L` and keeps head and tail (`codex-rs/utils/output-truncation/src/lib.rs`; a `head-tail-buffer` util exists).
- **Claude Code** [2nd]. Results over about 50K chars are persisted to disk. Context keeps a ~2KB preview plus the path inside `<persisted-output>`, with a 200K-char aggregate cap per user message. "Once a result is 'seen', its fate is frozen so the cached prefix stays stable" ([finisky 2026-04-05](https://finisky.github.io/en/claude-code-context-compaction/)). A comment on [issue #42542](https://github.com/anthropics/claude-code/issues/42542) quotes remote config of `global: 50000, Bash: 30000`. Officially, Claude Code recommends PreToolUse hooks that `grep`/`head` test output before the model sees it ([doc](https://code.claude.com/docs/en/costs)).
- **Manus** [doc]. "File system as context": drop page content but keep the URL, drop a document but keep its sandbox path ([doc](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
- **OpenAI** [doc]. Its preserved-reasoning guide says to avoid shortening past tool outputs *after* they were sent. If you must, do it before the content is first sent ([doc](https://developers.openai.com/api/docs/guides/preserved-reasoning)). This is the strongest argument for doing reduction at write time.
- **Research.** Task-conditioned pruners replace fixed head/tail with a small model that keeps only the relevant lines. SWE-Pruner (2026-01) uses a 0.6B skimmer and reports −23–54% tokens on SWE-bench Verified at equal success ([paper](https://arxiv.org/abs/2601.16746)). Squeez fine-tunes a 2B model and ships an 11,477-example benchmark ([paper](https://arxiv.org/html/2604.04979)) [2nd: search snippets].

**When it helps.** Always. It is the only reduction with zero cache cost, because it happens before first send.

**Tradeoffs.** A fixed head or tail may cut the one relevant line. Spilling needs a sandbox-readable path and a model that knows to `read` it.

**Pi application.** This is already good. Two possible extensions:
1. Make spill-to-file uniform for every tool (`read` of huge files, MCP results, `web_fetch`) through one shared helper (DRY).
2. Freeze the truncation decision at first send, as Claude Code does, so later passes never change already-sent bytes.

---

## 4. Tool-result clearing, observation masking and context editing (levels 1–2)

### 4.1 Observation masking (OpenHands, JetBrains)

**Mechanism.** Replace old observations (tool results) with a placeholder and keep the action, its arguments, and the model's reasoning. OpenHands V0 `ObservationMaskingCondenser(attention_window=5)` replaces every `Observation` older than the window with `<MASKED>` ([src @0.50.0](https://raw.githubusercontent.com/All-Hands-AI/OpenHands/0.50.0/openhands/memory/condenser/impl/observation_masking_condenser.py)).

**Measured** ("The Complexity Trap", JetBrains, v1 2025-08-29, v3 2025-10-27) ([paper](https://arxiv.org/html/2508.21433v3)):
- Setup: SWE-agent on SWE-bench Verified (500 instances), 5 model configurations, masking window M=10. LLM-Summary summarized N=21 turns and kept a tail of M=10.
- Masking cut cost 50–57% against the raw agent. Solve rate matched or beat summarization in 4 of 5 configurations. Example: Qwen3-Coder-480B scored 54.8% with masking, 53.8% with summary and 53.4% raw, at $0.61 vs $0.64 vs $1.29 per instance.
- Summarization **lengthened trajectories by 13–15%**. The summary appears to hide failure signals that would otherwise stop the agent.
- Summary calls cost **0.65–7.2%** of total. They rarely hit the cache because "each one processes a unique turn sequence".
- **Hybrid**: mask until N=43 turns, then summarize, passing the *unmasked* context to the summarizer. Result: +2.6 pp solve rate, cost −7% vs masking and −11% vs summary. A naive hybrid (N=21) was *worse* because of KV-cache churn.

### 4.2 Anthropic context editing (server-side)

Beta header `context-management-2025-06-27` ([doc](https://docs.anthropic.com/en/docs/build-with-claude/context-editing)):
- **`clear_tool_uses_20250919`**: defaults are `trigger` 100,000 input tokens, `keep` 3 tool uses, `clear_at_least` none, `exclude_tools` none, `clear_tool_inputs` false. The oldest results are replaced with placeholder text.
- **`clear_thinking_20251015`**: `keep: {type:"thinking_turns", value:N}` or `"all"`. It must come first in `edits`.
- The edits are applied server-side. The client keeps the full history, which is useful for audit and resume.
- Caching: clearing "invalidates cached prompt prefixes". Use `clear_at_least` so that each miss buys a meaningful reduction.
- Memory tool (`memory_20250818`): near the threshold Claude gets a warning to save notes before content is cleared.
- Responses report `context_management.applied_edits`. `count_tokens` returns both before and after counts.

### 4.3 Claude Code microcompact [2nd]

Per [issue #42542](https://github.com/anthropics/claude-code/issues/42542) (v2.1.89+, 2026-04) and [finisky](https://finisky.github.io/en/claude-code-context-compaction/):
- **Time-based microcompact.** If more than ~60 minutes have passed since the last assistant message (so the cache is cold anyway), old results are replaced with `[Old tool result content cleared]` and only the latest thinking is kept. The cache is already lost, so the clearing is free.
- **Cached microcompact.** Count-based. It uses a `cache_edits` API to delete old results from the server-side cache *without* invalidating the prefix. Eligible tools: Bash, Read, Grep, Glob, WebFetch, WebSearch, FileEdit, FileWrite.
- Users complained that clearing was silent ([#42542](https://github.com/anthropics/claude-code/issues/42542)). The lesson is to surface every reduction event in the UI.
- Officially, Claude Code's `/usage` lists "compaction or tool-result clearing" as *expected* cache rebuilds ([doc](https://code.claude.com/docs/en/costs)).

### 4.4 Other harnesses
- **Goose**: summarizes older tool outputs in the background and keeps the last `GOOSE_TOOL_CALL_CUTOFF` calls in full ([doc](https://goose-docs.ai/docs/guides/environment-variables/)).
- **opencode**: used to run a `prune` pass that walked backwards, protected the last `PRUNE_PROTECT=40k` tokens of tool output, pruned only if at least `PRUNE_MINIMUM=20k` was prunable, and wrote `[Old tool result content cleared]` ([2nd gist](https://gist.github.com/sam-saffron-jarvis/2c8a6c26297f5748dac55b597381d268)). **At HEAD `compaction.prune` and `tail_turns` are rejected as "unsupported legacy setting"** ([src normalize.ts:353](https://github.com/sst/opencode/blob/dev/packages/core/src/config/normalize.ts)). Instead, the summarizer's *input* transcript is degraded in levels: whole → outputs clipped to 2,000 chars head and tail → outputs removed → user text only → omitted (`TRANSCRIPT_LEVELS`, [src compaction.ts:144](https://github.com/sst/opencode/blob/dev/packages/core/src/session/compaction.ts)).
- **Cline (basic mode)**: rule-based, no LLM. It drops old tool activity and replaces it with per-span tool-activity summaries, keeps the 3 most recent assistant texts verbatim, and strips old attachments ([src basic-compaction.ts](https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/context/basic-compaction.ts)).
- **Research**: Self-GC treats context as indexed objects with lifecycles ([paper](https://arxiv.org/html/2607.00692v1)). CWL ("Beyond Compaction") uses a typed, dependency-linked episode graph with deterministic, LLM-free eviction that sheds action episodes whose effects already live in the environment. It reports 89 sequential tasks over 80M tokens with no measured degradation ([paper](https://arxiv.org/abs/2606.11213)).

**When it helps.** Coding agents, where most tokens are file reads and command output and the *action plus path* is enough to re-fetch.

**Tradeoffs.** The model may re-read files it already saw, so a few extra tool calls are needed. Each clearing is a cache miss, so batch it. The agent may lose subtle evidence such as an error string. Mitigate with `exclude_tools` and by keeping errors (Manus: "keep the wrong stuff in").

**Pi application (highest-ROI gap).** Pi already has the primitive: append-only `ContextEditEntry {targetId, replacement|null}` ([session-manager.ts:184](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/session-manager.ts:184)), which extensions can emit through `SessionBoundaryDraft`. Today core uses it only to omit failed attempts during overflow recovery ([agent-session.ts:1391](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/agent-session.ts:1391)). Proposal: a built-in **observation-masking stage** that runs before threshold compaction and works as follows.
- Trigger at X% of the window, or when more than K tokens are clearable (amortized, like `clear_at_least`).
- Replace tool-result content outside the last N results with a placeholder that keeps the tool name, args and the spill path, for example `[cleared: read path=src/x.ts lines 1-400; re-read if needed]`.
- Skip results flagged as errors, and skip an `exclude_tools` list.
- Prefer doing it when `isPromptCacheCold()` is true, because the miss is then free, as with Claude Code's time-based microcompact. Pi already computes this in [cache-warmer.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/cache-warmer.ts).
- Price the decision with the existing `economics.ts` model.

---

## 5. Compaction / summarization (level 3)

### 5.1 Pi (vendored) [src]

Files: [compaction.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/compaction/compaction.ts), [utils.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/compaction/utils.ts), [economics.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/compaction/economics.ts), [docs/compaction.md](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/docs/compaction.md).

- **Trigger.** `contextTokens > contextWindow − reserveTokens`, with `reserveTokens = 16384` by default ([compaction.ts:275](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/compaction/compaction.ts:275), [settings-defaults.ts:9](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/settings-defaults.ts:9)). That is about 92% of 200k and **98.4% of 1M**. Per-model overrides exist through `compaction.modelOverrides`.
  - The check runs between turns, after tool results and before the next assistant response (`_compactBeforeNextAssistantResponse`, [agent-session.ts:894](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/agent-session.ts:894)). It also runs before new prompts and as one compact-and-retry recovery on a provider overflow error or an early `stopReason:"length"`.
- **Token counting.** It uses the last assistant `usage` (`totalTokens`, or input+output+cacheRead+cacheWrite) plus a chars/4 estimate for trailing messages (images count as 4,800 chars). The usage is discarded if a later `context_edit` or `compaction` invalidated it ([compaction.ts:204-270](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/compaction/compaction.ts:204)).
- **Cut point.** Walk backwards accumulating `keepRecentTokens = 20000`. Cuts are allowed only at user, assistant, bash or custom messages, never at tool results. If a single user turn is larger than the budget, it is a "split turn" and a separate turn-prefix summary is generated and merged.
- **Summary.** It serializes to `[User]: … [Assistant]: … [Assistant tool calls]: read(path=…) [Tool result]: …`, with tool results truncated to **2,000 chars** and **thinking omitted** ([utils.ts:95,121](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/compaction/utils.ts:121)). The system prompt is "Do NOT continue the conversation".
  - Format: Goal / Constraints & Preferences / Progress (Done, In Progress, Blocked) / Key Decisions / Next Steps / Critical Context, followed by `<read-files>` and `<modified-files>` lists carried *cumulatively* across compactions.
  - On repeated compaction it uses an **iterative update prompt** ("PRESERVE all existing information… move items from In Progress to Done"), anchored at the previous `firstKeptEntryId`.
- **Persistence.** An append-only `CompactionEntry {summary, firstKeptEntryId, tokensBefore, usage, details}`. The raw transcript stays on disk and the projection rebuilds context as system + summary + kept messages.
- **Cache.** Summary requests use `cacheRetention:"none"` ([compaction.ts:638](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/compaction/compaction.ts:638)). The summary call is a *new* prompt (serialized text), so it never reads the session's cache.
- **Economic / cold compaction** (`compaction.economic`, opt-in). Before a run, if the cache has expired (or always, with `warm:true`), Pi compares two costs. It assumes `EXPECTED_REQUESTS = 30` further requests (the 25th percentile of measured sessions). The first cost is carrying the full context for 30 requests, plus rewriting it if cold. The second is one uncached summary read on a cheap model, plus writing keep+summary, plus 30× the smaller context. Pi compacts if the saving is at least `minSaving` ([economics.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/compaction/economics.ts), [agent-session.ts:865](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/agent-session.ts:865)). **I found no other harness that prices compaction this explicitly.**
- **Cache warming** (`cacheWarming:"idle"`, default). It refreshes the cache at 90% of the TTL while expected savings are at least $0.05. It warms for up to 60 minutes while streaming and 30 minutes when idle, assuming an idle continuation probability of 0.15 ([pi-ai cache-warming.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/ai/src/cache-warming.ts)).
- **Extensibility.** `session_before_compact` can cancel or supply its own summary ([custom-compaction.ts example](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/examples/extensions/custom-compaction.ts)). The `context` event can rewrite messages per request. A `/handoff` example extension implements Amp-style handoff ([handoff.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/examples/extensions/handoff.ts)). `/tree` branch summarization summarizes an abandoned branch when you navigate away.

### 5.2 OpenAI Codex CLI [src]

Source: `openai/codex` at 2026-11-12, `codex-rs/core/src/` (`compact.rs`, `compact_remote_v2.rs`, `session/context_window.rs`, `session/async_compaction.rs`, `compact_token_budget.rs`, `tools/handlers/new_context_window.rs`), `codex-rs/prompts/templates/compact/`.

- **Trigger.** `auto_compact_token_limit()` is `min(config_limit, context_window × 9/10)` ([protocol/openai_models.rs:579](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs)). There is a separate hard cap at `effective_context_window_percent`, which defaults to **95%**.
  - Config: `model_auto_compact_token_limit` with scope `Total` or `BodyAfterPrefix` (count only tokens added after the fixed prefix).
  - `model_post_turn_compact_threshold_percent` lets you compact at turn end below the hard limit.
- **Speculative background compaction.** Default **`DEFAULT_ASYNC_COMPACTION_THRESHOLD_PERCENT = 65`**. A background remote compaction request is launched and "polled at checkpoints or awaited when compaction is due". Results are discarded if history changed, and their usage is still charged (`session/async_compaction.rs`). This hides the 30–60 s summarization latency.
- **Local compaction** (for non-OpenAI providers). It appends the user-style prompt `prompt.md` ("You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM…") to the *existing* history, which keeps the prefix cacheable.
  - The new history is built as canonical initial context (re-rendered from current state) + **recent real user messages up to `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`** + the summary prefixed with `summary_prefix.md` ("Another language model started to solve this problem and produced a summary…").
  - Assistant messages and tool calls are dropped. Initial context is inserted just before the last real user message ([compact.rs:651](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs)).
- **Remote compaction v2** (OpenAI provider). It calls the Responses compaction endpoint and keeps the returned encrypted `compaction` item. It retains user messages, hook prompts, client-authored developer messages and some inter-agent messages, all within `RETAINED_MESSAGE_TOKEN_BUDGET = 64_000`, plus explicitly retained tool outputs.
- **Pre/PostCompact hooks** can abort. Manual `/compact` accepts a custom `compact_prompt`.
- **`TokenBudget` feature** (experimental). Compaction becomes "install a fresh context window without summarizing". The model gets `new_context` ("Start a new context window. Does not clear, reset, or otherwise affect environment state.") and `get_context_remaining` tools. This is *model-initiated reset* plus self-monitoring, related to the research in §7.
- **Model training.** GPT-5.1-Codex-Max (2025-11-19) is "the first model natively trained to operate across multiple context windows through compaction" ([doc](https://openai.com/index/gpt-5-1-codex-max/)).

### 5.3 Claude Code [doc + 2nd]

- **Trigger.** The default is the model's limit, except at the 200K boundary for Sonnet/Opus 4.6 without extended context. **Native 1M models compact at ~967K.**
  - `/autocompact <100k..1M>`, the `autoCompactWindow` setting, `--autocompact`, and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (highest precedence) set the window.
  - `idleCompaction` compacts idle sessions before the 1-hour cache expires ([doc](https://code.claude.com/docs/en/model-config), [doc](https://code.claude.com/docs/en/context-window)).
  - Older third-party measurements put the trigger at window − ~33k (about 83.5% of 200K) ([2nd](https://getklyr.ai/blog/claude-code-auto-compact-threshold)). Finisky reports `window − max_output − 13K buffer` ([2nd](https://finisky.github.io/en/claude-code-context-compaction/)).
- **Order.** It "clears older tool outputs first, then summarizes the conversation if needed". It stops after a few attempts with a thrashing error if a single huge output refills the window ([doc](https://code.claude.com/docs/en/how-claude-code-works)).
- **What survives** ([doc](https://code.claude.com/docs/en/context-window)):
  - The system prompt and output style.
  - Root CLAUDE.md, unscoped rules and auto memory, re-read from disk.
  - Rebuilt skill descriptions.
  - A refreshed git status.
  - The plan-mode plan.
  - **Up to 5 recently read or edited files, re-read** (a file over 5K tokens becomes a path reference).
  - Invoked skill bodies (5K per skill, 25K total, truncated from the end).
  - A reminder of background tasks.
  - SessionStart `compact` hooks.
  - Path-scoped rules and nested CLAUDE.md are summarized away and reload on demand.
- **Cache-friendly summary.** "The summary request uses the same system prompt, tools, and history, plus a summarization instruction as a final user message. While the cache is warm, that request reads the prefix from cache." After a TTL gap, `/compact` is the most expensive operation. `/rewind` is cheaper than compaction because it truncates to an already-cached prefix ([doc](https://code.claude.com/docs/en/prompt-caching)).
- **Summary format** [2nd]. An `<analysis>` scratchpad (stripped) followed by a 9-section `<summary>`: Primary Request, Key Technical Concepts, Files and Code Sections, Errors and Fixes, Problem Solving, **All User Messages**, Pending Tasks, Current Work, Optional Next Step. Other reported details:
  - A "NO TOOLS" preamble.
  - A circuit breaker after 3 consecutive failures, motivated by 1,279 sessions with 50+ failures.
  - On prompt-too-long, the oldest API rounds are dropped, up to 3 retries.
  - The summary includes the transcript path so the model can look details up.
  - **Session-memory compact**: a background forked agent maintains a markdown notes file (Current State, Task spec, Files and Functions, Errors & Corrections, Learnings, Worklog…). At compaction the notes *become* the summary with **no LLM call**, keeping a tail of 10K–40K tokens ([finisky](https://finisky.github.io/en/claude-code-context-compaction/), [#42542](https://github.com/anthropics/claude-code/issues/42542)).
- **User controls.** `/compact <focus>`, a "Compact instructions" section in CLAUDE.md, and `/rewind → Summarize from/up to here` ([doc](https://code.claude.com/docs/en/costs)). A third-party test reported the CLAUDE.md section was ignored on auto-compact (0 of 354) ([2nd gist comment](https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f)), which is unverified.

### 5.4 OpenHands [src]

- **V1 SDK** (`software-agent-sdk`, 2026-11-12). `LLMSummarizingCondenser(RollingCondenser)` with `max_size=240` events, an optional `max_tokens` (capped by the agent LLM's input limit), `keep_first=2`, and `minimum_progress=0.1`. Its `hard_context_reset` retries up to 5 times, scaling event strings by 0.8. On trigger it forgets the middle down to `max_size//2` events (or down to `max_tokens//2`) and inserts one summary event that folds the previous summary in.
  - The prompt tracks USER_CONTEXT, TASK_TRACKING (preserve IDs), COMPLETED, PENDING, CURRENT_STATE, CODE_STATE, TESTS, CHANGES, DEPS and VERSION_CONTROL_STATUS (`openhands/sdk/context/condenser/prompts/summarizing_system.j2`).
  - It is a *rolling* window: condensation happens rarely and halves the history, so cache rebuilds are amortized.
- **V0 condensers** (removed at HEAD; read at tag 0.50.0) ([src](https://github.com/All-Hands-AI/OpenHands/tree/0.50.0/openhands/memory/condenser/impl)):
  - `NoOp`.
  - `ObservationMasking(attention_window=5)`.
  - `RecentEvents`.
  - `AmortizedForgetting(max_size=100, keep_first)`: drop the middle to `max_size//2` with no summary.
  - `LLMSummarizing(max_size=100, keep_first=1, max_event_length=10_000)`.
  - `LLMAttention`: the LLM ranks event IDs by importance using a JSON schema.
  - `StructuredSummary`: a function-calling `StateSummary` with fields such as files_modified, tests_passing, branch_name.
  - `BrowserOutput`.
  - `ConversationWindow`.
  - `Pipeline`: chaining condensers.
- **Measured.** The blog (2025-04-09) reports 54% vs 53% solved on a subset, with per-turn cost "less than half" the baseline once condensation kicks in, and cost going from quadratic to linear ([doc](https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents)). But the full-Verified PR #6597 measured 200 vs 203 resolved and **+$40 cost due to lower cache utilization**, while latency stayed flat at 8 s versus 12–16 s for the baseline ([PR](https://github.com/OpenHands/OpenHands/pull/6597)). This illustrates that **summarization saves money only if cache effects are handled**.

### 5.5 opencode [src]

Source: `packages/core/src/session/compaction.ts` (1,274 lines, 2026-11-12).

- **Trigger.** Keep `buffer` free: by default 15% of the window, at least `RESERVE_MIN = 16_000`. That is about 85% of large windows. `keep` defaults to 15,000 tokens of recent conversation kept verbatim.
- **Precompute.** It starts a *background* summary `PRECOMPUTE_LEAD = 60_000` tokens before the ceiling (a summary takes 30–60 s, and growth is p95 above 25k), and only while at least 30 s of the 5-minute cache lifetime remains (`CACHE_MARGIN`). The held summary is swapped in when compaction becomes due if the tail since it is ≤ 40% of the budget. It gives up after 2 failures.
- **Overflow recovery.** `SHRINK_STEPS = [0.85, 0.7, 0.5, 0.35]` of the first rejected size.
- **Native compaction.** If `model.compaction.type === "native"`, it uses the provider's encrypted compaction window (Anthropic or OpenAI) instead of its own summary.
- **Summary template.** Objective / Requirements / Decisions / Work State (Completed, Active, Blocked) / Next Move / **Relevant Files (≤15)** / Important Context.
  - Rules: "Prefer short references over detailed restatement… leave out information the next agent can recover from the code"; "Preserve consequential workflow state (uncommitted/pushed/merged)"; "Leave out instructions … AGENTS.md… The next agent receives current versions separately."
  - The update prompt was rewritten in Sep 2026 (#48058) because the old preserve-everything prompt "carried detail forward indefinitely". **Iterative summaries bloat unless the prompt allows forgetting.**
- **History.** The prune pass (`PRUNE_PROTECT` 40k / `PRUNE_MINIMUM` 20k) was removed.

### 5.6 Cline [src + doc]

- **Modes.** `agentic` (LLM summary, the default), `basic` (rule-based truncation) and `off`.
- **Constants** ([compaction-shared.ts](https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/context/compaction-shared.ts)):
  - `CONTEXT_WINDOW_INPUT_RATIO 0.9` and `COMPACTION_TRIGGER_RATIO 0.9`, giving a trigger at about 81% of the window.
  - `DEFAULT_TARGET_RATIO 0.7` and `DEFAULT_PRESERVE_RECENT_TOKENS 20_000`.
  - `DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS 8_192`, raised from 4,096 because reasoning models spent the budget thinking and returned no summary.
  - Tool-result and file-content clip of 2,000 chars, and file-op tracking that closely mirrors Pi.
- Docs: "Summarization leverages your existing prompt cache… you're primarily paying for summary generation". Checkpoints let you restore pre-summary state ([doc](https://github.com/cline/cline/blob/main/docs/features/auto-compact.mdx)).
- Commands: `/smol` (alias `/compact`) condenses in place. `/newtask` starts a fresh task with distilled context ([doc](https://docs.cline.bot/features/slash-commands/smol)). Focus Chain todo lists survive summarization.

### 5.7 Roo Code [doc]

Intelligent Context Condensing is on by default. The threshold slider defaults to 100%, with per-profile thresholds since 3.21.3. It always uses the active provider and model, because "a different model can degrade summaries when the history contains tool calls". It has a custom CONDENSE prompt and a manual button. On a context-exceeded error it reduces context by 25% and retries. Slash commands in the first message are preserved. 30% of the window is reserved (20% output, 10% buffer) ([doc](https://docs.roocode.com/features/intelligent-context-condensing)).

### 5.8 Aider and Goose

- **Aider** [src]. `ChatSummary` recursively summarizes *done* messages when they exceed `max_chat_history_tokens = min(max(max_input/16, 1024), 8192)` ([models.py](https://github.com/Aider-AI/aider/blob/main/aider/models.py), [history.py](https://github.com/Aider-AI/aider/blob/main/aider/history.py), last change 2025-06-25).
  - It keeps a tail of about half the budget and summarizes the head, recursing up to depth 3.
  - The prompt is written "as the user" ("I asked you…"), with "less detail about older parts and more detail about the most recent".
  - It runs in a **background thread** between turns (`summarize_start`/`summarize_end` in `base_coder.py`).
  - Aider's design keeps chat history tiny because file contents are re-sent fresh each turn from the repo map and added files. **Offloading is the primary strategy and summarization is secondary.**
- **Goose** [doc]. Auto-compact at `min(GOOSE_AUTO_COMPACT_THRESHOLD (0.8) × window, GOOSE_AUTO_COMPACT_TOKEN_LIMIT (225k))`. Strategies: summarize (the Desktop default), truncate, clear and prompt. It also summarizes old tool outputs in the background ([doc](https://goose-docs.ai/docs/guides/sessions/smart-context-management/)).
  - Known bug: it checks only at turn boundaries, so a long tool loop can overflow ([issue #11072](https://github.com/aaif-goose/goose/issues/11072)). **Check between tool calls, as Pi already does.**

### 5.9 Amp: handoff instead of compaction [doc]

On 2025-10-23 Amp "removed compaction … and replaced it with … Handoff" ([doc](https://ampcode.com/news/handoff)). The user states the next goal (`/handoff now implement this for teams`). A secondary model extracts the relevant context and files into a **draft prompt for a new thread** that the user can edit.

Amp's reasons: compaction is lossy in ways the user can't see, and it "encourages long, meandering threads … stacking summary on top of summary". Amp also has fork, edit/restore and thread references. Anthropic's "context reset + structured handoff artifact" is the same idea in an automated harness ([doc](https://www.anthropic.com/research/harness-design-long-running-apps)).

**Pi application.** The `/handoff` example extension already exists. Consider promoting it to core and offering it in the UI at the compaction threshold ("compact" vs "handoff to new session").

---

## 6. Provider-side (server) compaction APIs

| | Anthropic threshold | Anthropic on-demand | OpenAI server-side | OpenAI standalone |
|---|---|---|---|---|
| API | `context_management.edits:[{type:"compact_20260112", trigger:{type:"input_tokens",value}, pause_after_compaction, instructions}]`, beta `compact-2026-01-12` | top-level `compaction:{type:"summarize", instructions}`, beta `compact-2026-09-04` | `context_management:[{type:"compaction", compact_threshold}]` on `/responses` | `POST /responses/compact` |
| Default trigger | 150,000 (min 50,000) | manual | none documented (examples use 200k) | manual |
| Output | `compaction` block (readable `content`) | `compaction` block with `signature`, `stop_reason:"compaction"` | **encrypted** compaction item in the stream | compaction item + retained items (do not prune) |
| Dropping prior content | API drops everything before the block | client removes summarized messages, block first | may drop items before latest compaction item | replace window with output |
| Thinking | pre-block thinking not carried | summarizer reads earlier thinking | reasoning after compaction retained | same |
| Caching | `cache_control` on block, breakpoint at end of system prompt | same | prefix changes, so misses | same |
| Model | same model as request (no cheaper option) | same | same | same |
| Sources | [doc](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold) | [doc](https://docs.anthropic.com/en/docs/build-with-claude/compaction) | [doc](https://developers.openai.com/api/docs/guides/compaction) | [doc](https://developers.openai.com/api/reference/python/resources/responses/methods/compact) |

Notes:
- Anthropic recommends server-side compaction over SDK compaction. The SDK `compaction_control` (default 100k threshold, summary in `<summary>`) is deprecated, and Python removed it in v1.0 ([doc](https://docs.anthropic.com/en/docs/build-with-claude/context-editing)).
- Anthropic usage reports compaction in `usage.iterations`. Top-level token counts exclude it.
- **Tradeoffs.**
  - Pro: server compaction can use model internals (encrypted state, reasoning) and saves an extra round trip.
  - Con: vendor lock-in. The OpenAI item is opaque, so you cannot inspect, edit, port to another model, or render it in the UI. The model cannot be swapped for a cheaper one, and harness extensions such as file lists or custom sections are harder to add.
- **Pi application.** Add an optional "native" path, as opencode does: when the active model supports it and the session is single-model. Keep Pi's portable summary as the default, because Pi routinely switches models and virtual models.

---

## 7. Agent-controlled and learned context management (research)

| Work | Date | Mechanism | Result |
|---|---|---|---|
| **Recursive summarization** (Wang et al.) | 2023-08, v4 2025-08 | memory_t = LLM(memory_{t-1}, new context) | more consistent long dialogue, complements 8K/16K models ([paper](https://arxiv.org/abs/2308.15022)) |
| **MEM1** (MIT/NUS) | 2025-06-18 | RL-trained constant-size internal state. Each turn rewrites the state and discards prior context | 3.5× performance, **3.7× less memory** vs Qwen2.5-14B on 16-objective multi-hop QA ([paper](https://arxiv.org/abs/2506.15841)) |
| **The Complexity Trap** (JetBrains) | 2025-08-29 | masking vs summary vs hybrid | see §4.1 ([paper](https://arxiv.org/abs/2508.21433)) |
| **ACON** (Microsoft) | 2025-10-01 | optimizes natural-language *compression guidelines* from failure analysis (no fine-tuning), then distills the compressor into a small model. Compresses both observations and history | **−26–54% peak tokens** with higher success, up to +46% for small LMs (AppWorld, OfficeBench, multi-objective QA) ([paper](https://arxiv.org/abs/2510.00615), [code](https://github.com/microsoft/acon)) |
| **Context-Folding / FoldGRPO** (Sun et al.) | 2025-10-13 | `branch` / `return(message)` actions: a sub-trajectory is folded to its summary. Trained with RL and process rewards | matches or beats ReAct with **~10× smaller active context**, beats summarization (Deep Research, SWE) ([paper](https://arxiv.org/abs/2510.11967)) |
| **AgentFold** (Alibaba Tongyi) | 2025-10-28 | the agent "folds" history at multiple scales each step (granular condensation or deep consolidation) | 30B-A3B: 36.2% BrowseComp, 47.3% BrowseComp-ZH with SFT only ([paper](https://arxiv.org/abs/2510.24699)). Context stays under ~20k at 500 turns [2nd] |
| **CAT / SWE-Compressor** | 2025-12-26 | context management as a *callable tool*. Three-part workspace (stable task semantics, condensed long-term memory, high-fidelity short-term) | **57.6% SWE-bench Verified** under a bounded context ([paper](https://arxiv.org/abs/2512.22087)) |
| **SWE-Pruner** | 2026-01-23 | goal-conditioned 0.6B line skimmer on tool output | −23–54% tokens at equal success ([paper](https://arxiv.org/abs/2601.16746)) |
| **CWL — Beyond Compaction** | 2026 | typed episode dependency graph, deterministic eviction | 89 tasks / 80M tokens in one session without degradation ([paper](https://arxiv.org/abs/2606.11213)) |
| **ICLR — when can agents forget reasoning** | 2026-09-24 | entropy-ranked dropping of past reasoning blocks, keeping actions and observations | reward 0.699→0.718, −25.5% input, −33.3% cache-read tokens ([paper](https://arxiv.org/abs/2609.29875)) |

Takeaways for a harness:
1. Letting the model decide *when* to compress (at milestones) beats a blind threshold. Codex's `new_context` tool and CAT are the production and research versions of this idea.
2. Sub-task folding (branch/return) is the in-thread analogue of sub-agents.
3. Learned or tuned compression prompts (ACON) beat hand-written ones. That argues for evaluating Pi's summary prompt against agent failures, not by eye.

**Pi application.** Pi's `get_context_remaining` equivalent is cheap: a tool or system note with the remaining budget, like Anthropic's context-awareness `<system_warning>Token usage: …</system_warning>` ([doc](https://platform.claude.com/docs/en/build-with-claude/context-windows)). A `checkpoint`/`fold` tool would let the model request compaction at a milestone, which is a natural cut point.

---

## 8. Thinking / reasoning tokens across turns

- **Anthropic** ([doc](https://platform.claude.com/docs/en/build-with-claude/thinking), [doc](https://platform.claude.com/docs/en/build-with-claude/context-windows)):
  - Within a tool-use turn, thinking blocks (including `redacted_thinking`) **must** be returned unmodified with their `signature`. Modifying them gives a 400 error.
  - *Keep-all* models (Opus 4.5+, Sonnet 4.6+, Haiku 5.5, Fable/Mythos) keep prior-turn thinking in context and bill it as input. Older models strip it automatically.
  - Interleaved thinking between tool calls is automatic with adaptive thinking. Older models need the `interleaved-thinking-2025-05-14` header.
  - `display:"omitted"` returns an empty text with a signature; it reduces latency, not cost.
  - Changing thinking mode, budget or effort invalidates the cache. Dropping thinking blocks changes the prefix.
  - `clear_thinking_20251015` with `keep:"all"` "maximizes cache hits". A small `keep` saves window space at the cost of a miss ([doc](https://docs.anthropic.com/en/docs/build-with-claude/context-editing)).
  - With threshold compaction, thinking before the compaction block is not carried forward.
- **OpenAI** ([doc](https://developers.openai.com/cookbook/examples/responses_api/reasoning_items), [doc](https://developers.openai.com/api/docs/guides/preserved-reasoning)):
  - Reasoning items must be passed back around function calls. With `store:false` or ZDR, use `include:["reasoning.encrypted_content"]`.
  - OpenAI reports about +3% on SWE-bench from including reasoning items (2025-05).
  - Newer models **drop reasoning items that follow any prefix change** (an anti-distillation measure), reported in `input_transformations`. Edits to past history therefore cost both cache *and* reasoning.
  - For custom compaction, put the compacted item at the *end* of the context, or accept that reasoning after it is dropped.
  - Prefer append-only `configuration_update` and `additional_tools` items over changing tools or instructions mid-session.
- **Gemini**: thought signatures must be resent exactly in stateless mode. Stateful mode (`previous_interaction_id`) manages them server-side ([doc](https://ai.google.dev/gemini-api/docs/thinking)).
- **Research**: dropping past reasoning becomes safe once its derived state has been externalized into code, files or tool outputs. It can also alter the later trajectory non-linearly ([paper](https://arxiv.org/abs/2609.29875)).
- **Pi today** [src]:
  - `transform-messages.ts` keeps redacted and signed blocks for the same model, drops thinking from a different model, and drops empty thinking ([transform-messages.ts:128](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/ai/src/api/transform-messages.ts:128)).
  - Responses requests use `store:false` + `include:["reasoning.encrypted_content"]` ([openai-responses.ts:372,409](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/ai/src/api/openai-responses.ts:409)).
  - Compaction omits thinking from the summarizer input.
  - **Gap:** there is no policy knob for clearing old thinking on keep-all Claude models. Prior thinking grows the window silently. Consider exposing `clear_thinking_20251015` or an equivalent client-side `context_edit`, applied only together with another cache-breaking event (compaction or masking), so the miss is paid once.

---

## 9. Prompt-caching interaction

**Rules that matter for compaction**

| | Anthropic | OpenAI | Gemini |
|---|---|---|---|
| Caching mode | explicit `cache_control` (max 4 breakpoints, 20-block lookback) or top-level automatic | automatic prefix | implicit by default (2.5+), explicit for older models |
| TTL | 5 min (1.25× write) or 1 h (2× write). Reads 0.1× (0.05× Opus/Sonnet 5.5, 0.025× Fable/Mythos 5.x). Hits refresh the TTL | GPT-5.6+: 30 min default (1.25× write) or 12 h (2.5×). Older: in-memory 5–10 min up to 1 h, or `24h` | not stated on page |
| Minimum | 512–4,096 tokens by model | 1,024 | 2,048–4,096 |
| Invalidated by | tool defs, `tool_choice`, images, thinking params, dropped thinking, any message edit | any prefix change, tools/effort/verbosity/`context_management`, compaction | prefix change |
| Source | [doc](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | [doc](https://platform.openai.com/docs/guides/prompt-caching) | [doc](https://ai.google.dev/gemini-api/docs/caching) |

**Why compaction breaks the cache.** The cache is a prefix hash. Compaction rewrites history starting right after the system prompt, so everything after the summary must be written again at write price. Masking or clearing old results also rewrites from the first cleared position. Codex's `BodyAfterPrefix` scope and Anthropic's advice to put a breakpoint at the end of the system prompt both keep the *tools + system* layer cached.

**Cache-friendly compaction patterns**
1. **Summarize as a fork of the live prefix.** Send the same system, tools and history, plus a final "summarize" user message, so the summary call reads the cache. This is used by Claude Code (forked agent; it cannot even change `maxOutputTokens` without breaking the cache key, [2nd](https://finisky.github.io/en/claude-code-context-compaction/)), Codex local compaction, Cline and Roo. The cost is that the summary must come from the *same model*.
   - JetBrains' finding that summary calls "rarely hit the cache" applies to the *separate-prompt* design, which Pi uses today.
2. **Amortize.** Clear or condense rarely and in large chunks: OpenHands halves history to `max_size//2`, and Anthropic offers `clear_at_least`. The JetBrains naive hybrid failed exactly because of frequent churn.
3. **Compact when the cache is cold anyway.** Claude Code's time-based microcompact (>60 min) and idle compaction, and Pi's `compaction.economic` `cold` path.
4. **Precompute in the background while the cache is warm.** opencode precompute starts only if at least 30 s of TTL remains. Codex async compaction starts at 65%.
5. **Freeze decisions on already-sent content.** Claude Code freezes persisted-output decisions once seen. OpenAI says to shorten before first send.
6. **Keep the cache warm across idle gaps** when the expected miss cost exceeds the refresh cost. Pi's cache-warmer does this; Claude Code's 1-hour TTL for subscription main conversations is the same idea ([doc](https://code.claude.com/docs/en/prompt-caching)).
7. **Append-only state updates.** Manus: stable prefix, no timestamps, deterministic JSON, mask tools instead of removing them. OpenAI: `configuration_update` items.

**Pi application.**
- Pi's summary call is uncached by design (`cacheRetention:"none"`, serialized transcript). That is optimal when the cache is cold or a cheaper model summarizes, which is the `economic` path.
- When the cache is **warm and the session model summarizes** (threshold compaction mid-run), a fork-style request is much cheaper. Example: 180k cached tokens at 0.1× is about 18k token-equivalents, versus 180k at 1×.
- Proposal: pick the strategy with `economics.ts`, comparing the fork-with-same-model cost against serialize-with-cheap-model, and include the masking stage from §4 in the same model.

---

## 10. Token counting, thresholds, budgets, and 1M windows

**Counting.** Every harness I read uses *provider-reported usage of the last response plus an estimate for anything appended since*: Pi `estimateContextTokens`, Codex `get_total_token_usage`, opencode `Estimate {measured, estimated}`. Estimates use chars/4 (Pi), chars/3 (Cline), or `approx_token_count` (Codex).

Edge cases handled in the code:
- Pi invalidates the measured usage after edits or compaction.
- opencode notes that an encrypted native window "estimates as nothing", so it waits for a real response before measuring.
- Cline caps how far measured usage may scale the char estimate (`MAX_INPUT_UNDERESTIMATE_FACTOR = 4`).
- Anthropic's SDK compaction double-counts server-tool cache reads, measuring 334k when the true value was 63k ([doc](https://docs.anthropic.com/en/docs/build-with-claude/context-editing)).
- Anthropic `count_tokens` reports pre- and post-edit counts.

**Thresholds in the wild**

| Harness | Default trigger | Kept verbatim |
|---|---|---|
| Pi | window − 16,384 | 20k recent tokens |
| Codex | 90% of window (hard cap 95%). Async from 65% | user msgs ≤ 20k (local) / 64k (remote) |
| Claude Code | model limit (≈967K on 1M, 200K boundary on 4.6 non-1M). Older builds: window − ~33k | 5 files, skills, plan, CLAUDE.md, tail 10–40K (session-memory) |
| opencode | 15% free (≥16k). Precompute 60k before | 15k |
| Cline | 0.9 × 0.9 ≈ 81% | 20k |
| Roo | 100% (configurable), 30% reserved | — |
| Goose | min(80%, 225k) | GOOSE_TOOL_CALL_CUTOFF tool calls |
| OpenHands SDK | 240 events or `max_tokens` | first 2 + tail to max_size/2 |
| Aider | done-history > max_input/16 (1k–8k) | ~half budget tail |
| Anthropic API | clear tools at 100k, compact at 150k | 3 tool uses |

Mario Zechner (Pi's author) surveyed harnesses in 2026 and recommended compacting at 85–90%, because "95% is often too late", and pruning tool outputs before full compaction ([2nd gist](https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f)).

**Why trigger earlier than the hard limit**
1. The summarizer needs room for its own input and output. Cline raised the output budget to 8k because reasoning models returned empty summaries.
2. Single steps can grow by 22k at p99 (opencode measurement). Goose overflowed mid tool-loop.
3. Quality degrades well before the limit (§1).
4. Context anxiety: the model knows the window and rushes.

**1M windows.** Opus 4.6+, Sonnet 4.6+ and Haiku 5.5 have 1M windows at standard pricing (except Haiku 5.5 above 100k) ([doc](https://platform.claude.com/docs/en/build-with-claude/context-windows)). OpenAI's Codex-Max line has a 400k window and relies on compaction for "millions of tokens" per task.

A large window helps with fewer compactions (less summary loss), whole-repo reads, and long single-task runs where everything is relevant. It **does not** remove the need to manage context:
- Length alone degrades accuracy (§1).
- Cost grows linearly per request: each request carries the whole context, with cached reads still 0.05–0.1× per token.
- Cache misses at 1M are expensive: 1.25–2× of 1M tokens.
- Users report Claude Code's 1M sessions silently clearing tool results ([#42542](https://github.com/anthropics/claude-code/issues/42542)).
- opencode issue #21208 found its fixed 40k/20k thresholds were tuned for 200k windows.
- Cognition reportedly enabled 1M while capping use at 200k to avoid anxiety [2nd].

Practical guidance: on 1M models, use an **absolute** working budget (for example 200–400k) *or* the economic model, rather than window − 16k. Pi's `modelOverrides.reserveTokens` can express this today, but it is per-model manual config. A default like "min(window − reserve, absoluteCap)", in the same shape as Goose's `min(pct, 225k)`, is more robust.

---

## 11. Comparison table: harness compaction implementations

| Harness | Trigger | Pre-compaction reduction | Summarizer input | Cache-aware summary call | Kept verbatim after | Summary format | Re-injection after | Background | Native API | Manual / alt | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Pi** (vendored) | window − 16,384, between tool turns, pre-prompt, overflow/length retry, `economic` cold/warm | write-time truncate (2000 lines/50KB, bash spill-to-file). `context_edit` used only for recovery omissions | serialized text, tool results ≤ 2,000 chars, no thinking, iterative update of previous summary | no (`cacheRetention:"none"`, new prompt). Cheap model allowed | 20k recent tokens (split-turn aware) | Goal/Constraints/Progress/Decisions/Next/Critical + cumulative read/modified files | system prompt rebuilt (AGENTS.md etc. live in system) | no (cache warming yes) | no | `/compact [instr]`, `/tree` branch summary, `/handoff` example, `session_before_compact` hook | [src](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/compaction/compaction.ts) |
| **Codex CLI** | 90% (cap 95%), post-turn %, scope Total/BodyAfterPrefix | write-time truncation policy (head+tail, token warning) | full history + `prompt.md` appended (local) or Responses compaction (remote) | yes (local appends to live prefix) | user msgs ≤ 20k (local) / ≤ 64k + retained items (remote) | free-form "handoff summary" + `summary_prefix` | canonical initial context re-rendered before last user msg | **yes, from 65%** | **yes** (encrypted) | `/compact`, hooks, `TokenBudget`: `new_context` + `get_context_remaining` tools | [src](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs) |
| **Claude Code** | model limit / `autoCompactWindow` (100k–1M), idle compaction | spill >50K chars to disk [2nd], microcompact (time/count, `cache_edits`) [2nd] | same prefix + instruction (fork) | **yes** | tail 10–40K (session memory) [2nd] | 9 sections incl. all user messages [2nd], or session-memory notes (no LLM call) [2nd] | CLAUDE.md, memory, skills, plan, 5 files, git status, bg tasks | session-memory extraction [2nd] | via API | `/compact <focus>`, `/rewind` summarize, `/clear` | [doc](https://code.claude.com/docs/en/context-window) |
| **OpenHands SDK** | events > 240 or tokens > max_tokens | V0 masking/amortized forgetting (removed in V1) | event strings, previous summary folded | no (separate call). Amortized by halving | first 2 events + tail to half | USER_CONTEXT/TASK_TRACKING/…/VERSION_CONTROL | — | no | no | condensation request | [src](https://github.com/OpenHands/software-agent-sdk) |
| **opencode** | 15% (≥16k) free | transcript levels (clip 2k head/tail → drop outputs → user only) for summarizer input. Old prune removed | transcript text | precompute only while ≥30 s TTL left | 15k recent | Objective/Requirements/Decisions/Work State/Next Move/Relevant Files≤15/Important Context | AGENTS.md etc. sent fresh | **yes** (60k lead) | **yes** ("native") | `/compact` | [src](https://github.com/sst/opencode) |
| **Cline** | ≈81% (0.9×0.9) | basic mode: rule-based tool-activity summaries | serialized, 2k clip, file ops | yes (docs: reuses cache) | 20k recent | summary + files section | Focus Chain todo | no | no | `/smol`=`/compact`, `/newtask`, checkpoints | [src](https://github.com/cline/cline/tree/main/sdk/packages/core/src/extensions/context) |
| **Roo Code** | 100% default slider, per-profile | −25% truncation on overflow error | active model only | yes (same model) | first-message slash cmds | custom CONDENSE prompt | — | no | no | Condense button | [doc](https://docs.roocode.com/features/intelligent-context-condensing) |
| **Goose** | min(80%, 225k) | background tool-output summarization | — | — | last N tool calls | — | — | partial | no | `/compact`, truncate/clear strategies | [doc](https://goose-docs.ai/docs/guides/sessions/smart-context-management/) |
| **Aider** | done-history > max_input/16 | files re-sent fresh, not in history | user/assistant text only | no | ~half-budget tail | first-person "I asked you…" | repo map + added files every turn | **yes** (thread) | no | `/clear` | [src](https://github.com/Aider-AI/aider/blob/main/aider/history.py) |
| **Amp** | none (removed 2025-10) | — | — | — | — | — | — | — | — | `/handoff` (new thread, editable draft), fork, edit/restore | [doc](https://ampcode.com/news/handoff) |
| **Anthropic API** | `compact_20260112` 150k (≥50k), `clear_tool_uses` 100k | tool/thinking clearing | full incl. thinking | breakpoint after system | — | default prompt, `<summary>` | — | n/a | itself | on-demand `summarize` | [doc](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold) |
| **OpenAI API** | `compact_threshold` | — | full | prefix changes | retained items | encrypted | — | n/a | itself | `/responses/compact` | [doc](https://developers.openai.com/api/docs/guides/compaction) |

---

## 12. Recommendations for our Pi-based harness (ranked)

1. **Add a built-in observation-masking stage** using `context_edit`. Batch it with a `clear_at_least`-style minimum and prefer cold-cache moments. Keep the tool name, args and spill path, exempt errors and a configurable tool list, and show every clearing in the UI. Evidence: JetBrains (−50% cost, same solve rate), Anthropic `clear_tool_uses`, Claude Code microcompact.
2. **Make the summary call cache-aware.** When the cache is warm and the session model is used, summarize as a fork of the live prefix (same system and tools, history, plus an instruction). When cold, keep the cheap-model serialized path. Let `economics.ts` choose between them. Evidence: Claude Code and Codex docs and source, OpenHands PR #6597 (+$40 without cache).
3. **Trigger earlier and more robustly.** Use `min(window − reserve, pct × window, absoluteCap)` with defaults near 85% and a cap around 200–400k for 1M models. Keep the between-tool-call check, which Pi already has and Goose lacks. Evidence: context rot, NoLiMa, Zechner survey, Goose and Codex caps.
4. **Run background or speculative compaction** from about 65–75%, adopting it only if history still matches. This hides the 30–60 s latency. Evidence: Codex async compaction, opencode precompute, Aider thread.
5. **Re-inject after compaction**: re-read the N most recently modified files (with a token cap, falling back to a path reference) and the active plan or todo. Reference the transcript path in the summary so the model can `read` exact details. Evidence: Claude Code.
6. **Keep user messages verbatim** (Codex keeps 20k/64k of user messages; Claude Code has an "All User Messages" section). User intent is the most expensive thing to lose and the cheapest to keep.
7. **Allow forgetting in the iterative summary prompt.** opencode #48058 showed preserve-everything update prompts bloat. Pi's update prompt says "PRESERVE all existing information". Measure summary growth across compactions and adopt "newer history takes precedence, prefer references over restatement".
8. **Optional native compaction** (Anthropic `compact_20260112`/`summarize`, OpenAI `context_management`) for single-model sessions, as opencode does.
9. **Expose a context budget to the model** (`get_context_remaining`, or a status note) and a model-callable `checkpoint`/`new_context` tool, so the model can compact at milestones. Evidence: Codex TokenBudget, CAT, Context-Folding. Pair it with the existing `/handoff` for user-directed resets (Amp).
10. **Thinking policy**: make prior-thinking retention on keep-all Claude models configurable, and only clear it together with another cache-breaking event.
11. **Evaluate, don't eyeball.** Set up an ACON-style loop: replay long sessions, compact, and check task completion and re-read counts. Track trajectory elongation after summaries, which JetBrains measured at +13–15%.

---

## Sources

### Local source code (read 2026-11-12)
- Pi: [compaction.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/compaction/compaction.ts), [utils.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/compaction/utils.ts), [economics.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/compaction/economics.ts), [branch-summarization.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/compaction/branch-summarization.ts), [agent-session.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/agent-session.ts:865), [session-manager.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/session-manager.ts:184), [cache-warmer.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/cache-warmer.ts), [pi-ai cache-warming.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/ai/src/cache-warming.ts), [truncate.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/tools/truncate.ts), [bash.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/src/core/tools/bash.ts), [transform-messages.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/ai/src/api/transform-messages.ts), [openai-responses.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/ai/src/api/openai-responses.ts), [docs/compaction.md](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/docs/compaction.md), [docs/settings.md](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/docs/settings.md), [handoff.ts](/Users/user/Developer/Developer/ai/pi-harness/vendor/pi/packages/coding-agent/examples/extensions/handoff.ts)

### GitHub source code
- Codex: https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs · https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_remote_v2.rs · https://github.com/openai/codex/blob/main/codex-rs/core/src/session/context_window.rs · https://github.com/openai/codex/blob/main/codex-rs/core/src/session/async_compaction.rs · https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_token_budget.rs · https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/new_context_window.rs · https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/compact/prompt.md · https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/compact/summary_prefix.md · https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs · https://github.com/openai/codex/blob/main/codex-rs/utils/output-truncation/src/lib.rs
- OpenHands SDK: https://github.com/OpenHands/software-agent-sdk/tree/main/openhands-sdk/openhands/sdk/context/condenser
- OpenHands V0 condensers @0.50.0: https://github.com/All-Hands-AI/OpenHands/tree/0.50.0/openhands/memory/condenser/impl
- OpenHands PRs: https://github.com/OpenHands/OpenHands/pull/6597 · https://github.com/OpenHands/OpenHands/pull/7588
- opencode: https://github.com/sst/opencode (packages/core/src/session/compaction.ts, packages/core/src/config/normalize.ts) · https://github.com/anomalyco/opencode/issues/21208
- Cline: https://github.com/cline/cline/tree/main/sdk/packages/core/src/extensions/context · https://github.com/cline/cline/blob/main/docs/features/auto-compact.mdx · https://github.com/cline/cline/issues/13157
- Aider: https://github.com/Aider-AI/aider/blob/main/aider/history.py · https://github.com/Aider-AI/aider/blob/main/aider/prompts.py · https://github.com/Aider-AI/aider/blob/main/aider/models.py · https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py
- Goose issues: https://github.com/aaif-goose/goose/issues/11072 · https://github.com/aaif-goose/goose/issues/11505
- Claude Code issue: https://github.com/anthropics/claude-code/issues/42542

### Vendor docs and engineering blogs
- Anthropic, Effective context engineering for AI agents (2025-09-29): https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic, Harness design for long-running apps (2026-03-24): https://www.anthropic.com/research/harness-design-long-running-apps
- Anthropic, Context editing: https://docs.anthropic.com/en/docs/build-with-claude/context-editing
- Anthropic, Compaction (on-demand): https://docs.anthropic.com/en/docs/build-with-claude/compaction
- Anthropic, Compaction (threshold): https://platform.claude.com/docs/en/build-with-claude/compaction-threshold
- Anthropic, Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic, Thinking: https://platform.claude.com/docs/en/build-with-claude/thinking
- Anthropic, Extended thinking (legacy): https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- Anthropic, Context windows: https://platform.claude.com/docs/en/build-with-claude/context-windows
- Claude Code docs: https://code.claude.com/docs/en/how-claude-code-works · https://code.claude.com/docs/en/context-window · https://code.claude.com/docs/en/costs · https://code.claude.com/docs/en/model-config · https://code.claude.com/docs/en/prompt-caching
- OpenAI, Compaction guide: https://developers.openai.com/api/docs/guides/compaction
- OpenAI, /responses/compact reference: https://developers.openai.com/api/reference/python/resources/responses/methods/compact
- OpenAI, Preserved reasoning ("Keep the prefix unchanged"): https://developers.openai.com/api/docs/guides/preserved-reasoning
- OpenAI, Reasoning items cookbook (2025-05-11): https://developers.openai.com/cookbook/examples/responses_api/reasoning_items
- OpenAI, Prompt caching: https://platform.openai.com/docs/guides/prompt-caching
- OpenAI, GPT-5.1-Codex-Max (2025-11-19): https://openai.com/index/gpt-5-1-codex-max/ · https://openai.com/index/gpt-5-1-codex-max-system-card/
- Google, Gemini caching: https://ai.google.dev/gemini-api/docs/caching · Thinking/signatures: https://ai.google.dev/gemini-api/docs/thinking
- Manus, Context Engineering lessons (2025-07-18): https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Amp, Handoff (2025-10-23): https://ampcode.com/news/handoff
- OpenHands, Context condensation blog (2025-04-09): https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents · SDK docs: https://docs.openhands.dev/sdk/guides/context-condenser
- Cline docs: https://docs.cline.bot/features/slash-commands/smol · https://cline.bot/blog/how-to-think-about-context-engineering-in-cline
- Roo Code docs: https://docs.roocode.com/features/intelligent-context-condensing
- Goose docs: https://goose-docs.ai/docs/guides/sessions/smart-context-management/ · https://goose-docs.ai/docs/guides/environment-variables/
- Cognition, Rebuilding Devin for Sonnet 4.5 (2025-09-29): https://cognition.com/blog/devin-sonnet-4-5-lessons-and-challenges
- Chroma, Context Rot (2025-07-14): https://research.trychroma.com/context-rot
- Lance Martin, Context Engineering for Agents (2025-06-23): https://rlancemartin.github.io/2025/06/23/context_engineering/

### Papers
- Lindenbauer et al., The Complexity Trap (2025-08-29, v3 2025-10-27): https://arxiv.org/abs/2508.21433 · https://arxiv.org/html/2508.21433v3
- Kang et al., ACON (2025-10-01): https://arxiv.org/abs/2510.00615
- Zhou et al., MEM1 (2025-06-18): https://arxiv.org/abs/2506.15841
- Sun et al., Context-Folding / FoldGRPO (2025-10-13): https://arxiv.org/abs/2510.11967
- Ye et al., AgentFold (2025-10-28): https://arxiv.org/abs/2510.24699
- Liu et al., Context as a Tool / SWE-Compressor (2025-12-26): https://arxiv.org/abs/2512.22087
- Wang et al., Recursively Summarizing (2023-08-29, v4 2025-08-25): https://arxiv.org/abs/2308.15022
- SWE-Pruner (2026-01-23): https://arxiv.org/abs/2601.16746
- Squeez (2026): https://arxiv.org/html/2604.04979
- Self-GC (2026): https://arxiv.org/html/2607.00692v1
- Semenov & Dorofeev, Beyond Compaction / CWL (2026): https://arxiv.org/abs/2606.11213
- Wang et al., When Can Agents Forget Their Reasoning? (2026-09-24): https://arxiv.org/abs/2609.29875
- Du et al., Context Length Alone Hurts (2025-10-06): https://arxiv.org/abs/2510.05381
- Modarressi et al., NoLiMa (2025-02-07): https://arxiv.org/abs/2502.05167v2
- OpenHands SDK paper (2025-11): https://arxiv.org/html/2511.03690v1

### Secondary analyses (unverified; used only where marked [2nd])
- Finisky, Claude Code five-layer cascade (2026-04-05): https://finisky.github.io/en/claude-code-context-compaction/
- Mario Zechner (badlogic), Context compaction research gist: https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f
- opencode compaction deep dive gist: https://gist.github.com/sam-saffron-jarvis/2c8a6c26297f5748dac55b597381d268
- Claude Code auto-compact threshold write-up: https://getklyr.ai/blog/claude-code-auto-compact-threshold
- AgentFold summary: https://bhakthan.substack.com/p/agentfold-long-horizon-web-agents
