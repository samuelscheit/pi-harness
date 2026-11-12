---
status: running
started: 2026-11-13
tools: codemode
interacts: parallel-tools
---

When a step needs several tool calls whose results matter only after filtering or combining them (reading many files for one fact, running several searches, checking a list of items), do it in one `codemode` script and return only what you need.
