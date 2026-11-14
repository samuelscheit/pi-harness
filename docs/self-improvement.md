# Self-improvement

The harness improves in three loops, from cheapest to most deliberate. None of them is a tool the agent calls to rewrite its own prompt mid-task.

| Loop | Trigger | Output |
| --- | --- | --- |
| Friction notes | the agent, during any task | a line in a backlog |
| Dreaming | nightly scheduled task | new or updated rules, one commit each |
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

1. **Collect** ([`collect.ts`](../scripts/dream/collect.ts)) the messages the user typed in Pi sessions since the last run, each with the agent's message before it. Delegated and child sessions and machine-written text are excluded.
2. **Label** each message with Sonnet ([`scripts/lib/labels.ts`](../scripts/lib/labels.ts)): its kind (correction, process, quality, failure report, new task, …), the reusable rule it implies, and whether that rule is global or project-specific.
3. **Curate** ([`curate.ts`](../scripts/dream/curate.ts)) the corrections that imply a rule into small deltas against the known rules, with Opus, in the style of [ACE](https://arxiv.org/abs/2510.04618): `recur` (an existing rule was broken again), `add`, `update`, or `skip`. Only editable rules can be updated: the files in `prompt/rules/` and the lines under a project's `## Learned rules`. The output is validated: every correction is used once, and read-only rules are never edited.
4. **Apply** ([`apply.ts`](../scripts/dream/apply.ts)) each delta as its own commit, which deploys at once:
   - a global rule becomes `prompt/rules/<name>.md` with `source: dream`;
   - a project rule becomes a line under `## Learned rules` in the repository's AGENTS.md (or CLAUDE.md).

   Files with uncommitted edits are skipped, so dreaming never commits the user's work in progress. The author's `prompt/AGENTS.md` is matched against but never edited.
5. **Record** ([`ledger.ts`](../scripts/dream/ledger.ts)) in `.agents/dreams/`: the ledger (`ledger.jsonl`), the read position (`state.json`) and the run's report (`<date>.md`), which also takes over the open notes from every backlog. These are local files, not committed.

**Recurrence** is the quality metric: a correction that matches a rule already in place means the rule did not work as text. Rules that recur in two or more sessions are listed in the report as candidates for a mechanical guard instead of more wording. The [bash background-process guard](tools.md#background-process-guard) began that way.

The design and its evidence are in [research report 05](research/context-engineering/05-memory-and-self-improvement.md) and [report 07](research/context-engineering/07-evidence-from-our-sessions.md).

## Experiments

Larger changes, such as a new tool or a rule whose cost is unclear, run as randomized experiments and are promoted or stopped from the comparison. See [prompt.md](prompt.md#experiments).

## Changelog

When an experiment is stopped or promoted, its results are written to `.agents/changelog.md`. The changelog, the backlogs and the dream records are personal runtime data and git-ignored in the public repository. The git history of `prompt/` and `extensions/` is the public record of every change, and each dreamed rule's commit message carries its evidence and how to revert it.
