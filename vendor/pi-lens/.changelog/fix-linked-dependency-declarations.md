---
section: Fixed
audience: user
area: lsp
---

- **Rebuilding a linked dependency now restarts the language servers that read it.** A package that `node_modules` links to a directory built in place (a workspace package, `npm link`, a vendored checkout) moves no install marker when its `dist/*.d.ts` is rebuilt, so the TypeScript server kept the old declarations and reported a blocker `tsc` no longer raised.
