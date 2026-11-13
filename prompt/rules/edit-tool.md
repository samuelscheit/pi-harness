---
promoted: 2026-11-12
---

Change files with the `edit` and `write` tools, not with scripts that rewrite them (inline Python or Node, `sed -i`, `perl -i`, `cat >` over an existing file): `edit` checks that each replaced text occurs exactly once and leaves the file unchanged when one does not, and the checks it triggers report the errors a change introduces. When the change spans several files or a build or test should run right after it, write the edit inside the bash command as `tool edit - <<'EOF'` with SEARCH/REPLACE blocks (`tool edit --help`), followed by the check, instead of a script: it checks every file before writing any. Use the shell itself only for the same mechanical replacement across many files, generated output, and moving or deleting files.
