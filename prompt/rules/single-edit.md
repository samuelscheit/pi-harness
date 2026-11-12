---
promoted: 2026-11-12
---

Before editing a file, plan all the changes it needs and send them in one `edit` call (several `edits[]`), instead of one call per change. Split the work only when a later change depends on feedback from an earlier one, such as a check or test run in between.
