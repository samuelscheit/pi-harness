# Session templates

A template is a prepared session that tasks of one kind start from: the role, the way of working, the project files read in, examples, the process. Every task forks it, so its prefix is written to the prompt cache once and read by every task after that. It is named, persistent and rebuilt when it goes stale. Code: [`extensions/template`](../extensions/template), with Pi's side in [`vendor/pi/.../template-prefix.ts`](../vendor/pi/packages/coding-agent/src/core/template-prefix.ts).

## Writing a recipe

A recipe is a Markdown file: `<repo>/.pi/templates/<name>.md` for a project (versioned and reviewed with it), or `templates/<name>.md` in this repository for every project. A project recipe replaces a global one of the same name. Names are lower case letters, digits and `-`.

```md
---
model: anthropic/claude-sonnet-5-5   # required: the template's turns belong to this model
thinking: medium                      # optional: the children's default
description: Reviews workflow changes # optional: shown by /template list
read:                                 # optional: paths or globs, relative to the repository
  - docs/tools.md
  - extensions/workflow/*.ts
---
You review changes to the workflow extension. …the role, the way of working, the process…

:::user
An example request.
:::
:::assistant
The answer, as you want it given.
:::
```

- The body before the first example is the instructions. Examples alternate `:::user` and `:::assistant` blocks, each closed by `:::`, starting with a user turn and ending with an assistant turn.
- Example answers are only ever your words. The build never asks a model to write a turn.
- Globs expand in sorted order. A path or glob that matches no file is an error, and so is a path that leaves the repository. A global recipe's paths are relative to the harness.

## What the build makes

The build needs no model call and is deterministic: the same recipe, files and model give the same bytes, and so the same entry ids and prompt cache keys. The session holds:

1. the instructions as the first user message;
2. one assistant message calling `read` for every file, and each call's result from Pi's own read tool (with its truncation rules), so the history is that of a session that read them;
3. a fixed reply listing the files read, which closes the tool loop;
4. the examples, verbatim;
5. a fixed user message: the template ends here, the task follows.

The last message makes the template end in a plain user message, so its prefix can be cached on its own, also with extended thinking (a prefix ending in tool results would need thinking blocks a built template cannot have). Every timestamp is the epoch, and ids are hashes chained over the content before them: a changed file changes the ids from its result on, not before it.

There is no system prompt. A template is the conversation: every fork runs it with its current prompt and tools, which Pi puts in front of the template (`hoistLeadingSystemEntry`). Harness releases change the prompt often, and a template that carried one would go stale with every release.

Builds live in `~/.pi/agent/templates/<name>/<scope>/`: `session.jsonl` and `meta.json` (recipe file and hash, model, thinking, every read with a hash of its result, build time, and the prefix key: the id chain key of the template's end). The scope is `global`, or `<repo>-<hash of its path>` for a project, so every checkout and worktree builds its own.

## Using one

Using a template is forking it, everywhere the same:

| Where | How |
| --- | --- |
| a delegated task | `delegate_task({ template: "<name>", task })`: the harness extension of t3's tool (see [tools.md](tools.md#delegate_task-extended-by-the-harness)) |
| a workflow | `delegate({ template: "<name>" }).run(task)`, in t3 and in-process |
| the user in Pi | `/template <name>` starts a fresh session from it; `/template list` lists them with their state |

- The child runs on the template's model. `target.model` must match it or be omitted; `target.options` may set the thinking level, which defaults to the recipe's.
- `system` and `tools` apply as without a template, since the prompt is not part of it. `fork` does not go with a template.
- The child's first message says `from template <name> (built <time>)`, plus the reason when it was rebuilt for this use.
- In t3 the harness passes the template's session file as `forkSessionFile`; t3 forks it with `pi --fork <file>` as it forks threads. t3 accepts only a real `.jsonl` file under Pi's `templates/` directory (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`, symlinks resolved), on a Pi target, on the same machine.

## Saving a session as a template

`/template save <name>` captures the current session at its current point: its context without its system messages (entry ids kept), plus the same closing user message. It is stored as `~/.pi/agent/templates/<name>/captured/`. A captured template cannot be rebuilt. Its read calls are run again at capture time to record what they return, and when that changes later, using it warns and uses it as captured. A recipe of the same name takes precedence.

## Staleness

A built template is stale when its recipe changed (hash), a file it read returns something else (the read is run again and hashed), its globs match other files, or its model is gone. The next use rebuilds it, once: the check and the build hold a lock per template (Pi's `FileLocks`, as for fork bases), so parallel uses, also in other processes, wait and then share the rebuild.

## Cost and the prompt cache

The template's prefix is named in Pi's shared registry like any other: model, prompt hash, and the id chain of the template's entries (the leading prompt entry is named by the prompt hash, not by its id, since every fork records its own). A fork's own requests write cache entries only after its task, which no other fork shares, so Pi writes the template prefix's entry itself, before a fork's first request: one request with `max_tokens` 1 (a `cache_prime` usage entry), ending at the template's closing message, which the fork's request then reads through the lookback.

Whether that pays is decided with Pi's cache-warming economics: the prime costs a read of the prefix (the fork writes it anyway), and saves a write of the prefix for every further fork within the cache lifetime. The chance of a further fork is the rate of the template's forks over the last day, kept with its registry record (`reads`). So:

- the first fork of a template writes nothing extra;
- a second fork within the hour (one-hour cache) primes the prefix and reads it, and later forks read it while it lives;
- forks waiting for the prefix's lock at the same time make the prime certain: one fork writes, the others read;
- while forks keep coming, a fork that used the entry refreshes it shortly before it expires (one refresh for all: under the same lock, a recent touch postpones it); when the rate no longer pays for the refresh, it stops. A template nobody uses is never written or warmed.

A harness release changes the prompt, and with it the prompt hash: the first use after a release writes the new prefix, later uses read it. With `compaction.economic`, a fork of a cold template compacts through a fork base like any cold fork ([compaction.md](../vendor/pi/packages/coding-agent/docs/compaction.md#shared-prompt-cache-and-fork-bases)).

Keeping warm needs a running Pi process: the forks of a template refresh its entry while they live (a t3 child stays loaded while it runs or warms its own cache).
