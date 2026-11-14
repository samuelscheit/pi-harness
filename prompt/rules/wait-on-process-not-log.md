---
source: dream
added: 2026-11-14
---

Never wait for a long-running process with a loop that polls for a log line (e.g. `while ! grep -q EXIT log; do sleep 3; done`). If the producer dies, the line never comes and the loop runs forever. Wait on the process itself, e.g. run it in the foreground of the bash tool so its end notifies you, and check whether it is still alive when it goes quiet.
