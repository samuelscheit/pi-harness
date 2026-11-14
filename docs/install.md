# Installation

The installer reproduces the author's setup. It is not a general-purpose installer: it assumes macOS, an Anthropic-compatible model gateway, and T3 Code. This page lists everything it does, so you can follow it, or adapt the parts that do not fit your setup.

## Requirements

- **macOS.** The installer uses the Keychain (`security`) and a LaunchAgent (`launchctl`).
- **Node.js 24 or later.** The harness runs its TypeScript sources directly through Node's type stripping, and uses `node:sqlite`.
- **A model gateway** that speaks the Anthropic Messages API, and lists models at `/v1/models` with the bearer token. The author's gateway also serves non-Claude models through the OpenAI Responses API, and passes through Anthropic server tools (web search and fetch).
- **[T3 Code](https://github.com/pingdotgg/t3code) (Nightly)**, optional. It is the front end the harness is built around: delegation, threads, scheduled tasks. Pi's terminal UI works as well, without those features.

## Running it

```sh
ANTHROPIC_BASE_URL=https://your-gateway.example ANTHROPIC_AUTH_TOKEN=… node scripts/install.mjs
```

These are the same two variables Claude Code uses for a gateway. Re-run the installer after pulling a new version of the bundled Pi.

## What it does

1. **Installs Pi's dependencies.** It runs `npm ci` in `vendor/pi`, and generates the model data if it is missing. Pi builds link to these dependencies and copy the model data (see [releases.md](releases.md#pi-builds)). The harness's `node_modules` is a symlink to `vendor/pi/node_modules`.
2. **Keeps T3 Code patched.** It writes and loads the LaunchAgent `com.pi-harness.patch-t3`, which runs [`scripts/patch-t3.ts`](../scripts/patch-t3.ts) at login and whenever `/Applications` changes. See [T3 Code integration](#t3-code-integration).
3. **Builds pi-lens and the dashboard.** pi-lens is built with `npm ci --ignore-scripts` (its `prepare` script would rewire git hooks), `build:dist` and the core tree-sitter grammars. The dashboard runs `npm ci` and `npm run build`.
4. **Writes `~/.pi/agent/models.json`.**
   - Pi's built-in `anthropic` provider is routed to the gateway, with message threads on (`compat.supportsMessageThreads`): the gateway forwards Anthropic message threads, so Claude requests send only what is new since the previous reply.
   - A `gateway` provider (`openai-responses`) carries every non-Claude model from the gateway's `/v1/models`, with their context windows. This is the only reason the installer calls the API.
   - `compat.supportsMidConvoSystemMessages` is set on the gateway, so prompt edits are sent as appended developer messages and keep the prompt cache (see [prompt.md](prompt.md#prompt-updates-and-the-cache)).
5. **Stores the key.** It saves the token in the Keychain item `pi-harness-gateway` and writes `~/.pi/agent/auth.json` so that both providers read it with `!security find-generic-password …`. T3 starts Pi without shell variables, and the token is never written to a file.
6. **Deploys the first release and links Pi.** The current branch's latest commit becomes `~/.pi/agent/harness/current`, after its `vendor/pi` is built and an import check passes. An npm-installed `@earendil-works/pi-coding-agent` is removed. The global package and `pi` command link to `~/.pi/agent/harness/pi`, the build each deploy switches to. See [releases.md](releases.md).
7. **Writes `~/.pi/agent/settings.json`.**

| Setting | Value | Why |
| --- | --- | --- |
| `packages` | the current release, then `vendor/pi-lens` | the harness loads first, so its lens extension can configure pi-lens before pi-lens loads |
| `defaultProvider`, `defaultModel` | `anthropic`, `claude-opus-5-5` | |
| `cacheRetention` | `long` | one-hour prompt cache (writes cost 2× input) |
| `cacheWarmingIdleMinutes` | 240 | keep an idle session's cache warm for up to four hours; of measured pauses still idle at a refresh, 37% / 14% / 11% / 10% resumed within the next hour at 54 / 114 / 174 / 234 minutes |
| `compaction.economic` | Haiku 5.5, `minSaving: 1` | before a run whose cache expired, compact with a cheap model when that saves more than $1 compared with writing the whole context again |

## T3 Code integration

T3 Code Nightly ships a Pi provider. It runs `pi --mode rpc` and registers T3's MCP tools (`delegate_task`, thread tools, `html_render`, …) as Pi tools. Pi's dialogs (select, confirm, input, editor) appear as T3 question cards. A Pi `notify` appears as a system notice only while a turn is active.

T3 has not shipped some adapter fixes the harness depends on. [`scripts/patch-t3.ts`](../scripts/patch-t3.ts) applies them to the installed app bundle. Each patch mirrors a commit on a T3 Code branch:

| Patch | Fixes |
| --- | --- |
| `cache-warming` | T3 unloaded idle sessions after 30 minutes before Pi's cache refresh at 54 minutes could run |
| `dialogs`, `session-questions` | open dialogs were cancelled when a turn ended, so an `ask_user` card left open past its turn vanished seconds after it appeared |
| `background-work` | sessions with bash jobs in the background were unloaded, and a delegated child reported "done" while its build was still running |
| `questions` | an `ask_user` call with several questions became several cards; now it is one card, paged |
| `delegate-fork-*` | `delegate_task` always started its child empty; `fork: true` (with `forkThreadId`, a thread the caller delegated) starts it from a `pi --fork` copy of that Pi conversation up to now, with the same model, so its first request reads the history from the prompt cache |

Unpatched T3 ignores the `questions` dialog, so `ask_user` shows nothing there. Every T3 update replaces the bundle and drops the patches, so the LaunchAgent re-applies them. It restarts T3 if an update started it less than two minutes ago, and otherwise sends a notification to restart. Log: `~/.pi/agent/logs/patch-t3.log`.

## Bundled Pi and pi-lens

Both are squashed git subtrees, so they can carry local patches.

| Package | Upstream | Update |
| --- | --- | --- |
| `vendor/pi` | [earendil-works/pi](https://github.com/earendil-works/pi) | `git subtree pull --prefix vendor/pi https://github.com/earendil-works/pi.git main --squash`, then re-run the installer |
| `vendor/pi-lens` | [apmantza/pi-lens](https://github.com/apmantza/pi-lens) | `git subtree pull --prefix vendor/pi-lens https://github.com/apmantza/pi-lens.git master --squash` |

Patches to Pi, all candidates for upstream:

- **`pi.requestReload()`** (`agent-session.ts`, extension API): reload extensions at the next turn boundary of a running agent loop, then run `before_agent_start` again with `reloaded: true`. Before, `reload()` was refused during a run, so a long autonomous run never picked up a new release. Test: `agent-session-request-reload.test.ts`.
- **Reloading changed JavaScript extensions** (`core/extensions/loader.ts`): Node caches natively imported `.js` and `.mjs` modules for the life of the process, so `/reload` kept running pi-lens's old bundle. A changed file is now imported with a cache-busting URL.
- **Cache lookback bridge** (`packages/ai/src/api/anthropic-messages.ts`): a turn that adds 20 or more content blocks pushed the previous cache breakpoint out of Anthropic's 20-block lookback, and the whole conversation was written to the cache again.
- **`ctx.ui.questions`**: one dialog with several questions, used by `ask_user`.
- **`pi.setBackgroundWork()`** and the `background_work` event: extensions report pending work, so a front end keeps the session loaded.
- **Dialog `dismiss`**: Pi tells the front end when an abort signal or a timeout closes a dialog.
- **Cache warming and cold compaction**: a one-hour cache miss is priced at the one-hour write rate, compaction entries record their reason, and `cache_warming` events are emitted.

## Adapting it to another setup

The parts specific to the author's setup are confined to the installer and to `scripts/patch-t3.ts`. The extensions themselves only need Pi.

- **Without a gateway:** skip the `/v1/models` call and the `gateway` provider, leave Pi's `anthropic` provider at its default URL, and put an `ANTHROPIC_API_KEY` in `auth.json` or the environment. `web_search` and `web_fetch` need a provider that accepts Anthropic server tools; the Anthropic API does.
- **Without macOS:** replace the Keychain lookup in `auth.json` with any command Pi can run, or with a plain key, and skip the LaunchAgent.
- **Without T3 Code:** skip the patch step. `ask_user` then uses Pi's terminal dialogs, and delegation is unavailable.
- **Without releases:** point `settings.json` `packages` at the repository checkout instead of `harness/current`. The release extension does nothing when it runs from a checkout, so edits take effect at the next session or `/reload`.

## Note on the system prompt identity

The author's gateway prepends "You are Claude Code, Anthropic's official CLI for Claude." to every Claude request made with a Claude subscription, because Anthropic rejects those requests without it. Pi sends a clean request, and [`prompt/base.md`](../prompt/base.md) does not contain that line.
