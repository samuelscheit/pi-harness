---
status: stopped
started: 2026-11-21T07:36:22.260Z
source: dream
hypothesis: Filtering and capping bash output before it enters context shrinks
  the largest cost item, because each bash result is re-read in about 152 later
  requests, and no information is lost since full logs stay in a file to grep.
expectedWeeklySaving: 1100
qualityRisk: low
stopped: 2026-11-22T09:08:12.109Z
---

## Bash output budget
Every line a command prints is re-read in every later request of this session. Keep bash results small:
- Builds, tests, CI and installs: write the full output to a log (`cmd > /tmp/<name>.log 2>&1; echo exit=$?`). Then show only what matters: `tail -n 60` of the log and `grep -nE 'error|fail|FAIL|panic' /tmp/<name>.log | head -50`. Read every failure, but read it by grepping the log, not by rerunning the command or dumping the whole log.
- Never dump whole files, JSON or thread contents through bash (`cat`, `jq .`, `t3_thread_read` output). Use `read` with offset/limit, or `jq`/`grep` for just the fields you need.
- Listings, process checks (`ps`, `pgrep`, `find`, `ls -R`, `git log`): add `| head -40` or a narrower filter. Use `cut -c1-200` on wide lines.
- If a result would plausibly exceed about 150 lines, filter it first.
- Do not run the same command again just to see a different part of its output. Grep the saved log instead.
Verification is unchanged: run the same checks and look at every failure. Only the way you view their output changes.
