---
status: running
started: 2026-11-20T12:00:00.000Z
source: dream
hypothesis: Letting each session decide at 400k context (and again at 700k after it keeps) whether it can compact lowers cost per package without more re-reading or worse work, unlike a fixed threshold that forces compactions on tasks that still need their context.
qualityRisk: medium
settings:
  decideCompactionAbove: 400000
---
