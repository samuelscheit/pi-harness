# Releases and hot reload

A commit to the deployed branch reaches every running Pi session within seconds, without a restart and without interrupting a run. Uncommitted edits never reach a session. To deploy, commit.

Implementation: [`extensions/lib/release.ts`](../extensions/lib/release.ts) (releases), [`extensions/lib/pi-build.ts`](../extensions/lib/pi-build.ts) (Pi builds) and [`extensions/release`](../extensions/release/index.ts) (watching and reloading).

## Layout

```text
~/.pi/agent/harness/
  releases/<commit>/    the commit's files (git archive, without vendor/), plus links to vendor/ and
                        dashboard/node_modules, node_modules linked to the commit's Pi build, and .release.json
  current               link to the deployed release, switched atomically by rename
  pi-builds/<tree>/     vendor/pi of a commit (git archive of its tree id), built in place
  pi                    link to the global Pi's build, switched atomically by rename
  pi-build              the tree id `pi` points at, for releases from before pi-builds/
  failed/<commit>.txt   why a commit was not deployed, so it is tried only once
  in-use/<pid>          the release and the Pi build each running Pi process loaded; pruning keeps these
  .lock/                held while deploying, with the holder's pid and a heartbeat
```

Pi loads the harness from `current` (set as a package in `settings.json`). The global `pi` command and the `@earendil-works/pi-coding-agent` package link to `pi/packages/coding-agent`. To roll back, point `current` at an earlier `releases/<commit>` and `pi` at its build.

## Pi builds

Pi is built from the commit, never from the working tree. Several agents can edit `vendor/pi` at once without holding up deploys, and the global Pi is exactly the commit's. A build directory holds:

- **The tree's files**, written by `git archive <tree>`.
- **`node_modules/`**, links to the entries of the working tree's `vendor/pi/node_modules`, which `npm ci` installs once (scripts/install.mjs). There is no install per build. Workspace packages (`@earendil-works/pi-*`) link to the build's own `packages/` instead, and each workspace's own `node_modules` links to the working tree's.
- **Model data**, `packages/ai/src/providers/data`. It is gitignored and generated from the network, so it is copied from the working tree. It is generated in the build only when the commit's check rejects that copy.

A build runs as `.<tree>.<pid>/` and is renamed into place when done. A failed build leaves nothing behind, and the previous Pi stays. On this machine a build takes about 15 s and uses 111 MB (dependencies are links). A whole deploy that builds Pi takes about 18 s; one that reuses a build takes about 1.3 s.

Pruning runs after each deploy. It keeps the build `pi` points at, the builds the remaining releases use, and the builds live processes run (`in-use/<pid>`). A running process runs the build it was loaded from, and Node resolves the real path, so a later switch of `pi` does not affect it.

## Deploying

Every Pi process that runs a release watches the source branch. The first one that sees a new commit deploys it, and the others find it already deployed.

1. **Build Pi if needed.** The commit's `vendor/pi` tree is built in `pi-builds/<tree>/`, unless it is built already (see above).
2. **Archive** the commit into `releases/<commit>`, with `node_modules` linked to that build.
3. **Check imports.** Every extension entry point must import in a fresh Node process, resolving Pi's packages from the commit's build. A commit with a broken import or a syntax error, or whose Pi does not build, is recorded in `failed/` and reported. The previous release and Pi keep running.
4. **Switch `pi`, then `current`**, and move the [dashboard](metrics.md#dashboard) to the new release. A deployed commit whose Pi is not the global one (for example after `pi` was pointed elsewhere) deploys again.

## Reloading sessions

Each session reloads into the new release with `pi.requestReload()`, a patch to the bundled Pi:

- **Idle:** at once.
- **During a run:** at the next turn boundary, after the turn's tool results and before the next request, when nothing is streaming or executing. `before_agent_start` runs again with `reloaded: true`, so the extensions rebuild the run's prompt and tools, and the run continues on the new code. A tool call already running finishes on the old code.
- **Otherwise:** when the run settles.

Pi itself cannot be swapped inside a running process, and a release may use Pi APIs newer than the process has. So a process reloads only into releases built for the Pi it runs, the build its Pi package was loaded from. For a newer one it says once that a restart is needed. Processes started later use the new global Pi.

Running from a repository checkout (tests, development), the release extension does nothing.

## Writes go to the repository

Code that changes the harness at runtime writes to the source repository, not to the release: experiment stops and promotions, dreamed rules, improvement notes. Changes that affect sessions are committed and so deploy like any other commit.
