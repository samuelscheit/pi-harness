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
| Other extensions' sections | e.g. [`goal`](goal.md) while a goal is active | Moved after the harness's own sections: they change during a session, so a change leaves the prompt before them intact. |
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
- `settings` and `sessions` fix session settings for every new session of that kind (see [Session settings](#session-settings)); a promoted settings experiment becomes such a rule.
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
- **`settings`** and **`sessions`**: session settings arm B runs with, and the sessions the experiment enrolls (see [Session settings](#session-settings)).
- **`source: dream`** marks an experiment dreaming started; dreaming also judges it (see [self-improvement.md](self-improvement.md#spend)).
- **Comparison** ([`queries/experiments.ts`](../extensions/metrics/queries/experiments.ts)). Sessions whose arm was forced by hand are left out, and so are projects without sessions in every arm, so each project's task mix weighs on both arms. A session counts only while it was in the experiment. Each metric is a ratio of sums: tool calls per turn, batched turns, cost per session, per package (one user request) and per turn, cache-read cost, turns per session, tool error rate, child-session cost, the quality metrics (the share of the user's messages that correct the agent or report a failure, from dreaming's labels, and interrupted turns per package), and for experiments that switch tools, each tool's usage, success rate and rereads. The effect B − A comes with a 95% bootstrap interval that resamples sessions within each arm. A tool's child sessions (for example `fix_loop`'s agent) count toward the parent's cost.

Commands:

```text
/harness experiment                    running experiments, this session's arms, interim results
/harness experiment <name> on|off      force this session into arm B or A (it leaves the random comparison)
/harness experiment <name> stop        mark it stopped and log the result in the changelog
/harness experiment <name> promote     turn it into a rule and log the result in the changelog
```

`stop` and `promote` commit the experiment and rule files, so the change is deployed to every session. The changelog is local state (see [self-improvement.md](self-improvement.md#changelog)).

## Session settings

Experiments and rules can set a session's model, thinking level and context limit ([`extensions/lib/variants.ts`](../extensions/lib/variants.ts)):

```markdown
---
settings:
  model: anthropic/claude-sonnet-5-5   # provider/id
  thinking: low                        # off | minimal | low | medium | high | xhigh | max
  maxContextTokens: 400000             # compact automatically above this, at least 50000
  decideCompactionAbove: 300000        # above this, the session decides whether to compact (tools.md#the-compaction-decider)
sessions: delegated                    # all (default) | delegated | top-level
---
```

- **Kinds.** A delegated session is one a parent started with `delegate_task`; its first message is t3's preamble "Act as the … sub-agent for this task."
- **Model and thinking level** are set once, on the session's first run, and only where the session still runs Pi's default (`defaultModel`, `defaultThinkingLevel` in the agent's `settings.json`, the project's `.pi/settings.json` over it): a subagent its parent gave a `target.model` or an effort keeps it, and is not enrolled in an experiment that would set it. A choice equal to the default cannot be told from none. Pi records the model and level in the session, so a resume keeps them and a later change by hand stays; for the same reason, stopping an experiment does not switch back sessions that already started in arm B.
- **Context limit** and the **compaction decider** apply on every run ([`extensions/context-limit`](../extensions/context-limit/index.ts)); the session's own `/context-limit` wins over both, a fixed `maxContextTokens` over the decider.
- **Enrollment.** An experiment with settings enrolls only sessions that made no request yet, so no session switches model or cache mid-way and no measured session mixes two settings. An experiment with `sessions` enrolls only that kind.
- **Precedence.** Rules first, then the arms B the session is in. Two running experiments may not set the same setting for sessions that can overlap: the one started later (`started`, then the name) gets a problem and does not run.

## Prompt updates and the cache

Pi sends a changed prompt section as a system message appended to the conversation, so the cached prefix stays valid and an edit costs only the new section. This works only for models with `compat.supportsMidConvoSystemMessages`. Without it, Pi folds the update into the leading prompt and the whole conversation is written to the cache again.

[`test/prompt-cache.test.ts`](../test/prompt-cache.test.ts) builds the real request payloads for every model in the installed `models.json` and requires each request to stay a prefix of the one after an edit.

- Claude 5.x support it through Pi's catalog. Older Claude models do not, and are skipped.
- The gateway provider declares it. Measured: a GPT model read the same 7.4k cached tokens after an edit.

The path the model sees for `prompt/AGENTS.md` is the one in the repository, not in the release. A release path would change with every release and turn each deploy into a prompt update.
