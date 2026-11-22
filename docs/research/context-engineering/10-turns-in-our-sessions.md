# 10: Turns in our sessions, and which ones we could cut

Analysed 2026-11-21. [09](09-turn-reduction-techniques.md) lists what the field does to reduce turns. This report measures turns in our own Pi sessions: what one turn costs, what the turns do, and which of them a harness change could have removed. It ends with ranked recommendations.

A **turn** is one model request in the tool loop, not one user prompt. A **package** is everything from one user prompt to the next. Every turn re-reads the whole context from cache, so cost per task is roughly turns × context.

## TL;DR

- **One turn costs $0.103 on average, and 85% of that is re-reading and writing the context.** Removing a turn saves that 85%. Merging two turns keeps the output, so only the re-read goes. Pi spent 408 hours waiting on the model across 176k turns: median 5.7 s, mean 9.1 s per turn.
- **95.4% of turns that call a tool call exactly one.** The parallel-tools rule has not changed this. Batched turns fell from 8.4% on 12 Nov to 3–5% since, which is below the Claude Code baseline of 5.8%. The prompt asks for batching, and the model does not do it.
- **Delegated Opus children are where the turns are.** They make 147k of the 176k turns and $15.9k of the $18.2k, at a mean context of 371k tokens, and they batch least (4.2%). A child package takes a median of 7 turns, and the slowest tenth take 89 or more. A main-session package takes a median of 1.
- **54% of turns only explore**: read, grep, list or query. 36% of all turns are an explore turn directly after another explore turn.
- **A judge read 300 random serial-explore pairs.** 34% of second turns did not need the first turn's result, 23% would have been covered by one wider first call, and 43% truly depended on it. That makes **57% (95% CI 52–63%) avoidable, about 36.7k turns or 21% of all turns**. Removing them would save up to about $2.8k, 15% of spend. Wider reads add some of that back as context.
- **The "next slice of the same file" pattern is 15% of serial-explore pairs.** The agent reads a file through `sed -n` in small ranges, one turn per slice. 87% of these were judged "wider": one larger read would have done.
- **Goal `wait` costs a model turn just to stop.** After 3,879 `wait` calls the model wrote only a closing line, a ~410-token text-only turn ($414, 2.3% of spend). The tool could end the run itself.
- **The redundancy the literature reports is small here.** Identical read-only calls with nothing changed since are 1.1% of turns. Rereads of unchanged files are 0.5%. Check runs repeated with no change are 156 of 4,814. Edits fail 1.8% of the time with `edit` and 2.7% with `tool edit -`. The Purdue study's prompt rules and a "test unchanged" detector would buy little here.
- **The batching tools are rarely used.** 8.9% of bash calls use `tool <name>`, `workflow` appears in 0.2% of turns, and `fix_loop` and `codemode` in under 0.1%.

## Data and method

- **Source:** `~/.pi/agent/metrics.db`, Pi sessions only (`sessions.source = 'pi'`): 1,778 sessions, 1,275 of them delegated children, 176,524 turns, $18,224 at list prices, 12–21 Nov 2026. The Claude Code baseline is the 218k imported turns from [07](07-evidence-from-our-sessions.md).
- **Assigning calls to turns:** the index stamps a request when its response ends, so each tool result belongs to the latest turn at or before it. This matched `requests.tool_calls` on 99.9% of turns.
- **Call kinds**, from the tool name and, for bash, the command text:
  - explore: read-only
  - edit: changes files
  - check: tests, builds, linters, type checks
  - edit+check: both in one bash call
  - wait: sleep, polling, `goal`, task status
  - vcs: git writes
  - delegate: subagents, `workflow`, `fix_loop`, `codemode`
  - interact: `ask_user`, `submit_result`

  A hand check of 25 random read-only bash calls found them all reading code or data: `sed -n`, `grep`, `cat`, `ls`, `git grep`, short Python queries.
- **Saving of an avoided turn:** what that turn paid for cache reads, cache writes and uncached input. Its output would still be written in the merged turn.
- **Judge:** 300 random serial-explore pairs (fixed seed). Claude Sonnet 5.5 saw the first turn's calls with their results (truncated to 2,500 characters), then the second turn's reasoning and calls. It answered independent, wider or dependent, plus what the second turn was doing.
- **Scripts:**

```sh
node scripts/evidence/turns.ts --samples /tmp/x/pairs.json 300   # every table in §1–5; writes the judge sample
node scripts/evidence/turns-judge.ts /tmp/x/pairs.json            # §6; verdicts cached next to the sample
```

## 1. Turns per package and what they cost

| sessions | packages | median turns | p90 turns | mean turns | median cost | mean cost | total |
|---|---:|---:|---:|---:|---:|---:|---:|
| main | 3,918 | 1 | 7 | 4.9 | $0.112 | $0.443 | $1,736 |
| child (delegated) | 4,662 | 7 | 89 | 33.7 | $0.558 | $3.54 | $16,488 |
| all | 8,580 | 2 | 55 | 20.6 | $0.222 | $2.12 | $18,224 |

| turns in package | packages | share of turns | share of cost | mean context | cost per turn |
|---|---:|---:|---:|---:|---:|
| 1–5 | 5,586 | 5.8% | 5.2% | 331k | $0.093 |
| 6–20 | 1,347 | 8.4% | 7.4% | 285k | $0.091 |
| 21–50 | 718 | 13.4% | 12.3% | 299k | $0.095 |
| 51–100 | 503 | 20.4% | 19.0% | 303k | $0.096 |
| 101–200 | 288 | 22.6% | 21.1% | 315k | $0.096 |
| >200 | 138 | 29.5% | 35.0% | 465k | $0.123 |

Packages of more than 50 turns are 11% of packages but 73% of turns and 75% of cost. In the longest packages each turn costs a third more, because the context has grown. A turn removed early also makes every later turn of the package a little cheaper, so the savings below are lower bounds in that respect.

By model and session type (turns over 1,000):

| model | session | turns | turns with 2+ calls | calls per tool turn | cost | mean context |
|---|---|---:|---:|---:|---:|---:|
| Opus 5.5 | child | 147,318 | 4.2% | 1.05 | $15,919 | 371k |
| Opus 5.5 | main | 18,039 | 7.8% | 1.09 | $1,723 | 328k |
| Sonnet 5.5 | child | 7,900 | 6.8% | 1.12 | $284 | 124k |
| Fable 5.2 | child | 1,551 | 3.9% | 1.04 | $285 | 377k |

## 2. Tool calls per turn

| slice | turns | no tool call | 1 call (of tool turns) | 2+ calls | calls per tool turn |
|---|---:|---:|---:|---:|---:|
| main sessions | 19,302 | 23.7% | 92.3% | 7.7% | 1.09 |
| child sessions | 157,222 | 6.7% | 95.7% | 4.3% | 1.06 |
| 2026-11-12 | 5,139 | 5.6% | 91.6% | 8.4% | 1.12 |
| 2026-11-13 | 7,301 | 7.8% | 93.8% | 6.2% | 1.09 |
| 2026-11-14 | 22,999 | 9.7% | 94.6% | 5.4% | 1.07 |
| 2026-11-15 | 21,402 | 8.1% | 93.7% | 6.3% | 1.08 |
| 2026-11-16 | 18,523 | 11.0% | 96.0% | 4.0% | 1.05 |
| 2026-11-17 | 29,810 | 3.4% | 96.8% | 3.2% | 1.04 |
| 2026-11-18 | 3,280 | 10.8% | 96.9% | 3.1% | 1.04 |
| 2026-11-19 | 28,824 | 7.1% | 96.0% | 4.0% | 1.06 |
| 2026-11-20 | 27,011 | 11.5% | 95.6% | 4.4% | 1.05 |
| 2026-11-21 | 12,235 | 14.3% | 95.3% | 4.7% | 1.05 |
| all | 176,524 | 8.6% | 95.4% | 4.6% | 1.06 |

Claude Code, same user and models, has 94.2% single-call tool turns and 5.8% batched. The randomized `parallel-tools` experiment (changelog, 12 Nov) measured +5.8 points of batched turns with a CI of −8 to +20 on 19 sessions, and was promoted on that. Every Pi session has had the rule since, yet the batched share went down, not up. As worded, the rule does not move the model. Anthropic's own nudge is stronger ("Err on the side of maximizing parallel tool calls", [09](09-turn-reduction-techniques.md) §1) and has not been tried here.

## 3. What turns do

| turn kind | turns | share | cost | share of cost | 1-call share | median cost without output |
|---|---:|---:|---:|---:|---:|---:|
| explore | 95,109 | 53.9% | $9,093 | 49.9% | 95.1% | $0.070 |
| edit | 43,965 | 24.9% | $5,418 | 29.7% | 96.1% | $0.085 |
| text (no tool call) | 15,239 | 8.6% | $1,301 | 7.1% | – | $0.065 |
| wait | 7,166 | 4.1% | $778 | 4.3% | 95.4% | $0.092 |
| vcs | 4,975 | 2.8% | $593 | 3.3% | 97.4% | $0.086 |
| check | 4,590 | 2.6% | $427 | 2.3% | 98.9% | $0.079 |
| edit+check | 2,641 | 1.5% | $291 | 1.6% | 88.9% | $0.082 |
| interact | 1,455 | 0.8% | $161 | 0.9% | 95.8% | $0.064 |
| delegate | 1,291 | 0.7% | $157 | 0.9% | 83.3% | $0.078 |

What started the turn: a tool result in 91.7% of turns, a user prompt in 4.9%. Harness wake-ups started the rest: a background job ending (3,827 turns, $398), a goal nudge (1,941, $174) and an `ask_user` answer (164).

Explore runs (consecutive explore turns inside one package) get long:

| explore run length | runs | turns in them |
|---|---:|---:|
| 1 | 14,276 | 14,276 |
| 2–3 | 9,726 | 22,733 |
| 4–7 | 4,768 | 23,729 |
| 8–15 | 1,703 | 17,739 |
| 16+ | 642 | 16,632 |

## 4. Patterns that waste turns (upper bounds)

| pattern | turns | share of turns | saving if removed | share of spend | note |
|---|---:|---:|---:|---:|---|
| serial explore (explore turn after explore turn) | 63,994 | 36.3% | $4,975 | 27.3% | judged in §6: 57% avoidable |
| wait / poll / harness wake-up | 12,882 | 7.3% | $1,250 | 6.9% | goal, task status, sleep loops, wake-ups |
| turn after a failed call | 5,062 | 2.9% | $383 | 2.1% | mostly unavoidable: the error is information |
| edit → separate check turn | 1,833 | 1.0% | $166 | 0.9% | `tool edit - … && check` makes it one |
| identical read-only call, nothing changed since | 1,857 | 1.1% | $155 | 0.9% | 2,365 calls; 156 of 4,814 check runs |
| reread-only turn (file unchanged since last read) | 880 | 0.5% | $75 | 0.4% | 1,199 of 8,753 `read` file reads |

Failed edits are rare: 1.8% of 2,261 `edit` calls and 2.7% of 10,242 `tool edit -` calls without a chained check. SWE-agent's failed-edit spiral (51.7% of runs, [09](09-turn-reduction-techniques.md) §4) does not happen here.

The failed calls followed by another turn are mostly read-only bash (1,886 turns, e.g. a grep with no match exits 1), file-changing bash (1,249), git writes (492) and `goal` (418).

## 5. Goal `wait` spends a turn to stop

| goal call (by argument keys) | next turn has no tool call | turns | cost |
|---|---|---:|---:|
| `action, steps` (wait) | yes | 2,962 | $312 |
| `action, steps, reason` (wait) | yes | 917 | $102 |
| `action` (achieved/show) | yes | 182 | $21 |
| `action, objective` (set) | no | 182 | $16 |

`wait` means every remaining step depends on a background job, so the run is over until that job wakes it. Even so, the model is called once more and writes a closing line of about 410 output tokens. Pi's agent loop already ends a run without a further model call when every tool result in a batch has `terminate: true` (`vendor/pi/packages/agent/src/agent-loop.ts`, `shouldTerminateToolBatch`). If `goal wait` returned that flag, it would save 3,879 turns and $414, 2.3% of spend, with no change in behaviour. The wake-up turn stays, since it does the work.

Separately, 2,456 bash calls in 373 sessions contain `sleep`, which the prompt forbids for waiting over 10 seconds. These are the "wait" turns that are left.

## 6. Judged sample: how many serial-explore turns were needed

| verdict | pairs | share | 95% CI |
|---|---:|---:|---:|
| independent: the second turn did not need the first turn's result | 102 | 34% | 29–40% |
| wider: one wider first call would have covered both | 70 | 23% | 19–28% |
| dependent: the second turn needed the first turn's result | 128 | 43% | 37–48% |

| what the second turn did | pairs | independent | wider | dependent |
|---|---:|---:|---:|---:|
| inspect another file or area | 129 | 71 | 14 | 44 |
| follow a reference | 53 | 1 | 3 | 49 |
| next slice of same file | 46 | 0 | 40 | 6 |
| run or query something | 40 | 20 | 0 | 20 |
| broaden or refine a search | 29 | 8 | 13 | 8 |
| web research | 2 | 2 | 0 | 0 |

Typical cases:

- **independent:** grepping `lib/api-tokens/types.ts` for rate constants after reading an unrelated slice of the notifications service. These two calls belonged in one response.
- **wider:** reading `Validity.lean` lines 140–286 right after lines 1–140. Another: reading lines 100–200 of a document after a grep that had already located hits at 114–191.
- **dependent:** grepping for "E25a" because the previous output mentioned it.

Scaled to the 63,994 serial-explore turns, 57% (52–63%) is about 36,700 turns, 21% of all turns. Their re-read cost is about $2,840, 15.6% of spend, and about 92 hours of model time at 9.1 s per turn. This is an upper bound on the saving. Batched calls return their results together, so the merged turn's context grows by the same amount. Wider reads add lines the agent would not have read, and those lines are re-read by every later turn. The judge also sees only truncated results, and it cannot tell whether the agent's plan really existed before the first result came back.

## 7. What this means: ranked recommendations

| # | change | turns saved | spend saved | certainty | effort |
|---|---|---:|---:|---|---|
| 1 | `goal` `wait` (and `blocked`) return `terminate: true`, so the run ends without a closing model turn | 3.9k (2.2%) | ~$414 (2.3%) | measured, deterministic | small |
| 2 | Wider default reads: tell the agent to read a whole file (or at least ~300 lines) when it will read on, instead of small `sed -n` slices; consider a hint in bash results when one turn reads the slice right after the previous turn's | ≤ 9.8k (≤ 5.6%) | ≤ $760 | judged; some cost returns as context | small (prompt) / medium (hint) |
| 3 | Rewrite the batching rule the way Anthropic words its nudge ("err on the side of maximizing parallel calls", with read-only examples), and A/B test it, judged by calls per tool turn and the §6 independent share | ≤ 21.8k (≤ 12%) | ≤ $1.7k | the current wording measurably failed; the new wording is untested | small + experiment |
| 4 | Make scripted exploration the default path for multi-step reading (Factory Script mode: 10 → 5 model calls on a coding task, [09](09-turn-reduction-techniques.md) §2): the prompt should name concrete exploration scripts (`for f in …; do sed -n …; done`, `tool read` chains) rather than only edit+check | overlaps 2–3 | – | vendor evidence only | small |
| 5 | Child sessions: give delegated tasks the context they need (paths, entry points) in the brief, so a child does not spend its first explore run rediscovering what the parent knew; measure child turns per package before and after | unknown | most spend is here | untested | small |
| 6 | Do not build: a "test unchanged" detector, prompt rules against rereads, edit-error recovery, or turn caps. Each targets ≤ 1% of turns here, or has no evidence ([09](09-turn-reduction-techniques.md) §6–7) | – | – | measured small | – |

Do 1 now: it is certain and needs no experiment. Run 2 and 3 as one experiment, since both act on explore turns and will interact. Judge it by turns per package and cost per package, with the children's turns included, and use the judge script on arm B's serial-explore pairs to see whether the independent share falls. Re-run `turns.ts` a week after any change to see whether the 95% single-call share moves at all.

## Threats to validity

- **Observational data.** The only randomized evidence is the promoted experiments' 5–11 sessions per arm, so no causal claim about the rules is made here. The fall in batched turns over time may come from a changed task mix (more long child runs in law-formalization), not from the rule.
- **Call kinds come from regexes over the first 200 characters of each command** (`tool_results.summary`). Commands that change files without a detectable write count as explore. Checks hidden in scripts count as explore or edit.
- **The judge is one model on 300 pairs**, seeing truncated results, and was not checked by hand beyond the examples above. "Wider" assumes that reading more lines costs less than the turn it saves, which holds only when the extra lines are few compared with the 300k+ context.
- **Savings are re-read costs at each turn's own context size.** Merged turns also change cache writes and later context sizes in ways this report does not simulate.
- **One user, one week, mostly two projects.** Opus 5.5 children dominate, so the numbers say little about other models.
