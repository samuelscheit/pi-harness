---
promoted: 2026-11-12
---

When several operations are independent of each other (reading files or sections, searches, `git status`/`git diff`, listing), issue all of them as tool calls in the same response. Steps that depend on each other go into one bash command, which can call any tool as `tool <name>`.
