# 06: How concrete harnesses assemble and manage context (source-level comparison)

Research slice 6 of 6. Researched 2026-11-12. Open-source harnesses were read at the commits listed in [Sources](#sources). Closed harnesses (Claude Code, Amp, Cursor, Factory) were read from their official docs and engineering posts. For Claude Code, the Piebald-AI prompt extraction at CC v2.1.322 was also used.

## TL;DR

1. **Four ideas now appear almost everywhere.** A short base prompt plus a hierarchical `AGENTS.md`-style file; read and shell output capped at roughly 2,000 lines / 50 KB / 10k tokens; compaction near 80–90% of the window that keeps a recent tail verbatim; and tools sent as JSON schemas. Pi has all four.
2. **Base prompts have shrunk sharply.** opencode's base prompt is about 750 bytes, Goose's about 1.2 KB, Cline's SDK prompt about 3.7 KB and Pi's about 2.5 KB. Cursor says it cut its prompt by about 66% by removing "DO NOT / MUST" phrasing. Gemini CLI (about 19–27 KB) and Codex's GPT-5.1/5.2 prompts (about 22–24 KB) are now the large outliers.
3. **System-prompt state is converging on append-only diffs.** Codex ("world state" sections), opencode (`Instructions` with `initial`/`changed` renderers) and Pi (`SystemMessage.sections` patches) never rewrite the system prompt mid-session. They append a "section X is now …" message, so the prompt cache survives changes to date, cwd, AGENTS.md or mode.
4. **Subdirectory instruction files load just in time.** Claude Code, Gemini CLI, opencode, Amp and Cursor load nested `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` only when a tool touches that subtree. Pi only walks *up* from the cwd, at startup.
5. **Compaction design has split two ways.** Codex, opencode and Factory use incremental or anchored summaries, background (speculative) summarization and cache-reusing summary requests. Gemini CLI adds a "probe" self-verification pass. Pi already updates its summary iteratively and has a cache-economics trigger that no other harness has. It lacks background precompute.
6. **Clearing old tool output has become its own layer.** Gemini masks old outputs to disk, Claude Code clears old results ("[Old tool result content cleared]"), SWE-agent uses `last_n_observations` with cache-friendly polling, and Goose summarizes tool pairs. JetBrains' paper found observation masking as good as LLM summarization at about half the cost. Pi has no such layer by default.
7. **Edit format follows the model family.** opencode and Cline switch GPT models to `apply_patch` and others to `old/new string` edits. Codex uses a Lark-grammar freeform `apply_patch`. Aider has eight formats chosen per model. Continue uses a "lazy edit + apply model". Pi uses a single multi-edit `edit` tool for every model.
8. **Tool and skill definitions are deferred.** Cursor saw -46.9% total tokens on sessions that used MCP. Factory saw -50.8% on sessions with 100+ hidden tools. Claude Code, Codex and Pi (`tool_search` extension, off by default) all have tool search. Skills are listed by name and description everywhere.
9. **Memory now means background consolidation.** Codex (two-phase rollout extraction), Gemini (session-history extraction) and Claude Code (auto-memory `MEMORY.md` plus "dream" consolidation) build memory automatically. OpenHands uses a two-tier `MEMORY.md` plus daily logs. Pi has no built-in memory.
10. **Pi's biggest gaps:** JIT nested instruction loading, old-tool-output masking, background or speculative compaction, a model-visible context budget (Codex's `get_context_remaining`/`new_context_window`, Goose's turn budget, Claude Code's token-usage reminder), per-model edit-format routing, built-in subagents and todo (only examples today), and loop detection. Pi is ahead on cache economics: cache warming, cold-cache economic compaction and an Anthropic lookback bridge.

---

## Source key

To keep citations short, these prefixes stand for permalinks at the commit given:

| Prefix | Expands to |
|---|---|
| `PI:` | local `vendor/pi/packages/` (`@earendil-works/pi-coding-agent` v1.5.2, commit `ae7358b`, 2026-11-12) |
| `CODEX:` | `https://github.com/openai/codex/blob/72532ecae5efe500d9e722f3ed5214e63cc8098a/codex-rs/` |
| `GEM:` | `https://github.com/google-gemini/gemini-cli/blob/42a715b0476ce3852b7190954f302b9431f4ba34/packages/core/src/` (v0.70.0-nightly) |
| `OC:` | `https://github.com/sst/opencode/blob/892176957717ec08251be8e0c06562a08222205d/packages/core/src/` |
| `OH:` | `https://github.com/OpenHands/software-agent-sdk/blob/10be259c4fc89b23999e8c653f2130a358e02116/` |
| `AIDER:` | `https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/` (0.86.3.dev) |
| `CLINE:` | `https://github.com/cline/cline/blob/50e77bc1e8f7ab023b7986821e4b5f82ff51b8c4/` |
| `ROO:` | `https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/` (3.53.0) |
| `GOOSE:` | `https://github.com/block/goose/blob/e5896a6bc517ae3d0e1c0028c3bd8c7e66785d6c/crates/` (1.59.0) |
| `CONT:` | `https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/` |
| `MINI:` | `https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/` (2.4.6) |
| `SWEA:` | `https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/` |
| `SMOL:` | `https://github.com/huggingface/smolagents/blob/96f33faaf028479119ec8d34507b47694cf14e34/src/smolagents/` (1.27.0.dev0) |
| `CCP:` | `https://github.com/Piebald-AI/claude-code-system-prompts/blob/05e3f645073f4a31c27627a0437e82f298b69b41/system-prompts/` (Claude Code v2.1.322, 2026-11-09) |

The OpenHands main repo (`All-Hands-AI/OpenHands`, commit `754abee`) now contains only the frontend and app. The agent, prompts and condenser live in `OpenHands/software-agent-sdk`, which is what `OH:` points to.

---

## 1. Pi (vendored, `@earendil-works/pi-coding-agent` 1.5.2)

**System prompt structure and size.** The prompt is an ordered map of named sections. `preamble` is untagged. Every other section is wrapped in `<name>…</name>`: `tools`, `rules`, `docs`, `addendum` (append-system-prompt), `project_context`, `skills`, `cwd`, plus extension-defined sections (`PI:coding-agent/src/core/system-prompt.ts:127-192`). The preamble is one sentence: "You are a coding assistant running inside pi, a coding agent harness…" (`system-prompt.ts:155-156`). Tool lines come from each tool's `promptSnippet`. Rules are deduplicated per-tool `promptGuidelines` plus "Be concise" and "Show file paths clearly" (`system-prompt.ts:88-125`). Before AGENTS.md and skills, the default prompt is about 2.5 KB (about 600–700 tokens). That is my estimate from the template; most of it is the `docs` block (`system-prompt.ts:162-168`).

**Project instructions.** Loading order is the global `~/.pi/agent/AGENTS.md` first, then every ancestor from the filesystem root down to the cwd. In each directory the first match among `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` wins (`PI:coding-agent/src/core/resource-loader.ts:212-301`). Unlike Codex, Pi has no project-root stop and no byte budget. It handles git worktrees: a nested worktree's AGENTS.md shadows the main repo's copy so it isn't loaded twice (`resource-loader.ts:233-258`). Files are rendered as `<project_instructions path="…">` (`system-prompt.ts:79-86`). Subdirectory (JIT) loading is not built in.

**Environment info.** The prompt carries only `<cwd>` (`system-prompt.ts:182`). There is no date, OS or git status. Model and session details come through `PI_*` environment variables visible to `bash` (`PI:coding-agent/src/core/tools/bash.ts:46, 222-234`). Leaving them out of the prompt keeps it byte-stable.

**Tools.** The default set is 4: `read`, `bash`, `edit`, `write` (`system-prompt.ts:64`). Optional built-ins are `grep`, `find`, `ls`, `powershell` (`PI:coding-agent/src/core/tools/`). Extensions are `tool_search` (registered inactive), `codemode`, `mcp` and `llama` (`PI:coding-agent/src/extensions/`). The default truncation limit is 2,000 lines or 50 KB, and grep lines are capped at 500 characters (`tools/truncate.ts:11-13`). `bash` keeps the tail, spills full output to a temp file, and says so in the result: `[Showing lines X-Y of N. Full output: <path>]` (`tools/bash.ts:371-380`).

**Edit format.** A single `edit` tool takes `{path, edits:[{oldText,newText}]}`: several disjoint exact replacements, each matched against the original file (`tools/edit.ts:18-46`). There is no per-model variant and no `apply_patch`.

**Mid-conversation reminders.** Pi has no `<system-reminder>` injection. Instead, a changed system-prompt section produces a patch, `diffSystemPromptSections` (`system-prompt.ts:216-228`). On APIs that accept mid-conversation system messages, the patch is rendered as `Updated system prompt section "name": …` / `Removed system prompt section "name".` (`PI:ai/src/utils/text.ts:23-40`). This is the same append-only, cache-preserving pattern as Codex's world state and opencode's `Instructions` (see Patterns).

**Compaction.**
- **Trigger:** `contextTokens > contextWindow − reserveTokens`, with `reserveTokens` = 16,384 and `keepRecentTokens` = 20,000 (`compaction/compaction.ts:134-138, 275-277`).
- **When it runs:** checked between turns after tool results, before a new prompt, and as one compact-and-retry recovery on overflow or `stopReason: length` (`docs/compaction.md`; `agent-session.ts:3212-3280`).
- **Summary:** a structured template (Goal, Constraints & Preferences, Progress Done/In Progress/Blocked, Key Decisions, Next Steps, Critical Context). Later compactions update the previous summary instead of rewriting it, using a `<previous-summary>` "UPDATE" prompt (`compaction.ts:515-587`). A split turn gets a separate turn-prefix summary (`compaction.ts:937`). Read and modified file lists are tracked cumulatively (`compaction/utils.ts:31-70`).
- **Branch summarization:** a separate pass runs when `/tree` navigation leaves a branch (`compaction/branch-summarization.ts`).

**Cache-economics compaction (unique).** `_compactIfCheaper` compares two costs: carrying the context for `EXPECTED_REQUESTS = 30` more requests (measured over 6,320 prompts), versus one uncached summary on a cheap model plus a smaller kept context. It compacts when the prompt cache has gone **cold**, or optionally when it is warm, whenever the saving exceeds `minSaving` (`compaction/economics.ts:12-65`, `agent-session.ts:856-892`).

**Caching.** On Anthropic, `cache_control` goes on the system prompt, the last tool and the last message. `bridgeCacheLookback` adds a breakpoint when a turn adds 20 or more blocks, so the previous entry stays within the 20-block lookback (`PI:ai/src/api/anthropic-messages.ts:1601-1650`). Optional cache warming replays the last request with a 1-token output cap before the TTL expires. It runs only when expected savings exceed 5%, the entry is at most 60 minutes old and idle for at most 30, using an idle-continuation probability of 0.15 (`PI:ai/src/cache-warming.ts:31-43`; `coding-agent/src/core/cache-warmer.ts`). Summarization requests disable cache writes (`docs/compaction.md:23`). On OpenAI Responses, `prompt_cache_key` = sessionId (`PI:ai/src/api/openai-responses.ts:190`).

**Subagents, memory, todo, plan.** None are built in. There are examples: `examples/extensions/subagent/` (scout/plan/implement agents), `handoff.ts` ("Instead of compacting (which is lossy)…"), `todo.ts`, `plan-mode/`, `custom-compaction.ts`, `claude-rules.ts` (`PI:coding-agent/examples/extensions/`). The agent loop exposes a `transformContext` hook for pruning (`PI:agent/src/types.ts:225-245`).

**Skills.** Listed in `<available_skills>` with name, description and location; the body is read on demand (`skills.ts:358-388`).

---

## 2. OpenAI Codex CLI (`codex-rs`, commit 72532ec)

**System prompt.** The base instructions are chosen per model family: `gpt_5_codex_prompt.md` is 6.6 KB, `gpt-5.1-codex-max_prompt.md` / `gpt-5.2-codex_prompt.md` are 7.6 KB, `gpt_5_1_prompt.md` is 24 KB and `gpt_5_2_prompt.md` is 21.6 KB (`CODEX:core/*.md`). Sections include General (prefer `rg`), Editing constraints (ASCII by default, dirty worktree, never revert user changes), Plan tool ("skip … easiest 25%"), and review mode and final-message formatting (`CODEX:core/gpt_5_codex_prompt.md:1-40`).

**Everything else is a developer- or user-role "context fragment".** Around 50 typed fragment kinds are in `CODEX:core/src/context/`. They include permissions, environment, AGENTS.md, plugins, apps, multi-agent mode, current-time reminder, memory, compaction summary and context-window guidance.

**World-state diffs (notable).** Each fragment implements `render_diff(previous)`. When nothing changed, nothing is emitted. When something changed, an update is emitted with an explicit supersession notice. Examples: "These AGENTS.md instructions replace all previously provided AGENTS.md instructions." (`CODEX:core/src/context/world_state/snapshots/codex_core__context__world_state__agents_md__tests__snapshots.snap`) and "This context-window guidance replaces all previously provided context-window guidance." (`CODEX:core/src/context/world_state/context_window_guidance.rs:8-10`).

**Project instructions.** Codex walks from the project root, detected by `project_root_markers` (default `.git`), down to the cwd and concatenates every `AGENTS.md`, preferring `AGENTS.override.md`. It never goes above the root (`CODEX:core/src/agents_md.rs:1-45`). Fallback filenames are configurable. The budget is `project_doc_max_bytes` = 32 KiB, with a warning when exceeded (`CODEX:config/src/config_toml.rs:76`; `agents_md.rs:51, 65-80`). Untrusted projects load no project docs (`agents_md.rs:65`). It is rendered as `# AGENTS.md instructions` + `<INSTRUCTIONS>` (snapshot above).

**Environment.** An `<environment_context>` user-role block carries `<current_date>`, `<timezone>`, a `<network>` allow/deny list, a `<filesystem>` permission profile, and per-environment `<cwd>`/`<shell>`, including multiple remote environments. All of it is diffed (`CODEX:core/src/context/world_state/snapshots/codex_core__context__world_state__environment__tests__snapshots.snap`). There is also a separate `<current_time_reminder>It is YYYY-MM-DD HH:MM:SS UTC.</current_time_reminder>` (`CODEX:core/src/context/current_time_reminder.rs:43-49`).

**Tools.** Main handlers (`CODEX:core/src/tools/handlers/`):

- unified exec (`exec_command` / `write_stdin`, PTY sessions), `apply_patch`, `update_plan`, `view_image`
- `request_user_input`, `request_permissions`, `tool_search`
- multi-agent `spawn_agent` / `send_input` / `send_message` / `followup_task` / `wait_agent` / `list_agents` / `close_agent` / `resume_agent` (`multi_agents_spec.rs:92-346`)
- MCP resources, `sleep`, `current_time`
- `get_context_remaining` and `new_context_window` (below)

Exec output defaults to `DEFAULT_MAX_OUTPUT_TOKENS = 10_000` (`CODEX:core/src/unified_exec/mod.rs:74`). The per-model default `truncation_policy` is 10,000 bytes (`CODEX:protocol/src/openai_models.rs:1228`). MCP event results are capped at 1 KB for events (`handlers/mcp.rs:823`).

**Edit format.** `apply_patch` is a **freeform (custom) tool constrained by a Lark grammar**, not JSON (`CODEX:core/src/tools/handlers/apply_patch_spec.rs:1-24`; grammar at `core/assets/tools/apply_patch.lark`). OpenAI trains its models on this format, which is why opencode and Cline route GPT models to it (see below).

**Model-visible context control (unique).** `get_context_remaining` returns `tokens_left` (`handlers/get_context_remaining_spec.rs:15-36`). `new_context_window` lets the *model* start a fresh window without summarizing ("A new context window will start without summarizing conversation history.") (`handlers/new_context_window.rs:14-61`). A `<context_window>` fragment tells the agent its name and first/previous/current window ids (`core/src/context/token_budget_context.rs:75-85`).

**Compaction.**
- **Trigger:** `auto_compact_token_limit` = min(config, 90% of the context window) (`CODEX:protocol/src/openai_models.rs:579-590`).
- **Local prompt:** "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM…" with progress, decisions, constraints, next steps and critical data (`CODEX:prompts/templates/compact/prompt.md`). The summary is prefixed with "Another language model started to solve this problem and produced a summary…" (`prompts/templates/compact/summary_prefix.md`).
- **What is kept:** the new history is summary + **the most recent real user messages up to 20k tokens** (`core/src/compact.rs:64, 395-430, 716-740`).
- **Remote compaction:** a server-side model-native compaction path producing opaque items (`core/src/compact_remote_v2.rs`).
- **Speculative background compaction:** "Holds the current speculative request, polled at checkpoints or awaited when compaction is due" (`core/src/session/async_compaction.rs:1-3`).

**Subagents.** Built-in multi-agent tools, plus an agent-roles crate and an orchestrator template (`CODEX:core/templates/agents/orchestrator.md`). A child inherits the parent's `prompt_cache_key` policy (`core/src/codex_delegate.rs:109-112`).

**Memory.** A two-phase background pipeline (`CODEX:memories/README.md`):
- **Phase 1:** extracts `raw_memory` + `rollout_summary` from idle past rollouts, in parallel and leased in a state DB.
- **Phase 2:** consolidates globally.
- **Read path:** injects a developer fragment capped at 8,900 bytes, "capped below 10k tokens" (`core/src/context/memory.rs:10-45`).

**Caching.** `prompt_cache_key` = conversation id (`core/src/client.rs:445-463`). The fragment-diff design keeps the prefix append-only.

---

## 3. Claude Code (closed; CC v2.1.322 via Piebald extraction plus official docs)

**System prompt.** Claude Code has no single prompt. It assembles 500+ conditional strings (`CCP:` README). Core blocks include:
- "Harness instructions" (~324 tokens): GFM output, permission modes, `<system-reminder>` guidance, prefer dedicated tools, parallel calls, `file:line` refs (`CCP:system-prompt-harness-instructions.md`)
- "Executing actions with care" (~1,105 tokens)
- several "Doing tasks" fragments (24–104 tokens each)
- a "Context management" block telling the model not to wrap up early because compaction will handle it (`CCP:system-prompt-context-management-lean-rewrite.md`)
- a git-status snapshot "at the start of the conversation… will not update" (`CCP:system-prompt-git-status.md`)

Total size is in the low tens of thousands of tokens once tool descriptions are included. That is my estimate from the per-piece token counts in the `CCP` README.

**Project instructions.** CLAUDE.md is loaded at four scopes, concatenated not overridden: managed, user `~/.claude/CLAUDE.md`, project `./CLAUDE.md` or `.claude/CLAUDE.md`, and local `CLAUDE.local.md`. Ancestors are loaded at launch. **Subdirectory CLAUDE.md files load when Claude reads files there.** `@path` imports recurse up to 4 hops. `.claude/rules/*.md` files with `paths:` glob frontmatter load only when matching files are read. HTML comments are stripped. Docs say to target under 200 lines. After `/compact`, the root CLAUDE.md is re-injected but nested ones are not (https://code.claude.com/docs/en/memory). Nested files arrive as a reminder, "Contents of ${path}: …" (`CCP:system-reminder-nested-instruction-file-contents.md`). Anthropic's own description is "CLAUDE.md files are naively dropped into context up front" (https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

**Mid-conversation reminders.** These are the most extensive of any harness: 216 `system-reminder-*` templates at v2.1.322 (`CCP:` directory listing). Examples:
- a TodoWrite nudge, "The TodoWrite tool hasn't been used recently…" (`CCP:system-reminder-todowrite-reminder.md`)
- `Token usage: used/total; remaining` (`CCP:system-reminder-token-usage.md`)
- `<new-diagnostics>` (`CCP:system-reminder-new-diagnostics-detected.md`)
- file-truncated and file-empty notices
- plan-mode-active
- memory-file contents

**Tools and truncation.** Tools include Read, Write, Edit, Bash, Glob, Grep, TodoWrite, Agent (Task), WebFetch/WebSearch, AskUserQuestion, Enter/ExitPlanMode, EnterWorktree, ToolSearch and many more (`CCP:` README tool list). Limits:
- `BASH_MAX_OUTPUT_LENGTH` default 30,000 characters, max 150,000
- `MAX_MCP_OUTPUT_TOKENS` default 25,000
- file reads capped at 25,000 tokens (`CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`)
- Read defaults to N lines with offset/limit (`CCP:tool-description-readfile.md`)
- MCP tools deferred behind ToolSearch by default (`ENABLE_TOOL_SEARCH`; `auto` = 10% of the window)

Sources for the limits: https://code.claude.com/docs/en/env-vars.

**Edit format.** Exact `old_string` → `new_string`, with `replace_all` and a must-Read-first rule (`CCP:tool-description-edit.md`).

**Compaction.** The prompt asks for `<analysis>` and then a 9-section `<summary>`: Primary Request and Intent, Key Technical Concepts, Files and Code Sections, Errors and fixes, Problem Solving, *All user messages* (verbatim, including security-relevant instructions), Pending Tasks, Current Work, and an Optional Next Step with direct quotes (`CCP:agent-prompt-conversation-summarization-with-additional-instructions.md`). There is also a "partial compaction" variant (`CCP:system-prompt-partial-compaction-instructions.md`).

After compaction, Claude Code re-attaches recently read files; per Anthropic, "the five most recently accessed files" (https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents). Files too large to re-attach get a reference reminder (`CCP:system-reminder-compact-file-reference.md`).

The default trigger is undocumented. Community measurements put it at about 83% (https://github.com/anthropics/claude-code/issues/31806). It can be lowered with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` or `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (env-vars doc).

**Tool-result clearing.** Old tool results are replaced by "[Old tool result content cleared]", and the summarizer is told how to treat them (`CCP:system-prompt-compaction-omitted-tool-result-handling.md`). This matches the API-level tool-result clearing Anthropic describes as "one of the safest lightest touch forms of compaction" (Anthropic post above).

**Subagents.** `Agent` tool; each subagent has its own context window and receives only the delegation message. Its body is the system prompt plus environment details. Built-ins are Explore (read-only, skips CLAUDE.md and git status), Plan and general-purpose. Nesting goes up to 3 levels, with 20 concurrent by default. Subagents can be resumed via `SendMessage`, and transcripts are saved per agent (https://code.claude.com/docs/en/sub-agents).

**Memory.** Auto memory lives at `~/.claude/projects/<project>/memory/`. `MEMORY.md` is loaded up to 200 lines or 25 KB, and topic files are read on demand (memory docs). A "Dream memory consolidation" agent and a "determine which memory files to attach" selector agent also exist (`CCP:` README).

**Caching.** Automatic prompt caching, which can be disabled with `DISABLE_PROMPT_CACHING`. Static/dynamic boundary placement is not documented.

---

## 4. Gemini CLI (v0.70.0-nightly, commit 42a715b)

**System prompt.** Composable render functions: preamble, core mandates, sub-agents, skills, hook context, primary workflows, operational guidelines, sandbox, YOLO mode, git repo, user memory, task tracker and planning workflow (`GEM:prompts/snippets.ts:136-663`). Snapshot sizes are about **19–27 KB** of characters (`GEM:core/__snapshots__/prompts.test.ts.snap`), the largest base prompt in this survey.

**Project instructions.** `GEMINI.md` (configurable) uses a **three-tier model**, explained in the code comment "Tiered context model (see issue #11488)" (`GEM:utils/environmentContext.ts:62-65`):
- **Tier 1:** global memory goes in the system instruction.
- **Tier 2:** extension and project memory goes in the first user message.
- **Tier 3:** subdirectory memory is delivered **JIT inside tool output** by "high-intent" tools (`read_file`, `list_directory`, `write_file`, `replace`, `read_many_files`), wrapped in `--- Newly Discovered Project Context ---` (`GEM:tools/jit-context.ts:8-60`).

The prompt explicitly states precedence: Sub-directories > Workspace Root > Extensions > Global, and contextual instructions "cannot override Core Mandates" (`GEM:prompts/snippets.ts:524-575`).

**Environment.** A `<session_context>` block gives the date, OS, project temp dir, and an optional folder tree (`getFolderStructure`, max 200 items) (`GEM:utils/environmentContext.ts:55-77`; `utils/getFolderStructure.ts:21`).

**Tools.** About 27 built-ins: `read_file`, `read_many_files`, `write_file`, `replace`, `glob`, `grep_search`, `list_directory`, `run_shell_command`, `google_web_search`, `web_fetch`, `write_todos`, six `tracker_*` tools, `enter/exit_plan_mode`, `ask_user`, `activate_skill`, `invoke_agent`, `update_topic`, `complete_task`, `get_internal_docs`, and MCP resource tools (`GEM:tools/tool-names.ts`, `tools/definitions/`).

Truncation: tool output above `DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD = 40_000` (`GEM:config/config.ts:487`) goes through `ToolOutputDistillationService`. It saves the full output to a file, truncates proportionally, and for massively oversized output adds an LLM "Strategic Significance of Truncated Content" intent summary (`GEM:context/toolDistillationService.ts:30-161`).

**Edit format.** `replace` (old/new string). Matching escalates from exact to flexible-whitespace to regex to fuzzy, and an **LLM edit fixer** repairs failed `old_string`s (`GEM:tools/edit.ts:52, 85, 197-270`; `utils/llm-edit-fixer.ts`).

**Tool output masking (unique layer).** The "Hybrid Backward Scanned FIFO" protects the newest 50k tool tokens and the latest turn. Once 30k or more prunable tokens accumulate, older tool outputs are masked: written to `tool-outputs/` and replaced with a `<tool_output_masked>` pointer. Exempt tools are `activate_skill`, `ask_user` and plan-mode tools (`GEM:context/toolOutputMaskingService.ts:25-66`).

**Compaction.**
- **Trigger:** `DEFAULT_COMPRESSION_TOKEN_THRESHOLD = 0.5` of the model limit, the earliest in this survey. It keeps the last 30% of history (split at a user turn), protects the last 3 tool turns, and budgets 50k tokens of function responses in the preserved tail (`GEM:context/chatCompressionService.ts:45-50, 367-372`).
- **Prompt:** an XML `<state_snapshot>` with `overall_goal`, `active_constraints`, `key_knowledge`, `artifact_trail`, `file_system_state`, `recent_actions` and `task_state`. It opens with an explicit anti-prompt-injection rule, and an approved plan is preserved when one exists (`GEM:prompts/snippets.ts:898-980`).
- **Two-pass "Probe" verification:** "Critically evaluate the <state_snapshot> you just generated. Did you omit any specific technical details…? … generate a FINAL, improved <state_snapshot>" (`GEM:context/chatCompressionService.ts:770-800`).

**Loop detection.** It flags 5 identical tool calls or 10 repeated content chunks. After 30 turns, an LLM loop check runs every 5–15 turns, at an adaptive interval (`GEM:services/loopDetectionService.ts:29-60`).

**Subagents.** `invoke_agent` with local agents (codebase-investigator, generalist, cli-help) and remote A2A agents (`GEM:agents/`).

**Memory.** Background extraction from past sessions. It runs only after at least 10 user messages and 3 hours idle, at most every 30 minutes, under a lock file, and produces memory and skill patches (`GEM:services/memoryService.ts:22-35`).

**Caching.** No explicit cache breakpoints were found. It relies on Gemini implicit caching; `cachedContent` is only passed through in `GEM:code_assist/converter.ts:44,170`.

---

## 5. opencode (sst, `packages/core` rewrite, commit 8921769, 2026-11-12)

**System prompt.** A deliberately tiny core: `session/runner/prompt/system.txt` is **756 bytes**, covering Harness, Communication and Working in codebases. It says "`<system-reminder>` blocks are harness instructions, not user-authored content" (`OC:session/runner/prompt/system.txt`).

Per-model "plugin" prompts add to it (`OC:plugin/system-prompt/*.txt`). `anthropic.txt` is only 300 bytes about comment density, while `gpt.txt` (2.6 KB) adds commentary-channel and final-answer rules. Kimi, Meta and Trinity variants are 7.7–8.7 KB. Older opencode shipped a near-copy of the Claude Code prompt; the rewrite dropped it.

**Project instructions.** Global `AGENTS.md` (config dir), then `fs.up` for `AGENTS.md` from the cwd, then configured instruction globs (`OC:config/plugin/instruction.ts:29-120`). **JIT:** after every successful `read`, it walks up from the file's directory to the project root, finds unseen `AGENTS.md` files, and injects them as "durable synthetic instructions" (`OC:tool/plugin/read.ts:129-152`).

**Environment and date as diffable instructions.** `Instructions.make({key, read, render:{initial, changed}})` covers `core/date` ("Today's date: … / Today's date is now: …") and `core/environment` (`<env>` with working dir, workspace root, git yes/no, platform, preferred tmp dir) (`OC:instructions/builtins.ts:19-50`). Only changes are re-emitted.

**Tools.** About 19 plugins: read, write, edit, patch, glob, grep, shell, webfetch, websearch, todo, question, skill, subagent, schedule, artifact, file-diff, mcp-resource, image-generate (`OC:tool/plugin/`). Read is capped at `MAX_READ_LINES = 2_000` and `MAX_READ_BYTES = 50 KiB` (`OC:tool/read-filesystem.ts:14-15`). Shell output is spilled to a file with a truncated preview (`OC:tool/plugin/shell.ts:46-47`).

**Edit format is per model.** `gpt-*` models (except `oss` and `gpt-4`) get `patch` (apply_patch with a grammar) and lose `edit`/`write`. All others get `edit` (`oldString`/`newString`/`replaceAll`) (`OC:tool/plugin/patch.ts:290-299`; `tool/plugin/edit.ts:26-32`). A miss on `oldString` returns a hint with the closest lines, "so the next attempt can succeed without rereading the file" (`edit.ts:194-196`).

**Compaction (the most engineered in the survey).** All references are in `OC:session/compaction.ts`.

- **Trigger and fallback:**
  - Room kept free = max(15%, 16k) (`:44, 131-135`).
  - A "too long" overflow retries at 85%, 70%, 50% and 35% of the size (`:127`).
  - Transcript fallback levels for oversize summaries: whole → tool outputs clipped (2k characters) → outputs removed → user-only → omitted (`:140-148`).
- **Summary prompt:**
  - Template: Objective, Requirements, Decisions, Work State (Completed/Active/Blocked), Next Move, Relevant Files (max 15), Important Context (`:173-205`).
  - Rules: preserve exact identifiers; record workflow state (uncommitted, pushed, merged); carry forward only unanswered questions; never mention compaction (`:207-213`).
  - It explicitly tells the summarizer to omit AGENTS.md and environment content because "the next agent receives current versions … separately" (`:216`).
- **Update mode:** "newer history always takes precedence" (`:231-247`).
- **Cache-reusing summary request.** The summarizer is sent the *same* prefix as the normal request plus the summary prompt, so it reads the prompt cache: `[system][S1 + "E9 E10"][E11 … E18][E19][prompt]` (`:450-470`). The result is one `<conversation-checkpoint><summary/><recent-context/></conversation-checkpoint>` user message.
- **Background precompute:**
  - Starts `PRECOMPUTE_LEAD = 60_000` tokens before the ceiling, and only while 30 s or more of cache lifetime remain (`:153-165`).
  - The summary is *held* (not applied, so the prefix isn't rewritten) until compaction is due (`:335-350`).
  - The tail kept beside a swapped-in summary is limited to 40% of the budget (`:164-169`).
- **Native compaction:** skipped when the model offers native compaction (`compaction?.type === "native"`, `:314, 358`).

**Subagents.** `subagent` tool plus `session/subagent-job.ts` and `subagent-completion.ts` (`OC:session/`).

**Reminders.** Plan mode uses `<system-reminder>` enter and leave blocks (`OC:plugin/plan.ts:14-25`).

---

## 6. OpenHands (software-agent-sdk, commit 10be259)

**System prompt.** It is a registry of Python "sections" ported verbatim from the old Jinja `system_prompt.j2`: Role, Persona, Memory, Efficiency, FileSystem, CodeQuality, VersionControl, PullRequests, ProblemSolving, Troubleshooting, ToolGuidance, Security, SecurityRiskAssessment and more (`OH:openhands-sdk/openhands/sdk/context/prompts/sections/static.py:27-48`).

**Cache tiers (notable).** Every section declares `CacheTier.STATIC` ("cache-stable across conversations") or `DYNAMIC` ("per-conversation"). These map onto two system content blocks (`OH:openhands-sdk/openhands/sdk/context/prompts/section.py:25-31`). Static text even avoids expanding `~` "so the block stays cache-shared and machine-independent" (`static.py:131-138`).

**Project instructions.** `AGENTS.md`, `agent.md`, `CLAUDE.md`, `GEMINI.md` and `.cursorrules` are all mapped to "third-party skills" and always loaded (`OH:openhands-sdk/openhands/sdk/skills/skill.py:349-355`). Skills can have keyword `triggers` that auto-inject their content when matched (`skill.py:107, 182-190`). The security section escalates actions influenced by repo context files to HIGH risk (`static.py:313, 382`).

**Tools.** `terminal`, `file_editor` (`str_replace_editor`-style: view/create/str_replace/insert/undo), `apply_patch`, `glob`, `grep`, `task_tracker`, `browser_use`, `delegate`/`task`/`child_conversation`, `ask_oracle`, `tom_consult` (`OH:openhands-tools/openhands/tools/`). File-editor output is clipped at `MAX_RESPONSE_LEN_CHAR = 16000` with an explicit `<response clipped><NOTE>… use grep -n …</NOTE>` (`OH:openhands-tools/openhands/tools/file_editor/utils/constants.py:1-9`).

**Compaction ("condenser").** `LLMSummarizingCondenser` triggers by **event count**: `max_size = 240` events, keeping the first 2 events and condensing to about half. A `max_tokens` bound tied to the agent LLM is optional (`OH:openhands-sdk/openhands/sdk/context/condenser/llm_summarizing_condenser.py:64-126`). The summary format is USER_CONTEXT, TASK_TRACKING (preserve IDs), COMPLETED, PENDING, CURRENT_STATE, plus CODE_STATE, TESTS, CHANGES, DEPS and VERSION_CONTROL_STATUS for code tasks (`OH:…/condenser/prompts/summarizing_system.j2`). Condensers compose with `PipelineCondenser`.

**Memory.** By default the agent is told to use repo `AGENTS.md` as persistent memory. Optionally it gets two tiers (project `.openhands/memory/` and user): `MEMORY.md` is an injected index (keep under about 6,000 characters) and daily logs `YYYY-MM-DD.md` are read on demand (`static.py:115-150`).

---

## 7. Aider (0.86.3.dev)

**Context layout (`ChatChunks`).** Order is `system + examples + readonly_files + repo(map) + done(history) + chat_files + cur + reminder` (`AIDER:coders/chat_chunks.py:6-26`). This puts stable material first for caching and the editable files right before the current turn.

**Repo map (unique).** A tree-sitter tag graph ranked with **PageRank personalized** to chat files and mentioned identifiers. The budget is `map_tokens = 1024`, multiplied by 8 when no files are in chat (`AIDER:repomap.py:49-56, 111-138, 374-382`; https://aider.chat/docs/repomap.html).

**Tools.** Aider has no tool calling. Edits are parsed from text.

**Edit formats.** It ships whole, diff (SEARCH/REPLACE), diff-fenced, udiff, udiff-simple, patch, editor-diff/editor-whole (architect → editor) and function-call variants (`AIDER:coders/`). The default per model comes from model settings, falling back to `whole` (`AIDER:models.py:131, 439`). The rationale is from benchmarks: unified diffs made GPT-4 Turbo "3X less lazy" (https://aider.chat/docs/unified-diffs.html). Architect mode splits reasoning and editing across two models (https://aider.chat/2024/09/26/architect.html).

**Reminder.** The edit-format rules (`system_reminder`, e.g. "# *SEARCH/REPLACE block* Rules: …") are **re-sent at the end of every request**, either as a final system message or appended to the last user message depending on `model.reminder` (`AIDER:coders/base_coder.py:1261-1330`; `coders/editblock_prompts.py:120-132`).

**History summarization.** `max_chat_history_tokens` = min(max(window/16, 1024), 8192) (`AIDER:models.py:356-358`). When exceeded, older messages are summarized recursively with a weak model, written "as the user": "Start the summary with 'I asked you…'" (`AIDER:prompts.py:46-61`; `history.py:27-92`).

**Caching.** `cache_control` on examples or system, on the repo map plus read-only files, and on chat files (`chat_chunks.py:28-56`). **Keepalive pings** every 5 min − 5 s (`--cache-keepalive-pings`) keep the Anthropic cache warm (`base_coder.py:1340-1360`). This is the ancestor of Pi's cache warmer.

---

## 8. Cline (SDK rewrite) / Roo Code / Kilo

**Cline SDK (commit 50e77bc).**
- **Prompt:** the act-mode system prompt is 3.7 KB, with `<env>` (Platform, Date, IDE, Working Directory) inline and `{{CLINE_RULES}}`/`{{CLINE_METADATA}}` slots (`CLINE:sdk/packages/shared/src/prompt/system/act.ts:1-50`). The legacy VS Code prompt was the much larger XML-tool prompt.
- **Instructions:** `.clinerules` (file or dir) plus workspace and global `AGENTS.md` (`CLINE:sdk/packages/core/src/extensions/config/user-instruction-config-loader.ts:131, 344-348, 563-581, 688`).
- **Tools:** 9 defaults: `read_files`, `search_codebase`, `run_commands`, `fetch_web_content`, `apply_patch`, `editor`, `skills`, `ask_question`, `submit_and_exit` (`CLINE:sdk/packages/core/src/extensions/tools/constants.ts:12-36`). The batched array inputs (read many files in one call) are a deliberate parallelism device (`act.ts:24-25`).
- **Per-model routing:** rule `codex-and-gpt-use-apply-patch` enables `apply_patch` and disables `editor` for `codex`/`gpt` model ids (`CLINE:sdk/packages/core/src/extensions/tools/model-tool-routing.ts:68-74`).
- **Compaction:** trigger ratio 0.9, target 0.7, keeps 20k recent tokens, summary capped at 8,192 output tokens; tool results and file content are clipped to 2,000 characters inside summary input (`CLINE:sdk/packages/core/src/extensions/context/compaction-shared.ts:15-37`). There are two strategies: `basic` (deterministic, no LLM: keeps user text and the last 3 assistant texts, summarizes tool activity) and `agentic` (LLM "continuation note … under 800 words") (`basic-compaction.ts`; `summarize-conversation.ts:26`).
- **Legacy extension:** replaced repeated file reads with "[[NOTE] This file read has been removed to save space…]" (`CLINE:apps/vscode/src/core/prompts/responses.ts:11-15`).

**Roo Code 3.53.**
- **Prompt:** built from sections (capabilities, modes, rules, system-info, tool-use, skills, custom-instructions) (`ROO:core/prompts/sections/`).
- **Condensing threshold:** `autoCondenseContextPercent`, settable per profile between 5 and 100%, within `TOKEN_BUFFER_PERCENTAGE = 0.1` (`ROO:core/context-management/index.ts:24, 142-190`; `core/condense/index.ts:109-110`).
- **Summary prompt:** stresses "This summarization request is a SYSTEM OPERATION, not a user message" so the "next step" isn't the summary request itself (`condense/index.ts:112-121`).
- **Non-destructive truncation (unique):** messages are tagged `truncationParent` (hidden, not deleted), which allows rewind (`context-management/index.ts:54-97`).
- **Folded file context (unique):** after condensing, tree-sitter **definition skeletons** of touched files are re-injected in `<system-reminder>` blocks, up to 50k characters (`ROO:core/condense/foldedFileContext.ts`).
- **Orphan repair:** synthetic tool_results are added for orphan tool_calls before condensing (`condense/index.ts:123-160`).

**Kilo Code** is a Roo/Cline-lineage fork. It was not read separately; expect Roo-like behaviour.

---

## 9. Goose (block, 1.59.0)

**System prompt.** `system.md` is 1.2 KB: identity, extension list with per-extension instructions, response guidelines (`GOOSE:goose/src/prompts/system.md`). There is a separate `tiny_model_system.md` for small models.

**Per-turn context ("MOIM", unique).** Each turn adds a `<turn-context>`-style block with current time, working directory, **turn budget** and extension context. The system prompt explains it: "When `<turn-budget>` is present … As the budget gets low, become more direct: reduce exploration, batch necessary tool calls…" (`GOOSE:goose/src/agents/moim.rs:6-25`; `agents/state_machine/inference_preparation.rs:76-80`). It is enabled only for contexts of 32k or more.

**Project instructions.** `.goosehints` and `AGENTS.md`, including subdirectories (`GOOSE:goose/src/hints/load_hints.rs:10-11`).

**Tools.** The developer extension has `write`, `edit`, `shell`, `tree`, `read_image` (`GOOSE:goose/src/agents/platform_extensions/developer/mod.rs:111-278`). Shell output is capped at 2,000 lines / 50 KB with preview slots (`developer/shell.rs:161-166`), the same numbers as Pi. Everything else arrives as MCP extensions that can be enabled dynamically, plus platform extensions (todo, summon, chatrecall, code_execution, tom).

**Compaction.** Default threshold is 0.8, capped at **225k tokens to stay under OpenAI's long-context price tier (>272k)** (`GOOSE:goose-context-management/src/lib.rs:32`; `goose/src/context_mgmt/mod.rs:23-55`). The prompt asks for `<analysis>` and then a single JSON block: `user_intent`, `technical_concepts`, `files[{path, summary, key_code}]`, `errors_and_fixes`, `problem_solving`, `user_messages`, … (`GOOSE:goose-context-management/src/prompts/compaction.md`). The continuation text varies by whether a tool loop was in progress (`context_mgmt/mod.rs:61-75`). Optional **tool-pair summarization** summarizes old tool call/result pairs in batches of 10 beyond a cutoff (`context_mgmt/mod.rs:27, 405-500`).

---

## 10. Continue (core 1.1.0)

- **Prompts:** minimal `<important_rules>` system messages per mode: agent, plan (read-only tools) and chat (`CONT:llm/defaultSystemMessages.ts:51-90`).
- **Rules:** rules support `globs`, `regex` (match on file content), `alwaysApply` and `description`. Description-only rules are pulled by the model through a `request_rule` tool, an early form of agent-requested rules (`CONT:llm/rules/getSystemMessageWithRules.ts:16-62`; `tools/definitions/requestRule.ts:19-34`).
- **Tools:** about 20, including a `view_repo_map` tool and `codebase` semantic search (`CONT:tools/definitions/`).
- **Edit format:** "lazy" edits with `// ... existing code ...` placeholders, applied by an apply model (`CONT:tools/definitions/editFile.ts:14-55`). `single_find_and_replace` and `multi_edit` are also available.
- **Compaction:** manual, summarizing up to a chosen message index and storing `conversationSummary` on it. Otherwise prompts are pruned from the top to fit (`CONT:util/conversationCompaction.ts`; `llm/countTokens.ts:282-481`).

---

## 11. Amp (Sourcegraph; closed, docs as of 2026)

- **AGENTS.md:** loaded from the cwd and parents up to `$HOME`, plus user and system files. **Subtree AGENTS.md files are included when the agent reads a file in the subtree.** Falls back to `AGENT.md` or `CLAUDE.md`. `@`-mentions inside guidance files support globs, and mentioned files with `globs:` frontmatter are included only when a matching file has been read (https://ampcode.com/docs/customize/agents-md).
- **Handoff vs compaction history:**
  - Oct 2025: Amp *removed* compaction in favour of **Handoff**, which extracts a goal-directed starting prompt and file list into a new thread (https://ampcode.com/news/handoff).
  - Dec 2025: the "200k tokens is plenty" short-thread argument (https://ampcode.com/notes/200k-tokens-is-plenty).
  - May 2026 ("Amp, Rebuilt"): "handoff is out. Compaction is in." Compaction now runs automatically at **90%** (https://ampcode.com/news/neo).
  - Thread references (`@T-…`) let the agent read and extract from other threads (https://ampcode.com/docs/threads).
- **Subagents:** Task subagents have their own window, start from the main agent's instructions, and return a final summary. Oracle (review and advice, no edits), Librarian (clones repos to /tmp) and Finder are optional plugins on separate models (https://ampcode.com/docs/models-and-subagents).

## 12. Cursor (closed; docs and blog)

- **Rules:** four types: Always Apply, Apply Intelligently (description), Apply to Specific Files (globs), Apply Manually (@). Nested AGENTS.md "when working with files in that directory". Referenced files "are not inlined" (https://cursor.com/docs/context/rules).
- **Dynamic context discovery** (https://cursor.com/blog/dynamic-context-discovery):
  - long tool output is **written to files**, not truncated
  - on summarization, the agent gets a **reference to the history file** to grep for lost detail
  - MCP tool descriptions are synced to a folder (-46.9% total tokens on MCP sessions)
  - terminals are synced to files
- **Token efficiency, Sep 2026** (https://cursor.com/blog/improved-token-efficiency):
  - built-in tools deferred too, keeping read/search/edit/shell static (-60% static description tokens)
  - system prompt trimmed about 66% by removing "DO NOT/MUST/IMPORTANT"
  - line numbers only every 10th line in reads (-1.6% cache-read tokens)
  - explicit cache breakpoints "after stable layers … before the growing conversation", with skills, subagents and env info moved into a "phantom user message" past the boundary (-20% cold cache misses)
  - overall -7% token cost

## 13. Factory (Droid; closed, blog)

- **Anchored iterative summarization:** two thresholds, `T_max` (fill line) and `T_retained` (drain line). Only the newly dropped span is summarized and merged into a persisted summary anchored to a message. Required content is intent, play-by-play, artifact trail and breadcrumbs (https://factory.ai/news/compressing-context, 2025-07-21). Their own eval scores it 4.04 vs Anthropic 3.74 vs OpenAI 3.43 (https://factory.ai/news/evaluating-compression). This is self-reported.
- **Deferred Context Engine:** a capability index (names and short descriptions) per turn; full schemas or skills are *promoted* on demand and stay loaded. Reported -50.8% input tokens for sessions with 100+ hidden tools, and only 5.4% of sessions executed an MCP tool (https://factory.ai/news/deferred-context-engine, 2026-05-20).

## 14. SWE-agent / mini-swe-agent / smolagents

**mini-swe-agent (2.4.6).**
- **Agent class:** about 100 lines (`MINI:src/minisweagent/agents/default.py`, 190 lines incl. boilerplate). The README claims ">74% on SWE-bench verified" (`MINI:README.md:26-28`).
- **Prompt:** the whole system prompt is about 10 lines: exactly one bash block per response, THOUGHT first. The instance template carries the workflow, `{{system}} {{release}}` info and `sed`/heredoc edit examples (`MINI:src/minisweagent/config/default.yaml:1-100`).
- **No tools or compaction:** bash only, every action in a fresh subshell, linear history, no compaction.
- **Truncation:** outputs over 10,000 characters show head 5,000 + tail 5,000 plus a warning telling the model to use a narrower command (`default.yaml` `observation_template`).
- **Point:** with strong models, a nearly empty harness is competitive.

**SWE-agent.**
- **ACI:** windowed file viewer and edit tools (`SWEA:tools/windowed*`).
- **History processors:** `last_n_observations` elides old observations to "Old environment output: (n lines omitted)". It was used with n=5 in the paper. The **`polling`** parameter exists precisely so elision changes only every k steps and the cache survives (`SWEA:sweagent/agent/history_processors.py:85-125`).
- **`ClosedWindowHistoryProcessor`:** collapses all but the latest view of each file (`:215-230`).
- **Masking evidence:** JetBrains found masking like this matches LLM summarization at about half the cost of the raw agent (https://arxiv.org/abs/2508.21433).

**smolagents (1.27.0.dev0).**
- **Actions:** `CodeAgent` acts in **Python code** rather than JSON tool calls (`SMOL:prompts/code_agent.yaml`, 17 KB).
- **Planning:** `planning_interval` periodically injects a "facts survey + plan" step and later "update plan" steps (`SMOL:agents.py:283, 550-551`; `prompts/code_agent.yaml:176-232`).
- **Limits and subagents:** print output capped at 50,000 characters (`SMOL:local_python_executor.py:57`); managed agents act as subagents (`agents.py:140-179`).

---

## Comparison table

| Harness | Base prompt (approx.) | Instruction files and hierarchy | JIT subdir instructions | Env injected | Default tools | Output cap | Edit format | Mid-convo reminders / state diffs | Compaction trigger → keep | Summary format | Old-output masking | Background compaction | Subagents | Memory | Caching strategy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Pi** | ~2.5 KB | global + all ancestors; AGENTS.override/AGENTS/CLAUDE; worktree de-dup | ✗ | cwd only (+`PI_*` env) | 4 (read/bash/edit/write) + grep/find/ls | 2,000 lines / 50 KB, full output to temp file | multi-edit exact replace | section patches ("Updated system prompt section") | window−16k → 20k recent | Goal/Constraints/Progress/Decisions/Next/Critical, iterative update | ✗ (hook only) | ✗ (but **cold-cache economic** compaction) | example ext. | ✗ | Anthropic breakpoints + lookback bridge, cache **warming**, `prompt_cache_key` |
| **Codex** | 6.6–24 KB per model | root→cwd AGENTS.md (+override), 32 KiB budget, trust-gated | ✗ | env_context (date, tz, cwd, shell, sandbox, network) | ~15+ (exec, apply_patch, plan, agents, tool_search, …) | 10k tokens exec | **apply_patch, Lark grammar** | **world-state diff fragments** + time reminder + context-window guidance | 90% → summary + last 20k user msgs | short "handoff summary" | ✗ | ✓ speculative; remote/native compaction | ✓ multi-agent tools | ✓ 2-phase background | `prompt_cache_key`, append-only |
| **Claude Code** | tens of k tokens incl. tools (est.) | managed/user/project/local + ancestors, `@` imports (4 hops), rules with `paths:` | ✓ | env + git-status snapshot | ~20 core + deferred | Bash 30k chars; read 25k tok; MCP 25k tok | old/new string, read-first | **216 `<system-reminder>` types** (todo, token usage, diagnostics, files…) | ~83% (community) → summary + 5 recent files | 9-section `<analysis>/<summary>` incl. all user msgs | ✓ tool-result clearing | ? | ✓ Agent, nested ≤3, background, resumable | ✓ auto MEMORY.md + dream | automatic; deferred MCP via ToolSearch |
| **Gemini CLI** | 19–27 KB | 3 tiers: global (sys), project/ext (1st user msg), subdir (JIT in tool output) | ✓ | date, OS, tmp, folder tree (200) | ~27 | 40k → file + distill + intent summary | replace + flexible/fuzzy + **LLM fixer** | JIT context blocks | **50%** → last 30% | XML `<state_snapshot>` + **probe verification** pass | ✓ masking to disk (50k protected / 30k batch) | ✗ | ✓ local + A2A | ✓ background extraction | implicit only |
| **opencode** | **0.75 KB** + per-model add-on | global + up-walk AGENTS.md + globs | ✓ (on read) | `<env>`, date as **diffable instructions** | ~19 | 2,000 lines / 50 KB; shell to file | **per model: patch (GPT) / edit** | `Instructions` initial/changed; `<system-reminder>` | max(15%,16k) free → keep N tokens | Objective/Requirements/Decisions/Work State/Next/Files/Context | clip levels inside summarizer only | ✓ **precompute 60k early, cache-reusing** | ✓ | ✗ | summary reuses request prefix cache |
| **OpenHands** | large, sectioned | AGENTS/CLAUDE/GEMINI/.cursorrules as skills; keyword-triggered skills | ✗ | dynamic tier | ~10 | 16k chars editor | str_replace_editor + apply_patch | – | 240 events → half | USER_CONTEXT/TASK_TRACKING/CODE_STATE… | ✗ | ✗ | ✓ delegate/task | ✓ two-tier MEMORY.md + daily logs | **STATIC vs DYNAMIC cache tiers** |
| **Aider** | per edit format | CONVENTIONS via `--read` | ✗ | platform in reminders | 0 (text edits) | – | **8 formats per model**; architect/editor | **edit rules re-sent every turn** | history > window/16 → recursive summary | first-person "I asked you…" | ✗ | ✗ | architect/editor | ✗ | breakpoints by chunk + **keepalive pings** |
| **Cline SDK** | 3.7 KB | .clinerules + AGENTS.md (ws, global) | ✗ | `<env>` in prompt | 9 (batched) | rolling collector | **per model: apply_patch (GPT) / editor** | – | 90% → 70% target, 20k recent | basic (no-LLM) or agentic note ≤800 words | dedupe file reads (legacy) | ✗ | team tools | ✗ | – |
| **Roo Code** | sectioned, large | .roo/rules, modes | ✗ | system-info section | ~20 | – | diff/search-replace | – | user % (5–100) | "SYSTEM OPERATION" guard | non-destructive hide | ✗ | modes/orchestrator | ✗ | – |
| **Goose** | 1.2 KB | .goosehints + AGENTS.md (+subdirs) | partial | **per-turn MOIM incl. turn budget** | 5 + MCP ext. | 2,000 lines / 50 KB | edit/write | MOIM block each turn | 0.8, capped **225k** (price tier) | `<analysis>` + JSON | ✓ tool-pair summarization | ✗ | summon/subagent | ✗ | – |
| **Continue** | minimal per mode | rules: globs, regex, alwaysApply, description→`request_rule` | via globs | – | ~20 | – | **lazy edit + apply model** | – | manual | conversationSummary | prune from top | ✗ | ✗ | ✗ | – |
| **Amp** | n/a | AGENTS.md cwd→$HOME + user/system; `@`-mention globs | ✓ | n/a | n/a | n/a | n/a | n/a | 90% (2026) | n/a | n/a | n/a | Task, Oracle, Librarian, Finder | thread references | n/a |
| **Cursor** | trimmed −66% | 4 rule types + nested AGENTS.md | ✓ (globs) | in "phantom user message" | static core, rest deferred | **to file, not truncated** | fast-apply (product) | – | n/a | summary + **history file reference** | to files | n/a | ✓ | – | explicit breakpoints after stable layers |
| **Factory** | n/a | AGENTS.md | n/a | n/a | capability index + promote | n/a | n/a | n/a | T_max → T_retained | anchored incremental merge | n/a | n/a | ✓ | n/a | deferred schemas keep prefix small |
| **mini-swe-agent** | ~10 lines | ✗ | ✗ | uname | bash only | 10k chars head+tail | sed / heredoc | – | none | – | – | – | ✗ | ✗ | – |
| **SWE-agent** | yaml | ✗ | ✗ | – | ACI tools | windowed (100 lines) | str_replace / windowed | – | – | – | ✓ last-n obs with **polling** | – | ✗ | ✗ | polling preserves cache |
| **smolagents** | 10–17 KB | ✗ | ✗ | – | Python-code actions | 50k chars | code | periodic re-planning | – | – | – | – | managed agents | memory steps | – |

✓ = present, ✗ = absent, – = not applicable or not found, n/a = not public.

---

## Patterns that appear in almost every harness

1. **Instruction files, loaded hierarchically and concatenated.** `AGENTS.md` is the de facto standard: Pi, Codex, opencode, Cline, Goose, OpenHands, Amp and Cursor read it, and Claude Code, Gemini and Amp have fallbacks. Global → root → cwd ordering puts the most specific file last. Pi has this.
2. **A short identity and harness block, with behaviour pushed into tool descriptions.** opencode, Goose, Pi, Cline SDK and Continue keep the base prompt small; per-tool snippets and guidelines carry the usage rules (Pi's `promptSnippet`/`promptGuidelines`). The trend is shrinking prompts (Cursor −66%).
3. **Output caps near 2,000 lines / 50 KB / 10k tokens, with an explicit continuation hint.** Pi, opencode, Goose, Codex, Claude Code, OpenHands and mini-swe-agent all do this. Most now **spill full output to a file** and tell the model where it is (Pi, opencode, Gemini, Cursor).
4. **Exact-string replace editing.** Every JSON-tool harness except Codex uses it, with a "read first / must be unique / replace_all" contract.
5. **Threshold compaction that keeps a recent tail verbatim and uses a structured summary.** Common sections are goal/intent, constraints, decisions, progress done/active/blocked, files, next steps and exact identifiers. Triggers range from 50% (Gemini) to 80–90% (Goose, Codex, Cline, Amp) to window−16k (Pi).
6. **Iterative "update previous summary" prompts.** Pi, opencode, Gemini and Factory do this to avoid summary-of-summary drift.
7. **Overflow recovery.** On a context-length error: compact and retry (Pi, opencode with shrink steps, Cline).
8. **Skills and progressive disclosure.** Name and description go in the prompt; the body is read on demand (Pi, Claude Code, Codex, Gemini, OpenHands, Cline, Cursor).
9. **Subagents with isolated context returning a summary.** Claude Code, Codex, Gemini, opencode, Amp, OpenHands, Cursor and smolagents. Anthropic's rationale is that subagents explore with tens of thousands of tokens and return 1–2k (Anthropic context-engineering post).
10. **A todo or plan tool as structured note-taking** (Claude Code, Codex `update_plan`, Gemini `write_todos`/tracker, opencode, OpenHands `task_tracker`).

## Distinctive ideas worth stealing (ranked by value for Pi)

| # | Idea | Who | Why it matters | Pi status |
|---|---|---|---|---|
| 1 | **JIT nested instruction loading** on read/edit (subdir AGENTS.md as a tool-output appendix or reminder) | Claude Code, Gemini (tier 3), opencode, Amp, Cursor | Monorepos; keeps the startup prefix small and stable | **Missing.** Pi loads ancestors only. |
| 2 | **Old tool-output masking** with a protected recent window, batched to preserve cache, originals spilled to disk | Gemini (50k/30k), SWE-agent polling, Claude Code clearing, Goose tool-pair summaries | Masking roughly halves cost at equal solve rate (JetBrains arXiv 2508.21433); cheaper than summarizing | **Missing.** `transformContext` hook only. |
| 3 | **Background or speculative summary** computed off the cache-hot prefix, held until due | opencode (`PRECOMPUTE_LEAD` 60k), Codex `async_compaction` | Removes the compaction stall; reuses cache for the summary call | **Missing.** Pi has cold-cache economics, which complements this. |
| 4 | **Cache-reusing summarization request** (same prefix + summary prompt) | opencode | The summary call reads cache instead of re-uploading | Pi summarizes on a separate cheap model with cache writes disabled. Different trade-off; worth making configurable. |
| 5 | **Model-visible context budget** (`get_context_remaining`, `new_context_window`, token-usage reminder, turn budget) | Codex, Claude Code, Goose | Lets the model pace itself and choose a clean reset | **Missing.** |
| 6 | **Per-model edit format routing** (GPT → `apply_patch` with grammar; Claude → string replace) | opencode, Cline, Codex, Aider | Models are trained on specific formats | **Missing.** Pi uses one `edit` for all. |
| 7 | **Summary verification "probe" pass** | Gemini | Catches dropped paths, errors and constraints | Missing; cheap to add as an option. |
| 8 | **Post-compaction re-hydration** (re-attach N recently read files, or tree-sitter skeletons, or a history-file reference) | Claude Code (5 files), Roo (folded skeletons), Cursor (history file) | Restores working set without a full re-read | Pi tracks read/modified file lists but only lists them. |
| 9 | **Deferred tool and skill schemas** with a capability index | Cursor, Factory, Claude Code ToolSearch, Codex tool_search | −15% to −51% input tokens when many tools exist | **Partial:** `tool_search` extension exists but is off by default. |
| 10 | **Explicit static vs dynamic prompt tiers** with the cache boundary between them; volatile setup in a "phantom user message" | OpenHands `CacheTier`, Cursor, Codex fragments | Raises cross-session cache hits | **Partial:** sections plus patches; no cross-session static tier. |
| 11 | **Background memory consolidation** from past sessions into a small injected index | Codex, Gemini, Claude Code (auto memory + dream), OpenHands | Cross-session learning without bloat | **Missing.** |
| 12 | **Loop detection** (repetition plus a periodic LLM check) | Gemini | Stops runaway turns | **Missing.** |
| 13 | **Summarizer hygiene rules**: ignore injected instructions in history (Gemini), don't restate AGENTS.md/env because they are re-sent (opencode), preserve all user messages verbatim (Claude Code), "SYSTEM OPERATION not a user request" (Roo) | various | Prevents summary pollution and injection | Pi's prompt has none of these; easy wins. |
| 14 | **Compaction capped by price tier**, not just window (225k under OpenAI's >272k tier) | Goose | Direct cost saving | Pi's economic compaction could take tiered pricing into account. |
| 15 | **Non-destructive compaction** (hide with a parent tag, allow rewind) | Roo | Undo and inspection | Pi already appends `CompactionEntry` without deleting: ✓ equivalent. |
| 16 | **Edit-miss hints** (closest lines, "already applied" detection) and LLM edit fixers | opencode, Gemini | Fewer edit retries | Partial; worth checking Pi's error text. |
| 17 | **Repo map** (PageRank-ranked symbols in a fixed token budget) | Aider, Continue `view_repo_map` | Cheap structural overview | Missing (the harness's pi-lens covers some of this outside core). |

## What Pi already does well (keep)

- An append-only system-prompt section diff, the same pattern Codex and opencode arrived at independently (`PI:coding-agent/src/core/system-prompt.ts:211-228`; `PI:ai/src/utils/text.ts:23-40`).
- Cache economics no other harness has: cold-cache-triggered economic compaction with measured `EXPECTED_REQUESTS = 30` (`compaction/economics.ts`), cache warming with expected-savings gating (`ai/src/cache-warming.ts`), and the Anthropic lookback bridge (`ai/src/api/anthropic-messages.ts:1601-1650`).
- A minimal prompt and tool set (4 tools, about 2.5 KB) in line with the minimalism trend shown by mini-swe-agent, opencode and Cursor.
- Iterative structured summaries with cumulative file tracking, branch summaries and turn-prefix summaries.
- Full output spilled to temp files with explicit paths.
- Worktree-aware AGENTS.md de-duplication, which is not seen elsewhere.

## What Pi lacks (summary list)

1. JIT subdirectory AGENTS.md loading.
2. Old tool-output masking or clearing.
3. Background or speculative compaction.
4. A model-visible context budget or reset tool.
5. Per-model edit-format routing (`apply_patch` for GPT).
6. Summary verification and summarizer hygiene rules.
7. Post-compaction re-hydration of recently read files.
8. Built-in subagents, todo and plan (examples only).
9. Memory.
10. Loop detection.
11. Date and environment as diffable sections. Pi omits the date entirely; adding it as a section patch would be cheap and cache-safe.

---

## Sources

**Local and cloned source (commit / date):**
- Pi: `vendor/pi` @ `ae7358b6b9094e7ac50dc72452c08308fd49dd41` (2026-11-12), `@earendil-works/pi-coding-agent` 1.5.2; upstream https://github.com/earendil-works/pi
- Codex CLI: https://github.com/openai/codex @ `72532ecae5efe500d9e722f3ed5214e63cc8098a` (2026-11-12)
- Gemini CLI: https://github.com/google-gemini/gemini-cli @ `42a715b0476ce3852b7190954f302b9431f4ba34` (2026-11-12)
- opencode: https://github.com/sst/opencode @ `892176957717ec08251be8e0c06562a08222205d` (2026-11-12)
- OpenHands SDK: https://github.com/OpenHands/software-agent-sdk @ `10be259c4fc89b23999e8c653f2130a358e02116` (2026-11-12); app repo https://github.com/All-Hands-AI/OpenHands @ `754abee`
- Aider: https://github.com/Aider-AI/aider @ `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` (2026-05-22)
- Cline: https://github.com/cline/cline @ `50e77bc1e8f7ab023b7986821e4b5f82ff51b8c4` (2026-11-12)
- Roo Code: https://github.com/RooCodeInc/Roo-Code @ `b867ec9145750d0ae1ff7f02d35406e9bf2a0b16` (2026-05-15)
- Goose: https://github.com/block/goose @ `e5896a6bc517ae3d0e1c0028c3bd8c7e66785d6c` (2026-11-12)
- Continue: https://github.com/continuedev/continue @ `5522c6f44ca0ac3528b37244818fbfa39b5af470` (2026-07-20)
- mini-swe-agent: https://github.com/SWE-agent/mini-swe-agent @ `04d809ceab9df28f9adaed044884180159172930` (2026-09-03)
- SWE-agent: https://github.com/SWE-agent/SWE-agent @ `3ea751c087f32b16e039a2233dd6eefecef325d5` (2026-07-16)
- smolagents: https://github.com/huggingface/smolagents @ `96f33faaf028479119ec8d34507b47694cf14e34` (2026-10-06)
- Claude Code prompt extraction: https://github.com/Piebald-AI/claude-code-system-prompts @ `05e3f645073f4a31c27627a0437e82f298b69b41` (CC v2.1.322, 2026-11-09)

**Docs and posts:**
- Claude Code memory: https://code.claude.com/docs/en/memory
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code env vars: https://code.claude.com/docs/en/env-vars
- Claude Code auto-compact threshold issue: https://github.com/anthropics/claude-code/issues/31806
- Anthropic, "Effective context engineering for AI agents" (2025-09-29): https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Amp AGENTS.md: https://ampcode.com/docs/customize/agents-md
- Amp threads: https://ampcode.com/docs/threads
- Amp subagents: https://ampcode.com/docs/models-and-subagents
- Amp handoff: https://ampcode.com/news/handoff
- Amp Neo (2026-05-06): https://ampcode.com/news/neo
- Amp, 200k tokens: https://ampcode.com/notes/200k-tokens-is-plenty
- Cursor rules: https://cursor.com/docs/context/rules
- Cursor dynamic context discovery: https://cursor.com/blog/dynamic-context-discovery
- Cursor improved token efficiency (2026-09-23): https://cursor.com/blog/improved-token-efficiency
- Factory compressing context (2025-07-21): https://factory.ai/news/compressing-context
- Factory evaluating compression: https://factory.ai/news/evaluating-compression
- Factory deferred context engine (2026-05-20): https://factory.ai/news/deferred-context-engine
- Aider repo map: https://aider.chat/docs/repomap.html
- Aider unified diffs: https://aider.chat/docs/unified-diffs.html
- Aider architect mode: https://aider.chat/2024/09/26/architect.html
- Lindenbauer et al., "The Complexity Trap" (2025-08-29): https://arxiv.org/abs/2508.21433

**Caveats.**
- Sizes marked "est." are mine.
- The Claude Code compaction threshold is community-measured.
- Factory's and Cursor's numbers are self-reported.
- Kilo Code, Factory internals and the Amp and Cursor tool sets were not readable as source.
