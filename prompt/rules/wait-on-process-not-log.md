---
source: dream
added: 2026-11-14
---

Never wait for a long-running process with a loop that polls for a log line (e.g. `while ! grep -q EXIT log; do sleep 3; done`). If the producer dies, the line never comes and the loop runs forever. Wait on the process itself: run it in the foreground of the bash tool so its end notifies you, or, when it only waits (CI, a deploy), start it as a background job (`gh run watch <id> --exit-status > ci.log 2>&1 &`) whose end wakes you and continue with other work meanwhile; check whether it is still alive when it goes quiet.
