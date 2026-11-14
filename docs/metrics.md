# Metrics and dashboard

All metrics come from Pi's own session files. Nothing is captured live, and no proxy is involved. `~/.pi/agent/metrics.db` (SQLite) is an index over the files that can be rebuilt at any time. Implementation: [`extensions/metrics`](../extensions/metrics).

## What Pi records

A Pi session file already contains everything needed:

- the leading system message (prompt sections and tool definitions), and later prompt and tool updates;
- all messages, with usage and cost per assistant message;
- each tool call's `durationMs`;
- compactions, branches, context edits, and cache-warming requests.

## Indexing

| Module | Role |
| --- | --- |
| [`indexer.ts`](../extensions/metrics/indexer.ts) | Rebuilds each request's context with Pi's `buildSessionContext`, so compactions, branches and context edits are respected. A changed file is re-indexed whole, and deleted files are pruned. |
| [`blocks.ts`](../extensions/metrics/blocks.ts) | Splits each request's context into blocks in provider order: prompt sections, tool definitions, messages, tool results. |
| [`attribution.ts`](../extensions/metrics/attribution.ts) | Walks the cache prefix with the rates Pi recorded and explains each rebuild (2k or more previously cached tokens not read): model switch, prompt change, compaction, expired cache, or a change outside the session file. |
| [`payload.ts`](../extensions/metrics/payload.ts) | Replays Pi's Anthropic request layout, to map thinking blocks that Anthropic dropped back to session blocks; those cost nothing. |
| [`work.ts`](../extensions/metrics/work.ts), [`efficiency.ts`](../extensions/metrics/efficiency.ts) | Files touched per tool call, subagent economics, unused context, best possible compaction. |
| [`claude.ts`](../extensions/metrics/claude.ts) | Optional import of Claude Code transcripts as a second source, for comparison. |
| [`store.ts`](../extensions/metrics/store.ts) | The schema. Bumping `SCHEMA_VERSION` drops the index and rebuilds it. |

**Harness version** is a hash of the prompt sections in effect plus the session's initial tools. Versions are per project, because the project context and skills are sections too. Section and tool texts are kept, so any two versions can be diffed.

## What it measures

- **Cost** per request, split by billing rate: input, output, cache read, cache write.
- **Cost by content:** how much each prompt section, tool definition and tool result costs over its life in the context.
- **Cache rebuilds** and their cause.
- **Idle pauses:** whether the cache was still warm, compacted, or cold when the user came back; the warming cost against the rebuild cost.
- **Compactions** by reason (threshold, overflow, cold cache).
- **Tools:** calls, errors, durations, result sizes, results whose files were never referenced again (an upper bound on unused context).
- **Subagents:** each `delegate_task` call linked to its child session, with the child's cost, wall time, startup write, and rediscovery (child calls on files the parent or an earlier child had already read). Also the estimated cost of resuming the cheapest earlier child instead of starting a new one.
- **Thinking:** replayed thinking priced at the reasoning tokens the message reported, with dropped blocks costing nothing.
- **User messages** by kind (follow-up, steer, after an interrupt), as the raw signal for corrections.
- **Experiment arms** (see [prompt.md](prompt.md#experiments)).

## Querying

[`queries/`](../extensions/metrics/queries) is the single query layer. Every function takes a `Scope`: time window, project, source (`pi` by default, `claude-code`, or `all`), model, session. Each function returns data. [`report.ts`](../extensions/metrics/report.ts) renders it as text, and the dashboard serves it as JSON.

```text
/harness stats            this project
/harness stats all        every project
```

```sh
npm run metrics -- [--all] [--cwd <dir>] [--since <date>] [--until <date>] [--source pi|claude-code|all] [--model <id>]
```

## Dashboard

A web UI at `http://127.0.0.1:4317`, served by [`dashboard/server`](../dashboard/server) (`node:http`, JSON under `/api/`, host-checked) with a React frontend. It also answers on the machine's LAN addresses, without authentication: see [SECURITY.md](../SECURITY.md).

| View | Shows |
| --- | --- |
| Overview | KPIs against the previous period, findings ranked in dollars, spend by billing rate over time, top sessions |
| Cost drivers | spend grouped by content, tool, model, project, source, context size, kind or day |
| Context & tools | request-size distribution, the heaviest tool results |
| Sessions | every session, and a timeline per session: compactions, pauses, subagent starts, user messages |
| Waste | cache rebuilds, cold resumes, unused tool results, replayed and dropped thinking |
| Subagents | starting a new subagent versus resuming an earlier one, per delegation |
| Harness versions | versions per project, with line diffs of sections and tools |

Filters live in the URL. The server indexes Pi sessions in a worker on start and on Refresh, imports Claude Code transcripts when a view first asks for that source, and caches responses per URL until the next index.

**Always on.** Every Pi process running the installed harness checks every 30 seconds that the dashboard answers on the deployed release. It starts the dashboard detached when it is not running (also after a crash), and replaces one running an older release, building the new frontend before stopping the old server. Lock: `~/.pi/agent/dashboard.lock`. Log: `~/.pi/agent/dashboard.log`. Run it in the foreground with `npm run dashboard`.

Tests: [`test/queries.test.ts`](../test/queries.test.ts) and [`test/dashboard.test.ts`](../test/dashboard.test.ts) run against a seeded store ([`test/seed.ts`](../test/seed.ts)). The frontend has vitest tests with fixtures from [`dashboard/scripts/fixtures.ts`](../dashboard/scripts/fixtures.ts), and Playwright tests render every view at desktop and phone width: `DASHBOARD_URL=… npm --prefix dashboard run test:e2e`.
