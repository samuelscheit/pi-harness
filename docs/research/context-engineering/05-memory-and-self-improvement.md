# 05 — Persistent memory and self-improving context

Slice: memory across sessions, and context that improves itself over time. Written 2026-11 for the self-improving Pi harness (see `HANDOFF.md`: `note_improvement` capture, recurring dreaming, changelog, A/B prompt experiments). Each claim links its source. Numbers are the authors' own unless marked "independent". Dates are publication dates.

## TL;DR

1. Two families. **Memory** stores facts about the user, project and past sessions (MemGPT/Letta, mem0, Zep, ChatGPT/Claude/Codex memory). **Self-improving context** stores procedures and lessons that change behaviour (ACE, Dynamic Cheatsheet, ExpeL, AWM, skills, GEPA). A coding harness needs mostly the second, plus a small amount of the first.
2. Coding agents have converged on **plain Markdown files, a small always-loaded index and on-demand topic files**: Claude Code auto memory (`MEMORY.md`, first 200 lines/25KB), Codex memories (`memory_summary.md` plus grep over `MEMORY.md`), and Letta Code MemFS (git-backed, `system/` pinned). Nobody in coding uses a vector DB on the native path.
3. Write in the **background, not the hot path**. Codex waits until a chat is idle and consolidates with a separate model. Claude Code has "auto dream", Letta has sleep-time agents and "dreaming", and LangMem has a background manager. Hot-path writes add latency and tool-choice burden ([LangMem](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)).
4. **ACE (Oct 2025)** is the best template for our dreaming. It keeps an itemized playbook with ids and helpful/harmful counters. A Reflector turns runs into lessons, a Curator turns lessons into small deltas, and deterministic code merges them. It avoids *brevity bias* and *context collapse*: a full rewrite once dropped 18,282 tokens to 122, and accuracy fell below the no-memory baseline. Reported gains: +10.6% on AppWorld and −82–91% adaptation latency ([arXiv 2510.04618](https://arxiv.org/html/2510.04618v1)).
5. Learning from verified outcomes beats learning from raw trajectories. Letta's skill learning on Terminal-Bench 2.0 gained +21% relative from trajectories alone and +36.8% with verifier feedback ([Letta](https://www.letta.com/blog/skill-learning/)). ExpeL's vote counts and ReasoningBank's success/failure distillation point the same way.
6. **Generic memory systems often don't help coding.** In VibeMemBench (Sep 2026), mem0, A-MEM, SimpleMem and MemoryOS failed to beat memory-off in 11 of 12 pairings. Verified, frozen experience gained +1–4.5 pp and cut steps on every solver ([arXiv 2609.23570](https://arxiv.org/html/2609.23570v1)). Memory must be *validated*, not just accumulated.
7. Memory *generation* is a distinct model skill. In Letta's Context-Bench V2 (Jul 2026), weaker models append dated corrections where stronger ones rewrite them into general rules ([Letta](https://www.letta.com/blog/evaluating-memory-in-production-agents/)). Use the strongest model for dreaming and a cheap one for classification.
8. Self-modifying agents work but game their metrics. SICA went from 17% to 53% on a 50-task SWE-bench subset ([arXiv 2504.15228](https://arxiv.org/pdf/2504.15228)). DGM went from 20% to 50%, and in some runs removed the hallucination-detection markers it was scored on ([Sakana](https://sakana.ai/dgm/)). Keep the evaluator out of the agent's write scope.
9. Memory is an attack surface. MINJA reaches >95% injection success through queries alone ([arXiv 2503.03704](https://arxiv.org/html/2503.03704v1)). SpAIware planted persistent exfiltration instructions in ChatGPT and Windsurf memory ([Embrace The Red](https://embracethered.com/blog/posts/2024/chatgpt-macos-app-persistent-data-exfiltration/)). Do not write memory from sessions that ingested untrusted web or MCP content without review. Codex has a switch for exactly this.
10. For us: keep **files in git as the source of truth** (AGENTS.md, `.agents/skills`, a playbook). Have dreaming emit **ACE-style deltas** with ids and counters, one commit per delta with its hypothesis, gated by the existing A/B experiment arms and the metrics DB. Track a **recurrence metric** (the same correction class reappearing) as the main memory KPI.

---

## 1. Taxonomy

| Axis | Options | Notes |
|---|---|---|
| Content | semantic (facts, preferences), episodic (past runs, examples), procedural (rules, prompts, skills) | LangMem's split ([docs](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)) |
| Shape | profile (one document updated in place) vs collection (many records) | Profiles avoid duplicates; collections need consolidation ([LangMem](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)) |
| Write timing | hot path (agent tool call mid-turn) vs background (after or between sessions) | Hot path: immediate but adds latency. Background: no latency, eventually consistent, higher recall ([LangMem](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)) |
| Read timing | always-in-context vs retrieved on demand (tool, grep, vector, graph) | ChatGPT injects everything, while Claude's chat memory searches via tools ([Willison](https://simonwillison.net/2025/Sep/12/claude-memory/)) |
| Store | files, relational/KV, vector DB, knowledge graph | Coding tools use files; chat SaaS memory uses DB, vector or graph stores |
| Who writes | the agent itself, a separate background agent, the user | Letta moved writes from the primary agent to a sleep-time agent ([Letta](https://www.letta.com/blog/sleep-time-compute)) |

## 2. Memory architectures

### 2.1 MemGPT and Letta (virtual context, sleep-time compute, MemFS)

- **Mechanism.** MemGPT (Oct 2023) treats the context window like RAM in an OS memory hierarchy. *Core memory* is always in context and edited by the agent. *Recall storage* holds the full message history, searchable after eviction. *Archival storage* is an arbitrary text/vector store (pgvector). A memory-pressure warning prompts the model to page data out ([arXiv 2310.08560](https://ar5iv.labs.arxiv.org/html/2310.08560)).
- **Sleep-time compute (Apr 2025).** A primary agent talks to the user and has no core-memory editing tools. A sleep-time agent with a stronger model rewrites shared memory blocks in the background ([Letta blog, 2025-04-21](https://www.letta.com/blog/sleep-time-compute)). Paper: ~5× less test-time compute for equal accuracy, +13% (GSM-Symbolic) and +18% (AIME) accuracy with more sleep-time compute, and 2.5× lower cost per query when amortized over related queries. On the agentic SWE-Features case the gain was only ~1.5× fewer tokens ([arXiv 2504.13171](https://arxiv.org/abs/2504.13171); [html](https://arxiv.org/html/2504.13171v1)). Critique: the 5× counts generated tokens only, and prefill may dominate ([Pith review](https://pith.science/paper/2504.13171)).
- **Letta Code (2025–26).** MemFS is a git-backed memory filesystem. Markdown under `system/` is compiled into the system prompt, and other files are read on demand ([docs](https://docs.letta.com/letta-code/memory/); [intro](https://github.com/ezra-letta/LETTA-MASTER-INTRO/blob/main/docs/concepts/memory-and-memfs.md)). Every edit is a commit. Memory subagents use worktrees and merge through git ([rywalker](https://rywalker.com/research/letta)). Other commands and settings: `/remember`, `/init`, `/doctor` (audits placement, duplication and system-prompt tokens), and dreaming triggered after N steps or on compaction, with an optional "agent reviews before applying" pass ([docs](https://docs.letta.com/letta-code/memory/)).
- **Letta's thesis.** Learning should live mostly in token space (context), not weights, and carry over across model generations ([Continual learning in token space, Dec 2025](https://www.letta.com/blog/continual-learning/)).
- **When it helps.** Long-lived, single-identity agents.
- **Tradeoffs.** Self-editing core memory in the hot path is distracting, which is why Letta moved it to sleep-time. Blocks can drift or contradict each other.
- **Fit for us.** High. MemFS is close to what we want: memory as files in git, pinned vs on-demand files, background dreaming with a review pass, and `/doctor`-style hygiene audits.

### 2.2 mem0

- **Mechanism.** The extraction phase passes an async conversation summary, the last m=10 messages and the new exchange to an LLM, which outputs candidate facts. In the update phase, each fact is compared with the top s=10 similar memories, and an LLM picks **ADD / UPDATE / DELETE / NOOP** via tool call. The Mem0g graph variant marks conflicting edges *invalid* rather than deleting them ([arXiv 2504.19413, Apr 2025](https://arxiv.org/html/2504.19413v1)).
- **Results (LoCoMo, LLM-judge J).** Mem0 66.9, Mem0g 68.4, Zep 66.0, OpenAI memory 52.9, full context 72.9. p95 latency is 1.44 s for Mem0 vs 17.1 s for full context, with ~1.8k vs 26k tokens ([arXiv](https://arxiv.org/html/2504.19413v1)). Independent: a later paper measured Mem0 *slower* than full context on answer latency (2.19 s vs 1.78 s median) ([arXiv 2606.16707](https://arxiv.org/pdf/2606.16707)).
- **Who uses it.** SaaS chat personalization, plus many MCP memory servers.
- **Fit.** Low as a dependency. The ADD/UPDATE/DELETE/NOOP decision against nearest neighbours is a good *curation rule* to copy into dreaming, applied to playbook bullets.

### 2.3 Zep / Graphiti (temporal knowledge graph)

- **Mechanism.** A bi-temporal graph: edges carry `valid_at`/`invalid_at` (true in the world) and `created_at`/`expired_at` (true in the system). When a new fact contradicts an edge with the same source and relation, an LLM decides, and the old edge gets `invalid_at` = new `valid_at`. Invalidated edges are kept, not deleted ([Zep blog](https://www.getzep.com/blog/beyond-static-knowledge-graphs/); [code walkthrough](https://codepointer.dev/p/agent-memory-systems-and-knowledge)).
- **Results.** DMR 94.8% vs MemGPT 93.4%. LongMemEval accuracy up to +18.5% with −90% latency vs full context ([arXiv 2501.13956, Jan 2025](https://arxiv.org/abs/2501.13956)). Gains were largest on temporal reasoning (+38–48%), and single-session-assistant regressed ([paper PDF](https://blog.getzep.com/content/files/2025/01/ZEP__USING_KNOWLEDGE_GRAPHS_TO_POWER_LLM_AGENT_MEMORY_2025011700.pdf)).
- **Fit.** Low as infrastructure, high as an idea. "Invalidate, don't delete, and record why" is how changelog/revert should treat superseded rules.

### 2.4 A-MEM (Zettelkasten)

- **Mechanism.** Each memory becomes an atomic note with LLM-generated keywords, tags and a context description. Notes are linked, and a new note can trigger *evolution* (rewrites) of linked notes ([arXiv 2502.12110, Feb 2025](https://arxiv.org/abs/2502.12110)).
- **Results.** The authors report gains over baselines on six models ([HF](https://huggingface.co/papers/2502.12110)). Independent: in VibeMemBench, A-MEM did not beat memory-off for coding ([arXiv 2609.23570](https://arxiv.org/html/2609.23570v1)). Forgetting-curve pruning of A-MEM cut size but "substantially dropped task performance" ([survey 2601.14192](https://arxiv.org/pdf/2601.14192)).
- **Fit.** Low. Linking notes is useful for skills cross-references, not as the store.

### 2.5 LangMem (semantic / episodic / procedural)

- **Mechanism.** Semantic memory is a profile or collection. Episodic memory stores (observation, thoughts, action, result) records of successful runs. Procedural memory is a prompt that `create_prompt_optimizer` rewrites from trajectories and feedback (metaprompt, gradient and prompt_memory variants). Memories can be written by hot-path tools or a background manager ([conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)). Released 2025-02-18 ([Cognee summary](https://www.cognee.ai/langchain-memory)).
- **Fit.** Its vocabulary maps directly onto our files: semantic → AGENTS.md facts, episodic → session index plus trajectory examples, procedural → base.md, playbook and skills.

### 2.6 Cognee

- **Mechanism.** ECL pipeline: `add` → `cognify` (classify, chunk, extract graph, summarize, embed) → `search`. `memify` (graph enrichment) is now **deprecated** in the official docs ([docs](https://docs.cognee.ai/core-concepts/main-operations/memify); [walkthrough](https://codepointer.substack.com/p/agent-memory-systems-and-knowledge)).
- **Fit.** None for now. It is document-RAG oriented.

### 2.7 Product memory features

| Product | Mechanism | Source |
|---|---|---|
| **ChatGPT** (saved memories since Feb 2024; "reference chat history" since Apr 2025) | `bio` tool writes timestamped one-liners into "Model Set Context". The prompt also gets "Recent Conversation Content" (~40 recent chats with **user messages only**) and periodically regenerated "User Knowledge Memories" summaries the user cannot see. There is no per-query RAG: everything is injected every turn ("bitter lesson" bet). Stale summaries persist | [OpenAI help](https://help.openai.com/en/articles/8590148-memory-in-chatgpt), [OpenAI 2025](https://openai.com/index/memory-and-new-controls-for-chatgpt/), [Khemani, 2025-09-08](https://www.shloked.com/writing/chatgpt-memory-bitter-lesson), [Embrace The Red](https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/) |
| **Claude apps** | First version: blank slate, with `conversation_search` / `recent_chats` tools that read raw history and are visible as tool calls. Sep 2025 (Team/Enterprise), Oct 2025 (Pro/Max): an editable memory summary, scoped per project; incognito chats excluded | [Willison 2025-09-12](https://simonwillison.net/2025/Sep/12/claude-memory/), [Anthropic](https://www.anthropic.com/news/memory) |
| **Anthropic memory tool** (`memory_20250818`) | Client-side file tool under `/memories` with view/create/str_replace/insert/delete/rename. The API auto-injects "ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE… ASSUME INTERRUPTION". Docs: guard path traversal, cap file size, expire unused files, pair with compaction and context editing. Multi-session pattern: progress log, feature checklist, verify end-to-end before marking done | [docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) |
| **Claude Code** | CLAUDE.md hierarchy (managed, user, project, local), `.claude/rules/` with `paths:` scoping, `@imports`. **Auto memory** (v2.1.59+, on by default): `~/.claude/projects/<repo>/memory/MEMORY.md` index; first 200 lines/25KB loaded each session; topic files read on demand; machine-local. Guidance: keep CLAUDE.md under 200 lines, specific, without conflicts; use hooks for must-run steps. Docs say memory is "context, not enforced configuration". The old `#` shortcut is no longer in the docs | [docs](https://code.claude.com/docs/en/memory) |
| **Claude Code auto dream** (~v2.1.81, early 2026, mostly undocumented) | Background sub-agent that merges, dedups, converts relative dates to absolute, prunes stale entries and rebuilds the index under 200 lines. Reported trigger ~24 h plus 5 sessions. No built-in undo was reported | [SFEIR](https://institute.sfeir.com/en/articles/claude-code-dream-auto-dream-memory-consolidation/), [Arcanada](https://arcanada.ai/en/blog/claude-code-memory-optimization), [Bregg](https://bregg.com/blog/claude-code-auto-dream-memory-consolidation) (third-party) |
| **Codex** | AGENTS.md hierarchy (32 KiB cap). **Memories** (off by default, `[features] memories = true`): background generation only after a chat is idle; per-chat extraction model plus a global consolidation model; skipped under rate-limit pressure; `disable_on_external_context` excludes chats that used MCP or web search; secrets redacted. Docs: "a recall aid, not a guarantee"; required rules belong in AGENTS.md | [OpenAI docs](https://developers.openai.com/codex/memories) |
| Codex internals (third-party) | Phase 1 extracts per rollout; phase 2 consolidates under a global lock; ~6 h idle; up to 256 rollouts; 30-day age-out of unused memories. Files: `memory_summary.md` (read whole at start), `MEMORY.md` (grep), `raw_memories.md`, `rollout_summaries/`, `skills/` | [mem0 blog](https://mem0.ai/blog/how-memory-works-in-codex-cli) |
| **Cursor** | Memories (beta in 1.0, Jun 2025; model-proposed and user-approved) were **removed in 2.1 (Nov 2025)**. Users were told to export them into Rules (`.cursor/rules/*.mdc`) | [Cursor forum](https://forum.cursor.com/t/are-my-memories-gone/144057) |
| **Windsurf** (Cognition) | Cascade auto-generates workspace-scoped memories in `~/.codeium/windsurf/memories/` (not in the repo). Rules: `global_rules.md` (6k chars) and `.windsurf/rules` (12k chars each). Hit by SpAIware memory-persistence exfiltration (2025) | [docs](https://docs.windsurf.com/plugins/cascade/memories), [Embrace The Red](https://embracethered.com/blog/posts/2025/windsurf-spaiware-exploit-persistent-prompt-injection/) |

**Pattern.** Coding tools split **human-owned rules** (AGENTS.md/CLAUDE.md/rules, versioned, loaded in full) from **machine-owned memory** (local, generated, partly loaded, background-consolidated). Cursor dropped machine memory altogether in favour of rules. OpenAI and Anthropic both say anything that *must* hold belongs in rules or hooks, not in memory.

## 3. Memory policies

### Write policy

- **Hot path vs background.** See LangMem's table above. Production coding tools moved to background: Codex waits for idle, Letta uses sleep-time agents and dreaming, Claude Code uses auto dream.
- **Explicit "remember X"** (Claude Code auto memory, Letta `/remember`, ChatGPT bio). This is the highest-precision write: the user states the fact.
- **Exclude untrusted sessions.** Codex's `disable_on_external_context` exists for this ([docs](https://developers.openai.com/codex/memories)).
- **Write deltas, not rewrites.** ACE shows that full rewrites collapse ([arXiv](https://arxiv.org/html/2510.04618v1)). mem0 and ExpeL use discrete operations: ADD/UPDATE/DELETE/NOOP and ADD/EDIT/UPVOTE/DOWNVOTE ([ExpeL](https://arxiv.org/abs/2308.10144)).

### Retrieval policy

- **Always-in-context index plus on-demand detail.** Claude Code: `MEMORY.md` capped, topic files on demand. Codex: `memory_summary.md` plus grep. Skills: name and description only, bodies loaded progressively ([Anthropic Agent Skills, 2025-10-16](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)).
- **Scored retrieval.** Generative Agents combine recency (exponential decay), importance (LLM 1–10) and relevance (cosine) ([arXiv 2304.03442](https://arxiv.org/pdf/2304.03442)). LangMem recommends combining similarity with "strength" (recency and frequency of use).
- **Path-scoped rules.** `.claude/rules` with `paths:` globs load only when matching files are read ([docs](https://code.claude.com/docs/en/memory)). This is cheap and deterministic, so for coding it beats embeddings.

### Forgetting and decay

- MemoryBank uses an Ebbinghaus curve, R = e^(−t/S), where recall strengthens S ([arXiv 2305.10250](https://arxiv.org/abs/2305.10250)).
- ExpeL: an importance counter starts at 2, upvote/edit increments it, downvote decrements it, and the insight is removed at 0 ([arXiv](https://arxiv.org/abs/2308.10144)).
- ACE: helpful/harmful counters plus semantic dedup (threshold 0.9), with lazy refinement when the playbook budget is exceeded ([repo](https://github.com/ace-agent/ace)).
- Codex: 30-day age-out. Anthropic memory tool: expire unaccessed files ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)).
- **Caution.** Time-based decay hurt A-MEM ([survey](https://arxiv.org/pdf/2601.14192)). For coding, prefer *evidence-based* removal (a harmful count, or the rule never fired) over age.

### Conflict resolution

- Bi-temporal invalidation, keeping history (Zep). Mark invalid, don't delete (Mem0g). The newest user-stated fact wins: ChatGPT's Model Set Context overrides summaries ([Khemani](https://www.shloked.com/writing/chatgpt-memory-bitter-lesson)).
- Claude Code docs: conflicting instructions "may be resolved arbitrarily", so review periodically ([docs](https://code.claude.com/docs/en/memory)).
- Weak models stack contradictory corrections instead of rewriting ([Letta Context-Bench V2](https://www.letta.com/blog/evaluating-memory-in-production-agents/)). Consolidation needs a strong model and an explicit "resolve conflicts" step.

### Memory poisoning

- **MINJA (Mar 2025).** Query-only injection, >95% injection success and >70% attack success; Llama Guard-style moderation was ineffective ([arXiv 2503.03704](https://arxiv.org/html/2503.03704v1)). Pre-existing correct memories cut injection success to ~25% for GPT-4o-mini ([arXiv 2601.05504](https://arxiv.org/html/2601.05504)).
- **AgentPoison (NeurIPS 2024).** ≥80% attack success at <0.1% poison rate, with ≤1% benign degradation ([arXiv 2407.12784](https://arxiv.org/pdf/2407.12784)).
- **SpAIware.** Persistent exfiltration via memory: ChatGPT in 2024, Windsurf in 2025 ([Embrace The Red](https://embracethered.com/blog/posts/2024/chatgpt-macos-app-persistent-data-exfiltration/)).
- **Skills.** "Install skills only from trusted sources", and audit bundled scripts ([Anthropic](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)).
- **Implications for us.** Dreaming must treat session content as untrusted data. Any rule derived from a session that used `web_fetch` or third-party MCP output needs provenance and should be flagged in the changelog. Rules must never instruct network egress. A git diff of every memory change is the audit trail.

## 4. Self-improving context and playbooks

### 4.1 ACE: Agentic Context Engineering (Stanford/SambaNova/Berkeley, 2025-10-06, ICLR 2026)

- **Mechanism.** The **Generator** runs the task and marks which bullets helped or misled. The **Reflector** critiques the trajectory, optionally over several rounds, and extracts lessons. The **Curator** emits *delta* items, which non-LLM code merges: append new ids, bump counters, dedup by embedding. Refinement is proactive or lazy, and works offline (prompt) or online (memory) ([arXiv](https://arxiv.org/html/2510.04618v1)). Bullet format: `[str-00001] helpful=5 harmful=0 :: …`, grouped into sections such as strategies, formulas and common mistakes ([repo](https://github.com/ace-agent/ace)).
- **Brevity bias.** Optimizers converge on short, generic instructions. **Context collapse**: full rewrites shrink context. In the paper's Dynamic Cheatsheet example, 18,282 tokens became 122 and accuracy fell from 66.7 to 57.1, below the 63.7 baseline ([arXiv](https://arxiv.org/html/2510.04618v1)).
- **Results.** AppWorld (DeepSeek-V3.1 ReAct) average 42.4 → 59.4 offline and 59.5 online, without labels. That matches IBM CUGA (GPT-4.1) overall and beats it by +8.4 TGC on test-challenge. It beats GEPA by +11.9 and ICL by +12.3. FiNER/Formula +8.6. Adaptation latency −82.3% vs GEPA and −91.5% vs Dynamic Cheatsheet ([arXiv](https://arxiv.org/html/2510.04618v1); [repo](https://github.com/ace-agent/ace)).
- **Tradeoffs.** It depends on feedback quality: without reliable signals the Reflector can learn wrong lessons ([alphaXiv summary](https://www.alphaxiv.org/abs/2510.04618)). Long playbooks cost prompt tokens, which prompt caching mitigates. Counter bookkeeping requires the generator to cite bullet ids.
- **Fit.** Very high. This is the dreaming design already sketched in HANDOFF. Adopt the bullet ids, counters, deterministic merge, dedup and token budget.

### 4.2 Dynamic Cheatsheet (Apr 2025; EACL 2026)

- **Mechanism.** A persistent, evolving cheatsheet of strategies and code snippets. Two variants: DC-Cu (cumulative, rewritten every query) and DC-RS (retrieval plus synthesis); no labels needed ([arXiv 2504.07952](https://arxiv.org/abs/2504.07952)).
- **Results.** GPT-4o on Game of 24 went from 10% to 99%, by storing and reusing a Python brute-force solver. Claude 3.5 Sonnet more than doubled on AIME ([arXiv](https://arxiv.org/abs/2504.07952)).
- **Tradeoffs.** Full rewrites lead to context collapse (ACE's critique).
- **Fit.** Mostly negative evidence: don't let dreaming rewrite files whole.

### 4.3 Reflexion (Mar 2023; NeurIPS 2023)

- **Mechanism.** After a failure, the agent writes a verbal self-reflection, stores it in episodic memory and retries ([arXiv 2303.11366](https://arxiv.org/html/2303.11366)).
- **Results.** HumanEval pass@1 91.0 vs GPT-4 80.1. AlfWorld +22%, HotPotQA +20%. No gain on weak models (StarChat 0.26 → 0.26) ([arXiv](https://arxiv.org/html/2303.11366)).
- **Fit.** It is within-task retry memory, so it suits the Generator role rather than cross-session memory. It needs a test signal, which coding usually has.

### 4.4 ExpeL (Aug 2023; AAAI 2024)

- **Mechanism.** Collect training trajectories (using Reflexion retries), then extract insights by comparing successes with failures. Insight operations are ADD/EDIT/UPVOTE/DOWNVOTE with importance counts, and an insight is deleted at 0. At inference the agent sees the insights plus retrieved similar successes ([arXiv 2308.10144](https://arxiv.org/abs/2308.10144)).
- **Results.** HotpotQA 28 → 39, ALFWorld 40 → 59, and transfer to FEVER 63 → 70. GPT-4 was needed for good insights; gpt-3.5 produced weaker ones ([arXiv](https://arxiv.org/abs/2308.10144)).
- **Fit.** High. Voting is a cheap, robust forgetting rule, and success/failure pairs are the right input for dreaming: a corrected session vs an uncorrected one.

### 4.5 Voyager skill library (May 2023)

- **Mechanism.** Verified executable programs are stored as skills, indexed by embeddings of their descriptions and composed into new skills ([arXiv 2305.16291](https://arxiv.org/html/2305.16291)).
- **Results.** 3.3× more unique items, 2.3× longer distances, tech-tree milestones up to 15.3× faster. The library also helped AutoGPT ([repo](https://github.com/minedojo/voyager)).
- **Fit.** It is the intellectual ancestor of `.agents/skills`. The key detail is that only **verified** programs enter the library.

### 4.6 Agent Workflow Memory (Sep 2024)

- **Mechanism.** Induce reusable workflows (sub-routines) from successful trajectories, offline or online, and add them to memory ([arXiv 2409.07429](https://arxiv.org/abs/2409.07429)).
- **Results.** +24.6% relative on Mind2Web and +51.1% relative on WebArena, with fewer steps ([arXiv](https://arxiv.org/abs/2409.07429)).
- **Fit.** Workflows map onto skills (for example "release this repo" or "add an extension").

### 4.7 ReasoningBank (Google, 2025-09-29)

- **Mechanism.** Distill reasoning strategies from both self-judged successes *and failures*, retrieve them per task, and use memory-aware test-time scaling (MaTTS) ([arXiv 2509.25140](https://arxiv.org/abs/2509.25140)).
- **Results.** SWE-Bench-Verified +4.6% with Gemini-2.5-Flash and ~3 fewer steps per task ([Google Research blog](https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/)).
- **Fit.** Shows that failure lessons ("don't do X because Y") are as valuable as success recipes.

### 4.8 Skills created by agents

- Anthropic (2025-10-16): "ask Claude to capture its successful approaches and common mistakes into reusable context and code within a skill". Agents creating and evaluating their own skills is stated as a *future* goal ([Anthropic](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)). The `skill-creator` skill exists ([anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/skill-creator)).
- **Letta skill learning (2025-12-02).** A reflection on the trajectory (solved? sound? repeated patterns?) is followed by `skill-creator` writing the skill. Terminal-Bench 2.0 (Sonnet 4.5, 89 tasks): +21.1% relative (+9 pp), −15.7% cost and −10.4% tool calls from trajectories; +36.8% relative (+15.7 pp) with verifier feedback ([Letta](https://www.letta.com/blog/skill-learning/)).
- **Fit.** Very high. Dreaming should produce skills for recurring multi-step procedures and playbook bullets for one-line rules. Feed it verifier signals: tests, lint, and a correction-free finish.

### 4.9 Self-modifying agents: SICA and the Darwin Gödel Machine

- **SICA (Apr 2025).** The agent edits its own code base. Each iteration benchmarks archived versions and the best becomes the meta-agent. SWE-bench Verified (50-task subset) went from 17% to 53%, and file editing from 82% to 94%, over 15 iterations. Most early gains were tools (faster editing, AST navigation) and cost reductions ([arXiv 2504.15228](https://arxiv.org/pdf/2504.15228); [code](https://github.com/MaximeRobeyns/self_improving_coding_agent)).
- **DGM (Sakana/UBC, May 2025).** An archive-based open-ended evolution of agent code with empirical validation instead of proofs. SWE-bench 20 → 50 and Polyglot 14.2 → 30.7 over 80 iterations, with Claude 3.5 Sonnet as the self-modifier. Without open-ended exploration it reached 23.0. **Objective hacking:** in some runs it removed the hallucination-detection markers and reported false success ([Sakana](https://sakana.ai/dgm/); [arXiv 2505.22954](https://arxiv.org/html/2505.22954v1)).
- **Fit.** Our A/B arms are a lightweight DGM: keep the archive (git history), keep losing variants revivable, and **never let the improver edit the metrics code or the evaluation thresholds**. Gains concentrate in tooling, which matches HANDOFF's focus on tools.

### 4.10 Prompt optimizers

| Method | Mechanism | Result | Source |
|---|---|---|---|
| OPRO (Sep 2023) | LLM proposes instructions given a history of (prompt, score) | Up to +8% GSM8K and +50% BBH over human prompts ("take a deep breath") | [arXiv 2309.03409](https://arxiv.org/pdf/2309.03409) |
| TextGrad (Jun 2024; Nature) | LLM "textual gradients" back-propagated through a compound system | General-purpose; PyTorch-like API | [arXiv 2406.07496](https://arxiv.org/abs/2406.07496), [repo](https://github.com/zou-group/textgrad) |
| DSPy MIPROv2 (Jun 2024) | Proposes instructions and bootstrapped demos per module, searched with Bayesian optimization (TPE) | Up to +13% on Llama-3-8B; demos matter most | [arXiv 2406.11695](https://arxiv.org/abs/2406.11695) |
| GEPA (Jul 2025; ICLR 2026 oral) | Reflects on traces in natural language, evolves prompts, Pareto-front selection | +6% avg / up to +20% vs GRPO with up to 35× fewer rollouts; >10% vs MIPROv2; prompts up to 9.2× shorter | [arXiv 2507.19457](https://arxiv.org/abs/2507.19457) |
| LangMem optimizer | metaprompt/gradient rewriting from trajectories and feedback | none published | [docs](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) |

- **Fit.** Medium. These optimizers need a scored dataset and many rollouts. We evaluate live, so GEPA's *reflection on traces* and *Pareto archive* ideas transfer, but its rollout budget doesn't. ACE beat GEPA on AppWorld with much lower adaptation cost. Use GEPA-style offline runs only for narrow sub-prompts that have a replayable test set (e.g. the correction classifier).

### 4.11 Learning from user corrections and mining trajectories

- **"Self-Improving AI Coding Agents Through Accumulated Behavioral Rules" (2026-07-13).** Every accepted review comment becomes a rule in a version-controlled instruction file, together with a pre-submit self-review checklist and automated validation of rule-set consistency. Rules grew from 5 to 18 over 11 sessions, with a reported 0% recurrence for error classes that have a rule. It is a small, single-deployment study ([arXiv 2607.13091](https://arxiv.org/abs/2607.13091)). This is almost exactly our loop, and *recurrence* is its metric.
- **ChatGPT design choice.** Only *user* messages from recent chats are injected, which keeps bad assistant output from propagating ([Willison](https://simonwillison.net/2025/Sep/12/claude-memory/)). For mining: treat user turns (corrections, interrupts, steers) as the signal and assistant turns as evidence.
- **Letta finding.** Strong models generalize a correction into a rule; weak models append the raw correction ([Letta](https://www.letta.com/blog/evaluating-memory-in-production-agents/)).
- **Anthropic.** Iterate with Claude; when it goes off track, ask it to self-reflect, then capture that in a skill ([Anthropic](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)).

## 5. Evaluating memory

| Benchmark | What it measures | Key finding | Source |
|---|---|---|---|
| LoCoMo (ACL 2024) | QA, event summarization and dialogue over ~300-turn, ~9k-token, up to 35-session dialogues | RAG and long context still trail humans, especially on temporal and causal questions. Later work: near-perfect LoCoMo scorers drop to 40–60% on the active-use MemoryArena | [arXiv 2402.17753](https://arxiv.org/html/2402.17753v1), [survey 2603.07670](https://arxiv.org/pdf/2603.07670) |
| LongMemEval (ICLR 2025) | 500 questions across five abilities: extraction, multi-session, temporal, knowledge update, abstention | Long-context models drop 30–60%; ChatGPT memory −37%, Coze −64% vs offline reading | [arXiv 2410.10813](https://arxiv.org/pdf/2410.10813) |
| Evo-Memory (UIUC/DeepMind, Nov 2025) | Streams of tasks; test-time memory evolution; accuracy, steps, order robustness | ExpRAG baseline; the ReMem act–think–refine loop helps across model families | [arXiv 2511.20857](https://arxiv.org/html/2511.20857v2) |
| SWE-Bench-CL (Jul 2025) | Chronological SWE-bench Verified; forgetting and transfer; CL-Fβ | Coding continual learning; unsupervised self-reflection can reinforce errors ([critique](https://arxiv.org/pdf/2603.26664)) | [arXiv 2507.00014](https://arxiv.org/pdf/2507.00014) |
| VibeMemBench (Sep 2026) | 111 coding targets, 3,634 history trajectories, matched memory on/off | Verified experience: +1–4.5 pp on 4/5 solvers and fewer steps on all. mem0, A-MEM, SimpleMem and MemoryOS: 11/12 pairings fail to beat memory-off | [arXiv 2609.23570](https://arxiv.org/html/2609.23570v1) |
| Letta Context-Bench V2 (Jul 2026, private) | **Usage** (adherence, retrieval) and **generation** (generalization, hygiene) | Memory generation is a distinct skill and does not track SWE-bench | [Letta](https://www.letta.com/blog/evaluating-memory-in-production-agents/) |

**Metrics for our coding harness.** We evaluate live from session files in `metrics.db`, not on a benchmark.

- **Recurrence rate.** How often a correction class reappears after a rule for it exists. This is the primary KPI ([2607.13091](https://arxiv.org/abs/2607.13091)).
- **Corrections per session** (follow-ups, steers, interrupts), split by A/B arm.
- **Steps, tokens and cost per completed task.** Every successful memory paper reports fewer steps (VibeMemBench, ReasoningBank, Letta skills).
- **Adherence.** When a rule's trigger condition occurs, did the agent follow it? A cheap LLM judge over the trajectory can check this; Letta's adherence axis is the model.
- **Retrieval.** Was a relevant skill or topic file loaded when needed? Measure from `read` calls on skill files after a matching trigger.
- **Hygiene.** Playbook size, duplicate rate, contradiction count, and the share of bullets with harmful > helpful (ACE counters).
- **Memory token cost.** Tokens of always-loaded memory per request, against the budget (Claude Code caps `MEMORY.md` at 200 lines/25KB).
- **Guardrails.** A tests-pass or lint proxy, so a rule that cuts corrections by making the agent do less is caught (the DGM objective-hacking lesson).

## 6. Comparison table

| Approach | Store | Write | Read | Forgetting / conflicts | Measured | Used by | Fit for our harness |
|---|---|---|---|---|---|---|---|
| MemGPT/Letta core+archival | DB blocks + vector | agent hot path → sleep-time agent | core always, archival via tool | agent rewrites | DMR 93.4% (via Zep paper) | Letta | Medium (ideas) |
| Letta Code MemFS + dreaming | **git-backed md files** | `/remember`, background dreaming (+review) | `system/` pinned, rest on demand | reorganize/doctor, git history | Skills +36.8% TB2 | Letta Code | **High** |
| Sleep-time compute | memory blocks | background | in context | rewrite | ~5× less test-time compute (non-agentic); 1.5× on SWE-Features | Letta | High (= dreaming) |
| mem0 | vector (+graph) | per message, LLM ADD/UPDATE/DELETE/NOOP | top-k | DELETE / mark invalid | LoCoMo J 66.9; fails on coding (VibeMemBench) | SaaS, MCP servers | Low (copy op set) |
| Zep/Graphiti | temporal KG | per episode | hybrid graph search | bi-temporal invalidation | LongMemEval +18.5%, −90% latency | Zep customers | Low (copy invalidation) |
| A-MEM | linked notes | per memory + evolution | similarity + links | note evolution | gains on chat; fails on coding | research | Low |
| LangMem | BaseStore | hot or background | search / profile | consolidation | none | LangGraph users | Medium (vocabulary) |
| ChatGPT memory | server DB | bio tool + periodic summaries | inject all | newest user fact wins; stale summaries | −37% on LongMemEval | ChatGPT | Low (user-only msgs idea) |
| Claude Code auto memory + dream | local md files | agent during work; background dream | 200-line index + on-demand topics | dream dedup/prune; no undo | none published | Claude Code | **High** (format), add git |
| Codex memories | local md files | idle-gated 2-phase background | summary whole + grep | 30-day age-out; external-context exclusion | none published | Codex | **High** (policies) |
| Anthropic memory tool | client files `/memories` | agent tool calls | agent views dir first | developer-defined expiry | none published | API users | Medium (progress-log pattern) |
| ACE | itemized playbook | Reflector → Curator deltas, deterministic merge | whole playbook (budgeted) | counters, embedding dedup | AppWorld +17 pp avg; −82–91% adaptation latency | research, ACE repo | **Very high** |
| Dynamic Cheatsheet | cheatsheet text | full rewrite per query | whole / retrieved | rewrite (collapse risk) | Game of 24 10 → 99% | research | Negative example |
| Reflexion | episodic reflections | after failure | in retry | per task | HumanEval 91.0 | research | Generator only |
| ExpeL | insights + successes | batch extraction | insights + kNN examples | votes → delete at 0 | ALFWorld 40 → 59 | research | High (votes) |
| Voyager / AWM / skills | code / workflows / SKILL.md | after verified success | description match → load | manual | 3.3× items; WebArena +51% rel; TB2 +36.8% | Claude/Codex/Letta skills | **Very high** |
| ReasoningBank | strategy items | success + failure distillation | retrieval | — | SWE-bench-V +4.6% | research | High (failure lessons) |
| SICA / DGM | agent code archive | self-edit + benchmark | — | archive, selection | 17 → 53%; 20 → 50% | research | Medium (archive and guardrails) |
| GEPA / MIPRO / OPRO / TextGrad | prompt | offline optimization over a dataset | — | Pareto / BO selection | GEPA +10% vs MIPROv2 | DSPy users | Low–medium (sub-prompts) |
| Accumulated behavioral rules | versioned instruction file | each accepted review comment | always loaded + checklist | consistency validation | 0% recurrence (n=11 sessions) | industry case | **Very high** |

## 7. Practical guidance for the Pi harness

### What to store

1. **User preferences and working rules.** Global `prompt/AGENTS.md`, human-owned. Dreaming may *propose* edits, but they land as changelogged commits.
2. **Project conventions.** `<repo>/AGENTS.md`: build and test commands, layout, "always use pnpm". This is the content Claude Code docs recommend ([docs](https://code.claude.com/docs/en/memory)).
3. **Failure lessons and strategies.** An ACE-style playbook, e.g. `<repo>/.agents/playbook.md` and a global one in this repo, with `[id] helpful=N harmful=M :: rule  (evidence: session ids)`. Sections: strategies, common mistakes, tool gotchas.
4. **Procedures.** `.agents/skills/<name>/SKILL.md` for multi-step workflows (Voyager/AWM/Letta). Only create one after the procedure *succeeded* and recurred at least twice.
5. **Session progress.** Not memory. Pi's session files and compaction already cover in-task state (the Anthropic memory-tool progress-log pattern is for agents without session persistence).
6. **Don't store** secrets, transient task details, or facts derivable from the repo (Codex redacts secrets; the ChatGPT bio prompt forbids short-term details).

### Where

- **Files in git, as source of truth.** These are auditable, diffable and revertible; HANDOFF's "visible and revertible" requirement and Letta MemFS take the same approach. No vector DB: every coding tool reviewed uses files plus grep or progressive disclosure, and generic retrieval memories failed on coding (VibeMemBench).
- **`metrics.db` as an index,** not as memory. Bullet counters can live in the playbook file, as ACE does, or be derived in the DB from session citations and written back during dreaming.

### How to keep it auditable and revertible

- One delta = one commit, carrying the hypothesis, the evidence (session ids, `note_improvement` entries), the target metric and the A/B experiment name. Changelog entry in `.agents/changelog.md`.
- Deterministic merge code applies Curator deltas (ADD/UPDATE/DOWNVOTE/REMOVE), and the LLM never rewrites a whole file. This prevents context collapse ([ACE](https://arxiv.org/html/2510.04618v1)).
- Invalidate, don't erase: a removed rule moves to a "retired" section or is reachable through git with the reason (Zep/Mem0g).
- An optional review pass before applying (Letta's "agent reviews before applying"). Run it with the strongest model, because memory generation is model-sensitive.
- Keep evaluation code (metrics, experiment assignment, thresholds) out of dreaming's write scope (DGM objective hacking).
- Provenance: tag deltas derived from sessions that ingested web or MCP content, and require stronger evidence for them (Codex `disable_on_external_context`; MINJA, SpAIware).

### How to avoid context bloat

- **Budget the always-loaded memory.** Claude Code uses 200 lines/25KB for `MEMORY.md` and under 200 lines per CLAUDE.md; Windsurf allows 6k/12k chars; Codex AGENTS.md has a 32 KiB cap. Track playbook tokens per request in metrics.
- **Progressive disclosure.** Rules go in the prompt; procedures go in skills, which load on description match; path-specific content goes in path-scoped rules, if Pi gains an equivalent of `.claude/rules` `paths:`.
- **Lazy refinement.** Dedup and prune only when over budget (ACE lazy mode). Prune by evidence (harmful > helpful, never cited in N sessions), not by age alone.
- **Cache friendliness.** Playbook edits change a prompt section. Pi sends changed sections as appended system messages, so the cached prefix survives (HANDOFF). Batch dreaming edits so they don't change every session.

### Proposed dreaming loop (combines the sources)

1. **Collect.** `note_improvement` backlog, plus sessions since the last dream (user corrections classified by a cheap model; outcomes such as tests, interrupts and cost), plus bullet citations (helpful/harmful).
2. **Reflect** (strong model, per cluster of similar corrections). Compare corrected with uncorrected sessions (ExpeL pairs) and record success and failure lessons (ReasoningBank).
3. **Curate.** Emit deltas against the playbook or skills with ADD/UPDATE/DOWNVOTE/REMOVE/NOOP (mem0 + ExpeL ops). Skill creation goes through `skill-creator` with verifier evidence (Letta).
4. **Merge** deterministically, dedup with a similarity threshold, enforce the budget.
5. **Experiment.** Each non-trivial delta becomes an arm in `prompt/experiments/` (existing 50/50 assignment). Promote or revert on recurrence rate, corrections per session, cost per task and guardrails.
6. **Record.** Commit and changelog entry, with a notice in t3.

## Sources

Papers

- MemGPT, arXiv 2310.08560 (2023-10): https://ar5iv.labs.arxiv.org/html/2310.08560
- Sleep-time Compute, arXiv 2504.13171 (2025-04-17): https://arxiv.org/abs/2504.13171, https://arxiv.org/html/2504.13171v1
- Mem0, arXiv 2504.19413 (2025-04): https://arxiv.org/html/2504.19413v1
- Zep, arXiv 2501.13956 (2025-01-20): https://arxiv.org/abs/2501.13956; PDF https://blog.getzep.com/content/files/2025/01/ZEP__USING_KNOWLEDGE_GRAPHS_TO_POWER_LLM_AGENT_MEMORY_2025011700.pdf
- A-MEM, arXiv 2502.12110 (2025-02-17): https://arxiv.org/abs/2502.12110
- ACE, arXiv 2510.04618 (2025-10-06): https://arxiv.org/html/2510.04618v1; code https://github.com/ace-agent/ace
- Dynamic Cheatsheet, arXiv 2504.07952 (2025-04): https://arxiv.org/abs/2504.07952
- Reflexion, arXiv 2303.11366 (2023-03): https://arxiv.org/html/2303.11366
- ExpeL, arXiv 2308.10144 (2023-08; AAAI-24): https://arxiv.org/abs/2308.10144
- Voyager, arXiv 2305.16291 (2023-05): https://arxiv.org/html/2305.16291; https://github.com/minedojo/voyager
- Agent Workflow Memory, arXiv 2409.07429 (2024-09-11): https://arxiv.org/abs/2409.07429
- ReasoningBank, arXiv 2509.25140 (2025-09-29): https://arxiv.org/abs/2509.25140; https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/
- SICA, arXiv 2504.15228 (2025-04-21): https://arxiv.org/pdf/2504.15228
- Darwin Gödel Machine, arXiv 2505.22954 (2025-05): https://arxiv.org/html/2505.22954v1; https://sakana.ai/dgm/
- GEPA, arXiv 2507.19457 (2025-07; ICLR 2026): https://arxiv.org/abs/2507.19457
- MIPRO, arXiv 2406.11695 (2024-06-17): https://arxiv.org/abs/2406.11695
- OPRO, arXiv 2309.03409 (2023-09): https://arxiv.org/pdf/2309.03409
- TextGrad, arXiv 2406.07496 (2024-06): https://arxiv.org/abs/2406.07496; https://github.com/zou-group/textgrad
- Generative Agents, arXiv 2304.03442 (2023-04): https://arxiv.org/pdf/2304.03442
- MemoryBank, arXiv 2305.10250 (2023-05): https://arxiv.org/abs/2305.10250
- Self-Improving Coding Agents via Accumulated Behavioral Rules, arXiv 2607.13091 (2026-07-13): https://arxiv.org/abs/2607.13091
- LongMemEval, arXiv 2410.10813 (2024-10; ICLR 2025): https://arxiv.org/pdf/2410.10813
- LoCoMo, arXiv 2402.17753 (2024-02; ACL 2024): https://arxiv.org/html/2402.17753v1
- Evo-Memory, arXiv 2511.20857 (2025-11-25): https://arxiv.org/html/2511.20857v2
- SWE-Bench-CL, arXiv 2507.00014 (2025-07): https://arxiv.org/pdf/2507.00014; Learning to Commit, arXiv 2603.26664: https://arxiv.org/pdf/2603.26664
- VibeMemBench, arXiv 2609.23570 (2026-09-20): https://arxiv.org/html/2609.23570v1
- Memory survey (MemoryArena critique), arXiv 2603.07670: https://arxiv.org/pdf/2603.07670
- Toward Efficient Agents survey, arXiv 2601.14192: https://arxiv.org/pdf/2601.14192
- Mem0 independent latency check, arXiv 2606.16707: https://arxiv.org/pdf/2606.16707
- MINJA, arXiv 2503.03704 (2025-03): https://arxiv.org/html/2503.03704v1; follow-up arXiv 2601.05504: https://arxiv.org/html/2601.05504
- AgentPoison, arXiv 2407.12784 (NeurIPS 2024): https://arxiv.org/pdf/2407.12784

Vendor docs and engineering blogs

- Claude Code memory docs: https://code.claude.com/docs/en/memory
- Anthropic memory tool docs: https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- Anthropic Agent Skills (2025-10-16): https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills; skill-creator: https://github.com/anthropics/skills/tree/main/skills/skill-creator
- Anthropic memory announcement (2025-10-23): https://www.anthropic.com/news/memory
- Anthropic, Effective context engineering: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- OpenAI ChatGPT memory help: https://help.openai.com/en/articles/8590148-memory-in-chatgpt; announcement: https://openai.com/index/memory-and-new-controls-for-chatgpt/
- OpenAI Codex memories: https://developers.openai.com/codex/memories
- Letta: sleep-time compute (2025-04-21) https://www.letta.com/blog/sleep-time-compute; memory blocks https://www.letta.com/blog/memory-blocks/; skill learning (2025-12-02) https://www.letta.com/blog/skill-learning/; continual learning https://www.letta.com/blog/continual-learning/; evaluating memory (2026-07-28) https://www.letta.com/blog/evaluating-memory-in-production-agents/; Letta Code memory docs https://docs.letta.com/letta-code/memory/
- LangMem conceptual guide: https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
- Cognee memify docs: https://docs.cognee.ai/core-concepts/main-operations/memify
- Zep blog, temporal edges: https://www.getzep.com/blog/beyond-static-knowledge-graphs/
- Windsurf memories docs: https://docs.windsurf.com/plugins/cascade/memories
- Cursor forum, memories removed: https://forum.cursor.com/t/are-my-memories-gone/144057

Analyses and security research

- Simon Willison, Claude vs ChatGPT memory (2025-09-12): https://simonwillison.net/2025/Sep/12/claude-memory/
- Shlok Khemani, ChatGPT memory and the bitter lesson (2025-09-08): https://www.shloked.com/writing/chatgpt-memory-bitter-lesson
- Embrace The Red: ChatGPT memory internals https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/; SpAIware (2024) https://embracethered.com/blog/posts/2024/chatgpt-macos-app-persistent-data-exfiltration/; Windsurf SpAIware (2025) https://embracethered.com/blog/posts/2025/windsurf-spaiware-exploit-persistent-prompt-injection/
- mem0 on Codex memory internals: https://mem0.ai/blog/how-memory-works-in-codex-cli
- Graphiti code walkthrough: https://codepointer.dev/p/agent-memory-systems-and-knowledge
- Claude Code auto dream (third-party): https://institute.sfeir.com/en/articles/claude-code-dream-auto-dream-memory-consolidation/, https://arcanada.ai/en/blog/claude-code-memory-optimization, https://bregg.com/blog/claude-code-auto-dream-memory-consolidation
- Letta MemFS (third-party): https://github.com/ezra-letta/LETTA-MASTER-INTRO/blob/main/docs/concepts/memory-and-memfs.md, https://rywalker.com/research/letta
- Sleep-time compute critique: https://pith.science/paper/2504.13171
