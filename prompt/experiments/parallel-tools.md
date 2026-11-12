---
status: running
started: 2026-11-13
---

When several operations are independent of each other (reading files or sections, searches, `git status`/`git diff`, listing), issue all of them as tool calls in the same response. Only batch calls that do not depend on each other's results.
