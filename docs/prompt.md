# Prompt, rules and experiments

[`extensions/prompt`](../extensions/prompt/index.ts) assembles the system prompt on every run, from files in [`prompt/`](../prompt). It reads them every run, so an edit, a forced arm or a stopped experiment reaches running sessions as an update without a restart.

## Sections, in order

| Section | Source | Notes |
| --- | --- | --- |
| Base prompt | [`prompt/base.md`](../prompt/base.md) | Replaces Pi's default preamble: autonomy, `ask_user`, updates during a turn, the final answer, skills. Deliberately minimal. |
| Working rules | [`prompt/AGENTS.md`](../prompt/AGENTS.md) | The author's global rules, injected as the first context file. Replace them with your own. Dreaming matches corrections against this file but never edits it. |
| Rules | [`prompt/rules/<name>.md`](../prompt/rules) | One section per promoted rule, named after the file. |
| Experiments | `prompt/experiments/<name>.md` | The variant's text, only for sessions in arm B. |
| Tool guidelines | the active tools' `promptGuidelines` | Rendered as the section `tool-guidelines`. Pi only puts them into its default prompt, which the base replaces. |
| Project context, skills, working directory | Pi | Pi appends the project's AGENTS.md files, the skills list and `cwd` as their own sections. |

The base prompt started from Codex CLI's instructions and was cut down to what the evidence supports. It grows only when a gap shows up in sessions.

## Rules

A rule is a Markdown file with optional frontmatter:

```markdown
---
promoted: 2026-11-12
tools: [workflow]
---

When a task is a procedure you can write down, write it as a `workflow` script …
```

- The body becomes a prompt section named after the file. A name Pi already uses is refused and reported.
- Tools listed in `tools` are switched on for every session. All optional tools are registered inactive, so deleting a rule's file removes both its section and its tools.
- `source: dream` marks a rule that dreaming wrote (see [self-improvement.md](self-improvement.md)).

Current rules: `parallel-tools`, `single-edit`, `edit-tool`, `fix-loop` and `workflow` were promoted from experiments; `resume-subagents` was learned by dreaming.

## Experiments

An experiment tests a prompt section, tools, or both, on real sessions. Implementation: [`extensions/lib/experiments.ts`](../extensions/lib/experiments.ts) and [`extensions/metrics/experiment.ts`](../extensions/metrics/experiment.ts).

```markdown
---
status: running
started: 2026-11-12
tools: fix_loop
interacts: workflow
---

When a check fails with a clear error and the fix is confined to files you can name, …
```

- **Assignment.** Each session gets arm A or B per experiment, 50/50 from `sha256(experiment, session id)`. The arm stays stable when the session resumes and is independent across experiments. It is recorded in the session file as a `harness-experiment` entry, so the metrics index can compare the arms after the experiment file is gone.
- **Arm B** gets the body as the section `experiment-<name>`, and the listed tools. **Arm A** gets neither.
- **`interacts`** names experiments whose effect may depend on this one. The comparison then also reports the crossed cells (AA, AB, BA, BB).
- **Comparison** ([`queries/experiments.ts`](../extensions/metrics/queries/experiments.ts)). Sessions whose arm was forced by hand are left out, and so are projects without sessions in every arm, so each project's task mix weighs on both arms. A session counts only while it was in the experiment. Each metric is a ratio of sums: tool calls per turn, batched turns, cost per session and per turn, cache-read cost, turns per session, tool error rate, child-session cost, and for experiments that switch tools, each tool's usage, success rate and rereads. The effect B − A comes with a 95% bootstrap interval that resamples sessions within each arm. A tool's child sessions (for example `fix_loop`'s agent) count toward the parent's cost.

Commands:

```text
/harness experiment                    running experiments, this session's arms, interim results
/harness experiment <name> on|off      force this session into arm B or A (it leaves the random comparison)
/harness experiment <name> stop        mark it stopped and log the result in the changelog
/harness experiment <name> promote     turn it into a rule and log the result in the changelog
```

`stop` and `promote` commit the experiment and rule files, so the change is deployed to every session. The changelog is local state (see [self-improvement.md](self-improvement.md#changelog)).

## Prompt updates and the cache

Pi sends a changed prompt section as a system message appended to the conversation, so the cached prefix stays valid and an edit costs only the new section. This works only for models with `compat.supportsMidConvoSystemMessages`. Without it, Pi folds the update into the leading prompt and the whole conversation is written to the cache again.

[`test/prompt-cache.test.ts`](../test/prompt-cache.test.ts) builds the real request payloads for every model in the installed `models.json` and requires each request to stay a prefix of the one after an edit.

- Claude 5.x support it through Pi's catalog. Older Claude models do not, and are skipped.
- The gateway provider declares it. Measured: a GPT model read the same 7.4k cached tokens after an edit.

The path the model sees for `prompt/AGENTS.md` is the one in the repository, not in the release. A release path would change with every release and turn each deploy into a prompt update.
