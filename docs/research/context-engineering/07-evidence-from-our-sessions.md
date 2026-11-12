# 07: Which candidates our own sessions support

Analysed 2026-11-12. Reports 01–06 list what the field does. This report checks each candidate for this harness against **our own sessions**, measuring how much it would change cost or quality. Everything here can be reproduced with three scripts:

```sh
node scripts/evidence/classify-messages.ts   # LLM labels for every human follow-up (cached)
node scripts/evidence/cluster-rules.ts       # recurring working rules vs prompt/AGENTS.md + base.md
node scripts/evidence/analyze.ts             # every table below, as Markdown
```

## Data

- **Source:** `~/.pi/agent/metrics.db`, which holds Pi sessions and Claude Code transcripts imported by `extensions/metrics/claude.ts`. Sessions on unpriced gateway models are excluded.
- **Size:** 1,616 sessions (1,572 Claude Code, 44 Pi), 219,434 requests, $21,034 at list prices, 2 Oct – 12 Nov 2026. Tool results held in context cost $3,244 in cache reads.
- **Why Claude Code counts:** it is the same user, on the same projects and the same models (Opus/Sonnet 5.5, 1M window). It is the workload Pi is replacing. Pi-only figures cover one day and are marked as such.
- **Quality signal:** the 2,779 human follow-up and steer messages, labelled by Sonnet 5.5. Machine-written messages are excluded (task notifications, delegated-task results, interrupt markers). The labels are correction, forgot_context, process, quality, failure_report, new_task, question, answer, approval and other.
  - The first five together form the **negative** label: the agent fell short.
  - Hand check of 8 random messages per label: failure_report 8/8 correct, correction 7/8, process about 6/8, forgot_context about 3/8. The classifier sees only the user's message, not what the agent did before it, so it cannot tell when something was forgotten.
  - Only the combined negative rate is used for decisions. forgot_context is reported but not relied on.
- **What the data cannot show:** these are observational comparisons, not randomised ones. Where a confounder is obvious (how far into the session a message is), the tables split by it. Final decisions need the A/B framework (`extensions/lib/experiments.ts`).

## Results

### 1. Large contexts are where the money goes

| context at request | requests | spend | share |
|---|---|---|---|
| <50k | 23,637 | $612 | 2.9% |
| 50–100k | 20,611 | $957 | 4.6% |
| 100–200k | 43,920 | $2,966 | 14.1% |
| 200–400k | 65,924 | $6,503 | 30.9% |
| ≥400k | 65,342 | $9,996 | **47.5%** |

78% of all spend comes from requests with more than 200k tokens of context. Today nothing compacts until the context nears the 1M window: Claude Code compacts at about 967k, and Pi at `window − 16384`.

### 2. Quality barely changes with context size

| context when the user replied | labelled | negative (95% CI) | failure_report | tool error rate |
|---|---|---|---|---|
| <50k | 532 | 26.5% (22.9–30.4) | 6.8% | 4.0% |
| 50–100k | 219 | 26.0% (20.7–32.2) | 6.4% | 3.2% |
| 100–200k | 402 | 29.9% (25.6–34.5) | 8.0% | 2.4% |
| 200–400k | 554 | 31.2% (27.5–35.2) | 6.1% | 1.7% |
| ≥400k | 1007 | 29.7% (27.0–32.6) | 6.6% | 1.6% |

- **Across all sessions:** the negative rate rises about 3–5 points from below 100k to above 200k, and the confidence intervals overlap. Split by how far into the session a message is, the pattern is not consistent.
- **Within the same session:** 72 sessions have replies both below 100k and at 400k or more. Their mean negative rate is 17.7% below 100k and 26.7% at 400k+. It is higher at 400k+ in 35 sessions and lower in 21. That is a sign test p = 0.08: suggestive, not significant.
- **Tool errors fall as context grows.** The likely reason is that the environment is set up by then, not that long context helps.

On our data, context rot (report 01) is at most a small effect on quality. **The case for keeping contexts small rests on cost, with quality as a possible bonus.**

### 3. What real compactions did (243 in Claude Code)

- **Complaints:** the negative rate of the user's next 3 replies was 28.8% (24.8–33.3, n=430), against 30.2% (26.2–34.5, n=477) for the 3 before. No detectable harm.
- **Re-reading:** returns to an already-touched file rose from 46.7% to 53.0% of the next 30 file accesses (198 compactions). That is a real but small cost: about 2 extra file touches per compaction. It happens even though Claude Code re-attaches recently read files after compacting.

### 4. Compacting earlier: simulated net saving

Each simulated session compacts whenever its context passes the cap. Context then grows from the post-compaction size exactly as it did in reality. Each compaction is costed as:

- a summary request that reads the cached context;
- an 8k-token summary at the output price;
- writing the post-compaction context to the cache.

| compact above | context after 40k | after 80k | after 120k |
|---|---|---|---|
| 150k | +33.9% | +23.5% | −3.7% |
| 200k | +32.4% | +26.2% | +17.2% |
| **300k** | **+27.5%** | **+23.8%** | **+20.0%** |
| 400k | +22.2% | +19.7% | +17.0% |

(Net saving as a share of all spend. 300k means about 1,200–1,400 simulated compactions over 6 weeks.)

Not priced here: the re-reads from §3 (cents per compaction), and any quality loss, which §3 suggests is small. Pi already has the mechanism: `compaction.economic` with `warm: true` compacts a warm context when that pays off over the next 30 requests. With `minSaving: 1` and Opus 5.5 prices, it would trigger at about 106k tokens. That threshold is more aggressive than the data supports, and the summary would come from Haiku. Your settings leave `warm` off, so economic compaction currently fires only when the cache is cold.

### 5. Masking old tool results loses money once caching is priced

| keep newest | batch | maskings | carry saved | cache rewrites | re-read penalty | net |
|---|---|---|---|---|---|---|
| 20k | 20k | 4,832 | $2,132 | $7,566 | $361 | **−$5,795** |
| 50k (Gemini CLI) | 30k | 2,005 | $1,270 | $4,038 | $228 | **−$2,996** |
| 100k | 50k | 468 | $425 | $1,359 | $90 | **−$1,024** |

- **Why it loses:** masking rewrites the cached prompt. A cache write costs 12.5–20× a cache read on Anthropic, so a masked result has to stay out of context for many more requests than it actually does to pay for that rewrite.
- **The rewrite cost is an upper bound,** since the simulation re-writes the whole prompt. The masked results are the oldest ones, though, so the rewrite starts early and nearly all of the prompt is re-written anyway.
- **This contradicts the JetBrains claim** of "−50% cost" (report 02). That paper priced its Qwen runs *"without distinguishing cache hit and miss input tokens… an inflated cost"* ([arXiv 2508.21433, App. A](https://arxiv.org/html/2508.21433v3)).
- **Verdict:** do not build masking as a separate layer for cost. Masking is free only when the cache is lost anyway: at compaction, or when the cache has expired. Pi already compacts in exactly those cases.

### 6. Spilling large tool outputs to files is worth little

| spill above | results | their carry | net saving (pessimistic re-read) |
|---|---|---|---|
| 5k tokens | 3,649 | $516 | $180 (0.9%) |
| 10k tokens | 446 | $109 | $77 |
| 20k tokens | 34 | $15 | $12 |

The average Bash result is 604 tokens. Pi already caps bash output at 50 KB / 2,000 lines and writes the full output to a file. **Not worth more work.**

### 7. Checking before ending a turn shows no link to user-reported failures

| agent turn before the reply | labelled replies | negative | failure_report |
|---|---|---|---|
| changed no files | 1,361 | 29.8% (27.5–32.3) | 6.5% (5.3–8.0) |
| changed files, ran a check after the last change | 285 | 34.0% (28.8–39.7) | 6.3% (4.0–9.8) |
| changed files, no check after the last change | 1,068 | 26.9% (24.3–29.6) | 7.0% (5.6–8.7) |

- 79% of turns that change files end without a check after the last change. Yet the user does not report more failures after those turns.
- The comparison is confounded, because agents check harder tasks more. Failures found later, not in the next reply, are invisible to it.
- **No observational support.** The randomised `fix-loop` / `workflow` experiment is the right test; let it run before building more verification.

### 8. Fixed context costs are small (Pi, one day)

| part | share of Pi spend |
|---|---|
| tool results | 34.8% |
| model output | 21.2% |
| **thinking blocks carried in history** | **20.7%** (all cache reads and writes) |
| skills listing | 2.7% |
| tool definitions | 1.3% |
| system prompt + project context | about 2% |

- **Tool search and skill-listing budgets are not worth building:** together they could save at most about 4%.
- **Old thinking blocks are a fifth of Pi spend.** Newer Claude models keep them in history. Dropping them breaks the cache, so as with masking, drop them only when the cache is lost anyway. One day of Pi data is a thin sample; re-check once Pi has more history.
- **Cache-loss events cost $18.70 (5.6% of Pi spend) in that one day.** Of that, $6.63 came from "prompt or tools updated mid-conversation" and $6.92 from "cache missed without a prompt change". Both are worth a diagnosis because tool-switching experiments are running.

### 9. Exploration in the main context

- **What it costs:** results that changed nothing cost $2,807 in cache reads: non-writing shell commands $2,235, read-only tools $572. That is 13% of spend, and only an upper bound for what read-only scout subagents could save.
- **Why the bound is loose:** it overlaps with the compaction saving, and subagents spend their own tokens.
- **Existing use:** subagents already run heavily (514 subagent transcripts).
- **Verdict:** no case for more subagents on cost grounds.

### 10. Rules the user repeats

The classifier pulled 650 working rules out of user messages, which cluster into 238 rules. **108 rules recur in 2 or more sessions, across 517 messages.** Each rule was checked against what the agent loads every session (`prompt/AGENTS.md`, `prompt/base.md`):

| already in the instructions | partly | missing |
|---|---|---|
| 95 messages | 91 | 331 |

The most repeated:

| rule | sessions | days | in instructions |
|---|---|---|---|
| Never end a turn waiting on background runs; wait in the foreground and finish in the same turn. | 22 | 10 | partly |
| Do not use subagents unless explicitly asked. | 12 | 5 | no |
| Keep code DRY with shared reusable components. | 12 | 7 | yes |
| Propose options with tradeoffs and a plan before implementing. | 11 | 8 | yes |
| Do not idly wait on long-running processes. | 11 | 6 | yes |
| Limit memory use: run heavy jobs sequentially with bounded parallelism. | 11 | 6 | no |
| Resume existing subagents with a warm cache instead of spawning new ones. | 10 | 6 | no |
| Agents must not run full test suites; the coordinator runs them. | 10 | 4 | no |
| Keep working until verified; do not stop early. | 9 | 5 | yes |
| Do not ask again once authorised. | 9 | 7 | yes |
| When asked only to propose, wait for approval without changing anything. | 8 | 3 | no |
| Use Sonnet 5.5 for subagents / use Opus for subagents / use Haiku for probes | 7 / 5 / 4 | | no (they conflict) |

What this means:

- **Rules missing from the instructions (331 messages)** are what memory and dreaming are for. Many are project- or situation-specific, so they belong in that project's `AGENTS.md`, not the global file. Some conflict, like the three subagent-model rules, which is why report 05 calls for delta edits with a person reviewing them rather than automatic appends.
- **Rules already in the instructions but repeated anyway (95 + 91 messages)** are failures to follow instructions. A better memory won't fix those.
  - The top one, ending a turn while background work runs, shows up in 22 sessions over 10 days. It can be detected mechanically at turn end: the final message says it is waiting, and there are live background jobs or watchers. A turn-end hook can send the agent back to work. That is cheaper and more reliable than more prompt text.
- **Caveat:** "covered" is judged against today's instructions. Some rules may have been added *because* of these complaints, so the 95 counts violations only for the time after a rule existed.

## Decision table

| candidate (reports 01–06) | evidence here | decision |
|---|---|---|
| Compact earlier (cap ~300k, or `economic.warm` with a minimum size) | 78% of spend above 200k; +20–28% simulated net saving; no measurable quality harm from real compactions | **Build as a setting-variant A/B experiment** (planned in `experiments.ts`, not built yet) |
| Turn-end guard against "ending while waiting on background work" | the most repeated correction: 22 sessions, 10 days, despite instructions | **Build** (a turn-end hook) |
| Dreaming: write recurring corrections into project/global AGENTS.md as reviewed deltas | 331 repeated messages for rules not in the instructions; conflicting rules exist | **Build** (already planned; the data supplies its first input) |
| Recurrence metric (same rule cluster again after it was written down) | the clustering pipeline exists now | **Build** alongside dreaming |
| Drop old thinking blocks and stale tool results when the cache is lost anyway | thinking 21% of Pi spend; masking free only then | **Investigate** once Pi has more than one day of data |
| Diagnose Pi cache-loss events | 5.6% of one day's Pi spend | **Investigate** (small) |
| Verify-at-stop loop | no observational link | **Wait** for the `fix-loop` / `workflow` experiment |
| Masking old tool results as a separate layer | −5% to −27% net under cache pricing | **Do not build** |
| Spilling large outputs | ≤0.9% | **Do not build** (already capped) |
| Tool search by default, skill-listing budget | ≤4% of spend combined | **Do not build** |
| More scout subagents | ≤13% upper bound, overlaps compaction, heavy use already | **Do not build** for cost |
| Lazy nested AGENTS.md, repo map, LSP, per-model edit formats, loop detection | not measurable from this data | no evidence either way; needs an experiment |

## Threats to validity

- **Prices:** spend is at list prices from the model catalogue, not what the gateway bills. Ratios between the options do not depend on this.
- **Simulation assumptions:**
  - The compaction simulation assumes the session's later growth does not depend on the summary.
  - The masking simulation charges a full prompt rewrite per masking, an upper bound that is close to real because the oldest results are masked.
  - The re-read penalties assume the worst case.
- **Classifier:** a single Sonnet pass sees only the user's message. Negative vs non-negative is reliable on the hand check. Individual labels are less reliable, forgot_context especially.
- **Pi data:** the Pi-only figures come from one day of sessions.
