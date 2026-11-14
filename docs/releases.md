# Releases and hot reload

A commit to the deployed branch reaches every running Pi session within seconds, without a restart and without interrupting a run. Uncommitted edits never reach a session. To deploy, commit.

Implementation: [`extensions/lib/release.ts`](../extensions/lib/release.ts) (releases) and [`extensions/release`](../extensions/release/index.ts) (watching and reloading).

## Layout

```text
~/.pi/agent/harness/
  releases/<commit>/    the commit's files (git archive, without vendor/), plus links to vendor/,
                        node_modules and dashboard/node_modules, and .release.json
  current               link to the deployed release, switched atomically by rename
  failed/<commit>.txt   why a commit was not deployed, so it is tried only once
  in-use/<pid>          the release each running Pi process loaded; pruning keeps these
  pi-build              the vendor/pi tree id the global Pi was built from
  .lock/                held while deploying, with the holder's pid and a heartbeat
```

Pi loads the harness from `current` (set as a package in `settings.json`). To roll back, point `current` at an earlier `releases/<commit>`.

## Deploying

Every Pi process that runs a release watches the source branch. The first one that sees a new commit deploys it, and the others find it already deployed.

1. **Archive** the commit into `releases/<commit>`.
2. **Rebuild Pi if needed.** When the commit's `vendor/pi` tree differs from `pi-build`, the global Pi is rebuilt (`npm run build:offline`) first. This is refused when the working tree's `vendor/pi` differs from the commit.
3. **Check imports.** Every extension entry point must import in a fresh Node process. A commit with a broken import or a syntax error is recorded in `failed/` and reported, and the previous release keeps running.
4. **Switch `current`**, and move the [dashboard](metrics.md#dashboard) to the new release.

## Reloading sessions

Each session reloads into the new release with `pi.requestReload()`, a patch to the bundled Pi:

- **Idle:** at once.
- **During a run:** at the next turn boundary, after the turn's tool results and before the next request, when nothing is streaming or executing. `before_agent_start` runs again with `reloaded: true`, so the extensions rebuild the run's prompt and tools, and the run continues on the new code. A tool call already running finishes on the old code.
- **Otherwise:** when the run settles.

Pi itself cannot be swapped inside a running process, and a release may use Pi APIs newer than the process has. So a process reloads only into releases built for the Pi it started with. For a newer one it says once that a restart is needed. Processes started later use the rebuilt global Pi.

Running from a repository checkout (tests, development), the release extension does nothing.

## Writes go to the repository

Code that changes the harness at runtime writes to the source repository, not to the release: experiment stops and promotions, dreamed rules, improvement notes. Changes that affect sessions are committed and so deploy like any other commit.
