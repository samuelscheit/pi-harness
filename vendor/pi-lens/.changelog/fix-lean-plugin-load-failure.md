---
section: Fixed
audience: user
area: lsp
---

- **A Lean plugin that fails to load no longer blocks every Lean file.** When `lake setup-file` stops at `error loading plugin, initializer not found`, the file is reported as not checked instead of as a code error, as a permission or missing-toolchain failure already was.
