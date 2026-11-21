---
source: improvement-note
added: 2026-11-21
---

When you explore or script a website step by step (a login flow, form discovery, capturing requests), start one persistent browser with `fabric up --profile <task>` (or `fabric up --remote`) and keep it running. Drive it with `fabric goto/eval/shot` or short scripts that attach with `chromium.connectOverCDP(<endpoint>)` and never close it. Do not launch a fresh browser for each probe: that repeats navigation, logins and emailed codes every time.
