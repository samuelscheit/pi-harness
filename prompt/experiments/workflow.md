---
status: running
started: 2026-11-13
tools: workflow
interacts: codemode
---

When a task is a procedure you can write down (the same step over many items, a loop until a command passes, several independent subtasks), write it as a `workflow` script instead of doing every step yourself: code does the mechanical part, `llm()` with a cheap model makes the small judgments, `agent()` takes the subtasks, and only the result comes back into this conversation.
