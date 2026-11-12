# Handoff: self-improving Pi harness

Last updated 2026-11-12. This file is for whoever picks up this work next, a person or an agent.

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
| System prompt | Codex CLI's prompt, because the user prefers it (not as a workaround of any kind). |
| Not needed | Agent/subagent, plan mode, task list: t3 provides delegation. Background monitoring: t3. |
| Needed | `ask_user` (Pi UI requests appear as t3 dialogs), LSP via a per-project setup scaffold, web search and fetch passed through by the gateway (no gateway endpoints), adapting t3's MCP tools (hide, re-describe, wrap), mid-session tool and prompt changes. |
| Self-improvement | No `improve_harness` tool. Instead: a cheap `note_improvement` capture, recurring **dreaming** as a **t3 scheduled task** (visible in t3), and on-demand improvement through t3's `delegate_task` subagent, plus `/improve`. Keep it harness-neutral where possible (AGENTS.md, `.agents/skills`, `.agents/improvements.md`, `.agents/changelog.md`), e.g. for project task-management conventions. |
| Promotion | All changes promote automatically, but each must be visible (changelog) and revertible. |
| Visualisation | Standalone, ideally served by the harness itself. Inside t3: status line, thread notices, `html_render` cards via the t3 MCP, preview panel. Forking t3 only if that isn't enough. |
| Claude Code sessions | Don't feed them into dreaming: everything moves to Pi. |
| Vendored packages | Clone them into this repo when used, so they can be customised. |

## Current state

### This repo (`~/Developer/Developer/ai/pi-harness`)

- `scripts/import-codex-prompt.mjs` imports `model_messages.instructions_template` for `gpt-6.1-sol` from `~/Developer/Developer/test/harness/codex` (`codex-rs/models-manager/models.json` at `origin/HEAD`) into `prompt/base.md`.
  - It applies a fixed list of adaptations (identity, `ask_user`, `bash`/`command`, no orchestrator skills, no Apps/Plugins sections).
  - It fails if a rule no longer matches or a Codex term is left over.
  - `prompt/SOURCE.json` records the upstream commit; `NOTICE` holds the Apache-2.0 attribution.
- `extensions/prompt/index.ts` sets `systemPromptOptions.customPrompt` from `prompt/base.md` on every run. Pi still appends the `project_context`, `skills` and `cwd` sections, and sends changed sections mid-session as appended updates.
- `scripts/install.mjs` (run with the gateway env set) writes to `~/.pi/agent`:
  - `settings.json`: this repo as the only package; default `anthropic/claude-opus-5-5`.
  - `models.json`: the built-in `anthropic` provider routed to the gateway origin, and a `gateway` provider (`openai-responses`) for every non-Claude model from the gateway's `/v1/models`.
  - `auth.json`: both providers read their key with `!security find-generic-password -ws 'pi-harness-gateway'` (Keychain). Needed because t3 starts Pi without shell variables.
- `package.json`: a Pi package; loads `extensions/*/index.ts`.

Verified: `pi -p` with no flags and no gateway env answers on Opus 5.5 through the gateway, the bash tool works, and the second request reads about 16k tokens from cache. `gateway/gpt-6-luna` also works.

### Pi

- Source: `~/Developer/Developer/test/harness/pi`, on `main` at the latest commit, after v1.5.2.
- CLI: `@earendil-works/pi-coding-agent@1.4.0` installed globally with npm. The user's npm config only allows releases older than two weeks (`before = 2026-10-29`), so 1.5.x isn't installable from npm yet. Build from the clone if needed.
- Docs: `packages/coding-agent/docs/` (extensions.md, settings.md, models-configuration.md, providers.md, rpc.md, skills.md).
- Useful APIs:
  - `before_agent_start` (systemPromptOptions), `context`, `before_provider_request` (rewrite the payload, e.g. append `tool_addition` system messages), `message_end` (`usage.cost`).
  - `tool_call` / `tool_result`, `session_before_compact`, `cache_warming_decision`.
  - `pi.registerTool`, `pi.appendEntry`, `pi.sendMessage`, `registerMcpServer`, tool exposure `deferred`.
  - Pi's Anthropic API code already sends `tool_addition` / `tool_removal` for tool changes (`packages/ai/src/api/anthropic-messages.ts`).

### t3

- T3 Code Nightly ships a Pi provider (`packages/provider-pi`): `pi --mode rpc`, plus a generated extension `pi-t3-mcp-extension.ts` (env `T3_MCP_URL`, `T3_MCP_BEARER_TOKEN`, `T3_PI_RUNTIME_MODE`) that registers t3's MCP tools as Pi tools. Pi's UI requests (select, confirm, input, editor) show as t3 dialogs. The plan-mode toggle is off for Pi.
- An extracted bundle for reading is in `/tmp/t3asar/apps/server/dist/runtimeLayer-D81jNfD9.mjs` (temporary; re-extract `app.asar` with `npx @electron/asar extract` if it's gone).
- The user enabled the Pi provider. After the Keychain fix, t3 needs a provider refresh or restart to clear the cached "Not authenticated" status. **Not yet confirmed that Pi runs in t3.**

### Gateway (`~/Developer/Developer/ai/Open-WebUI-Adapter`, branch `samuel_test`; pushing redeploys prod)

- `48a5d14`: `/v1/messages` passes through Anthropic adapters unchanged (server tools, web search and fetch results, citations, mid-conversation system messages, `tool_addition`/`tool_removal`, `defer_loading`). Deployed and checked on prod.
  - Unverified side effect: requests without any `cache_control` now get top-level automatic caching.
- `7aceca0` / `a1c5dd9`: usage analytics (Usage area, backfill). `54ee8f1`: per-version Claude pricing.
- Prod analytics DB backup before the backfill: `/var/lib/docker/volumes/analytics_data/_data/analytics.db.before-usage-insights-20261112`.
- Known: `gpt-6.1-sol` returns a Codex websocket 401 at the gateway (account or token issue behind that alias); `gpt-6-luna` works.

## Next steps (in order)

1. **Confirm Pi in t3.** Refresh the provider; run a thread; check that t3's tools (delegate_task, thread tools, html_render) appear and that ask/confirm dialogs work.
2. **`extensions/metrics`.** SQLite at `~/.pi/agent/metrics.db` (`node:sqlite`).
   - Per request: payload split by content and billing rate. Port `usage_insights/blocks.py` + `attribution.py` from the gateway; Pi has the exact payload in `before_provider_request` and usage/cost in `message_end`.
   - Per tool: size, duration, errors, turns kept in context.
   - Per session/task: corrections, interruptions, compactions.
   - Every row: project, session, model, harness version hash (prompt sections, playbook, skills, extensions, settings).
   - `/harness stats`. Record a baseline before any improvement runs.
3. **Tools.** `ask_user` (ctx.ui select/input), LSP via `/harness init` (detect languages, write the project LSP config; vendor pi-lens), a `t3-adapt` extension (hide, re-describe or wrap `mcp__t3_code__*` tools), web search/fetch as Anthropic server tools passed through the gateway.
4. **Self-improvement.**
   - `note_improvement` writes to `.agents/improvements.md` (project) or this repo's backlog (global).
   - Dreaming as a t3 scheduled task: reads the backlog, sessions and metrics; makes small playbook edits (ACE style); commits each change with its hypothesis and target metric; switches a share of new sessions to it; promotes or reverts on the target metric plus guardrails (corrections, tool errors).
   - Mid-session rollout through appended system messages.
   - Changelog in `.agents/changelog.md` and here.
5. **Visualisation.** Status line, change notices, `/harness` card through `html_render`, a dashboard served by the harness and opened in t3's preview.

## Gotchas

- **Don't change requests to hide what client sent them.** If Anthropic ever answers "Third-party apps now draw from your extra usage", report it; don't work around it. The user's wish to use Codex's prompt is a preference, not a workaround.
- **Gateway:** commit with `git commit --only <paths> -F <file>`. Pushing `samuel_test` deploys prod, so verify first (a staging container on respond5 next to prod worked well: `docker run` with the prod image, env and `/data`, on `127.0.0.1:18081`).
- **User's working rules:** `~/.claude/CLAUDE.md`. Root causes, no legacy code, DRY, in-depth tests, propose before big tasks, conventional commits with detailed bodies.
