# Self-improvement

The harness improves in three loops, from cheapest to most deliberate. None of them is a tool the agent calls to rewrite its own prompt mid-task.

| Loop | Trigger | Output |
| --- | --- | --- |
| Friction notes | the agent, during any task | a line in a backlog |
| Dreaming | nightly scheduled task | new or updated rules, spend experiments and their verdicts, one commit each |
| Experiments | a person or an agent, on demand | a promoted rule or a stopped experiment |

## Friction notes

`note_improvement` ([`extensions/improvements`](../extensions/improvements/index.ts)) appends an entry (time, session, working directory, observation, proposal) to a backlog:

- **scope `project`:** `<repo>/.agents/improvements.md`, for the project's AGENTS.md, skills and conventions;
- **scope `harness`:** this repository's `.agents/improvements.md`, for the base prompt, global rules, tools and models.

The tool's guidance tells the agent to use it when the user corrects it or repeats an instruction, when an instruction is missing, wrong or ambiguous, when a tool fails or misleads, or when time is lost on something a rule or a tool would have prevented.

## Dreaming

[`scripts/dream`](../scripts/dream/run.ts) runs nightly at 03:00 as a T3 Code scheduled task:

```sh
node scripts/dream/run.ts [--dry-run] [--since <ISO date>]
```

A dry run labels, curates, reviews, judges and asks the economist, but changes, commits and records nothing.

1. **Collect** ([`collect.ts`](../scripts/dream/collect.ts)) the messages the user typed in Pi sessions since the last run, each with the agent's message before it. Delegated and child sessions and machine-written text are excluded.
2. **Label** each message with Sonnet ([`scripts/lib/labels.ts`](../scripts/lib/labels.ts)): its kind (correction, process, quality, failure report, new task, …), the reusable rule it implies, and whether that rule is global or project-specific. Every label is kept in `.agents/dreams/labels.jsonl`, which the metrics index loads ([`extensions/metrics/labels.ts`](../extensions/metrics/labels.ts)) as the quality signal of the A/B comparison.
3. **Curate** ([`curate.ts`](../scripts/dream/curate.ts)) the corrections that imply a rule into small deltas against the known rules, with Opus, in the style of [ACE](https://arxiv.org/abs/2510.04618): `recur` (an existing rule was broken again), `add`, `update`, or `skip`. Only editable rules can be updated: the files in `prompt/rules/` and the lines under a project's `## Learned rules`. The output is validated: every correction is used once, and read-only rules are never edited.
4. **Apply** ([`apply.ts`](../scripts/dream/apply.ts)) each delta as its own commit, which deploys at once:
   - a global rule becomes `prompt/rules/<name>.md` with `source: dream`;
   - a project rule becomes a line under `## Learned rules` in the repository's AGENTS.md (or CLAUDE.md).

   Files with uncommitted edits are skipped, so dreaming never commits the user's work in progress. The author's `prompt/AGENTS.md` is matched against but never edited.
5. **Judge** the spend experiments dreaming started, and **economize**: see [Spend](#spend).
6. **Record** ([`ledger.ts`](../scripts/dream/ledger.ts)) in `.agents/dreams/`: the ledger (`ledger.jsonl`), the spend decisions (`economy.jsonl`), the session reviews (`reviews.jsonl`), the labels (`labels.jsonl`), the read position (`state.json`) and the run's report (`<date>.md`), which also takes over the open notes from every backlog. These are local files, not committed.

**Recurrence** is the quality metric: a correction that matches a rule already in place means the rule did not work as text. Rules that recur in two or more sessions are listed in the report as candidates for a mechanical guard instead of more wording. The [bash background-process guard](tools.md#background-process-guard) began that way.

### Spend

Dreaming also lowers what model usage costs, under one constraint: quality must not get worse. Every change it makes to spend is an A/B experiment first, and only the measured result decides.

1. **Facts** ([`spend.ts`](../scripts/dream/spend.ts)): from the metrics index, the window since the last run next to the 7 days before: cost per day, per package and per turn; cost by session kind, by model and thinking level, by context size and by prompt content; tools by what their results cost while carried; the costliest single results and sessions; cache rebuilds, pauses, compactions, subagent rediscovery; and the quality signals of the same windows.
2. **Judge** ([`judge.ts`](../scripts/dream/judge.ts)) each running experiment with `source: dream`, on its random sessions. It looks every night, so it decides on 99% intervals of B − A rather than 95%: repeated looks at 95% would promote by chance far more often than one time in twenty.
   - **promote** (to a rule, one commit) with at least 30 sessions and 30 reviews per arm, cost per package lower (whole interval below 0), and every quality guard non-inferior (the interval's worse end within the margin);
   - **stop** (one commit) once each arm has 10 sessions and a guard is worse (whole interval on the worse side) or cost per package is higher; when the experiment has a problem and no longer runs; or after 14 days without promotion;
   - **continue** otherwise, with what is missing in the report, and while an earlier decision waits on a dream branch that did not land.

   The guards, each with its margin and the least data each arm needs before it counts (fewer: neither held nor worse, so a guard resting on two messages never vouches for quality):

   | guard | margin | data per arm |
   |---|---|---|
   | user messages correcting or reporting failures (dream labels) | 0.02 | 30 labelled messages |
   | tool error rate | 0.01 | 200 tool results |
   | interrupted turns per package | 0.05 | 30 packages |
   | follow-up requests per session (delegated experiments: the parent had to ask again) | 0.1 | 10 sessions |
   | subagent tasks delegated again (the parent redid the work) | 0.05 | 10 delegated sessions |
   | blind review score, 1 to 10 | 0.75 | 10 reviews to stop, 30 to promote |

   The review always has to hold for a promotion. Endings are logged in the changelog, as `/harness experiment … promote|stop` does, once their commit landed.
3. **Review** ([`review.ts`](../scripts/dream/review.ts)): Opus grades settled sessions of both arms from 1 to 10, blind to the arm: it sees what the user wrote, what the agent said, its tool calls and their failures while the session was in the experiment, never the prompt, model or settings. Sampling starts only once each arm has 30 settled sessions, so the sample is drawn from both arms over the same time, not from whichever sessions ended first; it takes up to 60 per arm, in a stable random order per experiment, and grades each session once. The score's interval is a Welch t-interval whose spread is at least 1 point, so a grader giving every session the same score does not make the difference look certain.
4. **Economize** ([`economize.ts`](../scripts/dream/economize.ts)): Opus, as economist, gets the facts, the rules and settings in force, every experiment with how dreaming ended its own, and the models' prices. It proposes at most two new experiments (at most three dream experiments run at once), each a prompt section and/or [session settings](prompt.md#session-settings) for some kind of session, with its evidence and expected saving; high-risk ideas are refused. When to compact is not the economist's: a fixed context limit forces compactions on tasks that need their context, so sessions decide it themselves ([the compaction decider](tools.md#the-compaction-decider)), whose decisions by framing are in the facts. Each valid proposal becomes `prompt/experiments/<name>.md` in its own commit. Improvements that need code go into the report.

The report's "Spend" section holds the facts, the verdicts, the experiments started and the improvements that need code.

The design and its evidence are in [research report 05](research/context-engineering/05-memory-and-self-improvement.md) and [report 07](research/context-engineering/07-evidence-from-our-sessions.md).

## Experiments

Larger changes, such as a new tool or a rule whose cost is unclear, run as randomized experiments and are promoted or stopped from the comparison. See [prompt.md](prompt.md#experiments).

## Changelog

When an experiment is stopped or promoted, its results are written to `.agents/changelog.md`. The changelog, the backlogs and the dream records are personal runtime data and git-ignored in the public repository. The git history of `prompt/` and `extensions/` is the public record of every change, and each dreamed rule's commit message carries its evidence and how to revert it.
