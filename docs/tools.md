# Tools

The harness adds or replaces these tools on top of Pi's built-ins (`read`, `edit`, `write`, `grep`, `find`, `ls`). Optional tools are registered inactive and switched on by a [rule or an experiment](prompt.md).

## bash

[`extensions/bash`](../extensions/bash) owns the `bash` tool. Each feature was added after a measured failure in real sessions.

### Long commands move to the background

[`jobs.ts`](../extensions/bash/jobs.ts) wraps Pi's bash. A command the model runs moves to the background, without being stopped, after two minutes, or as soon as a user message arrives while it runs. The tool returns at once with the output so far, the process group (`kill -- -<pgid>`) and the path of a log of the latest output. When the command ends, its normal result arrives as a message that wakes the session, even after the turn has ended.

While jobs run, the session reports background work (`pi.setBackgroundWork`), so T3 keeps it loaded and keeps a delegated child's run open. Jobs live in process state, so a harness reload mid-job still delivers the result.

Why: agents sat 37 and 40 minutes in a single build command, and the user's messages could not reach them.

### Detaching is refused

[`detach.ts`](../extensions/bash/detach.ts) parses each command with a Bash parser and refuses one that detaches a job: a statement ending in `&` that nothing waits for or stops, `setsid` or `disown`, also inside `bash -c '…'` and behind `nohup`, `env` or `sudo`. Such a job would lose the wake-up message. Detaching is never needed, because long commands move to the background on their own.

### Background-process guard

[`index.ts`](../extensions/bash/index.ts) records each command's process group. When a run is about to end while processes from those groups are still alive, it names them and asks for one more turn: wait for them, stop them, or say why they keep running. Each set of processes is reported once, so the agent can still end the turn deliberately. A process that leaves its group (`setsid`, a daemonizing server) is not seen.

Why: the most repeated correction in the author's sessions was an agent ending its turn "waiting" on a background job that nothing would ever report (22 sessions over 10 days). Instructions alone did not stop it.

### `tool` inside bash

[`bridge.ts`](../extensions/bash/bridge.ts) gives every bash call a `tool` command that runs any tool the agent can call, through the session's normal tool pipeline (validation, hooks, permissions), recorded as a nested call:

```sh
npm run build && ./app --screenshot shot.png && tool read shot.png
tool web_fetch --url https://example.com
tool lens_diagnostics --args '{"source":"lsp","scope":"paths","paths":["src/a.ts"]}'
```

- Required parameters are positional. Others are passed as `--name value`, with repeated options for arrays, JSON for objects, or as one object with `--args <json|->`.
- Text goes to stdout. Failures go to stderr with exit code 1, and usage errors exit with 2, so `&&` and `set -e` work. Images are attached to the bash result.
- Transport: one Unix socket per bash call, closed when the call ends. A client that dies (`timeout 5 tool …`) aborts its call.

Why: tool calls in one response run in parallel, so dependent steps cost one model request each. A script expresses the order. Pi's JavaScript code-mode tool saw 4 calls against 4,841 bash calls, so bash became the one way to script.

### `tool edit -`

[`edit-blocks.ts`](../extensions/bash/edit-blocks.ts) accepts SEARCH/REPLACE blocks (aider's format) for several files on stdin, checks every block with Pi's own matching before writing any file, then applies each file as one `edit` call. That way pi-lens checks it and the metrics count it.

```sh
tool edit - <<'EOF' && npm test
src/a.ts
<<<<<<< SEARCH
old
=======
new
>>>>>>> REPLACE
EOF
```

Why: agents edited files with inline Python scripts almost twice as often as with `edit` (813 against 451), mostly to edit several files and then run a check in the same step.

## workflow and fix_loop

[`extensions/workflow`](../extensions/workflow) lets the agent write a TypeScript script that does a procedure in code and calls a model only where a judgment is needed. Only the script's return value reaches the conversation. The full API, as the model sees it, is in [`api.d.ts`](../extensions/workflow/api.d.ts):

| Global | Purpose |
| --- | --- |
| `tools.<name>(args)` | call any session tool |
| `shell(cmd)`, `` sh`…` `` | run shell commands, with values quoted safely |
| `llm(prompt, { schema })` | one model request; JSON answers validated against a schema; cached per session |
| `agent({ files }).run(msg)` | a child agent with tools; `files` limits what it may change, and other changes are reverted |
| `map(items, fn)` | bounded concurrency |
| `changes()` | the files and diff changed during the run |
| `budget` | the run's USD limit and what it has spent |

Saved workflows become tools of their own: `<repo>/.pi/workflows/<name>.ts` for a project, [`workflows/`](../workflows) for every session. They are read on every run, so a workflow the agent saves can be called from its next turn.

[`fix_loop`](../workflows/fix_loop.ts) is the shipped workflow. It hands a failing check with a clear error and a known set of files to a cheaper child agent (Sonnet) with a short context. The workflow runs the check itself before the first round and after every round, so "green" means the check's exit code, not the child's claim. Changes outside `files` are refused or reverted.

Why: in one large project, repair chains (failed check → … → green) cost 17% of all spend, 59% of it cache reads of a median 379k-token context per turn.

## ask_user

[`extensions/ask-user`](../extensions/ask-user/index.ts) implements Codex's asynchronous `request_user_input` contract on Pi's dialogs. It shows the questions and returns `{"accepted":true}` at once. The answers arrive later as a message that steers the running turn or starts a new one. One call is one dialog: in T3 a single card with every question, each also accepting typed text; in the terminal, one question after another. Calls do not queue behind each other.

The tool description is taken from Codex CLI (Apache-2.0, see [NOTICE](../NOTICE)). In T3 it needs the [patches](install.md#t3-code-integration).

## web_search and web_fetch

[`extensions/web`](../extensions/web/index.ts). Pi keeps no server-tool blocks in its messages, so, as in Claude Code's WebSearch, each call is its own small Messages request to Haiku with Anthropic's `web_search_20250305` or `web_fetch_20250910` server tool. It returns the findings as text and reports its usage, so the cost counts toward the session and shows in the metrics. This works whatever model the session runs on.

## note_improvement

[`extensions/improvements`](../extensions/improvements/index.ts). The agent records friction (a correction, a missing or wrong instruction, a misleading tool) with an observation and a proposal. It only appends to a backlog, so it costs almost nothing during the task. See [self-improvement.md](self-improvement.md).

## pi-lens

[pi-lens](https://github.com/apmantza/pi-lens) adds LSP diagnostics, linters, formatters, autofix, a read guard, structural rules, and code-navigation tools (`lens_diagnostics`, `symbol_search`, `module_report`, `read_symbol`, ast-grep tools behind `pi_lens_activate_tools`).

[`extensions/lens`](../extensions/lens/index.ts) makes every pi-lens setting configurable at two levels:

- **Global:** [`config/pi-lens.json`](../config/pi-lens.json), versioned in this repository.
- **Project:** `<repo>/.pi/pi-lens.json`, any key.

Objects merge key by key, other values replace, and `null` removes a global key. The merged file is written to `~/.pi/agent/pi-lens/<hash>.json` and passed to pi-lens through `PI_LENS_CONFIG_PATH` before pi-lens loads. pi-lens's own `.pi-lens.json` still applies on top.

The one global deviation from pi-lens's defaults is `contextInjection.retain: true`. Without it, an injected finding rides on one request only, so the next request's prefix differs from the cached one and the cache is rebuilt.
