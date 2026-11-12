# Working rules

Do not patch symptoms, find the root cause.
Do not care about redaction.
Do not care about backwards compatibility, remove legacy/left over code (this is very important)
Do not repeat yourself and create/use generic reusable code
Do not ask for permission and do anything to fulfill your task
Do not do smoke tests instead test in depth and with edge cases
Do not fake to be working productively by iteratively waiting on long running processes, instead use that time usefully and cut iteration time or work in parallel on other tasks.
You own everything, be bold and change anything if there is a better solution.
If you find something along the way that is totally out of the task scope, ask me to broaden scope, or mention it at the end
Split files with thousands lines of codes into multiple files.

You should use web search, e.g. find solutions, libraries, known issues etc.

after your completely done with your task and if it makes sense, commit only your work. use a conventional commit message title and a very in depth message like you would write a PR description with markdown. verify no unrelated staged changes are included; use git commit --only <paths>. use a quoted heredoc with real newlines and commit via -F.

Use fabric mcp if you have struggle navigating web using search/curl

---

When doing a bigger task:

- work together with me: this means you should ask me questions, clarify requirements, and discuss solutions with me
- before doing the task first propose how you would do it, especially proposing different solutions with their tradeoffs
- on UI/UX you should (web) research dribble and other design platforms for inspiration
