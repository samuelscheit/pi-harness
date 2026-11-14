# 03 — Selecting what enters the context: code retrieval, tools, skills, instructions

Slice 3 of 6 of the context-engineering map. Researched November 2026. Every claim links a source. Labels: **[primary]** means a vendor post, official docs, a paper, or source code. **[secondary]** means a blog, reverse-engineering write-up, or forum post. Treat secondary claims as unverified.

## TL;DR (10 lines)

1. Frontier harnesses have converged on a **just-in-time** default. The model gets a small pinned layer (instruction files, a tool and skill index, environment facts) and pulls everything else in with grep, glob, read and LSP. Anthropic calls this a "hybrid": some context up front for speed, the rest by exploration.
2. **Agentic search vs. embeddings is not settled.** Claude Code dropped vector RAG for grep ("generally works better", "just vibes"). Cursor measured +12.5% average QA accuracy (6.5–23.5%) with semantic search *added to* grep, mostly on repos of 1,000+ files. Cognition's answer is a fast, RL-trained parallel-grep subagent.
3. Most of the ACI gain comes from **bounding observations**. In SWE-agent's ablation, a 100-line viewer beats both a full-file view (−5.3 pts) and a 30-line one, summarized search beats iterative search (−6 pts), and a lint gate on edits is worth 3 pts.
4. **Tool definitions are the biggest fixed context cost.** 58 MCP tools take about 55K tokens. Tool selection falls apart past ~30–100 candidates. Retrieval over tools fixes both: Anthropic Tool Search went from 49% to 74% on Opus 4, and RAG-MCP from 13.6% to 43.1%.
5. **Code-as-tool-interface ("code mode")** makes tool cost almost independent of tool count: 150K to 2K tokens (Anthropic), and about 1K tokens for 2,500 endpoints (Cloudflare). Intermediate results also never reach the model.
6. Tool *quality* beats tool *quantity*: consolidated workflow tools, namespacing, `response_format` concise/detailed (about 3× fewer tokens), actionable errors, truncation with steering, and `input_examples` (72% to 90% on complex parameters).
7. **Progressive disclosure** (Agent Skills) is now a cross-vendor standard (agentskills.io; Claude Code, Codex, Pi, and others): about 100 tokens of metadata per skill, a body under 5K tokens when activated, and resources on demand. Listings are budgeted at 1–2% of the context window.
8. Progressive disclosure has a real failure mode: **the model does not trigger it**. Vercel's skill went uninvoked in 56% of cases, and an 8 KB compressed docs *index* in AGENTS.md scored 100% vs. 53–79% for skills. Always-on *pointers* beat on-demand *bodies* for horizontal knowledge.
9. Instruction files are hierarchical and increasingly **lazy**. AGENTS.md (60k+ repos, Linux Foundation) is closest-wins. Claude Code loads subdirectory CLAUDE.md and `paths:`-scoped rules only when a matching file is read. Codex caps the merged chain at 32 KiB.
10. **Mid-conversation injection** (hooks' `additionalContext`, `<system-reminder>`, `!`cmd`` in skills) is how mature harnesses keep context fresh and steer late in long sessions. For Pi, the biggest gaps are: lazy nested AGENTS.md and path rules, a skill-listing budget, environment and git facts, a reminder channel, and an optional repo map and LSP tool.

---

## 0. Where Pi stands today (baseline for "apply to our harness")

These facts come from the vendored source:

- **Instruction files.** [resource-loader.ts](../../../vendor/pi/packages/coding-agent/src/core/resource-loader.ts#L212) loads `AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` from the agent dir, then from every ancestor of cwd, **eagerly**, one file per directory, with handling for worktree shadowing. Files in subdirectories below cwd are not loaded, there is no lazy loading, no path-scoped rules and no byte cap.
- **Skills.** [skills.ts](../../../vendor/pi/packages/coding-agent/src/core/skills.ts#L358) renders an `<available_skills>` XML list with name, description and location. `disable-model-invocation` hides a skill. The model loads a skill with `read` or `bash`. There is no listing budget, no `paths:` gating, and no re-attachment after compaction.
- **System prompt.** [system-prompt.ts](../../../vendor/pi/packages/coding-agent/src/core/system-prompt.ts#L128) builds named, tagged sections (`tools`, `rules`, `docs`, `project_context`, `skills`, `cwd`, plus custom ones). It already includes a progressive-disclosure pointer to Pi's own docs. It does **not** inject the date, git status or platform.
- **Tools.**
  - MCP tools have four exposure modes ([mcp-servers.ts](../../../vendor/pi/packages/coding-agent/src/core/mcp-servers.ts#L52)): `codemode` (the default; callable only from scripts and found with `searchTools()`), `deferred` (loaded by `tool_search`), `direct`, and `hidden`.
  - `tool_search` is a BM25 ranker over name, description, schema and namespace text, with a default limit of 8 ([tool-search/tool.ts](../../../vendor/pi/packages/coding-agent/src/extensions/tool-search/tool.ts#L1)). Its comment says "a hybrid ranker with embeddings can replace it".
  - `pi-codemode` runs model-written JS in a QuickJS sandbox. Only the script output reaches the model.
- **Code retrieval.**
  - Core Pi ships `read`, `grep`, `find`, `ls` and `bash`. Output is truncated at 2,000 lines or 50 KB, and grep lines at 500 characters ([truncate.ts](../../../vendor/pi/packages/coding-agent/src/core/tools/truncate.ts#L11)).
  - In this harness, the vendored pi-lens extension adds LSP diagnostics and navigation, `symbol_search`, `module_report`, `read_symbol` and ast-grep. That is an LSP/AST layer with on-demand tool activation.

In short, Pi already implements the 2025–26 frontier patterns for *tools* (deferral, code mode, search) and the basics of *skills* and *AGENTS.md*. Its gaps are mostly **instruction laziness and scoping, budgets, freshness signals, and retrieval quality evaluation**.

---

## 1. Code context retrieval

### 1.1 Agentic search: grep, glob, read in a loop

- **Mechanism.** The model issues search tools (ripgrep, glob, read with offset and limit) and iterates. It keeps lightweight identifiers such as paths and line numbers rather than content. No index exists, so nothing goes stale.
- **Claude Code's choice to drop RAG.**
  - Boris Cherny (X, ~Feb 1 2026): "Early versions of Claude Code used RAG + a local vector db, but we found pretty quickly that agentic search generally works better. It is also simpler and doesn't have the same issues around security, privacy, staleness, and reliability." [primary] https://x.com/bcherny/status/2017824286489383315
  - Asked for the benchmark, he reportedly answered that it "was just vibes". [secondary] https://x.com/aakashgupta/status/2018933856460775597
  - A secondary quote attributed to a Latent Space appearance says it "outperformed everything. By a lot." [secondary] https://robertheubanks.substack.com/p/anthropic-replaced-their-rag-pipeline
- **Anthropic's framing.** Anthropic (Sep 29 2025): "CLAUDE.md files are naively dropped into context up front, while primitives like glob and grep allow it to navigate its environment and retrieve files just-in-time, effectively bypassing the issues of stale indexing and complex syntax trees." The stated tradeoff is that "runtime exploration is slower than retrieving pre-computed data". [primary] https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- **Costs.**
  - Latency and tokens. Cognition saw agents "often spending >60% of their first turn just retrieving context", with agentic search taking 10–20 serial turns. Exploration also floods context with "tens of thousands of tokens worth of irrelevant information". [primary, Oct 16 2025] https://cognition.com/blog/swe-grep
  - The Claude Code team concedes the approach comes "at the cost of latency and tokens". [secondary quote] https://relace.ai/blog/fast-agentic-search
- **Who uses it.** Claude Code, Codex CLI, Pi, Gemini CLI, opencode. A source-code study of 11 agents found none used vector RAG for code. [secondary paper, unverified] https://arxiv.org/pdf/2609.00006
- **When it helps.** Fresh or private code, frequently changing trees, exact-identifier queries, and security-sensitive environments with no upload.

### 1.2 Fast agentic search as a subagent (Cognition SWE-grep / Windsurf Fast Context)

- **Mechanism.** A small RL-trained model has a restricted toolset (grep, glob, read). It makes up to **8 parallel calls per turn** for at most **4 turns** (3 to explore, 1 to answer), and returns **files and line ranges**, not prose. [primary] https://cognition.com/blog/swe-grep
- **Reward.** Weighted F-β with **β=0.5**, which favors precision over recall: "context pollution hurt more than omitting some context".
- **Measured.**
  - 650 tok/s (SWE-grep) and 2,800 tok/s (mini) on Cerebras.
  - Going from 4 to 8 parallel searches cut turns from 6 to 4 at equal quality.
  - Windsurf documents "up to 20x faster" retrieval. [primary] https://docs.windsurf.com/context-awareness/fast-context
- **Relace** applied the same idea of exploiting parallel tool calls to make agentic search 4× faster. https://relace.ai/blog/fast-agentic-search
- **Applies to Pi.**
  - Use a `search` subagent on a cheap or fast model with read-only tools and a hard parallelism and turn budget.
  - Return a structured `{path, ranges}` list, not prose, and let the main agent read those ranges itself.
  - Precision-biased output ("fewer, right files") is the lesson to copy even without RL.

### 1.3 Embedding / vector indexing

| System | Mechanism | Measured result | Notes |
|---|---|---|---|
| **Cursor** | Syntactic (tree-sitter) chunks, embeddings cached by chunk hash, Merkle tree of file hashes so a sync descends only into changed subtrees, simhash to reuse a teammate's index. [primary] https://cursor.com/blog/secure-codebase-indexing | Index reuse cut time-to-first-query "from hours to seconds" on the largest repos (same source). Semantic search gave **+12.5% avg** QA accuracy (6.5–23.5% by model), **+2.6% code retention on 1,000+ file repos** (+0.3% overall), and 2.2% fewer dissatisfied follow-ups. [primary, Nov 6 2025] https://cursor.com/blog/semsearch | The embedding model was trained on agent traces: an LLM ranks which chunks *would have helped* at each step. Cursor concludes that **grep and semantic search together** work best. An unconfirmed later claim says semantic search was quietly removed. [secondary] https://dikrana.dev/blog/code-context-benchmarks-cant-tell/ |
| **Windsurf** | A "RAG-based" context engine plus local indexing. Remote indexing for Enterprise keeps only embeddings and honors `.codeiumignore`; about 300 MB RAM per 5k files. [primary] https://docs.windsurf.com/context-awareness/remote-indexing, https://docs.windsurf.com/context-awareness/windsurf-ignore | n/a | Now paired with SWE-grep Fast Context. |
| **Augment Context Engine** | A real-time, branch-aware semantic index, also exposed as MCP (local stdio via Auggie, or remote). [primary] https://www.augmentcode.com/blog/context-engine-mcp-now-live | Vendor-reported: **+70–80%** agent PR quality when added to Claude Code, Cursor or Codex. [primary, vendor eval] | Closed-source and paid, with no independent replication. https://rywalker.com/research/augment-context-engine |
| **Sourcegraph Cody** | Started with embeddings ("easily 10 times better with embeddings"), then "replace[d] embeddings for context retrieval with Sourcegraph's native platform" (keyword and code search) plus local context. [primary] https://about.sourcegraph.com/blog/cody-is-cheating, https://sourcegraph.com/blog/how-cody-understands-your-codebase | n/a | The paper frames context as a recommender-system problem. https://arxiv.org/abs/2408.05344 |
| **Continue** | Hybrid of embeddings (transformers.js, local) and keyword search. Retrieves `nRetrieve`=25, then **reranks** to `nFinal`=5. [primary, deprecated docs] https://docs.continue.dev/reference/deprecated-codebase | n/a | Its agent mode uses a different path. |
| **Moatless Tools** | A LlamaIndex vector index with roughly method-level chunks (Voyage embeddings), used as a search tool inside a lean agent. [primary] https://pypi.org/project/moatless/0.0.1/ | 24% on SWE-bench Lite at about $0.13 per instance with GPT-4o (v0.0.1). | Low cost depends on a prebuilt index. |

**Academic evidence.**

- **CodeRAG-Bench** (2024): for code, dense and code-specific embedders (Voyage-code, Jina-v2-code) often beat BM25, unlike in general text retrieval. BM25 is still about 100× cheaper per query. Gold documents add +27.4% on SWE-bench Lite for GPT-4o, so *retrieval quality* is the bottleneck, not the generator. [primary] https://arxiv.org/abs/2406.14497
- **Agentless**: combining LLM prompting over the repo tree with embedding retrieval gives the best file localization: **81.67%** vs. 78.67% (prompting only) vs. 70.33% (embedding only). [primary] https://arxiv.org/html/2407.01489v2

**Tradeoffs.**

- Embeddings help on large repos, on conceptual queries ("where is auth handled"), and when lexical overlap is low.
- They cost index staleness, privacy and upload concerns, infrastructure, and the risk of "too much weight to irrelevant information". [primary] https://cognition.com/blog/swe-grep

**Applies to Pi.** Keep grep as the default. If we add semantic search, do it as **an optional tool, not pre-inference injection**: a local index (tree-sitter chunks plus a content-hash cache, Merkle-style incremental sync) exposed as `semantic_search`. Then evaluate it on *our* tasks; Cursor's gain only became material above about 1,000 files. The same BM25 and embedding hybrid can serve `tool_search`, whose interface is already designed for it.

### 1.4 Repo maps (Aider)

- **Mechanism.**
  - Tree-sitter extracts definitions and references.
  - A file graph is built with an edge for each dependency.
  - A graph ranking algorithm, PageRank personalized toward files in the chat, picks the most-referenced symbols.
  - The result is rendered as signatures with `⋮...` elisions within a token budget: `--map-tokens` defaults to 1K and expands substantially "when no files have been added to the chat".
  - Sources: [primary, Oct 22 2023] https://aider.chat/2023/10/22/repomap.html and https://aider.chat/docs/repomap.html. PageRank via networkx and the personalization details: [secondary] https://deepwiki.com/Aider-AI/aider/4.1-repository-mapping-system
- **Measured.** The primary sources publish no ablation. The tree-sitter map replaced a ctags map for richer signatures and easier installation.
- **Who uses it.** Aider. Ports exist: RepoMapper (https://github.com/pdavis68/RepoMapper) and repomap-mcp, with `focus_files` to bias the PageRank (https://github.com/mi7chal/repomap-mcp).
- **Related.**
  - **Agentless** uses a repo tree, then **skeletons** (class and function signatures plus comments), then full code. Skeletons beat full files on localization (58.33% vs. 53.67%) at about 10% fewer LoC and 1/7 the cost. [primary] https://arxiv.org/html/2407.01489v2
  - **Anthropic** notes that folder structure itself is signal: `tests/test_utils.py` vs. `src/core_logic/test_utils.py`. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- **Tradeoffs.** Cheap orientation (about 1K tokens) and good for "where should this go" questions. But it is a pre-inference push, so it pays tokens on every turn, and in big repos the ranking may miss the relevant part.
- **Applies to Pi.** Offer a `repo_map` *tool* (pull, not push) with a token budget and a `focus` argument. pi-lens's `project_report` and `module_report` already approximate this. Optionally pin a tiny map (about 500 tokens) in the system prompt for the first turn only.

### 1.5 LSP navigation, AST and code graphs

- **AutoCodeRover.** Program-structure-aware search APIs (class, method and code-snippet search over the AST), plus **spectrum-based fault localization** when tests exist. Results: 19% on Lite at first, later 30.67% on Lite and 46.2% on Verified. [primary] https://arxiv.org/abs/2404.05427, https://github.com/AutoCodeRoverSG/auto-code-rover
- **Claude Code LSP tool** (v2.0.74+, Dec 2025). Go-to-definition, find-references, hover, document symbols, implementations and call hierarchy, with language plugins installed via `/plugin`. [secondary] https://claudelog.com/faqs/what-is-lsp-tool-in-claude-code/, https://github.com/boostvolt/claude-code-lsps
- **Serena MCP.** LSP-backed `find_symbol`, `find_referencing_symbols`, `get_symbols_overview`, and symbol-level edits (`replace_symbol_body`, rename). If grep tools stay available, Claude tends to drift back to grep; Serena's `--context claude-code` mode disables its duplicate file tools. [secondary] https://mcp.so/servers/serena, https://mcpvault.io/blog/serena-mcp-server-guide
- **When it helps.** Precise cross-file navigation in typed languages, large refactors, and disambiguating overloaded names. Reading a symbol body instead of a whole file also saves tokens.
- **Tradeoffs.** A language-server dependency per language, startup latency, flaky servers, and models prefer grep unless the tools are clearly better and described as such.
- **Applies to Pi.** pi-lens already provides `read_symbol`, `module_report`, `symbol_search` and on-demand LSP tools. Two things are left:
  - Tool descriptions that steer *when* symbol tools beat grep.
  - An eval comparing token cost of `read_symbol` vs. `read`.

### 1.6 SWE-agent's Agent-Computer Interface (ACI)

- **Design** (NeurIPS 2024). [primary] https://arxiv.org/abs/2405.15793, https://arxiv.org/html/2405.15793v3
  - The file viewer shows **100 lines** with line numbers, the path, total lines and lines omitted above and below, and supports `open`, `goto`, `scroll_up` and `scroll_down`.
  - `search_file`, `search_dir` and `find_file` return **at most 50 results**. Beyond that, they report nothing and ask the agent to narrow the query.
  - `edit n:m` runs **flake8** (syntax and undefined-name codes). An edit that fails lint is **reverted**, and the agent is shown the error, the would-be file, and "DO NOT re-run the same failed edit command".
  - Observations older than the last 5 collapse to one line each.
- **Ablation** (SWE-bench Lite, GPT-4 Turbo; full system = 18.0%):

| Variant | % resolved | Δ |
|---|---|---|
| Edit without linting | 15.0 | −3.0 |
| No edit command | 10.3 | −7.7 |
| Iterative search (no summary) | 12.0 | −6.0 |
| No search commands | 15.7 | −2.3 |
| Viewer 30 lines | 14.3 | −3.7 |
| Viewer = full file | 12.7 | −5.3 |
| Full history (no collapsing) | 15.0 | −3.0 |
| Shell-only baseline (Table 1) | 11.0 | −7.0 |

- **Lesson.** Bounded, informative observations beat both too little and too much. Note that "no search" (15.7) did better than *iterative* search (12.0): a badly shaped search tool is worse than none.
- **Applies to Pi.** Pi's truncation (2,000 lines or 50 KB) is far looser than 100 lines. Several changes follow:
  - Make `read`'s default page smaller and footer-annotated ("lines 1–200 of 3,412; use offset").
  - Make `grep` *refuse* above N matches with a "narrow your query" hint instead of returning a truncated wall.
  - Add a syntax lint gate on `edit`. pi-lens diagnostics already run after edits; consider *rejecting* syntax-breaking edits.

### 1.7 Pipeline localization: Agentless and friends

- **Agentless** (Jul 2024). Fixed phases with no agent loop. [primary] https://arxiv.org/html/2407.01489v2
  - **Localize** hierarchically: tree to top-3 files, combined with embeddings, then file skeletons to classes and functions, then code to edit lines.
  - **Repair**: ±10-line windows producing search/replace diffs, 40 samples per bug.
  - **Validate**: generated reproduction tests plus regression tests, then majority vote.
  - Result: **32% on Lite at $0.70** per issue.
- **Moatless** uses a similar "smart search, then narrow edits" state machine, at 24–39% on Lite depending on model and version. [primary/secondary] https://pypi.org/project/moatless/0.0.1/, https://medium.com/@te2be/coding-agents-open-source-approaches-on-swe-bench-074cc28c5bb0
- **When it helps.** Batch or CI repair, cost-capped runs, and weaker models. It is worse for open-ended interactive work.
- **Applies to Pi.** The *skeleton* idea is directly reusable, either as a `read --outline` mode or as pi-lens `module_report`. The phase pipeline belongs in a workflow or skill, not the core loop.

### 1.8 Rerankers and hybrid retrieval

- **Pattern.** Over-retrieve cheaply (BM25 and/or embeddings), then rerank with a cross-encoder or LLM down to k. Continue retrieves 25 and keeps 5 (Voyage `rerank-1` is supported). [primary] https://docs.continue.dev/reference/deprecated-codebase, https://github.com/continuedev/continue/issues/1848
- **Cursor** trains the *embedder itself* on LLM-generated relevance rankings from agent traces, which bakes in a reranker's signal. https://cursor.com/blog/semsearch
- **Agentless** combines lists by intersecting the top files from two retrievers. https://arxiv.org/html/2407.01489v2
- **Applies to Pi.** The cheapest win is to use the *main model as the reranker*: tools return compact candidate lists (path, symbol, score, one-line snippet) and the model chooses what to read. Add a cross-encoder only if evals show it is needed.

### 1.9 Just-in-time vs. up-front: decision table

| Content | Load up front | Load just in time |
|---|---|---|
| Build, test and lint commands; hard rules | ✅ (AGENTS.md; small) | |
| Directory-specific conventions | | ✅ when a file in that dir is read (Claude Code nested CLAUDE.md, `paths:` rules) |
| Repo orientation | Tiny map or tree on turn 1 (optional) | ✅ `repo_map`/`find` tool |
| Code bodies | | ✅ grep, read, LSP |
| Framework docs not in training data | ✅ **compressed index of paths** (Vercel 8 KB) | ✅ actual doc files via read |
| Tool definitions | 3–5 core tools | ✅ deferred and searched |
| Workflows and procedures | Name and description only | ✅ SKILL.md body on activation |

Sources: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents, https://code.claude.com/docs/en/memory, https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals, https://www.anthropic.com/engineering/advanced-tool-use

---

## 2. Tools as context

### 2.1 Tool count and degradation

- **Token cost.** GitHub (35 tools, ~26K), Slack (~21K), Sentry, Grafana and Splunk add up to **58 tools ≈ 55K tokens**. Jira alone is ~17K, and Anthropic has seen **134K tokens** of tool definitions before optimization. [primary, Nov 24 2025] https://www.anthropic.com/engineering/advanced-tool-use
- **GitHub MCP.**
  - Default toolsets cut usage from 64.6K to 30.3K tokens (−53%). [primary] https://github.com/github/github-mcp-server/discussions/1182
  - Loading only 3–10 tools cuts a further ~60–90%. [primary] https://github.blog/changelog/2025-12-10-the-github-mcp-server-adds-support-for-tool-specific-configuration-and-more/
- **Accuracy.**
  - RAG-MCP's stress test: selection is mostly correct (>90%) below ~30 candidate servers, has intermittent failures from 31 to 70, and failure dominates beyond ~100. These thresholds are read off a heatmap. [primary] https://arxiv.org/html/2505.03275v1
  - "Less is More" (DATE 2025): dynamically shrinking the tool list improves small-model success and cuts execution time by up to 70%. [primary] https://arxiv.org/abs/2411.15399
- **Vendor guidance.**
  - OpenAI: keep tools available at the start of a turn under ~20 ("soft suggestion"), or use tool search. [primary] https://developers.openai.com/api/docs/guides/function-calling
  - Anthropic: consider tool search at 10+ tools or above 10K tokens of definitions, and keep 3–5 tools always loaded. https://www.anthropic.com/engineering/advanced-tool-use
- **Overlap is the real failure.** "If a human engineer can't definitively say which tool should be used … an AI agent can't be expected to do better." https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

### 2.2 Dynamic tool loading: tool search and `defer_loading`

- **Mechanism (Anthropic API).**
  - Tools marked `defer_loading: true` are excluded from the prompt.
  - A tool search tool (regex `tool_search_tool_regex_20251119`, BM25, or a custom one such as embeddings) costs about 500 tokens. Matching tools (typically 3–5, ~3K tokens) are expanded inline.
  - It "doesn't break prompt caching" because deferred tools are never in the cached prefix.
  - MCP servers can default-defer per toolset.
  - [primary] https://www.anthropic.com/engineering/advanced-tool-use, https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context
- **Measured.**
  - Context drops from about 77K to 8.7K tokens.
  - MCP eval accuracy: **Opus 4 went from 49% to 74%, and Opus 4.5 from 79.5% to 88.1%**.
  - A third-party retrieval test found regex at 56% and BM25 at 64% retrieval accuracy. [secondary] https://growthmethod.com/anthropic-tool-search/
- **Claude Code.** `ENABLE_TOOL_SEARCH=auto` (the default) turns tool search on when MCP tool definitions exceed **10% of context**; `auto:N` changes the threshold. Early auto-enable bugs are on record. [secondary] https://www.builder.io/blog/claude-code-mcp-servers, https://github.com/anthropics/claude-code/issues/18298
- **Server-side variant.** GitHub MCP "dynamic toolsets" (`list_available_toolsets`, `enable_toolset`) let the model enable groups. https://github.com/github/github-mcp-server/issues/275
- **Tradeoffs.** It adds a search step, and recall depends on description quality: "write descriptive names", e.g. `search_customer_orders`, not `query_db_orders`. A system-prompt hint naming the available tool *groups* helps.
- **Applies to Pi.** Pi already has `deferred` exposure and a BM25 `tool_search`. Next steps:
  1. A system-prompt section that lists *namespaces with one-line descriptions*. Pi has `mcp_servers` with `description`; make sure built-in extension tools are covered too.
  2. A hybrid BM25 and embedding ranker behind the existing `ToolRanker` interface.
  3. A token-threshold auto mode like Claude Code's.
  4. A tool-retrieval eval set, modeled on HumanMCP (https://arxiv.org/pdf/2602.23367) and LiveMCPBench (https://arxiv.org/pdf/2508.01780).

### 2.3 RAG over tools (RAG-MCP and friends)

- **RAG-MCP** (May 2025). Embed MCP server and tool descriptions in a vector index and retrieve the top-k for each query *before* the LLM call, so only those descriptions enter the prompt.
  - Accuracy: **43.13% vs. 13.62%** with all tools in the prompt.
  - Prompt tokens: 1,084 vs. 2,134 (about −49%).
  - Precision degrades as the registry grows into the thousands.
  - [primary] https://arxiv.org/abs/2505.03275
- **Difference from tool search.**
  - RAG-MCP is harness-side and pre-inference: the model never asks.
  - Tool search is model-initiated and just-in-time.
  - Pre-retrieval wastes no turn but cannot adapt mid-task. Model-initiated search adapts but costs a turn.
- **Applies to Pi.** A hybrid fits Pi: on each user turn, pre-rank deferred tools against the user message and *suggest* the top-3 names in a reminder ("possibly relevant tools: …"), while keeping `tool_search` for loading.

### 2.4 Code execution with MCP, Code Mode, programmatic tool calling

- **Cloudflare Code Mode** (Sep 26 2025): convert MCP schemas to a **TypeScript API with doc comments** and give the model one "execute TypeScript" tool in a V8 isolate. "LLMs are better at writing code to call MCP, than at calling MCP directly." [primary] https://blog.cloudflare.com/code-mode/
- **Anthropic "Code execution with MCP"** (Nov 4 2025):
  - Tools become files under `./servers/<server>/<tool>.ts`, and the agent lists and reads only what it needs, or uses `search_tools` with a detail level (name only, plus description, or full schema).
  - **150K to 2K tokens (−98.7%)**.
  - Privacy: intermediate data stays in the sandbox and PII can be tokenized.
  - State persists in files, and saved functions plus a SKILL.md become skills.
  - Cost: sandboxing and operational overhead.
  - [primary] https://www.anthropic.com/engineering/code-execution-with-mcp
- **Cloudflare server-side Code Mode** (Feb 20 2026): the whole Cloudflare API (2,500+ endpoints) sits behind `search(code)` over the resolved OpenAPI spec and `execute(code)`, for **about 1,000 tokens fixed vs. ~1.17M** (−99.9%). "The full OpenAPI spec never enters the model context." [primary] https://blog.cloudflare.com/code-mode-mcp/. Converting a typical MCP server to a TS API saves 81%. https://blog.cloudflare.com/dynamic-workers/
- **Anthropic Programmatic Tool Calling** (API):
  - Tools opt in with `allowed_callers: ["code_execution_20250825"]`. Claude writes Python that calls them, and only the final output enters context.
  - Tokens fall from 43,588 to 27,297 (−37%).
  - Knowledge retrieval improves from 25.6% to 28.5%, and GAIA from 46.5% to 51.2%.
  - It removes 19+ inference passes for 20 calls.
  - Use it for large data, 3+ dependent calls, or filtering. Skip it for single simple calls.
  - [primary] https://www.anthropic.com/engineering/advanced-tool-use
- **Tradeoffs.** It needs a sandbox, debugging is harder, the model must know return shapes ("document return formats"), and it is a poor fit when the model must reason over every intermediate result.
- **Applies to Pi.** Pi's `codemode` with `searchTools()` and `codemode` MCP exposure already implements the Anthropic and Cloudflare pattern. Remaining work:
  1. Give `searchTools()` an explicit **detail-level** argument (name, plus description, or full declaration) mirroring Anthropic's `search_tools`.
  2. Generate typed declarations, including **return types**, for MCP tools that ship `outputSchema`.
  3. Measure codemode vs. direct on multi-call tasks.

### 2.5 Tool description quality and result formatting

From Anthropic's "Writing effective tools for agents" (Sep 11 2025) [primary] https://www.anthropic.com/engineering/writing-tools-for-agents:

- **Consolidate** around workflows (`schedule_event`, `search_logs`, `get_customer_context`) rather than wrapping endpoints (`list_contacts`).
- **Namespace** by service or resource. Prefix vs. suffix naming has "non-trivial effects" that vary by model.
- **Return meaningful context.** Prefer names over UUIDs, which "significantly improves … precision in retrieval tasks by reducing hallucinations".
- **`response_format` enum**: `concise` (72 tokens) vs. `detailed` (206 tokens), about ⅓. Detailed includes the IDs needed for follow-up calls.
- **Truncation and pagination with steering**: "For Claude Code, we restrict tool responses to 25,000 tokens by default". Encourage "many small and targeted searches".
- **Actionable errors** that include examples of correct input.
- **Descriptions as onboarding docs for a new hire.** "Small refinements to tool descriptions can yield dramatic improvements". Precise description refinements were part of Claude Sonnet 3.5's SWE-bench Verified SOTA.

Other findings:

- **Tool use examples** (`input_examples`, 1–5 realistic minimal, partial and full examples): complex-parameter accuracy went from **72% to 90%**. They add tokens, so use them only where the schema can't express usage. [primary] https://www.anthropic.com/engineering/advanced-tool-use
- **Empirical studies of MCP descriptions** (Feb 2026):
  - 97% of 856 tools have description smells. LLM-augmented descriptions raised MCP-Universe rubric scores by +2.7–4.0. Removing *examples* made no significant difference (p>0.20), while full augmentation risks context bloat. [primary] https://arxiv.org/html/2602.14878v2
  - Across 10,831 servers, smells are pervasive. Functionality and accuracy smells move selection by +11.6% and +8.8%. [primary] https://arxiv.org/abs/2602.18914

**Applies to Pi.**

1. Lint tool descriptions in CI against a checklist: purpose, when to use and when *not* to, return shape, limits.
2. Add `response_format`/`detail` to grep, find and MCP wrappers.
3. Rewrite truncation footers so they steer ("N more matches; narrow with path or glob").
4. Allow MCP description overrides in config, which Pi's `description` field partly covers.

### 2.6 MCP context bloat: mitigation ladder

| Rung | Technique | Token effect | Who |
|---|---|---|---|
| 0 | Load everything | Baseline: 55K for 58 tools, ~1.17M for the full Cloudflare API | naive clients |
| 1 | Curated toolsets / allowlists | −53% (GitHub default toolsets), −60–90% (3–10 tools) | GitHub MCP |
| 2 | Pre-retrieval over tools (RAG-MCP) | −49% prompt, ×3 accuracy | research |
| 3 | Deferred loading + tool search | −85–89%, plus accuracy | Anthropic API, Claude Code, Pi `deferred` |
| 4 | Code mode / files-as-tools | −98.7% / −99.9% | Anthropic, Cloudflare, Pi `codemode` |

Sources are in §2.1–2.4.

---

## 3. Progressive disclosure of instructions: skills, rules, instruction files

### 3.1 Agent Skills (SKILL.md)

- **Mechanism** (Anthropic, Oct 16 2025; published as an open standard Dec 18 2025). [primary] https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
  - **Level 1**: the `name` and `description` of every skill are preloaded into the system prompt.
  - **Level 2**: the full SKILL.md is read when relevant.
  - **Level 3+**: bundled files are read on demand.
  - **Scripts** are *executed* without loading their source, so "the amount of context that can be bundled into a skill is effectively unbounded".
  - Security: install only from trusted sources, and audit scripts and network instructions.
- **Spec** (agentskills.io). [primary] https://agentskills.io/specification
  - `name` is 1–64 characters, lowercase and hyphens, and must match the directory.
  - `description` is 1–1024 characters and covers *what* and *when*.
  - Optional fields: `license`, `compatibility` (≤500), `metadata`, and experimental `allowed-tools`.
  - Budgets: about 100 tokens of metadata per skill, a body **under 5,000 tokens and 500 lines**, and references one level deep.
- **Claude Code extensions.** [primary] https://code.claude.com/docs/en/skills
  - Frontmatter: `disable-model-invocation`, `user-invocable`, `paths:` globs (auto-load only when matching files are touched), `context: fork` (run in a subagent), `model`, `allowed-tools`, `arguments`/`$ARGUMENTS`.
  - **`!`cmd`` dynamic injection**: shell output is spliced in before the model sees the skill.
  - **Listing budget = 1% of the context window**. Descriptions are capped at 1,536 characters each, and overflow drops descriptions of the *least-invoked* skills while keeping their names.
  - **After compaction**, each invoked skill is re-attached (first 5K tokens each, 25K total, most recent first).
  - Nested `.claude/skills` in subdirectories load when a file there is first touched.
  - Slash commands have been merged into skills.
- **Codex.** The same format, scanning `.agents/skills` from cwd up to the repo root. The initial list uses **≤2% of the context window, or 8,000 characters** if unknown, configurable up to 10K tokens. [primary] https://developers.openai.com/codex/skills
- **Measured weakness.** Vercel (Jan 27 2026), Next.js 16 APIs not in training data. [primary] https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals

| Config | Pass rate |
|---|---|
| Baseline | 53% |
| Skill (default) | 53% (**uninvoked in 56% of cases**) |
| Skill + explicit "use it" instructions | 79% |
| AGENTS.md with an 8 KB compressed docs index (pipe-delimited paths, plus "Prefer retrieval-led reasoning over pre-training-led reasoning") | **100%** |

  Wording mattered: "MUST invoke the skill" anchored the agent too early, while "explore the project first, then invoke the skill" worked better. A replication was less lopsided (AGENTS.md at 76–90%). [secondary] https://dev.to/edysilva/stop-putting-best-practices-in-skills-3pof

- **Takeaway.** Use skills for **vertical, explicitly triggered workflows**. For **horizontal knowledge**, pin a compressed index of paths in the always-on context and let the model read files.
- **Applies to Pi.**
  1. Add a **listing budget** (a percentage of the window) with least-used-first degradation to name-only. This needs invocation counts.
  2. Add `paths:` gating so a skill is listed or activated only when matching files are touched.
  3. **Re-attach invoked skills after compaction**, budgeted.
  4. Support `!`cmd`` injection, gated by trust and permissions.
  5. Track invocation so skill descriptions can be evaluated: did the skill fire when it should have?
  6. Let skill descriptions include *when not to use* the skill.

### 3.2 Instruction files: AGENTS.md, CLAUDE.md, Cursor rules

| System | Locations and precedence | Laziness | Caps | Source |
|---|---|---|---|---|
| **AGENTS.md** standard | Nearest file in the tree wins; explicit user prompt overrides everything. 60k+ repos; OpenAI's main repo has 88 files. Stewarded by the Agentic AI Foundation (Linux Foundation). | Agent-defined | none | [primary] https://agents.md/ |
| **Codex** | Global `~/.codex/AGENTS(.override).md`, then root to cwd, one file per dir (`override` > `AGENTS.md` > fallback names), concatenated root-first so closer files override. | Built once per run | **32 KiB** combined (`project_doc_max_bytes`) | [primary] https://developers.openai.com/codex/guides/agents-md |
| **Claude Code** | Managed, user, then ancestors of cwd (root to cwd), with `CLAUDE.local.md` after `CLAUDE.md`. `@path` imports up to 4 hops (no context saving). `.claude/rules/*.md`: rules without `paths:` load at launch; rules with `paths:` load **when a matching file is read**. **Subdirectory CLAUDE.md loads when a file in that subtree is read**, and is not re-injected after `/compact` until read again. | Partly lazy | Guidance: under 200 lines; HTML comments stripped | [primary] https://code.claude.com/docs/en/memory |
| **Cursor rules** (`.cursor/rules/*.mdc`) | Frontmatter `alwaysApply`, `globs`, `description`. Types: Always; Auto-Attached (glob matches a file in context); Agent-Requested / "Apply Intelligently" (model reads the description); Manual (@-mention). Plain `.md` files are ignored. | Glob- and description-gated | n/a | [primary] https://cursor.com/docs/rules; [secondary] https://www.shiplight.ai/blog/cursor-rules |
| **Pi** | Agent dir, then ancestors of cwd; `AGENTS.override.md` > `AGENTS.md` > `CLAUDE.md` | Eager only | none | vendored source |

- **Mechanism family.** These all apply *scoping* (directory or glob) and *triggering* (always, on file touch, model decides, user mentions) to instruction text. Cursor's four rule types are the cleanest taxonomy and map one-to-one onto skill invocation modes.
- **Tradeoffs.**
  - Always-on files are reliable (no decision point, as Vercel found) but cost tokens every turn, and long files "reduce adherence" (Claude Code guidance).
  - Lazy, path-triggered rules are cheap but arrive only after the model has already started touching files, so conventions can't shape the plan.
- **Applies to Pi.**
  1. **Lazy subdirectory AGENTS.md**: when `read`, `edit` or `write` touches a path under an unloaded directory that has an AGENTS.md, inject it once as a reminder attached to the tool result.
  2. **Path-scoped rules** with a `paths:` frontmatter, using the same trigger.
  3. A **byte cap** with a visible warning.
  4. Record *why* each file was loaded (session start, nested traversal, path match), like Claude Code's `InstructionsLoaded.load_reason`, so the UI and evals can audit context provenance.
  5. Unify rules and skills: a rule is a skill whose trigger is `always` or `paths`.

### 3.3 Explicit user context: @-mentions and slash commands

- **@-mentions** insert file content without a tool call. In Claude Code, `@`-referenced files bypass `PreToolUse`, so blocking them needs `Read` deny rules or `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1`. [primary] https://code.claude.com/docs/en/hooks
- In Cursor, rules with no globs and no description are @-mention-only. https://cursor.com/docs/rules
- **Slash commands** are user-triggered prompt templates. In Claude Code they are now skills with `disable-model-invocation`, `$ARGUMENTS` and `!`cmd``. https://code.claude.com/docs/en/skills. Pi has prompt templates (`prompt-templates.ts`).
- **Why it matters.** It is the highest-precision selection signal, because the human *is* the retriever. AGENTS.md's FAQ puts explicit chat prompts above all files. https://agents.md/
- **Applies to Pi.** Make `@path` (and `@path#L10-40` or `@symbol`) insert bounded content with a size footer, and route it through the same permission and trust checks as `read`.

### 3.4 Hooks that inject context

- **Claude Code** has 33 hook events. Those that can inject `additionalContext` are `SessionStart`, `UserPromptSubmit` (plain stdout also counts), `UserPromptExpansion`, `SubagentStart`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch` (injected once before the next model call), `PostModelSwitch` and `Stop`.
  - Each string is capped at **10,000 characters**. Above that, the content goes to a file with a 2,000-character preview.
  - `<system-reminder>` in hook output is escaped, to prevent spoofing.
  - On resume, earlier hook output is *replayed*, not re-run, so it can be stale.
  - `InstructionsLoaded` is observability only.
  - [primary] https://code.claude.com/docs/en/hooks
- **Typical uses.** Inject the ticket or branch context at SessionStart, add retrieved docs or a repo map on UserPromptSubmit, append lint or test results after edits (PostToolUse), or make the agent continue on Stop.
- **Applies to Pi.** Pi's extension API is the hook layer. Make sure extensions can:
  - append context to a tool result,
  - add a per-turn ephemeral message,
  - apply caps with spill-to-file,
  - and tag each injection's provenance.

### 3.5 System reminders mid-conversation

- **Mechanism.** The harness injects short `<system-reminder>…</system-reminder>` blocks into user messages or tool results. The tag's meaning is defined in the system prompt, so the model treats them as harness content rather than adversarial tool output.
- **Categories** (37+ extracted reminders):
  - file state: truncated, empty, modified by user or linter, opened or selected in the IDE;
  - context: token usage, post-compaction "contents may have been summarized";
  - todos: "task tools haven't been used recently…";
  - plan mode;
  - security: a malware-consideration note after reads.
  - Sources: [secondary, Mar 2026] https://michaellivs.com/blog/system-reminders-steering-agents/; the extracted catalog (v2.1.x, with token counts per prompt) [secondary] https://github.com/Piebald-AI/claude-code-system-prompts
- **Why.** Recency and attention: instructions in the system prompt decay over 100K tokens, while user-slot content gets more attention. It also lets the harness send **deltas** (file X changed) instead of re-reading files.
- **Applies to Pi.** Build a typed reminder bus:
  - `file_changed_externally` (mtime check on files read this session),
  - `instructions_loaded` (lazy AGENTS.md),
  - `tools_available` (deferred-tool suggestions),
  - `context_budget`,
  - `todo_stale`.
  Render the bus into the next user or tool message, deduplicated and with caps. Pi's tagged system-prompt sections already make "updates to section X" expressible.

### 3.6 Environment info injection

- **Claude Code** injects an `<env>` block (working directory, whether it is a git repo, additional directories, platform, OS version, today's date) plus a **gitStatus snapshot** (branch, main branch, status, recent commits) that is explicitly labeled as not updating during the conversation. [secondary captures] https://gist.github.com/AnExiledDev/86e6895336348bfdeebe4ba50bce6470, https://blog.thepete.net/claude-code-system-prompt/, https://gist.github.com/drew-wallace/c588ac9f8a442b5b4e10b3b553204af7
- The git status prompt is 37 tokens in the extracted catalog. https://github.com/Piebald-AI/claude-code-system-prompts
- Hooks let users add more (SessionStart), and `CwdChanged` and `FileChanged` events exist. https://code.claude.com/docs/en/hooks
- **Why.** These are cheap facts that prevent wasted turns (`date`, `git status`) and wrong assumptions about the year, OS or shell. Anthropic's tool post shows a model appending "2025" to searches; better descriptions fixed it. https://www.anthropic.com/engineering/writing-tools-for-agents
- **Tradeoff.** The date and git status change, so putting them in the cached system prefix either breaks caching or goes stale. Claude Code labels the snapshot as stale-by-design.
- **Applies to Pi.** Pi only injects `cwd`. Add an `env` section (platform, shell, date, git repo flag, branch) and a git snapshot. Put volatile fields **after** the cache breakpoint, or deliver them as the first user-message reminder, so the cached prefix stays stable.

---

## 4. Web and documentation retrieval

| Approach | Mechanism | Pros | Cons | Who | Source |
|---|---|---|---|---|---|
| **llms.txt** | Markdown file with an H1, blockquote summary, and H2 sections of links to `.md` pages; an "Optional" section marks skippable links. v2 adds link-relation discovery and per-page markdown alternates. `llms-full.txt` is a community convention, not part of the proposal. | Cheap, crawlable index; pairs with just-in-time fetch | No vendor confirms consumption; quality varies by site | Anthropic, OpenAI and Google docs publish it | [primary, Sep 3 2024] https://llmstxt.org/; [secondary] https://llmpulse.ai/blog/llms-txt-guide/ |
| **Context7** (Upstash) | MCP with `resolve-library-id`, then `query-docs` (formerly `get-library-docs`); version-specific snippets ranked by query (default about 5K tokens). There is also a CLI/skills mode with no MCP. | Fresh, version-correct API docs | Third-party corpus, which raises trust and injection concerns; an extra turn | Widely used with Cursor and Claude Code | [primary] https://github.com/upstash/context7, https://context7.com/docs/resources/all-clients |
| **Docs vendored into the repo + index** | Download versioned docs to `.next-docs/` and pin a pipe-delimited path index (8 KB, down from 40 KB) in AGENTS.md | 100% on Vercel evals; offline; no decision point | Index costs tokens every turn; must be regenerated on upgrade | Vercel `npx @next/codemod agents-md` | [primary] https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals |
| **WebFetch summarized by a small model** | Fetch locally, convert HTML to markdown, truncate (~100K chars), then a **Haiku** call answers the caller's prompt over the page. Only the answer enters main context. Preapproved markdown docs may bypass the summarizer. | Large token savings; caller's prompt focuses extraction | Lossy (no verbatim quotes, which are capped); summarizer can hallucinate; no injection filtering | Claude Code (and this harness's `web_fetch` tool with `prompt`) | [secondary] https://medium.com/@liranyoffe/reverse-engineering-claude-code-web-tools-1409249316c3, https://www.withgauge.com/blog/how-claude-code-searches-the-web/, https://note.com/hacklog_stealth/n/n5273709ddbe5?hl=en |
| **Doc MCP / search servers** | Search and fetch exposed as tools, ideally deferred | Composable | Tool bloat (§2) | Many | §2 sources |

**Applies to Pi.**

1. Implement `web_fetch(url, prompt?)`: with a prompt, run a cheap-model extraction pass; without one, return raw markdown, paginated.
2. Look for `llms.txt` and `.md` alternates before scraping HTML.
3. Add a "docs index" generator skill that writes a compressed path index into AGENTS.md for pinned dependency versions (the Vercel pattern).
4. Treat fetched text as untrusted: wrap it in tags and never execute instructions from it.

---

## 5. Cross-cutting comparison

### 5.1 Selection triggers: who decides that something enters context?

| Trigger | Examples | Reliability | Token efficiency |
|---|---|---|---|
| Harness, always | AGENTS.md, env block, core tools, skill index | Highest (no decision point) | Lowest |
| Harness, rule-based (path or glob) | Claude Code nested CLAUDE.md and `paths:` rules, Cursor Auto-Attached, skill `paths:` | High once triggered; late for planning | High |
| Harness, retrieval-based | RAG-MCP, Cursor and Windsurf pre-retrieval, Aider repo map personalization | Depends on retriever quality | Medium–high |
| Model-initiated | grep, read, LSP, tool_search, skills ("Agent Requested"), WebFetch | Depends on the model *deciding* to look (56% skill miss rate at Vercel) | Highest |
| User-initiated | @-mentions, slash commands | Highest precision | High |
| Event-initiated | Hooks `additionalContext`, system reminders | Good for freshness and steering | Small |

### 5.2 Code retrieval approaches

| Approach | Index? | Staleness | Best at | Weak at | Evidence |
|---|---|---|---|---|---|
| grep/glob/read loop | none | none | exact identifiers, fresh code | conceptual queries, huge repos, latency | Cherny (qualitative); SWE-agent search ablation |
| Parallel search subagent | none | none | speed, keeping main context clean | needs a fast model; multi-hop | SWE-grep: ~10× faster at equal quality (internal) |
| Embeddings (+ rerank) | vector | sync needed | semantics, large repos | precision; distractors | Cursor +12.5% QA, +2.6% retention on 1k+ files |
| Repo map (tree-sitter + PageRank) | AST graph | cheap rebuild | orientation | deep detail | no public ablation |
| LSP / symbol tools | language server | live | exact navigation, refs | setup, language coverage | AutoCodeRover; Serena (qualitative) |
| Hierarchical localization pipeline | optional | n/a | cost-capped batch repair | interactivity | Agentless 81.7% file localization; 32% Lite at $0.70 |

---

## 6. Recommendations for the Pi harness (prioritized)

1. **Lazy, scoped instructions.**
   - Load subdirectory AGENTS.md when a file under that directory is first touched.
   - Add `paths:`-scoped rules.
   - Add a byte cap and a load-reason log.
   - *Why*: Claude Code and Cursor prove the pattern, and Pi currently loads everything eagerly. *Effort*: small.
2. **Reminder bus.** Add typed, deduplicated `<system-reminder>`-style injections attached to tool results and user messages, covering external file changes, lazy instructions, tool suggestions, budget warnings and stale todos. Volatile env and git info go here, not in the cached prefix. *Effort*: medium.
3. **Skill budget, triggers and persistence.**
   - A listing budget of 1–2% of the window, degrading to name-only.
   - Skill-level `paths:`.
   - Re-attach invoked skills after compaction.
   - Track invocation metrics.
   - `!`cmd`` injection behind trust.
4. **Pin pointers, not bodies.** Encourage a compressed *index* (paths plus one-liners) in AGENTS.md for horizontal knowledge (Vercel). Provide a generator skill.
5. **Tighten the ACI.**
   - Smaller default `read` pages with position footers.
   - `grep` refuses above N matches and suggests narrowing.
   - Syntax-gated `edit` (reject and show the error).
   - `detail`/`response_format` on search tools.
   - Truncation messages that steer.
   - *Why*: SWE-agent's ablations show 3–6 points from each of these.
6. **Tool search upgrades.**
   - A namespace index in the prompt.
   - A hybrid BM25 and embedding `ToolRanker`.
   - An automatic threshold (defer MCP tools when definitions exceed X% of the window).
   - Turn-start pre-ranking that *suggests* tools.
   - A detail level for codemode `searchTools()`.
   - A tool-retrieval eval set.
7. **Search subagent.** A read-only, parallel-call, budgeted (≤4 turns) "find context" subagent on a fast model that returns `{path, line ranges}`. *Why*: SWE-grep shows this keeps the main context clean.
8. **Optional semantic index tool.** A local tree-sitter chunk index with content-hash and Merkle incremental sync, exposed as a tool, never auto-injected. Adopt it only if our evals on 1,000+ file repos show a gain.
9. **Env section.** Platform, shell, date, git flag, branch, plus a git snapshot labeled stale-by-design, placed after the cache breakpoint.
10. **Web.** `web_fetch` with optional small-model extraction, `llms.txt` and markdown-alternate discovery first, and an untrusted-content wrapper.

---

## Sources

Primary sources (vendor engineering posts, official docs, papers, code):

- Anthropic, "Effective context engineering for AI agents", Sep 29 2025. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic, "Writing effective tools for AI agents", Sep 11 2025. https://www.anthropic.com/engineering/writing-tools-for-agents
- Anthropic, "Equipping agents for the real world with Agent Skills", Oct 16 2025. https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Anthropic, "Code execution with MCP", Nov 4 2025. https://www.anthropic.com/engineering/code-execution-with-mcp
- Anthropic, "Introducing advanced tool use", Nov 24 2025. https://www.anthropic.com/engineering/advanced-tool-use
- Claude Platform docs, manage tool context. https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context
- Claude Code docs: memory https://code.claude.com/docs/en/memory · skills https://code.claude.com/docs/en/skills · hooks https://code.claude.com/docs/en/hooks · hooks guide https://code.claude.com/docs/en/hooks-guide · Agent SDK hooks https://code.claude.com/docs/en/agent-sdk/hooks
- Boris Cherny on X, ~Feb 1 2026. https://x.com/bcherny/status/2017824286489383315
- Agent Skills specification. https://agentskills.io/specification
- AGENTS.md. https://agents.md/
- OpenAI Codex AGENTS.md guide. https://developers.openai.com/codex/guides/agents-md
- OpenAI Codex skills. https://developers.openai.com/codex/skills
- OpenAI function calling guide. https://developers.openai.com/api/docs/guides/function-calling
- Cursor, "Securely indexing large codebases". https://cursor.com/blog/secure-codebase-indexing
- Cursor, "Improving agent with semantic search", Nov 6 2025. https://cursor.com/blog/semsearch
- Cursor rules docs. https://cursor.com/docs/rules
- Cognition, "SWE-grep", Oct 16 2025. https://cognition.com/blog/swe-grep
- Windsurf Fast Context. https://docs.windsurf.com/context-awareness/fast-context
- Windsurf remote indexing. https://docs.windsurf.com/context-awareness/remote-indexing
- Windsurf ignore. https://docs.windsurf.com/context-awareness/windsurf-ignore
- Augment, "Context Engine MCP". https://www.augmentcode.com/blog/context-engine-mcp-now-live
- Sourcegraph, "How Cody understands your codebase". https://sourcegraph.com/blog/how-cody-understands-your-codebase
- Sourcegraph, "Cody is cheating". https://about.sourcegraph.com/blog/cody-is-cheating
- Cody paper. https://arxiv.org/abs/2408.05344
- Continue codebase retrieval (deprecated docs). https://docs.continue.dev/reference/deprecated-codebase
- Continue issue showing a Voyage reranker. https://github.com/continuedev/continue/issues/1848
- Aider, repo map blog, Oct 22 2023. https://aider.chat/2023/10/22/repomap.html
- Aider repo map docs. https://aider.chat/docs/repomap.html
- SWE-agent (NeurIPS 2024). https://arxiv.org/abs/2405.15793 · https://arxiv.org/html/2405.15793v3
- Agentless. https://arxiv.org/abs/2407.01489 · https://arxiv.org/html/2407.01489v2
- AutoCodeRover. https://arxiv.org/abs/2404.05427 · https://github.com/AutoCodeRoverSG/auto-code-rover
- Moatless. https://pypi.org/project/moatless/0.0.1/
- CodeRAG-Bench. https://arxiv.org/abs/2406.14497
- RAG-MCP. https://arxiv.org/abs/2505.03275 · https://arxiv.org/html/2505.03275v1
- Less is More (function calling). https://arxiv.org/abs/2411.15399
- MCP tool descriptions are smelly. https://arxiv.org/html/2602.14878v2
- Smell-aware MCP descriptions. https://arxiv.org/abs/2602.18914
- HumanMCP. https://arxiv.org/pdf/2602.23367
- LiveMCPBench. https://arxiv.org/pdf/2508.01780
- Cloudflare, "Code Mode", Sep 26 2025. https://blog.cloudflare.com/code-mode/
- Cloudflare, "Code Mode MCP", Feb 20 2026. https://blog.cloudflare.com/code-mode-mcp/
- Cloudflare, "Dynamic Workers". https://blog.cloudflare.com/dynamic-workers/
- GitHub MCP default toolsets. https://github.com/github/github-mcp-server/discussions/1182
- GitHub MCP changelog, Dec 10 2025. https://github.blog/changelog/2025-12-10-the-github-mcp-server-adds-support-for-tool-specific-configuration-and-more/
- GitHub MCP dynamic toolsets. https://github.com/github/github-mcp-server/issues/275
- Vercel, "AGENTS.md outperforms skills", Jan 27 2026. https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals
- llms.txt. https://llmstxt.org/
- Context7. https://github.com/upstash/context7 · https://context7.com/docs/resources/all-clients
- Chroma, "Context Rot", Jul 2025 (background on why less context matters). https://www.trychroma.com/research/context-rot

Secondary sources (reverse engineering, blogs; unverified):

- Piebald-AI Claude Code system prompts catalog. https://github.com/Piebald-AI/claude-code-system-prompts
- System reminders analysis, Mar 2026. https://michaellivs.com/blog/system-reminders-steering-agents/
- Claude Code env/gitStatus captures. https://gist.github.com/AnExiledDev/86e6895336348bfdeebe4ba50bce6470 · https://blog.thepete.net/claude-code-system-prompt/ · https://gist.github.com/drew-wallace/c588ac9f8a442b5b4e10b3b553204af7
- WebFetch internals. https://medium.com/@liranyoffe/reverse-engineering-claude-code-web-tools-1409249316c3 · https://www.withgauge.com/blog/how-claude-code-searches-the-web/ · https://note.com/hacklog_stealth/n/n5273709ddbe5?hl=en
- Claude Code tool search auto threshold. https://www.builder.io/blog/claude-code-mcp-servers · https://github.com/anthropics/claude-code/issues/18298
- Tool search retrieval accuracy test. https://growthmethod.com/anthropic-tool-search/
- Aider repo map internals. https://deepwiki.com/Aider-AI/aider/4.1-repository-mapping-system
- Claude Code LSP. https://claudelog.com/faqs/what-is-lsp-tool-in-claude-code/ · https://github.com/boostvolt/claude-code-lsps
- Serena. https://mcp.so/servers/serena · https://mcpvault.io/blog/serena-mcp-server-guide
- Relace fast agentic search. https://relace.ai/blog/fast-agentic-search
- RAG-replacement commentary. https://x.com/aakashgupta/status/2018933856460775597 · https://robertheubanks.substack.com/p/anthropic-replaced-their-rag-pipeline · https://vadim.blog/claude-code-no-indexing/
- Cursor semantic search removal claim (unconfirmed). https://dikrana.dev/blog/code-context-benchmarks-cant-tell/
- Augment third-party review. https://rywalker.com/research/augment-context-engine
- Cursor rules guide. https://www.shiplight.ai/blog/cursor-rules
- Vercel replication. https://dev.to/edysilva/stop-putting-best-practices-in-skills-3pof
- llms.txt guide. https://llmpulse.ai/blog/llms-txt-guide/
- Coding agents source-code study. https://arxiv.org/pdf/2609.00006
