# 01 — Context engineering: foundations, taxonomies, failure modes, prompt and cache design

Slice 1 of 6 in the context-engineering research set for the Pi-based coding-agent harness.
Research date: 2026-11-12. Every claim links to a source, and dates are publication dates. Numbers are as reported by each source. I checked arithmetic where I could and marked inconsistencies.

## TL;DR

1. **Definition.** Context engineering means curating the *whole* token state the model sees on *every* step: system prompt, tools, history, tool results, memory, and retrieved data. Prompt engineering covers only how instructions are worded. The term spread in June 2025 through Lütke, Karpathy and Cognition. Anthropic, LangChain, Google and the academic surveys all adopted it by late 2025.
2. **Guiding principle.** Context is a finite **attention budget** with diminishing returns. Aim for "the smallest possible set of high-signal tokens" ([Anthropic, 2025-09-29](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
3. **Canonical taxonomy: Write / Select / Compress / Isolate** ([LangChain, 2025-07-02](https://blog.langchain.com/context-engineering-for-agents/)). Breunig's six tactics, Anthropic's compaction / notes / sub-agents, Manus's offload / reduce / isolate / cache, and Google ADK's "compiled view" all map onto it (§2).
4. **Context rot is universal and starts early.** All 18 models Chroma tested degrade with input length ([Chroma, 2025-07-14](https://research.trychroma.com/context-rot)). Length alone hurts by 13.9–85% even with perfect retrieval and masked distractors ([Du et al., 2025-10](https://arxiv.org/abs/2510.05381)). Effective length is often under half of the advertised length ([RULER](https://arxiv.org/abs/2404.06654), [NoLiMa](https://arxiv.org/abs/2502.05167), [STRING](https://arxiv.org/abs/2410.18745)).
5. **Four content failure modes: poisoning, distraction, confusion, clash** ([Breunig, 2025-06-22](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html)). Add position effects ("lost in the middle", [Liu et al.](https://arxiv.org/abs/2307.03172)), instruction-density decay ([IFScale](https://arxiv.org/abs/2507.11538)), the "few-shot rut" ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)), and goal drift after summarization ([LangChain, 2026-01-28](https://blog.langchain.com/context-management-for-deepagents/)).
6. **Tools are context.** Accuracy falls as the tool count rises: by up to 85% ([LongFuncEval](https://arxiv.org/abs/2505.10570)); Llama 3.1 8B fails with 46 tools and succeeds with 19 ([Less is More](https://arxiv.org/abs/2411.15399)). Overlap matters more than count ([OpenAI guide](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)). Tool search with deferred schemas cut tokens by about 85% and raised Opus 4 from 49% to 74% ([Anthropic, 2025-11-24](https://www.anthropic.com/engineering/advanced-tool-use)).
7. **Prompt design.** Write at the "right altitude": neither brittle if/else logic nor vague platitudes. Use XML or Markdown sections and diverse canonical examples, not edge-case laundry lists. Put long data first and the query last: up to +30% for Claude ([Anthropic docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/long-context-tips)). OpenAI instead recommends instructions at **both** ends ([GPT-4.1 guide](https://cookbook.openai.com/examples/gpt4-1_prompting_guide)).
8. **Cache economics shape the architecture.** Cached input costs about 0.1× base, and agents run roughly 100:1 input:output ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). Caching cut cost by 41–80% and time to first token by 13–31% ([Lumer et al., 2026-01](https://arxiv.org/abs/2601.06007)). Rules: stable prefix, append-only, deterministic serialization, no mid-session tool or model swaps, `<system-reminder>` messages instead of system-prompt edits, mask or defer tools instead of removing them, cache-safe compaction forks.
9. **Main tension: pruning vs caching.** Every edit to history breaks the prefix cache. The 2025–26 answer is staged reduction: raw → reversible compaction (path or ID stubs) → schema-driven summarization at a threshold, then batched and cache-aware eviction ([Manus/Martin](https://rlancemartin.github.io/2025/10/15/manus/), [Schmid](https://www.philschmid.de/context-engineering-part-2), [TokenPilot](https://arxiv.org/abs/2606.17016)).
10. **Open disagreements.** Multi-agent vs single-thread ([Anthropic](https://www.anthropic.com/engineering/built-multi-agent-research-system) vs [Cognition](https://cognition.ai/blog/dont-build-multi-agents)); RAG over tool definitions vs a stable tool set; todo-list recitation (Manus first recommended it, later dropped it); few-shot examples; and query placement (§7).

---

## 0. Scope and method

This file covers **foundations**: definitions, taxonomies, failure modes and their evidence, prompt and tool design as context engineering, and KV-cache-aware design. Other slices cover memory, compaction mechanics, multi-agent flows, retrieval and loop patterns in depth, so I touch those only where they define the taxonomy.

Each approach is described as **What / Why-when / Tradeoffs / Who uses it / Coding-harness application**. "Pi today" notes refer to the vendored Pi code at `vendor/pi/packages/coding-agent/src/core`, which I checked only lightly:

- `system-prompt.ts` builds a sectioned, XML-tagged system prompt and supports hidden or loadout tools.
- `compaction/compaction.ts` sets defaults of `reserveTokens: 16384` and `keepRecentTokens: 20000`.
- `cache-warmer.ts` plus `ai/src/api/anthropic-messages.ts` place `cache_control` markers on the system prompt, the last tool, and the last message.

---

## 1. Definitions and lineage

| Date | Who | Definition / contribution | Source |
|---|---|---|---|
| 2025-06-12 | Walden Yan (Cognition) | "Context engineering" is the #1 job of agent builders. Two principles: share full traces, and remember that actions carry implicit decisions. | [cognition.ai](https://cognition.ai/blog/dont-build-multi-agents) |
| 2025-06-18/19 | Tobi Lütke (Shopify CEO) | "the art of providing all the context for the task to be plausibly solvable by the LLM" | quoted in [Willison](https://simonwillison.net/2025/Jun/27/context-engineering/), [Schmid](https://www.philschmid.de/context-engineering) |
| 2025-06-25 | Andrej Karpathy | "+1 for 'context engineering' over 'prompt engineering'… the delicate art and science of filling the context window with just the right information for the next step." LLM = CPU, context = RAM. | [X post](https://x.com/karpathy/status/1937902205765607626), quoted in [LangChain](https://blog.langchain.com/context-engineering-for-agents/) |
| 2025-06-27 | Simon Willison | Argues the term will stick because its *inferred* meaning is close to its intended one, unlike "prompt engineering", which people read as "typing things into a chatbot". | [simonwillison.net](https://simonwillison.net/2025/Jun/27/context-engineering/) |
| 2025-06-30 | Philipp Schmid (Google DeepMind) | "the discipline of designing and building dynamic systems that provides the right information and tools, in the right format, at the right time". It is "a system, not a string". "Agent failures aren't only model failures; they are context failures." Seven components: instructions, user prompt, state/history, long-term memory, RAG, tools, structured output. | [philschmid.de](https://www.philschmid.de/context-engineering) |
| 2025-07-02 | LangChain | "the art and science of filling the context window with just the right information at each step of an agent's trajectory". Taxonomy: **write, select, compress, isolate**. | [blog.langchain.com](https://blog.langchain.com/context-engineering-for-agents/) |
| 2025-07-17 | Mei et al. (survey, 1,400+ papers) | A formal discipline beyond prompt design. Foundational components: context *retrieval & generation*, *processing*, *management*. System implementations: RAG, memory, tool-integrated reasoning, multi-agent. Key finding: an asymmetry, since models understand complex context far better than they generate long sophisticated output. | [arXiv 2507.13334](https://arxiv.org/abs/2507.13334) |
| 2025-07-18 | Yichao "Peak" Ji (Manus) | Six production lessons: KV-cache hit rate, mask don't remove, filesystem as context, recitation, keep errors in, don't get few-shotted. "Stochastic Graduate Descent". | [manus.im](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) |
| 2025 (spring; date in repo history) | Dex Horthy (HumanLayer) | 12-Factor Agents. Factor 3 "Own your context window": no need to use the standard message format, so pack history as custom XML events. | [GitHub](https://github.com/humanlayer/12-factor-agents) |
| 2025-09-29 | Anthropic | "the natural progression of prompt engineering… strategies for curating and maintaining the optimal set of tokens during LLM inference". Context is "a finite resource with diminishing marginal returns". Introduces the **attention budget**. | [anthropic.com](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) |
| 2025-10-30 | Hua et al. | "Context Engineering 2.0": traces the practice back 20+ years to HCI and context-aware computing. Eras follow machine intelligence levels. | [arXiv 2510.26493](https://arxiv.org/abs/2510.26493) |
| 2025-12-04 | Google ADK (Hangfei Lin) | "Context is a compiled view over a richer stateful system". Session/memory/artifacts are the sources, and flows/processors are the compiler. | [developers.googleblog.com](https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/) |
| 2026-02-11 | OpenAI (Codex team) | "Harness engineering": the work moves to environments, feedback loops and control. AGENTS.md is a ~100-line "table of contents, not an encyclopedia". | [openai.com](https://openai.com/index/harness-engineering/) (snippets only; full text not fetched) |
| 2026-03-10 | Vishnyakova | Pyramid: prompt → context → intent → specification engineering. Five context-quality criteria: **relevance, sufficiency, isolation, economy, provenance**. | [arXiv 2603.09619](https://arxiv.org/abs/2603.09619) |

**Consensus.** Prompt engineering is a *subset*: it covers the instruction text. Context engineering covers the dynamic, per-step assembly of everything else, and in agents it is iterative: "the curation phase happens each time we decide what to pass to the model" ([Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

**Out of scope for everyone.** Schmid and 12-factor explicitly exclude training, fine-tuning and sampling parameters ([12-factor F3](https://github.com/humanlayer/12-factor-agents)).

**Newest framing (2026).** "Harness engineering" treats context engineering as one component of a harness. The other components are execution environment, tool integration, scope negotiation, loop management and verification ([Agent Harness survey, Apr 2026](https://doi.org/10.20944/preprints202604.0428.v1); [arXiv 2606.20683](https://arxiv.org/html/2606.20683v1)). An empirical study of 2,853 repos found **context files (AGENTS.md / CLAUDE.md) dominate** harness configuration, while skills and sub-agents are rarely configured ([Galster et al., 2026-02](https://arxiv.org/abs/2602.14690)).

---

## 2. Taxonomies and how they map

### 2.1 LangChain: Write / Select / Compress / Isolate (2025-07-02)

Source: [LangChain](https://blog.langchain.com/context-engineering-for-agents/).

- **Write** (save outside the window): scratchpads (a plan saved to memory, as Anthropic's researcher does because context above 200k "will be truncated"), and long-term memories (Reflexion, Generative Agents, ChatGPT, Cursor, Windsurf).
- **Select** (pull in): scratchpad reads; episodic, procedural and semantic memories (CLAUDE.md, rules files); RAG over tool descriptions (cites "3-fold" better tool selection); knowledge retrieval. Windsurf combines grep, a knowledge graph and re-ranking because "embedding search becomes unreliable… as the codebase grows".
- **Compress**: summarization (Claude Code auto-compacts at 95% of the window; Cognition uses a fine-tuned summarizer at hand-offs) and trimming (heuristics, Provence pruner).
- **Isolate**: multi-agent (separate windows), sandboxes (Hugging Face CodeAgent keeps heavy objects in variables), and state-schema fields hidden from the LLM.

### 2.2 Breunig: four failures × six fixes (2025-06-22/26)

Sources: [failures](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html), [fixes](https://www.dbreunig.com/2025/06/26/how-to-fix-your-context.html).

The six fixes:

- **RAG**
- **Tool loadout**: select tool definitions per task.
- **Context quarantine**: separate threads.
- **Context pruning**: e.g. Provence, a ~1.75 GB pruner that cut 95% of an article.
- **Context summarization**
- **Context offloading**: e.g. the "think" tool, up to 54% on a specialized-agent benchmark.

Breunig's thesis: "context is not free"; every token influences behavior.

### 2.3 Anthropic: just-in-time context + three long-horizon techniques (2025-09-29)

Source: [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

- **Just-in-time retrieval.** Keep lightweight identifiers such as paths, queries and URLs, and load content via tools. Claude Code is a *hybrid*: CLAUDE.md is loaded up front, glob/grep run on demand.
- **Compaction.** Summarize near the limit, keeping "architectural decisions, unresolved bugs, and implementation details" plus the 5 most recently accessed files. Tune for recall first, then precision. The lightest form is *tool-result clearing*.
- **Structured note-taking.** NOTES.md, to-do lists, the memory tool.
- **Sub-agents.** Each explores with "tens of thousands of tokens" and returns "1,000–2,000 tokens".
- **When to use which.** Compaction suits long back-and-forth. Notes suit milestone-driven work. Multi-agent suits parallelizable research.

### 2.4 Manus: offload / reduce / retrieve / isolate / cache (2025-07-18; 2025-10-15 update)

Sources: [Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus), [Lance Martin's notes of the Manus × LangChain webinar](https://rlancemartin.github.io/2025/10/15/manus/).

- **Reduce** splits into *compaction* and *summarization*:
  - Compaction swaps a stale tool result's "full" form for its "compact" form (a path), and is reversible.
  - Summarization runs only when compaction gives diminishing returns. It is generated from full results using a fixed schema.
- **Layered action space.** Fewer than 20 atomic function calls (bash, filesystem, code execution). Everything else runs as sandbox CLIs or packages called through bash, which keeps tool definitions small and cache-stable.
- **Isolation by communicating vs sharing memory.** Simple tasks get instructions only. Complex tasks get the full context. In both cases the planner defines an output schema that is enforced by constrained decoding.

### 2.5 Google ADK: context as a compiled view (2025-12-04)

Sources: [Google Developers Blog](https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/), [ADK context docs](https://google.github.io/adk-docs/context/).

- **Separate storage from presentation.** The Session is an event log and the ground truth. The working context is a per-call projection, rebuilt every invocation.
- **Ordered request processors.** The order is: `basic, auth, request_confirmation, instructions, identity, contents, context_cache_processor, planning, code_execution, output_schema`. "The order matters."
- **Compaction** writes a summary event back into the Session over a sliding window. **Filtering** is its rule-based sibling.
- **Stable prefix / variable suffix**, plus a "static instruction" primitive for an immutable system prompt.
- **Artifacts as handles.** The agent sees a name and summary and calls `LoadArtifactsTool` for "ephemeral expansion". The example is a 5 MB CSV.
- **Scoped hand-offs.** `include_contents` takes the default or `none`. On transfer, earlier assistant messages are recast as narrative ("[For context]: Agent B said…") so the new agent doesn't mistake them for its own outputs.
- **State scopes.** Keys are prefixed `app:`, `user:` or `temp:`.

### 2.6 HumanLayer: 12-factor agents (2025)

Source: [GitHub](https://github.com/humanlayer/12-factor-agents).

These factors bear directly on context: F2 own your prompts, F3 own your context window, F8 own your control flow, F9 compact errors into the context window, F10 small focused agents, F12 agent as stateless reducer, plus the appendix "pre-fetch all the context you might need".

F3 shows a whole history serialized into one user message as typed XML events. The claimed benefits are density, the ability to hide resolved errors, PII filtering, and token efficiency.

### 2.7 ACE: Agentic Context Engineering (2025-10-06, ICLR 2026)

Source: [arXiv 2510.04618](https://arxiv.org/abs/2510.04618).

ACE treats context as an evolving **playbook** curated through generation, reflection and curation, using *incremental structured updates*. It names two failure modes of naive prompt optimization:

- **Brevity bias**: dropping domain insight in favour of terse summaries.
- **Context collapse**: iterative rewriting erodes detail.

Reported gains: +10.6% on agent tasks and +8.6% on finance. It matched the top AppWorld agent with a smaller open model.

### 2.8 Unified mapping

| Bucket | LangChain | Breunig | Anthropic | Manus | ADK | Evidence of benefit |
|---|---|---|---|---|---|---|
| Persist outside window | Write | Offloading | Notes / memory tool | Filesystem as context, todo.md | Session, artifacts, memory | Memory + context editing: +39% vs baseline ([Anthropic](https://www.anthropic.com/news/context-management)) |
| Pull in on demand | Select | RAG, tool loadout | Just-in-time, hybrid | glob/grep, no vector index | Artifact handles, `load_memory` | Tool search: Opus 4 49→74% ([Anthropic](https://www.anthropic.com/engineering/advanced-tool-use)) |
| Shrink | Compress | Pruning, summarization | Compaction, tool-result clearing | Compaction → summarization | Compaction, filtering | Context editing −84% tokens on a 100-turn eval ([Anthropic](https://www.anthropic.com/news/context-management)) |
| Separate | Isolate | Quarantine | Sub-agents | Agent-as-tool with schema | `include_contents`, agents-as-tools | Multi-agent +90.2% on internal research eval, ~15× tokens ([Anthropic](https://www.anthropic.com/engineering/built-multi-agent-research-system)) |
| Keep cheap & fast | — | — | — | KV-cache first | Context cache processor | −41–80% cost ([arXiv 2601.06007](https://arxiv.org/abs/2601.06007)) |
| Shape attention | — | — | Right altitude, examples | Recitation, keep errors, variation | Instructions processor | Query-at-end up to +30% ([Anthropic docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/long-context-tips)) |

LangChain's taxonomy has no "cache" or "attention-shaping" axis. Production practitioners (Manus, Claude Code, ADK) treat caching as a first-class design constraint, so this file adds both columns.

---

## 3. Failure modes

### 3.1 Attention budget and the n² argument

- **What.** Every token draws on a finite attention budget. Self-attention forms n² pairwise relations, so relations get "stretched thin" as n grows. Training data skews short, and position interpolation trades away positional precision ([Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- **Mechanistic support.** Relative-position frequencies are left-skewed in pretraining, so distant positions are undertrained. Effective length is "typically not exceeding half" of training length. STRING, which shifts well-trained positions at inference with no training, gives +10 points on RULER/InfiniteBench for Llama 3.1 70B ([An et al., 2024-10](https://arxiv.org/abs/2410.18745)).
- **Harness implication.** Treat context size as a *quality* lever, not just a cost lever. Budget it per section (system, tools, project docs, history, scratch).

### 3.2 Context rot (Chroma, 2025-07-14)

- **What.** Reliability falls as input grows, *even on trivial tasks*. Chroma tested 18 models (Anthropic, OpenAI, Google, Qwen) ([Chroma](https://research.trychroma.com/context-rot)). Findings:
  - Low needle–question similarity degrades faster.
  - Even one distractor hurts, and the effect grows with length.
  - **Coherent haystacks hurt more than shuffled ones** (counterintuitive).
  - LongMemEval *focused* (~300 tokens) beat *full* (~113k tokens) for every model.
  - Repeated-word copying fails with length, producing refusals and random output.
  - Claude models abstain more; GPT models hallucinate more.
  - Quote: "what matters more is how that information is presented."
- **Length alone hurts.** Du et al. show 13.9–85% drops across 5 models on math, QA and code as input grows, *even when irrelevant tokens are whitespace or fully attention-masked*, and even when the evidence sits right before the question. Mitigation: **recite-then-solve**, which turns a long-context task into a short one (up to +4% for GPT-4o on RULER) ([arXiv 2510.05381](https://arxiv.org/abs/2510.05381), EMNLP Findings 2025).
- **Practitioner thresholds** (heuristics, not measurements):
  - Schmid: degradation often starts below about 256k on 1M-token models; summarize around 128k ([Schmid, 2025-12-04](https://www.philschmid.de/context-engineering-part-2)).
  - HumanLayer: keep utilization at **40–60%** ([ACE-FCA](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md)).
  - Gemini Pokémon agent: began repeating past actions beyond about 100k ([Breunig](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html), citing the Gemini 2.5 report).
  - Thariq (Claude Code): "you have to think more carefully about session management with one million context, not less" ([X, 2026](https://x.com/trq212/status/2044873898572001376)).
- **Coding-harness application.** Trigger compaction on *quality* thresholds, not only on the window limit. Pi's default compacts at `window − 16384`, which is far beyond the rot zone on 1M models. Keep tool outputs short and clear stale reads. Consider recite-then-solve prompts, for example "quote the relevant lines/symbols before editing".

### 3.3 Position effects: lost in the middle (Liu et al., 2023-07; TACL 2024)

- **What.** Accuracy follows a U-shape: best at the start and end, worst in the middle. GPT-3.5-Turbo on 20-document QA scored 75.8% with the answer first, 53.8% in the middle (index 9) and 63.2% last. That middle score is *below the 56.1% closed-book score*, so adding the documents made it worse ([arXiv HTML](https://arxiv.org/html/2307.03172v3)).
- **Query-aware contextualization** (query before *and* after the data) makes key-value retrieval near-perfect, but barely helps multi-document QA.
- **More retrieval saturates.** Going from 20 to 50 retrieved documents adds only about 1.5 points, so the authors recommend reranking relevant documents to the front and truncating.
- **Instruction primacy.** IFScale also finds a bias toward *earlier* instructions ([arXiv 2507.11538](https://arxiv.org/abs/2507.11538)).
- **Status in 2025–26.** Newer models flatten the U, but Chroma and Du still find strong position and length effects.
- **Harness application.** Put durable rules in the system prompt (start) and the current goal and plan at the end (recitation, §4.6). Don't bury the user's task between large tool outputs.

### 3.4 Effective vs advertised context length (benchmarks)

| Benchmark | Date | What it adds | Headline |
|---|---|---|---|
| NIAH (Kamradt) | 2023-11 (GPT-4-128K run 11/8, Claude 2.1 run 11/21) | Single-fact retrieval sweep over length × depth | Origin of the genre; v2 adds multi-needle and UUID chains ([GitHub](https://github.com/gkamradt/LLMTest_NeedleInAHaystack)) |
| RULER (NVIDIA) | 2024-04, COLM 2024 | 13 tasks: multi-needle, multi-hop tracing, aggregation | All 17 models claim ≥32K; only about half hold up at 32K ([arXiv 2404.06654](https://arxiv.org/abs/2404.06654)) |
| Databricks long-context RAG | 2024-08-12 | 2,000+ runs, 13 LLMs | Llama-3.1-405B declines after 32k per the text (after 16k per the table); GPT-4-0125 after 64k (text) or 16k (table); Claude-3-Sonnet copyright refusals rise from 3.7% to 49.5% between 16k and 64k ([Databricks](https://www.databricks.com/blog/long-context-rag-performance-llms)) |
| HELMET (Princeton/Intel) | 2024-10, ICLR 2025 | 7 application categories, 59 models | **NIAH does not predict downstream performance**; use RAG-style tasks ([arXiv 2410.02694](https://arxiv.org/abs/2410.02694)) |
| LongMemEval | 2024-10, ICLR 2025 | 500 questions across 5 memory abilities (extraction, multi-session, temporal, knowledge update, abstention) | ~30% accuracy drop for chat assistants and long-context LLMs ([arXiv 2410.10813](https://arxiv.org/abs/2410.10813)) |
| NoLiMa (Adobe) | 2025-02, ICML 2025 | Needle with minimal lexical overlap, so literal matching can't solve it | At 32K, 11 of 13 models are below 50% of their short baseline; GPT-4o drops from 99.3% to 69.7% ([arXiv 2502.05167](https://arxiv.org/abs/2502.05167)) |
| Fiction.LiveBench | 2025-02 onward | Deep story comprehension up to 192k | Most models are below 80% at 192k; Gemini 2.5 Pro, GPT-5 and Grok 4 lead ([Epoch AI](https://epoch.ai/data-insights/context-windows); X posts via [@ficlive](https://x.com/ficlive)). I could not load the primary page, so treat this as secondary evidence. |
| Gemini docs | updated 2026-10 | Vendor statement | ~99% single-needle accuracy, but multiple needles are "not the same accuracy" ([Google](https://ai.google.dev/gemini-api/docs/long-context)) |
| OpenAI GPT-4.1 guide | 2025-04-14 | Vendor statement | Strong NIAH to 1M, but degrades on many-item retrieval or full-state reasoning such as graph search ([OpenAI](https://cookbook.openai.com/examples/gpt4-1_prompting_guide)) |

**Takeaway for a coding harness.** Coding tasks are *multi-needle, multi-hop and full-state reasoning*: call graphs, cross-file invariants, test failures. That is exactly where RULER, NoLiMa, HELMET and the GPT-4.1 guide show the largest drops. **Never use the advertised window as the working budget.**

### 3.5 Context poisoning

- **What.** A hallucination or error enters the context and is repeatedly referenced. Gemini 2.5 playing Pokémon became "fixated on achieving impossible or irrelevant goals", and the poisoning took "a very long time to undo" ([Breunig](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html)).
- **Severity ranking.** HumanLayer ranks *incorrect* information as worse than *missing* information, which is worse than *noise* ([ACE-FCA](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md)).
- **Tension.** Manus *keeps* failed actions and stack traces in context so the model updates away from them ("Erasing failure removes evidence") ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). 12-factor F3/F9 *hides resolved* errors ([12-factor](https://github.com/humanlayer/12-factor-agents)). These don't conflict: keep *observed* failures, which are evidence, and remove *the model's own false claims*, which are poison, once they are resolved.
- **Coding application.**
  - Keep compiler and test errors until the fix lands, then compact them into one line ("tried X, failed because Y").
  - Never carry forward unverified "facts" the agent asserted about the codebase. Compaction summaries should separate *verified* from *assumed*.
  - Restart from a fresh context plus artifacts when the trajectory is poisoned, rather than arguing with it.

### 3.6 Context distraction

- **What.** The context is so long that the model over-relies on it and under-uses its training: it repeats history instead of planning. Databricks found Llama-3.1-405B correctness falling around 32k ([Breunig](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html); [Databricks](https://www.databricks.com/blog/long-context-rag-performance-llms)).
- **Irrelevant-context sensitivity.** This is older evidence: GSM-IC showed that irrelevant sentences "dramatically" reduce accuracy. Self-consistency and an instruction to ignore irrelevant information help ([Shi et al., 2023](https://arxiv.org/abs/2302.00093)).
- **Mitigation.** Summarize or compact, use sub-agents for exploration, and use just-in-time loading.

### 3.7 Context confusion, including too many tools

- **What.** Superfluous content steers the output. The headline case is tools:
  - BFCL: every model does worse with more than one tool, and models sometimes call tools when none are relevant ([Breunig](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html)).
  - Llama 3.1 8B fails with 46 tools and succeeds with 19, well inside 16k. LLM-recommended tool subsets gave +44% on BFCL and −77% time ([arXiv 2411.15399](https://arxiv.org/abs/2411.15399), via [Breunig](https://www.dbreunig.com/2025/06/26/how-to-fix-your-context.html)).
  - RAG-MCP: selection becomes critical above 30 tools and fails "virtually guaranteed" above 100. Retrieval to fewer than 30 tools gives about 3× accuracy ([arXiv 2505.03275](https://arxiv.org/abs/2505.03275), via Breunig).
  - LongFuncEval: performance drops 7–85% with tool count, 7–91% with tool-*response* length, and 13–40% over longer multi-turn conversations ([arXiv 2505.10570](https://arxiv.org/abs/2505.10570)).
  - Microsoft's MCP survey (2025-09-11) of 1,470 servers: 775 tool-name collisions ("search" appears on 32 servers); mean response 4,431 tokens vs a median of 98; the largest averages 557,766 tokens; 16 tools exceed 128k. Flattening parameters gave +47% (Composio). OpenAI's soft guidance is fewer than 20 tools and a hard cap of 128 ([Microsoft Research](https://www.microsoft.com/en-us/research/blog/tool-space-interference-in-the-mcp-era-designing-for-agent-compatibility-at-scale/)).
  - OpenAI: "the issue is similarity or overlap, not just count". Some systems handle more than 15 distinct tools while others fail with fewer than 10 overlapping ones ([OpenAI guide, 2025-04](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)).
- **Coding application.**
  - Keep a small atomic core (read, write, edit, bash, search) and push the long tail behind bash/CLI or deferred tool search (§6.6).
  - Namespace MCP tools.
  - Cap tool output size: Claude Code defaults to 25k tokens ([Anthropic tools post](https://www.anthropic.com/engineering/writing-tools-for-agents)); Deep Agents offloads results above 20k ([LangChain](https://blog.langchain.com/context-management-for-deepagents/)).

### 3.8 Context clash and multi-turn drift

- **What.** New information conflicts with earlier context. Laban et al. (2025-05) sharded single-turn tasks across turns and ran 200k+ simulated conversations: performance dropped 39% on average, and o3 fell from 98.1 to 64.1. The drop is mainly *unreliability*, not lost aptitude. Models commit to early assumptions and "when LLMs take a wrong turn… they get lost and do not recover" ([arXiv 2505.06120](https://arxiv.org/abs/2505.06120); numbers via [Breunig](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html)).
- **Multi-agent version.** Sub-agents acting on unstated, conflicting assumptions: Cognition's Flappy Bird example produced a Mario-style background next to a mismatched bird ([Cognition](https://cognition.ai/blog/dont-build-multi-agents)).
- **Coding application.**
  - When requirements change mid-session, consolidate them into a single restated spec (a plan file) instead of letting contradictory turns accumulate.
  - Offer "restart with consolidated context" as a first-class action.
  - Sub-agents get explicit decisions and conventions in their briefs.

### 3.9 Instruction density and the instruction budget

- **What.** On IFScale (500 keyword instructions, 20 models), the best model reaches only about 68% at 500 instructions. There are three degradation patterns, plus a primacy bias ([arXiv 2507.11538](https://arxiv.org/abs/2507.11538)).
- **HumanLayer's heuristics.** Frontier thinking models follow "~150–200 instructions with reasonable consistency". By their proxy-capture analysis, Claude Code's system prompt alone holds about 50. Keep CLAUDE.md under 300 lines (theirs is under 60). Claude Code wraps CLAUDE.md in a reminder that it "may or may not be relevant", so diluted files get ignored ([HumanLayer, 2025-11-25](https://www.humanlayer.dev/blog/writing-a-good-claude-md)).
- **Coding application.** Count instructions across the system prompt, AGENTS.md, skills and tool guidelines. Use progressive disclosure: an index of docs with one-line descriptions. Enforce style with linters or hooks, not prose: "Never send an LLM to do a linter's job."

### 3.10 Self-induced failure modes in agent loops

- **Few-shot rut.** A uniform history of similar action–observation pairs makes the agent imitate it, causing drift and hallucination. Manus's example is reviewing 20 résumés. Fix: structured variation in serialization templates, phrasing and order ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
- **Goal drift after summarization.** Watch for the agent asking for clarification or declaring completion right after compaction. LangChain tests this by forcing summarization mid-task and by planting a "needle" that must be recovered from the filesystem ([LangChain, 2026-01-28](https://blog.langchain.com/context-management-for-deepagents/)).
- **Brevity bias and context collapse** in iteratively rewritten playbooks or summaries ([ACE](https://arxiv.org/abs/2510.04618)).
- **Long-run failure modes** ([Anthropic, 2025-11-26](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)):
  - "One-shotting": runs out of context mid-feature.
  - "Declaring victory early".
  - Leaving the environment broken.
  - Premature "done" without end-to-end tests.
  - Fixes: a feature list in JSON with `passes:false`, a progress file, git commits, and `init.sh`.

---

## 4. System prompt and instruction design

### 4.1 The "right altitude"

- **What.** Avoid both extremes ([Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)):
  - Too low: hard-coded brittle if/else logic.
  - Too high: vague guidance that "falsely assumes shared context".
  - Aim for the "minimal set of information that fully outlines your expected behavior", where "minimal does not necessarily mean short".
  - Process: start minimal with the best model, then add instructions for *observed* failures.
- **Support from other sources.**
  - OpenAI: convert existing SOPs into numbered routines, map each step to a concrete action, capture edge cases as branches, and use one templated base prompt rather than many prompts ([OpenAI guide](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)).
  - Anthropic docs: treat the model as "a brilliant but new employee"; explain *why* ("Claude can generalize from the explanation"); say what to do, not what not to do ([Anthropic best practices](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags)).
- **Tradeoff.** Too-high prompts under-specify, and too-low prompts break on unseen cases and use up the instruction budget (§3.9).
- **Coding application.**
  - Core rules: reversibility (ask before `rm -rf` or a force push), verification before "done", minimal diffs, no test tampering.
  - Each rule should state its *reason*.
  - Push procedures (how to run tests in repo X) into AGENTS.md or skills, not the global prompt.

### 4.2 Structure: XML vs Markdown vs JSON

- **Anthropic.** Use XML tags (`<instructions>`, `<context>`, `<documents><document index>`) consistently, nested for hierarchy. Exact formatting "may matter less as models improve" ([Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags)).
- **OpenAI (GPT-4.1).** Start with Markdown headings. XML also works well. For document lists, XML and `ID | TITLE | CONTENT` work well, while "JSON performed particularly poorly" ([OpenAI](https://cookbook.openai.com/examples/gpt4-1_prompting_guide)).
- **Anthropic tools post.** Choose XML, JSON or Markdown for tool *responses* by evaluation; "no one-size-fits-all" ([Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)).
- **12-factor.** A custom XML event log for history ([12-factor](https://github.com/humanlayer/12-factor-agents)).
- **Pi today.** Already emits named XML sections "so the model can match later updates to it" (`system-prompt.ts`).

### 4.3 Examples: canonical-diverse vs "don't get few-shotted"

- **Anthropic.** Few-shot is still "strongly advised", but use "diverse, canonical examples", not "a laundry list of edge cases" ([Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Docs: 3–5 examples in `<example>` tags that are relevant, diverse and structured ([docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags)).
- **Tool use examples.** 1–5 `input_examples` per tool raised complex-parameter accuracy from 72% to 90% ([Anthropic advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)).
- **OpenAI.** Put examples in an `# Examples` section of the system prompt, not inside tool descriptions ([OpenAI](https://cookbook.openai.com/examples/gpt4-1_prompting_guide)).
- **Many-shot (Google).** Hundreds to thousands of examples can approach fine-tuning, and become affordable with caching ([Gemini long context](https://ai.google.dev/gemini-api/docs/long-context)).
- **Manus.** The agent's *own history* acts as unintended few-shot examples, so inject variation ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
- **Reconciliation.** Designed examples should be diverse. Accidental examples (repetitive trajectories) should be diversified or compacted. **Caution:** "minor noise in formatting" works against deterministic serialization for caching. Apply variation only to *new* appended content, never by rewriting the prefix.

### 4.4 Placement and order

| Guidance | Source |
|---|---|
| Long documents at the **top**, query/instructions at the **end**; up to +30% on complex multi-document inputs (20k+ tokens) | [Anthropic docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/long-context-tips) |
| Query at the end "especially if the total context is long" | [Gemini docs](https://ai.google.dev/gemini-api/docs/long-context) |
| Instructions at **both** beginning and end beat either alone; if only one, put them **above** the context | [OpenAI GPT-4.1 guide](https://cookbook.openai.com/examples/gpt4-1_prompting_guide) |
| Query before and after the data makes key-value retrieval near-perfect | [Liu et al.](https://arxiv.org/html/2307.03172v3) |
| Ask the model to quote relevant parts first, then answer | [Anthropic docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/long-context-tips); recite-then-solve [Du et al.](https://arxiv.org/abs/2510.05381) |
| Recite objectives at the end of context (todo.md) | [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) |
| Static first, dynamic last (cache) | [OpenAI caching](https://platform.openai.com/docs/guides/prompt-caching), [ADK](https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/), [Lumer et al.](https://arxiv.org/abs/2601.06007) |

**Agent-loop synthesis.** The system prompt (rules) comes first and stays cached. Large observations go in the middle. The **most recent turn ends with the current goal, plan and state as a reminder**. This gives the OpenAI "both ends" effect without editing the prefix.

### 4.5 Agentic reminders that measurably help

- The OpenAI GPT-4.1 guide lists three reminders: *persistence* ("keep going until… resolved"), *tool-calling* ("do NOT guess… use your tools"), and *planning*. Together they gave about **+20% on SWE-bench Verified** (internal); planning alone gave +4%. Passing tools via the `tools` field instead of the prompt gave +2% ([OpenAI](https://cookbook.openai.com/examples/gpt4-1_prompting_guide)).
- Anthropic: if the harness compacts, *tell the model*, so it doesn't stop early from budget anxiety. Use structured state (JSON for tests, free text for progress, git for checkpoints) and prescriptive restart steps ("call pwd, read progress.txt, tests.json, git log") ([Anthropic docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags)).
- The parallel-tool-call instruction can push parallelism "toward ~100%" (same source).

### 4.6 Recitation and "system reminders"

- **Manus.** Rewriting `todo.md` keeps objectives in recent attention over about 50 tool calls ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). By October 2025, though, todo updates consumed about **one third of all actions**, so Manus moved planning to a planner sub-agent ([Martin](https://rlancemartin.github.io/2025/10/15/manus/)). Schmid puts it as "~30% of tokens" ([Schmid](https://www.philschmid.de/context-engineering-part-2)).
- **Claude Code.** Injects `<system-reminder>` blocks into user or tool-result messages (date, git status, todo state, mode changes) rather than editing the system prompt ([secondary: devaubree](https://blog.devaubree.fr/en/blog/prompt-caching-claude-code/), [claudecodecamp](https://www.claudecodecamp.com/p/how-prompt-caching-actually-works-in-claude-code); [HumanLayer proxy capture](https://www.humanlayer.dev/blog/writing-a-good-claude-md)).
- **Harness application.** Have the harness append a *cheap* state reminder (goal plus open todos plus mode) to the tail of each turn. The model then doesn't need to spend actions rewriting files.

### 4.7 Context files (AGENTS.md / CLAUDE.md)

- Context files dominate real-world harness configuration ([Galster et al.](https://arxiv.org/abs/2602.14690)).
- OpenAI Codex: one big AGENTS.md failed. They moved to about 100 lines as a *map* pointing to a structured `docs/` tree, i.e. progressive disclosure ([OpenAI harness engineering](https://openai.com/index/harness-engineering/), snippets).
- HumanLayer: under 60 lines; `file:line` pointers instead of snippets; don't auto-generate ([HumanLayer](https://www.humanlayer.dev/blog/writing-a-good-claude-md)).

---

## 5. Tool design as context engineering

Tools are "the contract between agents and their information/action space" ([Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Ranked practices:

1. **Fewer, workflow-level tools, not API wrappers.** For example `schedule_event` instead of list/list/create. Test: "If a human engineer can't definitively say which tool should be used… an AI agent can't be expected to do better" ([Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)).
2. **Namespacing** (`asana_projects_search`). Prefix vs suffix choice mattered per model in evaluations (same source). MCP lacks formal namespaces, which produces collisions ([Microsoft](https://www.microsoft.com/en-us/research/blog/tool-space-interference-in-the-mcp-era-designing-for-agent-compatibility-at-scale/)). Manus uses consistent prefixes such as `browser_` and `shell_` so logit masking can select a group ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
3. **High-signal outputs.**
   - Return names instead of UUIDs.
   - Offer a `response_format` of concise vs detailed (72 vs 206 tokens in Anthropic's example).
   - Paginate, filter and truncate with *steering* messages.
   - Write actionable errors (§3.5).
   - Sources: [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents); 12-factor F9.
4. **Descriptions written like onboarding a new hire.**
   - Use unambiguous parameter names (`user_id`) and strict schemas.
   - Small description edits produced SOTA on SWE-bench for Sonnet 3.5. A description fix stopped Claude from appending "2025" to every search ([Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)).
   - Flatten nested parameters: +47% per Composio, via [Microsoft](https://www.microsoft.com/en-us/research/blog/tool-space-interference-in-the-mcp-era-designing-for-agent-compatibility-at-scale/).
5. **Evaluation-driven iteration.** Use realistic multi-step tasks with verifiers; track tokens, calls and errors; let the model refactor tools from transcripts (same source).
6. **Layered action space.** A small set of fewer than 20 atomic tools plus a sandbox CLI and packages. Code execution can orchestrate many calls and keep intermediate data out of context: programmatic tool calling cut tokens 37% (43,588 → 27,297), and 200 KB of raw data became 1 KB in context ([Anthropic advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use); [Martin/Manus](https://rlancemartin.github.io/2025/10/15/manus/)).

For a coding harness, the core set is read (with ranges), edit (exact replace), write, bash (with output cap and offload), grep/glob, and possibly LSP/symbol tools. Everything else should be a skill or a deferred tool.

---

## 6. KV-cache and prompt-cache-aware design

### 6.1 Why it dominates

- **Hit rate is the key metric.** "the KV-cache hit rate is the single most important metric for a production-stage AI agent". Input:output is about **100:1** in Manus. Cached input on Claude Sonnet is $0.30/MTok vs $3 uncached, a **10×** gap ([Manus, 2025-07-18](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
- **Claude Code designs for caching first.** Its team "fundamentally ha[s] to design agents for prompt caching first", alerts on cache hit rate, and declares SEVs when it drops ([Thariq, 2026-02-19](https://x.com/trq212/status/2024638793719177291); details via [devaubree](https://blog.devaubree.fr/en/blog/prompt-caching-claude-code/)).
- **Hit rates and session cost.** An independent measurement found about 96% hit rate in real Claude Code sessions. A 100-turn Opus session costs an estimated $50–100 uncached vs $10–19 cached ([claudecodecamp, 2026-02-25](https://www.claudecodecamp.com/p/how-prompt-caching-actually-works-in-claude-code), secondary).
- **Peer-reviewed-style evidence.** Over 500 DeepResearch Bench sessions with 10k-token system prompts across OpenAI, Anthropic and Google: **−41–80% cost, −13–31% time to first token**. Naive full-context caching "can paradoxically increase latency". Best practice is to keep dynamic content at the end, avoid dynamic function sets, and exclude dynamic tool results from the cached block. The best strategy differs by provider ([Lumer et al., 2026-01-09](https://arxiv.org/abs/2601.06007)).

### 6.2 Provider mechanics (as fetched 2026-11-12; these change often)

| | Anthropic | OpenAI | Google Gemini |
|---|---|---|---|
| Mode | Explicit `cache_control` breakpoints (max 4) plus automatic caching (uses 1 slot) | Automatic prefix caching; explicit breakpoint on GPT-5.6+ | Explicit context caching (per-hour storage) plus implicit caching |
| Min size | 512–4,096 tokens depending on model | 1,024 visible tokens (GPT-5.6+) | see caching page |
| TTL | 5 min (refreshed on hit) or 1 h | in-memory ~5–10 min / 24 h (older); 30 m / 12 h (GPT-5.6+) | configurable |
| Price | write 1.25× (5 m) / 2× (1 h); read 0.1× (lower on some newest models) | read 0.1× (GPT-5.6+); write 1.25× (30 m) / 2.5× (12 h); "up to 95%" discount | ~4× cheaper per request in the docs' Flash example |
| Invalidation order | tools → system → messages; `tool_choice`, images and thinking params invalidate parts | hash of initial tokens incl. tools; `prompt_cache_key` for routing, ~15 rpm per key | — |
| Gotcha | lookback of only **20 blocks** per breakpoint, so add intermediate breakpoints in long histories | per-machine caches, overflow routing | — |
| Source | [Anthropic docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) | [OpenAI docs](https://platform.openai.com/docs/guides/prompt-caching) | [Gemini docs](https://ai.google.dev/gemini-api/docs/long-context) |

### 6.3 Design rules

Each rule lists what it is, why, its costs, and who uses it.

1. **Stable prefix.** No timestamps or per-turn state in the system prompt; "a single-token difference can invalidate the cache from that token onward" ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). In one experiment, changing "senior" to "Senior" dropped cache reads from 2,727 to 0. Moving a timestamp to the bottom recovered 20+ points of hit rate (anecdote) ([claudecodecamp](https://www.claudecodecamp.com/p/how-prompt-caching-actually-works-in-claude-code)). *Users:* Manus, Claude Code, ADK static instruction, OpenAI docs.
2. **Layer by volatility.** Global (system + tools) → per-project (AGENTS.md / memory) → per-session (env, MCP list) → messages ([devaubree on Thariq](https://blog.devaubree.fr/en/blog/prompt-caching-claude-code/)). Global layers become cross-user cache hits.
3. **Append-only history.** Don't modify earlier actions or observations ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus); [OpenAI docs](https://platform.openai.com/docs/guides/prompt-caching)). *Cost:* conflicts with pruning (§6.5).
4. **Deterministic serialization.** Stable JSON key order and stable tool ordering. Non-deterministic tool shuffling broke Claude Code's cache ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus); [devaubree](https://blog.devaubree.fr/en/blog/prompt-caching-claude-code/)).
5. **Explicit breakpoints.** At least at the end of the system prompt. Respect TTL. For self-hosted vLLM, enable prefix caching and route by session ID ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). Add mid-history breakpoints because of the 20-block lookback ([Anthropic docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)).
6. **State changes as messages, not prefix edits.** Date, git status and mode switches go into `<system-reminder>` in the next user or tool message ([claudecodecamp](https://www.claudecodecamp.com/p/how-prompt-caching-actually-works-in-claude-code)). Anthropic now also supports mid-conversation `role: "system"` messages that don't invalidate the cache on newer models ([Anthropic docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)).
7. **Don't switch models mid-session.** Caches are per model. At 100k tokens, asking Haiku costs more than letting Opus answer. Delegate to a sub-agent with a hand-off instead ([devaubree](https://blog.devaubree.fr/en/blog/prompt-caching-claude-code/)).
8. **Cache-safe forks for compaction and side tasks.** Reuse the identical system prompt, tools and history, then append the compaction instruction as a new user message, so only the new tokens are uncached (about 1/10 the price). Reserve a compaction buffer (same source). Schmid notes that forking with *different* shared context breaks the cache ([Schmid](https://www.philschmid.de/context-engineering-part-2)).
9. **Warm and monitor.** Pre-warm with `max_tokens: 0` ([Anthropic docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)). Track hit rate like uptime. *Pi already has* `cache-warmer.ts` (TTL-aware, expected-savings gating) and `cache-stats.ts`.

### 6.4 Mask, don't remove; defer, don't swap

- **Manus logit masking.** Tool definitions stay fixed. A state machine constrains decoding using prefill modes in Hermes format: *auto* (`<|im_start|>assistant`), *required* (`…<tool_call>`), and *specified* (`…<tool_call>{"name": "browser_`). Removing tools also leaves dangling references in history, which leads to schema violations and hallucinated calls ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). *Requires* constrained decoding or prefill, which hosted APIs expose only partially (`tool_choice`). Anthropic notes that changing `tool_choice` itself invalidates the system and tools cache layers ([docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)), and newer Claude models no longer support assistant prefill ([docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags)). For hosted frontier APIs, the practical equivalent is therefore **mode-as-message**.
- **Claude Code plan mode.** Keep all tools and add `EnterPlanMode` / `ExitPlanMode` tools. The mode change is a message, and the model can enter plan mode by itself ([devaubree](https://blog.devaubree.fr/en/blog/prompt-caching-claude-code/)).
- **Deferred tool loading.** Stubs carry `defer_loading: true` plus a `ToolSearch` tool, and full schemas are appended as messages when needed. Tool search "doesn't break prompt caching" ([Anthropic advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)). Use it when tool definitions exceed 10k tokens or there are 10+ tools (same source). Claude Code reportedly locks the MCP tool list at session start ([claudecodecamp](https://www.claudecodecamp.com/p/how-prompt-caching-actually-works-in-claude-code)).
- **Pi today.** `hiddenTools` / `prepareLoadout` exist. Make sure loadout changes never mutate the declared tool array mid-session; expose them via a search or dispatch tool instead.

### 6.5 Main tension: pruning and compaction vs cache continuity

- Every in-place removal (tool-result clearing, trimming) rewrites the prefix, which costs a full cache write.
- **Resolution patterns:**
  - (a) *Batch* removals and do them rarely. Thresholds go stale at 85% of the window in Deep Agents ([LangChain](https://blog.langchain.com/context-management-for-deepagents/)).
  - (b) Prefer **reversible compaction** (full → path stub) over summarization ([Martin/Manus](https://rlancemartin.github.io/2025/10/15/manus/), [Schmid](https://www.philschmid.de/context-engineering-part-2)).
  - (c) Offload large results *at ingestion*, before they enter the cached prefix. Deep Agents offloads results above 20k tokens with a 10-line preview ([LangChain](https://blog.langchain.com/context-management-for-deepagents/)).
  - (d) Use lifecycle-aware eviction that drops a segment only when its relevance expires, on a batch-turn schedule. TokenPilot reports −56–87% cost ([arXiv 2606.17016](https://arxiv.org/abs/2606.17016), 2026).
- **Order of preference** (Schmid): raw > compaction > summarization.

---

## 7. Disagreements and tensions between sources

| Topic | Position A | Position B | Notes / reconciliation |
|---|---|---|---|
| Multi-agent | Lead plus sub-agents gave +90.2% on an internal research eval; token usage explains 80% of BrowseComp variance ([Anthropic, 2025-06-13](https://www.anthropic.com/engineering/built-multi-agent-research-system)) | "Don't build multi-agents"; a single-threaded linear agent "will get you very far" ([Cognition, 2025-06-12](https://cognition.ai/blog/dont-build-multi-agents)) | Both agree coding is a poor fit for *parallel writers*. Anthropic itself says most coding tasks are less parallelizable. Consensus by late 2025: sub-agents for **read-only context isolation** that return compact results ([HumanLayer](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md), [Schmid](https://www.philschmid.de/context-engineering-part-2)) |
| Selecting tools per step | RAG over tools gives about 3× accuracy ([RAG-MCP via Breunig](https://www.dbreunig.com/2025/06/26/how-to-fix-your-context.html), [LangChain](https://blog.langchain.com/context-engineering-for-agents/)) | Don't RAG tool definitions per step, because it breaks the KV-cache and leaves dangling references ([Schmid](https://www.philschmid.de/context-engineering-part-2), [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)) | Deferred loading with appended schemas ([Anthropic](https://www.anthropic.com/engineering/advanced-tool-use)) gets selection *without* prefix mutation |
| Todo recitation | Rewrite todo.md to keep goals in recent attention ([Manus, 2025-07](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)) | It consumed about 1/3 of actions, so Manus moved to a planner agent ([Martin, 2025-10](https://rlancemartin.github.io/2025/10/15/manus/)) | Harness-injected reminders are a cheaper alternative (§4.6) |
| Errors in context | Keep failures in ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)) | Hide resolved errors ([12-factor F3](https://github.com/humanlayer/12-factor-agents)) | Keep until resolved, then compact into a lesson |
| Examples | Diverse canonical few-shot "strongly advised" ([Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)) | Uniform context makes agents brittle, so add variation ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)) | Different objects: designed examples vs self-generated history |
| Instruction placement | Data first, query last (Anthropic, Google) | Instructions at both ends, or above if only one (OpenAI GPT-4.1) | Model-family-specific. In agent loops, combine a cached top with a tail reminder |
| Message format | Standard chat messages (most SDKs) | Custom single-message XML event log ([12-factor F3](https://github.com/humanlayer/12-factor-agents)) | Custom formats lose native tool-call training priors. OpenAI measured +2% from using the API `tools` field over prompt-injected schemas ([OpenAI](https://cookbook.openai.com/examples/gpt4-1_prompting_guide)) |
| Embeddings for code | Windsurf: embedding search alone is unreliable at scale, so combine it with grep and graphs ([LangChain](https://blog.langchain.com/context-engineering-for-agents/)) | Manus and Claude Code: glob/grep only, no index ([Martin](https://rlancemartin.github.io/2025/10/15/manus/), [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)) | Covered in the retrieval slice |
| Harness structure vs model progress | Add structure for today's failures | "Bitter lesson": structure becomes the bottleneck. Eval across model strengths and be ready to delete scaffolding ([Martin/Manus](https://rlancemartin.github.io/2025/10/15/manus/)); Anthropic: "do the simplest thing that works" | Keep context-engineering features modular and removable |
| Data inconsistencies | Databricks text says Llama-405B declines after 32k; its table shows after 16k ([Databricks](https://www.databricks.com/blog/long-context-rag-performance-llms)). Anthropic tool search claims −85%, but its own numbers give about −89% ([Anthropic](https://www.anthropic.com/engineering/advanced-tool-use)) | — | Prefer the tables and raw numbers |

---

## 8. Implications for the Pi-based coding harness

Candidate work items, mapped to evidence:

1. **Quality-based context budget.** Make the compaction trigger a fraction of an *effective* window per model (e.g. a 40–60% target, or a ~128k cap on 1M models), not `window − reserve`. Evidence: §3.2 and §3.4.
2. **Staged reduction pipeline.**
   - (a) Offload oversized tool outputs at ingestion: write to a file and keep a head/tail preview plus a path. Deep Agents uses 20k; Claude Code caps output at 25k.
   - (b) Reversible compaction of stale read/bash results into path stubs, batched.
   - (c) Schema-based summarization (intent, decisions, verified vs assumed facts, files touched, next steps), done as a **cache-safe fork**, then rehydrate recently touched files.
   - (d) Eval: forced mid-task summarization plus needle recovery plus a goal-drift check.
3. **Cache discipline.**
   - Freeze the system prompt and tool array for the session.
   - Put date, cwd changes, git status, mode and todos into tail `<system-reminder>` messages.
   - Use deterministic JSON and tool order.
   - Add a breakpoint at the end of the system prompt, plus rolling message breakpoints (keeping the 20-block lookback in mind).
   - Don't switch models in-thread; use sub-agents instead.
   - Track hit rate as a first-class metric and alert on drops. Pi already has warming and stats, so extend them.
4. **Tool surface.** Use fewer than 20 atomic core tools. MCP and long-tail tools go behind deferred search or a bash CLI. Namespace and dedupe names, cap outputs, write steering errors, and add `input_examples` for complex tools.
5. **Prompt layering.** Write a minimal right-altitude core with reasons attached to rules. Keep AGENTS.md as a short map; put procedures in skills and docs (progressive disclosure). Track an instruction budget (~150–200 total). Enforce style through linters and hooks.
6. **Attention shaping.** Add a tail reminder with goal, plan and open todos each turn, generated by the harness. Use recite-then-solve prompts for edits ("quote target lines before editing"). Put the user's latest request last.
7. **Poisoning and clash hygiene.** Compaction summaries mark *verified* vs *assumed*. Restating changed requirements produces a single spec file. Offer a fresh-context restart from artifacts (plan, progress, git log), following Anthropic's long-running harness pattern.
8. **Isolation.** Read-only explore sub-agents return about 1–2k-token summaries under an output schema. Avoid parallel writers (Cognition, Anthropic). Hand-offs recast prior assistant turns as narrative (ADK).

---

## Sources

Primary and vendor sources, with publication dates. Secondary sources are marked (sec).

**Definitions and frameworks**
- Anthropic — Effective context engineering for AI agents (2025-09-29): https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- LangChain — Context engineering for agents (2025-07-02): https://blog.langchain.com/context-engineering-for-agents/
- LangChain — Context management for Deep Agents (2026-01-28): https://blog.langchain.com/context-management-for-deepagents/
- Manus (Yichao Ji) — Context Engineering for AI Agents: Lessons from Building Manus (2025-07-18): https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Lance Martin — Context Engineering in Manus (2025-10-15): https://rlancemartin.github.io/2025/10/15/manus/
- Drew Breunig — How Long Contexts Fail (2025-06-22): https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html
- Drew Breunig — How to Fix Your Context (2025-06-26): https://www.dbreunig.com/2025/06/26/how-to-fix-your-context.html
- Philipp Schmid — The New Skill in AI is Not Prompting, It's Context Engineering (2025-06-30): https://www.philschmid.de/context-engineering
- Philipp Schmid — Context Engineering for AI Agents: Part 2 (2025-12-04): https://www.philschmid.de/context-engineering-part-2
- Andrej Karpathy — X post (2025-06-25): https://x.com/karpathy/status/1937902205765607626
- Simon Willison — Context engineering (2025-06-27): https://simonwillison.net/2025/Jun/27/context-engineering/
- HumanLayer — 12-Factor Agents (2025): https://github.com/humanlayer/12-factor-agents
- HumanLayer — Advanced Context Engineering for Coding Agents (2025-08/09): https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md
- HumanLayer — Writing a good CLAUDE.md (2025-11-25): https://www.humanlayer.dev/blog/writing-a-good-claude-md
- Google — Architecting efficient context-aware multi-agent framework for production (2025-12-04): https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/
- Google ADK — Agent context docs (2026, undated): https://google.github.io/adk-docs/context/
- OpenAI — A practical guide to building agents (2025-04): https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf
- OpenAI — Harness engineering: leveraging Codex in an agent-first world (2026-02-11; snippets only): https://openai.com/index/harness-engineering/
- Cognition — Don't Build Multi-Agents (2025-06-12): https://cognition.ai/blog/dont-build-multi-agents
- Anthropic — How we built our multi-agent research system (2025-06-13): https://www.anthropic.com/engineering/built-multi-agent-research-system
- Anthropic — Effective harnesses for long-running agents (2025-11-26): https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Anthropic — Managing context on the Claude Developer Platform (2025-09-29): https://www.anthropic.com/news/context-management

**Academic surveys and taxonomies**
- Mei et al. — A Survey of Context Engineering for LLMs (2025-07-17): https://arxiv.org/abs/2507.13334
- Hua et al. — Context Engineering 2.0 (2025-10-30): https://arxiv.org/abs/2510.26493
- Zhang et al. — ACE: Agentic Context Engineering (2025-10-06; ICLR 2026): https://arxiv.org/abs/2510.04618
- Vishnyakova — Context Engineering: From Prompts to Corporate Multi-Agent Architecture (2026-03-10): https://arxiv.org/abs/2603.09619
- Galster et al. — Harness Engineering for Agentic AI Coding Tools (2026-02-16): https://arxiv.org/abs/2602.14690
- Agent Harness for LLM Agents: A Survey (2026-04, preprint): https://doi.org/10.20944/preprints202604.0428.v1
- From Question Answering to Task Completion: A Survey on Agent System and Harness Design (2026-06): https://arxiv.org/html/2606.20683v1

**Failure modes and long-context evaluation**
- Chroma — Context Rot (2025-07-14): https://research.trychroma.com/context-rot
- Liu et al. — Lost in the Middle (2023-07-06; TACL): https://arxiv.org/abs/2307.03172 and https://arxiv.org/html/2307.03172v3
- Du et al. — Context Length Alone Hurts LLM Performance Despite Perfect Retrieval (2025-10-06; EMNLP Findings): https://arxiv.org/abs/2510.05381
- Hsieh et al. — RULER (2024-04-09; COLM 2024): https://arxiv.org/abs/2404.06654
- Modarressi et al. — NoLiMa (2025-02-07; ICML 2025): https://arxiv.org/abs/2502.05167
- Yen et al. — HELMET (2024-10-03; ICLR 2025): https://arxiv.org/abs/2410.02694
- Wu et al. — LongMemEval (2024-10-14; ICLR 2025): https://arxiv.org/abs/2410.10813
- An et al. — Why Does the Effective Context Length of LLMs Fall Short? (2024-10-24): https://arxiv.org/abs/2410.18745
- Kamradt — Needle In A Haystack (2023-11): https://github.com/gkamradt/LLMTest_NeedleInAHaystack
- Databricks — Long Context RAG Performance of LLMs (2024-08-12): https://www.databricks.com/blog/long-context-rag-performance-llms
- Laban et al. — LLMs Get Lost in Multi-Turn Conversation (2025-05-09): https://arxiv.org/abs/2505.06120
- Shi et al. — LLMs Can Be Easily Distracted by Irrelevant Context (2023-01-31): https://arxiv.org/abs/2302.00093
- Jaroslawicz et al. — How Many Instructions Can LLMs Follow at Once? (IFScale, 2025-07-15): https://arxiv.org/abs/2507.11538
- Epoch AI — Context windows data insight (2025) (sec. for Fiction.LiveBench): https://epoch.ai/data-insights/context-windows
- Fiction.live — @ficlive posts (2025) (sec.): https://x.com/ficlive

**Tools and tool overload**
- Anthropic — Writing effective tools for agents (2025-09-11): https://www.anthropic.com/engineering/writing-tools-for-agents
- Anthropic — Introducing advanced tool use (2025-11-24): https://www.anthropic.com/engineering/advanced-tool-use
- Microsoft Research — Tool-space interference in the MCP era (2025-09-11): https://www.microsoft.com/en-us/research/blog/tool-space-interference-in-the-mcp-era-designing-for-agent-compatibility-at-scale/
- Kate et al. — LongFuncEval (2025-04-30): https://arxiv.org/abs/2505.10570
- "Less is More" — tool-count / tool-recommender paper (2024-11): https://arxiv.org/abs/2411.15399
- Gan & Sun — RAG-MCP (2025-05): https://arxiv.org/abs/2505.03275
- Provence — trained context pruner for QA (2025-01): https://arxiv.org/abs/2501.16214

**Prompt design and placement**
- Anthropic — Prompting best practices / long-context tips / XML tags (live docs, fetched 2026-11-12): https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/long-context-tips and https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags
- OpenAI — GPT-4.1 Prompting Guide (2025-04-14): https://cookbook.openai.com/examples/gpt4-1_prompting_guide
- Google — Gemini API long context (updated 2026-10-15): https://ai.google.dev/gemini-api/docs/long-context

**Caching**
- Anthropic — Prompt caching docs (live, fetched 2026-11-12): https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- OpenAI — Prompt caching guide (live, fetched 2026-11-12): https://platform.openai.com/docs/guides/prompt-caching
- Lumer et al. — Don't Break the Cache (2026-01-09): https://arxiv.org/abs/2601.06007
- Xu et al. — TokenPilot: Cache-Efficient Context Management (2026-06-15): https://arxiv.org/abs/2606.17016
- Thariq Shihipar — Lessons from Building Claude Code: Prompt Caching Is Everything (2026-02-19): https://x.com/trq212/status/2024574133011673516 and https://x.com/trq212/status/2024638793719177291
- (sec.) Kevin Aubrée — summary of Thariq's post: https://blog.devaubree.fr/en/blog/prompt-caching-claude-code/
- (sec.) Claude Code Camp — How prompt caching actually works in Claude Code (2026-02-25): https://www.claudecodecamp.com/p/how-prompt-caching-actually-works-in-claude-code
