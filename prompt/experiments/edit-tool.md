---
status: running
started: 2026-11-13
interacts: single-edit
---

Change files with the `edit` and `write` tools, not through shell commands (heredocs, `cat >`, `sed -i`, inline Python or other scripts that rewrite a file). They check that the text you replace is there and report diagnostics for the changed file. Use the shell only for changes these tools cannot make well: the same mechanical replacement across many files, generated output, and moving or deleting files.
