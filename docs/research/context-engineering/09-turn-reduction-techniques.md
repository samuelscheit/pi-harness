# 09: Reducing the number of turns per agent task: techniques and evidence

Researched 2026-11-21. Scope: web only. [10](10-turns-in-our-sessions.md) measures the same questions on our own sessions and ranks what to do; where the two disagree, 10 wins. Builds on `03-selection-retrieval-tools-skills.md` §2.4 (code mode, PTC token numbers), `04-flows-loops-multi-agent.md` §2.3 (ReWOO/LLMCompiler basics) and the subagent material; those are referenced, not repeated.

Evidence labels: **[M]** measured in a paper or by an independent party; **[V]** vendor claim or vendor-run benchmark; **[A]** anecdote or secondary source. Every number has its URL in the Sources list.

## TL;DR

- Cost per task is roughly turns × context. The 2026 harness study "What Does a Harness Buy? Tokens, Mostly." found that harnesses with similar pass rates (within ~2 points) differ up to 3× in cost, driven by fixed preamble size (16.6k tokens Claude Code, 7k OpenCode, 0.8k mini-SWE-agent) times step count. Lowering steps and lowering preamble are equally strong levers. [M, Oct 2026]
- The strongest direct turn-cutting technique with a real number is **script/programmatic tool calling**. Factory Script mode: the same 15 tool calls took 5 model calls instead of 10 (56.8 s → 41.6 s), and −15% cost on Opus 5.5. Anthropic PTC: −37% tokens, "19+ inference passes" removed for 20 calls. Both are vendor-run [V]. Our `tool` CLI inside bash and `workflow` are the same idea.
- **Parallel tool calls** are a free win in principle, but whether models use them is another matter. In our sessions 95% of tool turns make one call, despite a batching rule ([10](10-turns-in-our-sessions.md) §2). Anthropic says Claude 4+ parallelizes by default and a system-prompt nudge raises it to "about 100%", but publishes no measurement. The only independent log we found (one developer, one setup) had 14% of tool-use turns with 2+ calls. [V/A]
- **Plan-then-execute (LLMCompiler)** gives up to 3.7× latency and 6.7× cost against ReAct on parallel-friendly QA tasks. It is worse than ReAct on WebShop-style sequential tasks (10.7 s vs 6.0 s). It is not shown to transfer to coding, where each step depends on the last observation. [M, 2023]
- **CodeAct**: up to 30% fewer actions and up to 20% higher success; on M³ToolEval GPT-4-1106 needed 5.5 turns vs 7.7 for text actions (82 tasks, 2024). Gains shrink or reverse for weak models. [M]
- **Failed edits are a large, measurable turn sink.** SWE-agent: 51.7% of trajectories had ≥1 failed edit; the chance an edit eventually succeeds drops from 90.5% to 57.2% after one failure; linting on edit is worth +3 points resolve rate. [M, 2024] Edit format matters a lot for weaker models (Aider: 20% → 61% for GPT-4 Turbo), much less for current frontier models (91–98% well-formed on Aider's polyglot).
- **Avoidable work is concentrated in three behaviours**: re-reading code already retrieved, regenerating near-duplicate scripts, and re-running tests with no code change. They hit 79–98% of SWE-bench tasks and account for up to 22.75% of cost (Claude Code and mini-SWE-agent). Plain prompt guidance ("reuse context, rerun tests only on new evidence") cut cost 8–42% in 6 of 8 settings with pass@1 within noise. This is the cheapest evidence-backed intervention for us. [M, Sep 2026]
- **Fast parallel exploration subagents** are the best-documented exploration-turn cut: SWE-grep does retrieval in 4 turns × up to 8 parallel calls vs 10–20 serial turns, and 4 → 8 parallelism cut search turns from 6 to 4 at equal quality. Requires RL training; main-agent prompts cannot copy it. [V, Oct 2025]
- **Budget awareness helps**: a plain budget tracker in context improved accuracy by 1–3 points at equal budget, and at budget 10 matched budget-100 ReAct accuracy with −31% cost (web-search agents, Gemini 2.5 Pro). Hard turn caps alone do not: agents without awareness "hit a performance ceiling" and extra budget is wasted. [M, Nov 2025]
- **Overthinking is the opposite failure**: acting on assumptions without observing (rogue actions) or stalling in reasoning. Picking the lower-overthinking sample gave 27.3% at $800 vs 29.1% at $1,400 for high effort (o1, SWE-bench Verified). Failed trajectories are longer (SWE-agent +18.5%, OpenHands +82.5%). Step limits double as a failure detector. [M]
- **No controlled study isolates LSP-diagnostics-in-edit-result or prefetching/repo-maps on turn count.** Both are design arguments only. Do not claim numbers for them; measure.
- Parallelism is not free: a 2,124-execution study of parallel subagents in Codex, Claude Code and Kimi Code found shell calls went up under concurrency, often several-fold, without guaranteed lower latency. [M, Oct 2026]

## 1. Parallel tool calling

**Mechanism.** One assistant message carries several independent tool calls; all results come back in one user message. N dependent-free calls cost 1 request instead of N, and the request count is what re-reads the context.

**Anthropic.** Claude 4 and later parallelize by default when a request benefits; `disable_parallel_tool_use: true` sits inside `tool_choice` and forces at most one call (zero or one with `auto`; exactly one with `any`/`tool`). The docs give a `<use_parallel_tool_calls>` system-prompt block "for even stronger parallel tool use (recommended if the default isn't sufficient)": "For maximum efficiency, whenever you perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially… Err on the side of maximizing parallel tool calls". They suggest a counter-nudge, "Only batch tool calls that are independent of each other", if dependent calls get batched. They ship a snippet that averages tool calls per message and say it "should be > 1.0 if parallel calls are working". The prompting best-practices page says the model has a high parallel success rate without prompting and that prompting can raise it to "about 100 percent". No methodology or measurement is published. [V; platform.claude.com parallel-tool-use and prompting-best-practices, undated, fetched Nov 2026]

**Measured rate.** The only measurement found is one developer's logs: 611 of 4,310 tool-use turns (14.2%) had 2+ `tool_use` blocks; the same post reports parallel results causing agent-loop crashes on 388 of 1,200 runs (a harness bug in result pairing, not a model problem). [A; dev.to, ~Oct 2026]

**OpenAI.** `parallel_tool_calls` (June 2024) defaults on; `false` guarantees zero or one call. GPT-5 and later can run functions in parallel but built-in tools cannot join a parallel batch. Prompting guides diverge: the GPT-5 guide's appendix says at most one tool call at a time; GPT-5.1 says "Parallelize tool calls whenever possible" and batch reads and edits; GPT-5.2 asks for explicit parallelism when scanning codebases; the Codex guide tells the model to use `multi_tool_use.parallel`. No official latency or turn numbers. [V; developers.openai.com function-calling and cookbook guides, 2025–2026]

**LLMCompiler numbers for OpenAI parallel calls** (GPT, 2023): vs ReAct†, OpenAI parallel function calling gave 1.61× (HotpotQA), 2.76× (Movie Rec.), 1.86× (ParallelQA) latency speedups and 1.8–3.3× cost reductions, i.e. most of the gain of a full compiler comes from plain parallel calling. [M; arXiv 2312.04511]

**Risks.** Parallel calls can hit ordering dependencies (write-then-compile); parallel batches in one `bash` are the same hazard. Parallel subagents raise total tool calls (below).

**Fit for us.** Already done. Remaining: (a) log the ratio of tool calls to model requests per session in Pi to see whether our models sit near 1.0 and whether the nudge text from Anthropic (or the OpenAI 5.1/5.2 wording) moves it; (b) treat as an A/B test per model, since GPT-5's own guide pushes the other way.

## 2. Programmatic tool calling, code mode, CodeAct, smolagents

**Mechanism.** The model writes one program that calls several tools, loops, filters and branches; only the final output re-enters context. Turns fall from "one per call" to "one per program".

**Evidence.**

- **CodeAct (ICML 2024):** "up to a 20% absolute improvement… while requiring up to 30% fewer actions" across 17 LLMs. On M³ToolEval (82 tasks, max 10 turns): gpt-4-1106 74.4% success and 5.5 avg turns with code vs 52.4% / 7.6 (JSON) and 53.7% / 7.7 (text); claude-2 54.9% / 7.2 vs 39.0% / 8.3; gpt-3.5-0613 51.2% / 7.0 vs 26.8% / 8.8. Weak or small open models show no gain (turns ~9.7–10 in every format), and claude-instant-1 and lemur-70b did worse with code. The "30%" is an upper bound; typical frontier gain is about 1–2.2 turns of ~8. Early-2024 models, not coding-agent tasks. [M; arXiv 2402.01030]
- **smolagents** docs repeat the CodeAct rationale (composability, object management, generality, training-data fit) and cite the papers but give no step numbers of their own. [V; huggingface.co/docs/smolagents]
- **Anthropic programmatic tool calling** (Nov 24 2025): average tokens 43,588 → 27,297 (−37%); internal knowledge retrieval 25.6% → 28.5%; GIA 46.5% → 51.2%; "eliminates 19+ inference passes" for 20+ calls; no latency measurement. Tool Search Tool: ~77K → ~8.7K tokens of tool definitions (−85%); MCP-eval accuracy Opus 4 49% → 74%, Opus 4.5 79.5% → 88.1%. Internal tests, not independently verified. Already summarised in doc 03 §2.4. [V]
- **Cloudflare Code Mode** (Sep 26 2025): argues "LLMs are better at writing code to call MCP, than at calling MCP directly" and that it "shines when an agent needs to string together multiple calls". The post has no benchmark numbers. The numeric claims (−98.7%, −99.9% tokens) are in doc 03 and measure tool-definition tokens, not turns. [V]
- **Factory Droid 1.0 Script mode** (Oct 29 2026; modified Nov 20): replay of fixing a failing unit test with GPT-6.1 Sol: direct = 10 model calls / 15 tool calls / 56.8 s (42.3 s in model calls); script = 5 model calls / same 15 tool calls / 41.6 s (28.0 s). Opus 5.5: Script mode cuts cost 15% vs direct. Bulk examples: 312 tool calls over 151 Linear issues would be 36 requests and ~3.1M input tokens direct (at 10 calls per request) vs 2 requests and ~61k tokens as a script; a 550-call CI sweep in 2 requests vs an estimated 59–187. Those bulk numbers are estimates for the direct case, not measured runs. Droid's headline Terminal-Bench numbers (Droid 65.2% vs Claude Code 57.6% on Opus 5.5; 17% fewer tokens; 26% less time per passed task) are vendor-run, three trials per task, and cannot be attributed to Script mode alone. [V; factory.com/news/frontier-harness]
- **Tradeoffs (all sources):** needs sandbox and good tool typings; debugging is harder; poor fit when the model must reason over each intermediate result. The unit-test example shows the saving is about 2× in requests for ordinary coding work, not 10×: dependent steps (read → patch → test) remain.

**Fit for us.** `tool <name>` in bash plus `workflow` already provide this. The open question is adoption: how often does the model batch read+edit+test in one bash command or script versus separate turns? Measure that on our sessions (compare with doc 07). Factory's design is worth copying in one respect: it makes the script the default path for multi-call work and returns a compact summary, rather than offering it as an option.

## 3. Plan-then-execute

**Mechanism.** Produce the whole plan (a DAG with variables) first, execute independent steps in parallel without re-calling the model, call the model again only to join or replan.

**Evidence.**

- **LLMCompiler** (ICML 2024), vs ReAct with anti-looping prompt (ReAct†), GPT: HotpotQA 3.95 s vs 7.12 s (1.80×), Movie Rec. 5.47 s vs 20.47 s (3.74×), ParallelQA 16.69 s vs 35.90 s (2.15×), accuracy equal or +5 points. Cost per 1k: HotpotQA $1.47 vs $5.00, Movie Rec. $3.04 vs $20.46 (6.7×), ParallelQA $103 vs $480 (4.65×); input tokens 20,000 → 2,800 on Movie Rec. Savings come from fewer LLM invocations and shorter prompts (plans contain no observations). Limits: bounded by number of parallel tasks N; planner plus final answer (3.5 s) are not parallelizable; WebShop was slower than ReAct (10.72 s vs 5.98 s with gpt-3.5; 26.73 vs 19.90 s with gpt-4) because of planner overhead; plain ReAct looped so badly its latency was unmeasurable. [M; arXiv 2312.04511]
- **ReWOO** (2023, in doc 04 §2.3): ~5× fewer tokens on HotpotQA (1,986 vs 9,795), accuracy 42.4% vs 40.8%, cannot react to surprises. [M]
- **Plan-and-Act** (Mar 2025): planner/executor split with synthetic plan data; 57.58% WebArena-Lite, 81.36% WebVoyager, reported as SOTA at the time. The abstract states no turn or cost comparison. [M, accuracy only; arXiv 2503.09572]

**Fit and risk for coding.** Exploration and verification phases (read N files, grep M patterns, run lint+typecheck+tests) are DAG-shaped and map to parallel calls or one script. Edit phases depend on observations. LLMCompiler's own sequential-bridge result (26.3% vs 22.7%, 1.37× faster) works only with replanning. We have no coding-agent measurement of plan-first; the nearest practical form is Factory/Anthropic-style scripts. Do not add a planner stage purely to save turns.

## 4. Edit formats and turn waste

**Mechanism.** A failed or ambiguous edit costs at least one turn (error, then retry), often more because the model must re-read the file. Fewer/larger-scoped edits per turn cut turns too.

**Evidence.**

- **SWE-agent (2024, GPT-4 Turbo):** 1,185 of 2,294 trajectories (51.7%) had ≥1 failed edit, median 3 among those, max 33; 31.5% of resolved instances had one. P(edit eventually succeeds) 90.5% with no prior failure vs 57.2% after one; successful recoveries needed 2.03 failed edits on average vs 4.22 for unsuccessful. "Failed edit recovery" is 23.4% of unresolved instances. Edit with flake8 linting scored 18.0% on SWE-bench Lite vs 15.0% without and 10.3% with no edit command. Mean steps: resolved median 12 (mean 14.71), unresolved mean 21. [M; arXiv 2405.15793]
- **Aider (Dec 21 2023, GPT-4 Turbo, 89-task laziness benchmark):** SEARCH/REPLACE 20% → unified diff 61% (gpt-4-0613: 26% → 59%); lazy comments in 12 tasks → 4 ("3× less lazy"). Without the "high-level diff" prompting, edit errors rise 30–50%; with flexible patching disabled, errors rise 9× on the Exercism benchmark. The effect is on lazy elision, not on turns directly. [M; aider.chat/2023/12/21/unified-diffs.html]
- **Aider polyglot well-formed-edit rates (2025, secondary mirrors of aider.chat):** gpt-5 high 91.6%, o3-pro 97.8%, o3 94.7%, o4-mini 90.7%, DeepSeek R1 94.6%; older llama3-70b 73.5% on diff. So current frontier models fail the format on roughly 2–9% of tasks, each time costing aider a retry round. [A/M; developersdigest.tech, steel.dev mirrors, not verified on aider.chat]
- **Fast/speculative apply.** The idea is to let a cheap model merge a lazy edit into the file, so the main model writes a short snippet and no format fails. Cursor: ~1,000 tok/s on a 70B model with speculative edits (2024). Morph: ~10,500 tok/s, 96–98% accuracy (its own benchmark; its pages disagree). Relace: >4,300 tok/s and ~900 ms (YC launch); a 2026 secondary source says ~10,000 tok/s. All vendor numbers; no study measures turns saved. They save latency and output tokens, and the sources say nothing on retry rates against exact-match edits. [V]
- **Multi-file patch tools (Codex `apply_patch`, our `tool edit -`):** no benchmark found that isolates the turn saving from patching several files per call; the saving is by construction (one request instead of N) and follows the same logic as parallel calls. [no data]

**Fit.** Our multi-file SEARCH/REPLACE with all-files-checked-before-writing avoids the partial-apply case. Log failed-edit rate per model in Pi; SWE-agent's 90.5% → 57.2% cliff suggests returning a precise error (closest matching lines, line numbers) on the first failure to avoid the second.

## 5. Tool design that reduces turns

- **Windowed reads and search caps (SWE-agent, 2024):** 100-line viewer window 18.0% vs 30-line 14.3% vs whole file 12.7%; summarized search (≤50 hits, otherwise "be more specific") 18.0% vs iterative search 12.0% vs no search 15.7%; a "ran successfully with no output" message avoids confused follow-ups (no score given). Lesson: both too-small and too-large views hurt; a middle size with context lines and an explicit position header wins. [M; arXiv 2405.15793]
- **Consolidated workflow tools and `response_format`:** Anthropic (Sep 11 2025) recommends tools like `schedule_event` over endpoint wrappers, and a concise/detailed switch (72 vs 206 tokens). Qualitative on turns. In doc 03 §2.5. [V]
- **Diagnostics in the edit result (LSP):** no controlled study. Evidence is design reasoning in feature requests, one timing measurement (432 ms for a diagnostic after a broken edit, 369 ms clean) and an unverifiable anecdote ("30% fewer edit-run-debug cycles"). OpenCode attaches LSP diagnostics to write/edit/apply_patch output; Claude Code has an opt-out `diagnostics` setting and a user bug report that diagnostics arrive after the tool returns. SWE-agent's flake8-on-edit (+3 points) is the best hard evidence that feedback at edit time helps. [A for turns; M for lint-on-edit]
- **Token-efficient tool use (Anthropic, Feb 2025):** −14% output tokens on average, up to −70%, for Claude 3.7 Sonnet via beta header; default in Claude 4 models. It is an output-token saving, not a turn saving, and conflicts with `disable_parallel_tool_use`. [V]
- **Harness preamble size:** a lean bash-only harness (mini-SWE-agent, ~100 lines, >74% SWE-bench Verified claimed by its README) has an 829-token first call vs 16,581 for Claude Code, yet took more steps on one model (141 vs 104 on DeepSeek) and fewer on another (80.2 vs 88.1 on GLM). Steps depend on the model; preamble does not. [M; arXiv 2610.04433]

**Fit.** Pi's `read` with ranges, grep context, and lint-on-edit via pi-lens are in line. Check whether edit results already carry diagnostics; if so there is nothing to build, only a flag to keep on.

## 6. Turn budgets and step limits

- **SWE-agent:** $4 per-instance cost cap with auto-submit of existing edits; default config later $3. Resolved runs: median 12 steps, median cost $1.21; unresolved: mean 21 steps, $2.52. The cap acts mostly on runs that are already failing. [M; arXiv 2405.15793, swe-agent docs]
- **Goose:** `GOOSE_MAX_TURNS` default 1000 (stops and asks whether to continue); subagent limit is either 25 or inherits 1000 depending on version, and a 2026 issue reports the default subagent limit causing failures. **Claude Code:** `--max-turns` applies in print mode only, exits with an error at the limit, no documented default. No success-rate data for any of these. [V/A]
- **Budget awareness (Google, Nov 2025):** "simply increasing the tool-call budget fails to improve performance". A Budget Tracker (per-step remaining budget in context) improved accuracy at equal budget: Gemini-2.5-Pro BrowseComp 12.6 → 14.6, HLE-Search 20.5 → 21.8; Sonnet-4 BrowseComp 12.2 → 14.0, HLE-Search 20.5 → 23.0. At budget 10 with tracker: 12.8% accuracy vs 12.6% for ReAct with budget 100, with −40.4% searches and −31.3% cost. BATS (planning + verification on top) reached 24.6% vs 12.6% on BrowseComp (Gemini-2.5-Pro) at $1.1/question; dropping old tool responses kept accuracy (24.3 vs 24.6). Web-search agents, not coding. [M; arXiv 2511.17006]
- **Reasoning-effort vs steps (o1, SWE-bench Verified):** low effort 21.0% at $400, high 29.1% at $1,400; low effort shows higher overthinking score (2.77 vs 2.43). Cheaper-per-run is not cheaper-per-solved-task. [M; arXiv 2502.08235]

**Fit.** Pi could expose "N of M turns used" and elapsed cost at each step (as a short system reminder at the tail, cache-safe) and use turn-count as a stuck signal (see §7). Hard caps without awareness show no success benefit in the literature found. Test on our sessions before adopting.

## 7. Wasted steps, overthinking, loops

- **Cost-inefficiency study (Purdue, Sep 2026; 1,200 trajectories of Claude Code and mini-SWE-agent, 300 SWE-bench Verified tasks):** subsumed retrieval (re-reading what was already retrieved) hits 64–92% of tasks and 5.0–11.4% of cost; similar script regeneration up to 68% of tasks, up to 9.6% of cost; test re-execution with no patch change 50–83% of tasks, up to 5.4% of cost; combined 79–98% of tasks, up to **22.75%** of cost. Mitigations on 200 held-out Verified and 100 SWE-bench Pro tasks: structure-aware retrieval (CodeGraph) did not reliably reduce cost (+8–28% in four cases; Claude Code tool calls −27–31%, LLM calls −19.7% / −23.2% for Claude Code but +8–14% for mini-SWE-agent); agent-synthesized skills −8.9–22.3% cost (one robust saving after amortization); **developer-written prompt rules** −7.9% to −41.7% cost in 6 of 8 settings with pass@1 changes of −2.3 to +2.7 points. The rules: state a hypothesis before reading, reuse context and justify re-reads, persist and revise scripts, understand the test harness and rerun only when warranted, break unproductive loops. Turn counts were not reported for the prompt rules. [M; arXiv 2609.30725]
- **AgentLens (2026):** 1,815 OpenHands trajectories on 47 tasks, 8 models. Prevalence in passing runs: regression loops 38.7%, blind retries 46.0%, redundant steps 50.7%, cyclic patterns 33.6%; mean wasted steps per affected trajectory 15.5, 5.6, 3.7, 4.6. 10.7% of passes are "lucky" (passing through weak process; 0.5% of Opus 4.5 passes, 23.2% of GPT-4.1). No overall fraction of wasted steps is given. Small task sample. [M; arXiv 2605.12925]
- **TraceLite:** 41.75% of observations in mini-SWE-agent Verified trajectories overlap with another observation in the same trajectory. [M; arXiv 2610.28612]
- **Failed vs successful trajectories (ICSE 2026; 3,977 trajectories, 8 agents):** failed runs are longer (SWE-agent +18.5%, OpenHands +82.5%) with repeated non-adaptive cycles. [M; arXiv 2511.00197]
- **The Danger of Overthinking (2025; 3,908–4,018 trajectories, text is inconsistent):** three patterns: analysis paralysis, rogue actions (several dependent actions without waiting for feedback), premature disengagement. Strong negative correlation between overthinking score and resolution (R² 0.84–0.89). Using the lower-overthinking sample of two low-effort runs: 27.3% at $800 vs 29.1% at $1,400 (−43% cost); of three samples: 30.3% at ~15% lower cost. Abstract's "almost 30% improvement" actually reads as an absolute 30.3% resolve rate. Native function calling raised o1 high effort from 29.1% to 47.7% with overthinking 2.43 → 1.05. [M; arXiv 2502.08235]
- **Parallel subagents (Oct 2026; 354 tasks, 2,124 executions, Codex / Claude Code / Kimi Code):** shell calls rise under concurrency "often by several fold"; parallelism does not automatically lower latency; 13 concurrency-specific failure modes. Per search summary; not read in full text. [M; arXiv 2610.10263]

**How much is avoidable.** Upper bound for the three measured behaviours: ~23% of cost; realistic recovered share from prompt rules: 8–42% by setting (median about 14% across the six robust cells, my calculation). Outside the studied categories, there is no good number.

**Fit.** The Purdue prompt rules are cheap to try and testable on our 1,616-session corpus (doc 07): count same-file re-reads without edits in between, repeated identical test commands with no diff, and near-duplicate bash scripts. A "same test command, no file changed since" detector in the harness (return "unchanged since last run: <result summary>") would remove the third behaviour deterministically instead of by prompt. Measured in [10](10-turns-in-our-sessions.md) §4: these behaviours are about 1% of our turns each, so neither is worth building here.

## 8. Exploration subagents, speculation, prefetch

- **SWE-grep / SWE-grep-mini (Cognition, Oct 16 2025):** RL-trained retrievers with ≤8 parallel tool calls per turn and ≤4 turns (3 explore + 1 answer) vs "10–20 serial turns" for ordinary agentic search; going from 4 to 8 parallel searches cut search turns from 6 to 4 "while retaining the same performance". Speeds above 650 tok/s and 2,800 tok/s on Cerebras (4.5× / 20× Haiku 4.5's 140 tok/s). Cognition reports its agents spent over 60% of the first turn retrieving context. Eval: weighted F1 (β=0.5) on an internal CodeSearch Eval; the numbers sit in charts, not text; downstream Windsurf Cascade test says the same tasks completed in "significantly lower end-to-end time" without figures. Training note: small models max out parallelism with duplicate calls, so the advantage was scaled by tool calls per turn. Vendor claims with an internal eval, and the authors say the comparison is "not meant to be an extremely rigorous benchmark". [V; cognition.ai/blog/swe-grep]
- **Cursor Composer (Oct 29 2025):** RL "incentivize[s] the model to make efficient choices in tool use and to maximize parallelism whenever possible"; reported speed 4× vs similar models; no turn numbers. [V; cursor.com/blog/composer]
- **Speculative tool execution (PASTE, Mar 2026):** runs likely next tools while the model is still generating; −48.5% average task completion time and 1.8× tool throughput vs baselines, per the abstract (benchmarks not read). Saves latency, not requests, and not cost. [M; arXiv 2603.18897]
- **Prefetching / repo map:** Aider's map (default ~1k tokens, 2023) lets the model request files it has not been given; no study counts turns saved. Prompt-injected context in doc 03 §3 is the related Pi mechanism. The Purdue study found that giving structure-aware retrieval (CodeGraph) cut Claude Code tool calls ~27–31% but did not lower cost, because tool output got more verbose. So prefetch saves turns only if the pushed context is compact. [M for CodeGraph; no data for repo maps]
- **Subagent cost.** Anthropic's research system: ~4× tokens for an agent, ~15× for multi-agent (doc 04). Subagents trade wall-clock and main-context size for more total tokens; they only save turns of the main thread.

**Fit.** A cheap-model explore subagent exists conceptually (`delegate`). The numbers say its value is wall-clock and main-context cleanliness, not total cost, unless its model is much cheaper and fast. The training behind SWE-grep is not reproducible with a prompt. We can cap exploration: ask for one batch of parallel searches first, then reads.

## 9. Other findings

- **Harness cost decomposition (Oct 2026):** pass rates moved less than between two repeats of the same setup; cost per task up to 3×; cost = first-call tokens + growth per step + step count; one harness effect beyond noise was a loss (OpenCode up to 9 points behind on the large pool). Per-run cost on GLM-5.3-Flash: Claude Code 1.81 CNY, mini-SWE-agent 0.97, OpenCode 0.56; ordering flipped on DeepSeek-V4-Flash. [M; arXiv 2610.04433, via search summaries; the-decoder.com Oct 24 2026]
- **"Think" tool (Anthropic, Mar 2025):** τ-bench airline 0.370 baseline → 0.570 with think tool plus optimized prompt (+54% relative); retail 0.783 → 0.812; adds a step, trades a turn for accuracy in policy-heavy domains. Not a turn reducer. [V; anthropic.com/engineering/claude-think-tool, reached via mirror]
- **Interleaved thinking:** docs make no claim of fewer tool calls; only one concrete AWS example (model computed the answer from the first call's data and skipped a call). Weak. [V/A]
- **Model-side efficiency claims:** Opus 4.5 "76% fewer output tokens at medium effort at Sonnet 4.5 parity" (token count, not turns). A "50% fewer tool calls" claim traces only to third-party sites, not Anthropic. An independent single-build test found Opus used 19.3% fewer tokens yet cost 41% more. [V/A]
- **Newer models are trained for efficiency:** Cursor Composer and SWE-grep reward parallelism and fewer calls in RL; Claude 4+ parallelizes by default. Prompt nudges are mostly a correction for models that were not trained for it. Check per model.
- **Amp and Cognition (Devin):** no primary numbers on turn efficiency found beyond SWE-grep. Amp's Oracle is a read-only escalation subagent requested on demand (third-party description).

## Comparison table

| Technique | Turns saved | Other effects | Evidence quality | Who uses it |
|---|---|---|---|---|
| Parallel tool calls in one response | N−1 requests per batch; real saving depends on how often the model batches (14% of turns in one log) | Lower latency; ordering hazards; GPT-5 guide pushes opposite | Mechanism certain; rates [A]; LLMCompiler comparison [M] | Claude 4+, GPT-5.1+, Codex, Claude Code, Pi |
| System-prompt parallel nudge | Raises batch rate toward "about 100%" (claim) | Free; may batch dependent calls | [V], no measurement | Anthropic docs, OpenAI 5.1/5.2 guides |
| Programmatic/script tool calling | 10 → 5 model calls in one coding example; 19+ passes per 20 calls; 36 → 2 on bulk jobs (estimate) | −37% tokens (Anthropic); −15% cost (Factory); sandbox and debugging cost | [V], internal or replay examples | Anthropic API, Factory Droid, Cloudflare, Pi `tool`/`workflow` |
| CodeAct-style code actions | Up to 30% fewer actions; 5.5 vs 7.7 turns (GPT-4) | +20% success; weak models no gain | [M], 2024 models, not coding tasks | smolagents, OpenHands |
| Plan-then-execute DAG (LLMCompiler) | Few LLM calls; 1.8–3.7× latency | −3.4 to −6.7× cost; worse than ReAct on WebShop; needs replan | [M], QA not coding | Research, LangGraph |
| ReWOO | ~5× fewer tokens | No reaction to surprises | [M], 2023 QA | Research |
| Better edit format / lint-on-edit | Avoids retry loops: 51.7% of SWE-agent runs had a failed edit | +3 pts (lint); 20 → 61% (udiff, GPT-4 Turbo) | [M] older models; frontier 91–98% well-formed | Aider, SWE-agent, Codex apply_patch |
| Fast apply models | No direct turn saving | Latency (1k–10k tok/s), fewer output tokens | [V] | Cursor, Morph, Relace |
| Windowed read, search cap, grep context | Fewer follow-up reads | 18.0% vs 12.7–14.3% (window); 18.0% vs 12.0% (search) | [M] one model (GPT-4 Turbo) | SWE-agent, Claude Code, Pi |
| Diagnostics in edit result | Plausibly one check turn per edit | — | [A] no study | OpenCode; Claude Code (partial) |
| Budget tracker / turn counter in context | Matches budget-100 accuracy at budget 10 (−40% searches, −31% cost) | +1–3 pts accuracy at equal budget | [M] web agents, not coding | Research (Google) |
| Hard max-turns / cost cap | Stops runaway runs | No success-rate evidence | [V] | Claude Code, Goose, SWE-agent |
| Prompt rules vs redundant work (reuse context, no re-test w/o change) | Re-reads −24 to −65%, re-tests −5 to −39% in cells | −8 to −42% cost, pass@1 within noise | [M] Sep 2026, 2 harnesses, Verified+Pro | Research; candidates for Pi |
| Overthinking-aware sample selection | Not about turns | −43% cost at −1.8 pts abs (o1) | [M] 2025 | Research |
| RL-trained parallel explorer (SWE-grep) | 10–20 serial turns → 4; 6 → 4 turns at 4 → 8 parallel | Much faster tok/s; needs training | [V] internal eval | Windsurf, Devin |
| Speculative tool execution (PASTE) | None (latency only) | −48.5% completion time | [M] abstract only | Research |
| Prefetch / repo map / CodeGraph | Claude Code tool calls −27–31% | Cost +8–28% from verbose output | [M] for CodeGraph; repo maps [no data] | Aider, Windsurf |
| Parallel write-capable subagents | Does not cut main-thread requests reliably | Shell calls up several-fold; failure modes | [M] 2,124 runs | Codex, Claude Code, Kimi Code |

## Open gaps (not found)

- No controlled coding-agent study of plan-first, diagnostics-in-edit-result, repo-map prefetch, or multi-file patch tools on turn count.
- Anthropic's "about 100%" parallel rate and Anthropic/Google "fewer tool calls" claims have no published method.
- Fetches of the Purdue study, AgentLens, harness-cost and parallel-subagent papers were via a summarising fetch tool: the Purdue (2609.30725) and AgentLens (2605.12925) numbers came from page text; harness-cost (2610.04433) and the parallel-subagent findings come from search summaries and the abstract only. Verify against the PDFs before quoting externally. Arxiv IDs in this range post-date my training, so I could not cross-check them from memory.

## Sources

- Anthropic parallel tool use docs (undated): https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use
- Anthropic prompting best practices ("about 100 percent"): https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- OpenAI function calling: https://developers.openai.com/api/docs/guides/function-calling ; GPT-5.1 guide https://cookbook.openai.com/examples/gpt-5/gpt-5-1_prompting_guide ; GPT-5.2 guide https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-2_prompting_guide ; Codex guide https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide ; GPT-5 guide https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide
- Parallel tool use log (anecdote): https://dev.to/ji_ai/claude-parallel-tool-use-my-agent-loop-crashed-on-388-of-1200-runs-4i28
- Anthropic advanced tool use (Nov 24 2025): https://www.anthropic.com/engineering/advanced-tool-use
- Anthropic token-efficient tool use: https://docs.claude.com/en/docs/agents-and-tools/tool-use/token-efficient-tool-use ; https://www.anthropic.com/news/token-saving-updates
- Anthropic "think" tool: https://www.anthropic.com/engineering/claude-think-tool
- Anthropic writing tools for agents (Sep 11 2025): https://www.anthropic.com/engineering/writing-tools-for-agents
- Cloudflare Code Mode (Sep 26 2025): https://blog.cloudflare.com/code-mode/
- CodeAct (ICML 2024): https://arxiv.org/abs/2402.01030 , https://arxiv.org/pdf/2402.01030
- smolagents concepts: https://huggingface.co/docs/smolagents/conceptual_guides/intro_agents
- LLMCompiler (ICML 2024): https://arxiv.org/abs/2312.04511 , https://arxiv.org/pdf/2312.04511
- Plan-and-Act (Mar 2025): https://arxiv.org/abs/2503.09572
- Factory Droid 1.0 (Oct 29 2026): https://factory.com/news/frontier-harness
- Cognition SWE-grep (Oct 16 2025): https://cognition.ai/blog/swe-grep
- Cursor Composer (Oct 29 2025): https://cursor.com/blog/composer
- PASTE speculative tool execution (Mar 2026): https://arxiv.org/abs/2603.18897
- Parallel subagents study (Oct 2026): https://arxiv.org/abs/2610.10263
- SWE-agent (2024): https://arxiv.org/pdf/2405.15793
- Aider unified diffs (Dec 21 2023): https://aider.chat/2023/12/21/unified-diffs.html ; edit formats https://aider.chat/docs/more/edit-formats.html ; leaderboard notes https://aider.chat/docs/leaderboards/notes.html ; 2025 polyglot mirror https://www.developersdigest.tech/benchmarks/aider-polyglot , https://leaderboard.steel.dev/leaderboards/aider/
- Cursor instant apply: https://cursor.com/blog/instant-apply ; Fireworks: https://fireworks.ai/blog/cursor ; Morph: https://www.morphllm.com/fast-apply-model ; Relace: https://www.ycombinator.com/launches/NV5-relace-cheaper-faster-and-more-reliable-ai-code-generation
- Budget-aware tool use (Nov 2025): https://arxiv.org/pdf/2511.17006
- The Danger of Overthinking (2025): https://arxiv.org/pdf/2502.08235
- Cost-inefficient behaviours in coding agents (Sep 2026): https://arxiv.org/html/2609.30725v2
- AgentLens (2026): https://arxiv.org/html/2605.12925
- TraceLite: https://arxiv.org/pdf/2610.28612
- Understanding code agent behaviour (ICSE 2026): https://arxiv.org/html/2511.00197
- What Does a Harness Buy? Tokens, Mostly. (Oct 2026): https://arxiv.org/html/2610.04433v1 ; summary https://the-decoder.com/fancy-harnesses-make-coding-agents-more-expensive-but-not-better-study-finds/
- mini-SWE-agent: https://github.com/swe-agent/mini-swe-agent
- Claude Code `--max-turns`: https://claudcod.com/blog/claude-code-max-turns/ ; Goose env vars https://goose-docs.ai/docs/guides/environment-variables/ ; Goose subagent issues https://github.com/aaif-goose/goose/issues/6198 , https://github.com/aaif-goose/goose/issues/11999 ; SWE-agent keys https://swe-agent.com/latest/installation/keys/
- LSP diagnostics anecdotes: https://github.com/darwin-finch/finch/issues/757 ; https://github.com/anthropics/claude-code/issues/93321 ; https://github.com/FreePeak/xdev/issues/263
- Interleaved thinking example: https://aws.amazon.com/blogs/opensource/using-strands-agents-with-claude-4-interleaved-thinking/
- Opus 4.5 claims (secondary): https://claudefa.st/blog/models/claude-opus-4-5 ; https://www.cosmicjs.com/blog/claude-sonnet-45-vs-opus-45-a-real-world-comparison
- Windsurf Fast Context (secondary): https://docs.windsurf.com/llms-full.txt ; Aider repo map: https://aider.chat/docs/ctags.html
