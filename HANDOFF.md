# Handoff: self-improving Pi harness

Last updated 2026-11-12 (second session). This file is for whoever picks up this work next, a person or an agent.

## Goal

A Pi-based coding harness that runs inside t3 and improves itself over time:

- **Globally** (prompt, extension settings, global skills: this repo) and **per project** (`<repo>/AGENTS.md`, `<repo>/.agents/skills/`, `<repo>/.pi/`).
- **Measured inside the harness**, not from the gateway. The gateway's Usage analytics stay as a legacy view.
- **Evaluated live:** changes are compared across real sessions, not on an offline benchmark.
- **Visible to the user:** every change goes in a changelog with its evidence and measured effect, and can be reverted.

## Decisions the user made

| Topic | Decision |
|---|---|
| Base | Pi (Earendil), not oh-my-pi. oh-pi was deleted; the user doesn't use it. |
| Models | Through the user's gateway (`ANTHROPIC_BASE_URL`, the same one Claude Code uses). Default `claude-opus-5-5`. The improvement loop may change models later. |
| System prompt | A minimal hand-written base (`prompt/base.md`), built up from the ground when a clarification proves necessary. Started from Codex CLI's prompt, then cut down. |
| Not needed | Agent/subagent, plan mode, task list: t3 provides delegation. Background monitoring: t3. |
| Needed | `ask_user` (Pi UI requests appear as t3 dialogs), LSP via a per-project setup scaffold, web search and fetch passed through by the gateway (no gateway endpoints), adapting t3's MCP tools (hide, re-describe, wrap), mid-session tool and prompt changes. |
| Self-improvement | No `improve_harness` tool. Instead: a cheap `note_improvement` capture, recurring **dreaming** as a **t3 scheduled task** (visible in t3), and on-demand improvement through t3's `delegate_task` subagent, plus `/improve`. Keep it harness-neutral where possible (AGENTS.md, `.agents/skills`, `.agents/improvements.md`, `.agents/changelog.md`), e.g. for project task-management conventions. |
| Promotion | All changes promote automatically, but each must be visible (changelog) and revertible. |
| Visualisation | Standalone, ideally served by the harness itself. Inside t3: status line, thread notices, `html_render` cards via the t3 MCP, preview panel. Forking t3 only if that isn't enough. |
| Claude Code sessions | Don't feed them into dreaming: everything moves to Pi. |
| Vendored packages | Clone them into this repo when used, so they can be customised. Pi itself is vendored at `vendor/pi` and is the global `pi`. |
| Metrics | Session files are the source of truth; `~/.pi/agent/metrics.db` is an index rebuilt from them (option B). |
| Message threads | On, through the gateway. |
| Corrections | Recorded as raw signals (user message kinds); classified later during dreaming. |
| Gateway identity line | Keep it for now (see Gotchas). |

## Current state

### This repo (`~/Developer/Developer/ai/pi-harness`)

- `vendor/pi`: Pi as a squashed git subtree of github.com/earendil-works/pi (9b88b94, after v1.5.2). Update with `git subtree pull --prefix vendor/pi https://github.com/earendil-works/pi.git main --squash`, then re-run the installer. The harness's `node_modules` is a symlink to `vendor/pi/node_modules` (npm can't install the vendored package's dependencies past the user's `before` cutoff).
- `prompt/base.md`: the harness's own minimal base prompt (autonomy, `ask_user`, updates during a turn, final answer and file links, skills). It replaced the imported Codex CLI prompt; grow it from evidence when a gap shows up.
- `prompt/AGENTS.md`: the user's global working rules (moved from `~/.claude/CLAUDE.md`).
- `extensions/prompt/index.ts` sets `systemPromptOptions.customPrompt` from `prompt/base.md` and puts `prompt/AGENTS.md` first in `contextFiles`, on every run. Pi still appends the `project_context`, `skills` and `cwd` sections, and sends changed sections mid-session as appended updates.
- `extensions/metrics`: metrics derived from Pi's session files.
  - Pi persists everything needed: the leading system message (prompt sections and tool definitions), later prompt and tool changes, all messages, usage and cost per assistant message, tool `durationMs`, compactions, cache-warm `usage` entries. Nothing is captured live.
  - `indexer.ts` rebuilds each request's context with Pi's `buildSessionContext` (compactions, branches, context edits), `blocks.ts` splits it into blocks in provider order (port of the gateway's `blocks.py`, reading Pi messages instead of provider payloads), `attribution.ts` walks the cache prefix with the rates Pi recorded and explains rebuilds (port of `attribution.py`; a rebuild is ≥ 2k previously cached tokens not read).
  - Harness version = hash of the prompt sections in effect plus the session's initial tools (tools loaded later by tool search are runtime state). Section and tool texts are kept in `blobs` to diff versions. Versions are per project, since `cwd`, `project_context` and `skills` are project sections.
  - `store.ts`: schema in `~/.pi/agent/metrics.db`; bumping `SCHEMA_VERSION` drops and re-indexes everything. Changed files re-index whole; deleted files are pruned.
  - `/harness stats [all]` (notify) and `npm run metrics -- [--all] [--cwd dir] [--since date]` print the same report: totals, cost by content, cache rebuilds, tools (errors, p50/p95, lifetime cost of results), versions.
  - The baseline is whatever sessions exist before the first improvement: every past session is in the index.
- `scripts/install.mjs` (run with the gateway env set, e.g. `zsh -ic 'node scripts/install.mjs'`) builds and globally links `vendor/pi`, removes an npm-installed Pi, and writes to `~/.pi/agent`:
  - `settings.json`: this repo as the only package; default `anthropic/claude-opus-5-5`.
  - `models.json`: the built-in `anthropic` provider routed to the gateway origin with `compat.supportsMessageThreads`, and a `gateway` provider (`openai-responses`) for every non-Claude model from the gateway's `/v1/models`.
  - `auth.json`: both providers read their key with `!security find-generic-password -ws 'pi-harness-gateway'` (Keychain). Needed because t3 starts Pi without shell variables.
- `extensions/ask-user`: `ask_user`, Codex's asynchronous `request_user_input_async` (same description and schema) on Pi dialogs: returns `{"accepted":true}` at once, answers arrive later as an `ask_user` custom message (steer, or a new turn). In t3 each question is a question card that also takes typed text; in the TUI a "Type an answer…" option opens an input.
- `extensions/web`: `web_search` / `web_fetch`. Pi drops server-tool blocks, so each call is its own Messages request (claude-haiku-5-5) with `web_search_20250305` / `web_fetch_20250910` through the gateway passthrough, like Claude Code's WebSearch. Results report their usage (+$0.01 per search); the metrics count it as `tool: <name>` side calls. The 2026 tool versions ran out of tool calls on simple queries through the gateway.
- Vendored Pi patch: `bridgeCacheLookback` in `vendor/pi/packages/ai/src/api/anthropic-messages.ts` (test `anthropic-cache-lookback.test.ts`). A turn adding ≥ 20 blocks (tool search loading many tools as `tool_addition`s, many parallel results) put the previous cache entry out of Anthropic's 20-block lookback, so the whole conversation was rewritten. Upstream candidate.
- Prompt caching for pauses (vendored Pi, settings written by the installer): `cacheRetention: "long"` (1 h cache, writes at 2x input), `cacheWarmingIdleMinutes: 60` (one idle refresh at ~54 min, so the cache lasts ~2 h after the last request), `compaction.coldCache: { minTokens: 50000, model: "anthropic/claude-haiku-5-5" }` (a run whose cache expired compacts a large context with Haiku first; compaction entries record `reason: "cold"`). Pi's warming economics now price a 1 h miss at the 1 h write rate. Metrics: `idle_pauses` (warm / compacted / cold / open, warming cost, rebuild cost) and `compactions` by reason, in `/harness stats`. Re-tune `minTokens` and the idle limit from these once there is history.
- The installer builds Pi with `build:offline` (the online build downloads model catalogs).
- `npm test` (node:test, `test/*.test.ts`), `npm run check` (tsc).

Verified: Pi runs in t3 (this handoff's second session ran in it); t3's MCP tools (`delegate_task`, thread tools, `html_render`) load; `/harness` is discovered through RPC `get_commands` and its report arrives as `notify`. Vendored 1.5.2 with threads through the gateway: no thread fallbacks, cache reads as before. `before_provider_request` still sees the full request (Pi trims it for the thread afterwards).

### Pi

- Source: `vendor/pi` (this repo). The old reference clone `~/Developer/Developer/test/harness/pi` is no longer used.
- Docs: `vendor/pi/packages/coding-agent/docs/` (extensions.md, settings.md, models-configuration.md, providers.md, rpc.md, skills.md, session-format.md, message-types.md).
- Useful APIs:
  - `before_agent_start` (systemPromptOptions), `context`, `context_with_system`, `before_provider_request`, `message_end` (`usage.cost`).
  - `tool_call` / `tool_result` / `tool_execution_end` (`durationMs`), `session_before_compact`, `cache_warming_decision`, `turn_end` / `agent_before_settle` (append entries, request a continuation).
  - `pi.registerTool`, `pi.appendEntry`, `pi.sendMessage`, `registerMcpServer`, tool exposure `deferred`.
  - Session helpers exported from `@earendil-works/pi-coding-agent`: `parseSessionEntries`, `migrateSessionEntries`, `buildSessionContext`, `getAgentDir`.

### t3

- T3 Code Nightly ships a Pi provider (`packages/provider-pi`): `pi --mode rpc`, plus a generated extension `pi-t3-mcp-extension.ts` (env `T3_MCP_URL`, `T3_MCP_BEARER_TOKEN`, `T3_PI_RUNTIME_MODE`) that registers t3's MCP tools as Pi tools. Pi's UI requests (select, confirm, input, editor) show as t3 dialogs. The plan-mode toggle is off for Pi.
- An extracted bundle for reading is in `/tmp/t3asar/apps/server/dist/runtimeLayer-D81jNfD9.mjs` (temporary; re-extract `app.asar` with `npx @electron/asar extract` if it's gone).
- t3 shows a Pi `notify` as a system notice only while a turn is active; other extension UI updates (status, widgets) are ignored. Dialogs (select/confirm/input/editor) are not yet tested: they need `ask_user`.

### Gateway (`~/Developer/Developer/ai/Open-WebUI-Adapter`, branch `samuel_test`; pushing redeploys prod)

- `48a5d14`: `/v1/messages` passes through Anthropic adapters unchanged (server tools, web search and fetch results, citations, mid-conversation system messages, `tool_addition`/`tool_removal`, `defer_loading`). Deployed and checked on prod.
  - Unverified side effect: requests without any `cache_control` now get top-level automatic caching.
- `7aceca0` / `a1c5dd9`: usage analytics (Usage area, backfill). `54ee8f1`: per-version Claude pricing.
- Prod analytics DB backup before the backfill: `/var/lib/docker/volumes/analytics_data/_data/analytics.db.before-usage-insights-20261112`.
- Known: `gpt-6.1-sol` returns a Codex websocket 401 at the gateway (account or token issue behind that alias); `gpt-6-luna` works.

## Next steps (in order)

1. **Tools.** Done: `ask_user`, web search/fetch. Open, waiting on the user's choice:
   - LSP: pi-lens (github.com/apmantza/pi-lens, MIT, peer-depends on `@earendil-works/pi-coding-agent`) is ~300k lines of runtime code (526 files) doing far more than LSP: linters, formatters, autofix, read-before-edit and git guards, turn-end finding injections, background scans, auto-installs. Options: vendor it and turn off all but LSP diagnostics; install it as a package first and judge it with the metrics; or a small own `lsp` extension (`/harness init` writes `.pi/lsp.json`, diagnostics appended to edit/write results, a navigation tool).
   - `t3-adapt`: which `mcp__t3-code__*` tools to hide, re-describe or wrap. Measured: t3's tool definitions and its `t3_code_orchestration` section cost ~1–2% per request; `orchestrator_capabilities` results are 1.6k tokens and stay in context ~75 requests.
   - Check `ask_user` cards in a real t3 thread (verified over RPC only).
2. **Self-improvement.**
   - `note_improvement` writes to `.agents/improvements.md` (project) or this repo's backlog (global).
   - Dreaming as a t3 scheduled task: reads the backlog, sessions and `metrics.db`; classifies `user_messages` (follow-up, steer, after interrupt) into corrections with a cheap model; makes small playbook edits (ACE style); commits each change with its hypothesis and target metric; switches a share of new sessions to it; promotes or reverts on the target metric plus guardrails (corrections, tool errors). Compare by harness version (`requests.version`).
   - Mid-session rollout through appended system messages.
   - Changelog in `.agents/changelog.md` and here.
3. **Visualisation.** Status line, change notices, `/harness` card through `html_render`, a dashboard served by the harness and opened in t3's preview.

Metrics open points: thinking blocks are sized from text plus signature length (the gateway's estimate; Anthropic's real count for replayed thinking is unknown), and scaled with everything else to the real prompt size. Models without mid-conversation system messages get the prompt replayed, which the block order doesn't model.

## Gotchas

- **Don't change requests to hide what client sent them.** If Anthropic ever answers "Third-party apps now draw from your extra usage", report it; don't work around it. The user's wish to use Codex's prompt is a preference, not a workaround.
  - Known: the gateway's Anthropic adapter (`routing_core._with_claude_code_identity`, gateway commit 4a1b514) prepends "You are Claude Code, Anthropic's official CLI for Claude." to every request on a Claude OAuth account (Anthropic answers OAuth Sonnet/Opus requests with a 429 without it). Pi sends a clean request. The user chose to keep it for now. The model therefore sees itself introduced as Claude Code.
- **Gateway:** commit with `git commit --only <paths> -F <file>`. Pushing `samuel_test` deploys prod, so verify first (a staging container on respond5 next to prod worked well: `docker run` with the prod image, env and `/data`, on `127.0.0.1:18081`).
- **User's working rules:** `~/.claude/CLAUDE.md`. Root causes, no legacy code, DRY, in-depth tests, propose before big tasks, conventional commits with detailed bodies.
