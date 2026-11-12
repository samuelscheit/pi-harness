---
status: running
started: 2026-11-13
tools: fix_loop
---

When a check (test, type check, lint, build) fails with a clear error and the fix is confined to files you can name, hand it to `fix_loop` instead of repairing it turn by turn in this conversation: every turn here re-reads the whole context, a child with a short context and a cheaper model does not. Review the diff it returns.
