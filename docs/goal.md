# Goal

[`extensions/goal`](../extensions/goal/index.ts) gives a session a goal: an objective it keeps working on until it is achieved, after the model of Codex CLI's `/goal`. Without a goal nothing changes, and a run ends when the agent ends its turn.

## Why

The user's most repeated complaint was an agent ending its turn "waiting" for a build or test, although independent work remained and the user had asked it to keep going. In the law-formalization coordinator's children (2026-11-13/14), about 30 pauses (318 minutes) ended only when a background job finished. A typical text before such a pause: "I wait for the reads lines and the two kernel tests; their end wakes me". The user intervened four times ("can't you work in parallel assuming they are green"). For a single task, ending the turn is right. So the run is held only when someone set a goal.

## Setting it

- **The user:** `/goal [--check <command>] [--budget <$5|200k>] <objective>`. This sets a new goal and starts a run on it (or steers the running one).
- **The agent:** the `goal` tool, action `set`, when its task says to keep going until something is done ("continue until all tests pass", or a delegated brief that says to finish X before reporting). A plain task needs no goal. The agent cannot replace or resume a goal the user set and that is still active or paused. Setting the same objective again updates the goal's check and budget and keeps its spend.

| Field | |
| --- | --- |
| objective | At most 4000 characters. |
| check | A shell command that must exit 0 for the goal to count as achieved. It runs in the session's directory, with a 10-minute timeout. |
| budget | USD (`$5`, `5usd`, `5`) or tokens (`200k`, `2m`, `150000 tokens`), or both. |

| Status | Holds the run | Changed by |
| --- | --- | --- |
| active | yes | set, `/goal resume`, a user message to a blocked goal |
| paused | no | `/goal pause` |
| achieved | no | the tool's `achieved`, only if the check exits 0; otherwise the check's output goes back to the agent |
| blocked | no | the tool's `blocked`, with a reason. The next user message makes it active again, since it was blocked on them. |
| budget-limited | no | the budget is reached |

Commands: `/goal` shows the goal and its spend. The others are `/goal pause`, `/goal resume`, `/goal clear`, and `/goal edit [--check <cmd>|--no-check] [--budget <b>|--no-budget] [objective]`. `/goal edit` without arguments opens the objective in an editor. `/goal -- <objective>` sets an objective that starts with a subcommand's name or `--`.

The tool's actions are `set`, `achieved`, `blocked` (with `reason`), `wait` (see below) and `show`.

## Storage

Each change appends a custom session entry `harness-goal` that holds the whole goal (or `null` once cleared). The current goal is the last such entry on the session branch. So it survives restarts, harness reloads and compaction, and navigating the session tree shows that branch's goal.

## What the model sees

- **The prompt section `goal`**, while the goal is active: the objective, the check, the budget, and how to finish. It holds no spend, so it stays the same from run to run. [`extensions/prompt`](../extensions/prompt/index.ts) moves sections other extensions set after its own, so the goal section is rendered last, and setting or finishing a goal leaves the prompt before it, and its cache, unchanged.
- **The status line** (`ctx.ui.setStatus("goal", …)`) shows the status, the objective, and the spend against the budget.

## End of a run

At Pi's `agent_before_settle`, while the goal is active and within budget, the run may not settle. It continues with a message that restates the goal and lists the choices:

- continue with the next step;
- audit the objective against evidence, then mark it achieved (its check must pass);
- mark it blocked with the reason.

**Strict mode**, when background work is pending: tool calls that moved to the background, and processes that bash commands left running (`globalThis.__harnessJobs`, the process-wide job state). The message lists the jobs and asks the agent to list the remaining steps that do not depend on them and do those now. Only a `goal` call with action `wait`, naming for each remaining step a running job (`call <id>`, `pid <n>`, or a part of its command that matches only that job), lets the turn end. An accepted wait ends the run itself (its result sets `terminate`), so the model is not called again only to write a closing line: before, 3,879 waits were followed by such a turn, 2.3% of Pi spend ([research 10 §5](research/context-engineering/10-turns-in-our-sessions.md)). A wait counts for the current run and only while every job it names still runs. When a job ends, its message wakes the session, and the goal holds that run again.

**Loop guard:** after 3 continues in a row without a tool call (other than `goal`), the run ends and the user is notified. The goal stays active. A tool call or a user message re-arms the guard.

## Budget

Spend counts the cost and the tokens of the session's assistant messages while the goal is active, from when it was set. A new objective starts again at zero. Tokens are input, output and cache writes. Cache reads are left out: they repeat the context on every request, so counting them would make a token budget measure context size rather than work.

After each turn the spend is compared with the budget. Once the budget is reached, the goal becomes budget-limited, a message asks for a summary (what is done, what remains, the next step), and the run then ends. Like Codex's, the budget is checked after each turn, so a turn can overshoot it. To go on, raise it with `/goal edit --budget …`, then `/goal resume`.
