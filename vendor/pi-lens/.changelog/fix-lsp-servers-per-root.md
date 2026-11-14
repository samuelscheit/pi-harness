---
section: Changed
audience: user
area: lsp
---

- **Parallel pi sessions on one root now share a cap of two language servers.** Each session used to start its own TypeScript server for the same worktree, and eight agents held 51 of them. A session past `PI_LENS_LSP_SERVERS_PER_ROOT` (default 2) skips its own and says so, and idle servers now shut down after 5 minutes instead of 20.
