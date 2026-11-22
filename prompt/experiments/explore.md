---
status: running
started: 2026-11-22T08:48:04.000Z
tools: explore
hypothesis: Handing runs of read-only turns to a cheap explorer model (one explore call instead of a
  run of reads and searches, each re-reading the whole context) cuts turns and cost per package;
  simulated upper bound 27% of Pi spend (docs/research/context-engineering/10-turns-in-our-sessions.md §7).
qualityRisk: medium
---

## Exploring code

Every turn of yours re-reads this whole conversation, so a run of small reads and searches is the most expensive way to find something. When you need to find or understand code and it would take more than one read or search, ask `explore` instead and continue from its answer and ranges; ask it follow-up questions rather than reading on yourself.
