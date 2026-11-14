# 08: Replayed thinking and cache-loss events in Pi sessions

Analysed 2026-11-12 (evening). Follow-up to [07](07-evidence-from-our-sessions.md) §8, which reported two numbers to look into. The first was "thinking blocks carried in history = 20.7% of Pi spend". The second was "$18.70 of cache-loss events in one day".

## TL;DR

- **Replayed thinking is about 11% of Pi spend, not 21.6%.** Half of the metrics figure is an estimation artefact. The index sizes a thinking block from its summary text plus its base64 signature. Anthropic bills a replayed block at the thinking tokens the model reported generating (`usage.reasoning`). That was measured on 2,723 tool-loop request pairs: the prompt grows by 1.00× the reported thinking tokens.
- **The real figure is 8–11% of spend.** Thinking blocks the API silently drops are not billed, which gives the lower bound. Thinking from earlier turns (before the latest user message) is 5.0%.
- **Dropping earlier-turn thinking at every cache-loss moment would have saved $10.27 (2.6%).** Only $1.62 (0.4%) of that comes from losses Pi can foresee (idle expiry, compaction). The rest comes from losses that are a bug, fixed below. Do not build the policy now.
- **77% of cache-loss waste had one root cause:** pi-lens's "retained context injections" ledger, $31.93 of the $37.14 total (8.2% of Pi spend, 17 of 28 events).
  - The ledger lives in process memory. A Pi restart or a harness hot reload (every commit) empties it.
  - pi-lens then stops re-sending injections that earlier requests carried in the middle of the transcript, so the whole conversation is written to the cache again.
  - The session file never shows this. The metrics therefore blame "prompt or tools updated mid-conversation" or "cache missed without a prompt change", and both labels are wrong.
- **The same bug silently drops reasoning.** The changed prefix invalidates every later thinking block's prefix binding. Pi sends `block_binding: drop_block`, so Anthropic dropped 2,003 thinking blocks across 46 requests in 13 sessions without an error.

## Data and method

- **Source:** `~/.pi/agent/metrics.db`, snapshot at 21:57 UTC, opened read-only. Pi sessions only (`sessions.source = 'pi'`): 114 sessions and 4,572 requests, $389.99 at list prices, 12 Nov 13:29–21:57 UTC. Pi still has only this one day; 07 covered its first 44 sessions.
- **Session files:** `~/.pi/agent/sessions/**.jsonl` as the source of truth. pi-lens's own telemetry in `~/.pi-lens/latency.log*` (`cache_context` and `cache_usage` records); it only covers 21:06 UTC onward because of log rotation.
- **Times:** all UTC.
- **Scripts** (each has a header comment saying what it measures):

```sh
node scripts/evidence/thinking-billing.ts            # what a replayed thinking block really costs, from prompt growth
node scripts/evidence/thinking-replay.ts [db]        # thinking share re-attributed at billed size + the "drop at cache loss" simulation
node scripts/evidence/cache-loss.ts [db] [--all]     # per cache_event: session entries in between + diff of the real request payloads
```

The headline SQL (shares in 07 were computed the same way):

```sql
-- Pi spend by content category (the metrics' own attribution)
SELECT c.category, SUM(c.read_cost) rd, SUM(c.write_cost) wr, SUM(c.read_cost + c.write_cost + c.uncached_cost) total
FROM request_costs c JOIN sessions s ON s.id = c.session_id
WHERE s.source = 'pi' GROUP BY c.category ORDER BY total DESC;

-- Cache-loss events as the metrics classify them
SELECT r.cache_event, COUNT(*), COUNT(DISTINCT r.session_id), SUM(r.cache_lost), SUM(r.cache_waste), SUM(r.cost_write)
FROM requests r JOIN sessions s ON s.id = r.session_id
WHERE s.source = 'pi' AND r.cache_event IS NOT NULL GROUP BY 1 ORDER BY 4 DESC;
```

## 1. Thinking blocks carried in history

### How Pi sends prior thinking

`vendor/pi/packages/ai/src/api/anthropic-messages.ts` handles prior thinking as follows:

- **Replay:** `convertMessages` (around line 1756) replays every thinking block of every earlier assistant message as `{type: "thinking", thinking, signature}`. Redacted blocks go back as `redacted_thinking`, and an unsigned block becomes plain text.
- **Other models:** `transform-messages.ts` drops thinking only when it came from a different model.
- **Opus 5.5 / Sonnet 5.5** (`compat.supportsMidConvoEffort`):
  - Pi requests `thinking: {type: "adaptive", display: "summarized", block_binding: {prefix_mismatch_behavior: "drop_block"}}` with the `thinking-binding-controls-2026-08-01` beta (around line 1544).
  - So a block whose prefix no longer matches is silently dropped by the API instead of returning a 400.
  - Pi records each such drop as an `anthropic_input_transformations` diagnostic on the assistant message.
- **Stored text vs. signature:** the stored `thinking` text is the *summary* (display `summarized`). The full reasoning travels encrypted in the signature.

### What Anthropic does with it (docs, Nov 2026)

- **Kept and billed** ([Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking), "Thinking block preservation by model"):
  - Opus 4.5+ and Sonnet 4.6+ (so Opus/Sonnet 5.x, Haiku 5.5) **keep all prior turns' thinking**. It counts toward the context window and is **billed as input** on every later request (cache read or write like any history).
  - Older models strip earlier turns' blocks automatically.
  - With summarized display you are billed for the full thinking tokens, not the summary.
- **Tool loop:** within a tool-use turn the thinking blocks must be passed back complete and unmodified. Outside tool use, prior turns' thinking may be omitted.
- **What may be removed** ([Prefix checks](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking/prefix-checks)):
  - Each block is bound to `system`, `tools` and every earlier *message*.
  - Thinking blocks themselves are not compared as content, but each block must keep the same previous thinking block. You may leave out "the oldest, the newest, or all of them, but not one in between".
  - "Changing, inserting, moving, or deleting an earlier message counts, whatever its role."
  - `drop_block`: the API drops invalid blocks and "you aren't billed for those blocks". The docs advise sending it only after a 400, not on every conversation.
- **Cache:** removing blocks the API would keep changes the cached prefix from that point. Server-side `clear_thinking_20251015` also invalidates the cache where it clears ([Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)). Message threads, which Pi uses through the gateway, support context editing only with `clear_thinking` `keep: "all"`. So a drop policy would have to be client-side.

### How the metrics size thinking

`extensions/metrics/blocks.ts` sizes a block as `thinking.length / 4 + signature.length × 0.75 / 4`, i.e. summary characters plus decoded signature bytes, each at 4 per token. `attribution.ts` then scales every block to the real prompt size. The harness docs already flagged this as an estimate.

### Measured: what a replayed block is billed at

`thinking-billing.ts` takes consecutive requests n, n+1 of a session with only tool results in between (no user message, system update, compaction, or model or effort change). For those, `prompt(n+1) − prompt(n)` is exactly assistant n as replayed, plus its tool results.

- **Calibration:** on 1,225 such pairs without thinking, ordinary content costs 0.422 tokens/char (2.37 chars/token) plus 203 tokens of framing.
- **Residual:** on the 2,723 pairs with thinking, subtracting that calibration leaves the residual.

| over 2,723 tool-loop pairs with thinking | tokens |
|---|---|
| measured residual (prompt growth not explained by text, tool calls, results) | 1,502,369 |
| **reported thinking tokens** (`usage.reasoning` = `output_tokens_details.thinking_tokens`) | **1,333,050** |
| metrics estimate: summary text / 4 | 519,412 |
| metrics estimate: signature bytes / 4 | 1,394,930 |
| metrics estimate: total | 1,914,341 |

A regression of the residual on (summary chars, signature chars, reported tokens) puts all the weight on the reported tokens: coefficients 0.08, −0.16 and 1.49. The cleanest cases (≥1.5k thinking tokens, <4k chars of other content, n = 96) match almost exactly: residual 275,139 vs reported 272,666 (1.01×). Two examples:

| prompt growth | other content | residual | reported thinking | summary/4 | signature/4 |
|---|---|---|---|---|---|
| 11,029 | 1,037 | 9,992 | 9,792 | 2,866 | 5,861 |
| 8,420 | 453 | 7,967 | 8,159 | 2,525 | 5,995 |

**Conclusion:** a replayed thinking block is billed at the thinking tokens the model generated. That is the full reasoning, about 3× the summary text.

- **Across user messages:** none of the 89 pairs that span a user message shows a prompt that shrank, and their residual is positive (8.8k against 15.5k reported). Stripping earlier turns at a new user message would make prompts shrink. That matches the docs: Opus 5.5 keeps every turn.
- **Where the index goes wrong:** the signature (about 1.05× the thinking tokens in bytes/4) is not what is billed. Adding the summary on top double counts the thinking. The extra 44% of thinking tokens is then taken from every other category by the scaling step.

### Share of spend, re-attributed

`thinking-replay.ts` re-runs the prefix walk of `attribution.ts` on all 4,133 answered turns ($382.20, all Pi turns). Each thinking block is sized at its message's reported thinking tokens, split across the message's blocks by the old estimate. Every other block is scaled to the rest of the real prompt.

| sizing | thinking tokens carried | cache read | cache write | total | share of Pi spend |
|---|---|---|---|---|---|
| metrics index (summary + signature, scaled) | 284.5M | $56.17 | $28.21 | $84.38 | 21.6% |
| **billed size (reported thinking tokens)** | 137.3M | $27.07 | $15.29 | **$42.36** | **10.9%** |
| … of it, earlier turns (before the latest user message) | | $14.22 | $5.40 | $19.62 | 5.0% |
| … of it, in requests at or after the session's first API-reported thinking drop | | | | $10.47 | 2.7% |

- **Verdict:** the 20.7% / 21.6% figure is about half real billing and half artefact.
- **Lower bound:** the last row is spent on blocks Anthropic may have dropped and not billed (§2.3). The billed share therefore lies between **8.2% and 10.9%**.
- **Cache read vs write:** about 64% of thinking cost is cache reads and 36% cache writes. The writes are mostly the current turn's new thinking, which has to be written once anyway.

### The policy: drop earlier-turn thinking only when the cache is lost anyway

- **Simulation:**
  - At every request flagged with a `cache_event`, or the first request after a compaction, all thinking blocks before the latest user message are removed for good. The current turn's blocks stay, as the tool-use protocol requires.
  - The saving is what those blocks cost in that request (its rewrite) and in every later request.
  - This edit is allowed by the prefix-check rules: it leaves out *all of the oldest* blocks, never one in between.

| cache-loss cause (as the metrics label it) | moments | saving until session end |
|---|---|---|
| prompt or tools updated mid-conversation | 14 | $7.49 |
| cache missed without a prompt change | 5 | $1.16 |
| cache expired after idle (5 min TTL) | 3 | $0.99 |
| cache expired after idle (1 h TTL) | 4 | $0.51 |
| compaction | 2 | $0.12 |
| **all** (26 of 28 moments had earlier thinking) | 28 | **$10.27 = $5.00 reads + $5.27 avoided rewrites (2.6%)** |

- **Realistic saving is 0.4%, not 2.6%.** The first two rows ($8.65) are the pi-lens bug of §2, and fixing it removes those cache losses altogether. Pi cannot predict them anyway. What remains is losses Pi knows about before sending (idle expiry, compaction): **$1.62, 0.4% of spend**.
- **Not priced:** the reasoning the model loses when earlier thinking is dropped. The docs warn that dropped blocks "can cost more" output.

## 2. Cache-loss events

### How the metrics classify them

`extensions/metrics/attribution.ts`:

- **Rebuild:** `cacheEvent` flags a rebuild when a request read ≥ 2,000 fewer cached tokens than the previous one left there.
- **Cause:** `rebuildCause` tests these in order, for the previous request and this one:
  - gap > TTL → "cache expired after idle (5 min / 1 h TTL)";
  - model changed;
  - thinking level changed;
  - message count fell below 60% → "compaction" (not avoidable);
  - the first differing block digest → "tool definitions changed" / "system prompt changed" / "earlier X changed".
- **Fallback when no digest differs:**
  - if a `system update` block is new → **"prompt or tools updated mid-conversation"**;
  - otherwise → **"cache missed without a prompt change"**.

These two fallback labels are guesses. All the classifier knows is that the session file shows no change before the new content.

### What happened, event by event

`cache-loss.ts` lists the session entries between the previous answered request and the event. It then rebuilds both **real request payloads** with Pi's own provider code and the installed `models.json` (captured via `onPayload`) and compares them in prefix-cache order.

- **The payloads match:** for 17 of the 19 non-expiry events, Pi's request n is an unchanged prefix of request n+1. The other two are compactions, whose summary messages the capture could not rebuild.
- **So the cause is outside the session file.** Pi's own requests did not diverge, so whatever changed was not in it.
- **Read size:** every event read back almost exactly the tools + system part (19.9k–28.4k tokens, the first cache breakpoint).

The only part of the request that changes without being persisted is **pi-lens's context injection** (`vendor/pi-lens/index.ts` `injectIntoRequest`, `context_with_system` hook):

- **What `retain` does:** with `contextInjection.retain: true` (our global default since 16:04 UTC, `config/pi-lens.json`, see [tools](../../tools.md#pi-lens)), pi-lens re-sends earlier injections byte for byte where they sat. It does so from an in-memory ledger (`clients/context-injection-ledger.ts`, a `BoundedLruCache`).
- **When the ledger is lost:**
  - **Pi restart:** t3 resumes a session in a new process. This shows as `model_change` + `session_info` entries between two requests.
  - **Extension reload:** the harness hot-reloads every session on every commit (`pi.requestReload()`). Pi loads extensions with `jiti` and `moduleCache: false` (`core/extensions/loader.ts`), so the ledger module is new and empty.
- **What then happens:** the next request no longer carries the injections in the middle of the transcript, and everything after the first one is rewritten.

pi-lens's own telemetry confirms it (`cache_context.retention.reemitted`, request before → at the event). Every logged event shows the same signature:

| session | event | pid before → at | retained injections re-sent before → at |
|---|---|---|---|
| 01a1d18b-8f65 | 80452404 | 77876 → 60653 (restart) | 12 → 0 |
| 01a1d059-5a68 | 76137fc5 | 92891 → 60641 (restart) | 9 → 0 |
| 01a1d16f-85ad | 268dcdab | 5796 → 60668 (restart) | 22 → 0 |
| 01a1d180-479c | 55ad3669 | 64033 → 70024 (restart) | 22 → 0 |
| 01a1d180-479c | 2d672885 | 70024 (release reload) | 1 → 0 |
| 01a1d180-479c | 92af9a48 | 70024 (release reload) | 4 → 0 |
| 01a1d180-479c | f06798b3 | 70024 (release reload) | 3 → 0 |
| 01a1d16f-d959 | e12f749c | 88005 (release reload) | 10 → 0 |
| 01a1d04d-f5f8 | ee44adf2 | 9905 (new process, previous record before the log) | ? → 0 |

The log covers 548 consecutive request pairs (21:06 UTC onward):

- Retained injections dropped to 0: **8 of 8 lost the cache**.
- Otherwise: **539 of 540 hit**. The one miss is `ee44adf2` above.

Before the log window, all 8 events labelled "cache missed without a prompt change" or "prompt or tools updated" on a resumed session follow the same pattern. They all came after `retain` was switched on. Resumes in sessions with nothing retained kept the cache (3 hits: 01a1d06a 15:47, 01a1d05d 17:30, 01a1d16f-d959 21:23).

Restart and reload by themselves do not lose the cache:

- **Pi's own `threadState`** (message threads) lives in `pi-ai`, which a reload does not re-import.
- **A new thread re-reads the full cache:** all 46 `thread_not_found` fallbacks in the snapshot (47 in the files by the end of the analysis) in the sessions re-sent the full request as a new thread and read up to 949k cached tokens.
- **Appended system updates keep the cache:** all 6 preamble updates made before hot reload existed (4 preamble only, 2 together with `project_context`) hit, as `test/prompt-cache.test.ts` requires.

The `project_context` and experiment-section updates in these events are a symptom, not the cause:

- **Every release changes `project_context`:** the AGENTS.md path in that section includes the release commit (`…/harness/releases/<commit>/prompt/AGENTS.md`). So every release appends a new `project_context`.
- **Reloads also redraw experiment arms,** which adds `experiment-*` sections and tools.
- **So the label follows the reload:** both always sit next to the reload that actually broke the cache, which is why the metrics label these events "prompt or tools updated".

### Root causes and cost

| root cause | events | tokens rewritten | waste (above read rate) | cache writes |
|---|---|---|---|---|
| **A1** pi-lens retained-injection ledger lost (log-confirmed: restart or release reload) | 9 | 2.36M | **$18.44** | $18.99 |
| **A2** same, on a resumed process before the log window (inferred, same signature) | 8 | 1.73M | **$13.49** | $14.16 |
| **D** idle expiry (5 min: 3, 1 h: 4) | 7 | 0.74M | $5.15 | $5.64 |
| **B** `tool_search` added 20 tools as `tool_addition` blocks, beyond the 20-block lookback (14:31; `bridgeCacheLookback` addresses this) | 1 | 7k | $0.03 | $0.09 |
| **C** partial miss inside a tool loop, nothing changed (provider-side) | 1 | 4k | $0.03 | $0.07 |
| **E** compaction (expected) | 2 | 0.10M | $0 | $0.81 |
| **total** | 28 | 4.94M | **$37.14 (9.5% of Pi spend)** | $39.76 |

- **A1 + A2 is $31.93**, i.e. 86% of waste and 8.2% of all Pi spend. The share grew from 07's 5.6% because Pi had more restarts and, from 21:16 on, a hot reload on every commit (58 commits that day).
- **The 1 h expiries:** the four at 19:31 came 73–86 min after the last request, with 0 warm refreshes. Pi's warmer would have refreshed at ~54 min, so the Pi processes were not alive (t3 unloads idle sessions). All four resumed within 13 s, and they are the only events with a cause outside harness control.

### 2.3 Side effect: silently dropped reasoning

The same prefix change breaks thinking blocks too. Each block generated after a now-missing injection is bound to a prefix that no longer exists:

- **Scale:** with `drop_block`, the API dropped **2,003 thinking blocks on 46 requests in 13 sessions** (`anthropic_input_transformations`, reason `prefix_binding_mismatch`).
- **Timing:** in every session the first drop is at a cache-loss event (A1/A2, two compactions, two of the 19:31 resumes). The drops repeat on later requests; for example, 01a1d059-5a68 has drops from 17:15 to 22:13.
- **Hidden:** the model loses that reasoning without any visible error, and the metrics still bill those blocks.

## Recommendations

1. **Fix the pi-lens ledger loss.** This is the largest item: about $32 per 8.5 h, 8.2% of Pi spend, plus the lost reasoning. Make retained injections survive restart and reload. Two options:
   - **Persist them in the session** (preferred, root cause): deliver an injection as a real session message, e.g. a `custom` message via `pi.sendMessage`, instead of a per-request rewrite in `context_with_system`. Pi's transcript then holds it, `buildSessionContext` replays it, compaction handles it, and the ledger goes away.
     - Where: `vendor/pi-lens/index.ts` `injectIntoRequest` (around 4930–5160) and `clients/context-injection-ledger.ts`.
     - Upstream candidate, as pi-lens's own comment says the ledger exists because "pi's stored messages never change".
   - **Smaller fix:** keep the ledger but write each retained entry with `pi.appendEntry` and rebuild it on `session_start` (reasons `resume` and `reload`).
   - **Until then:** switching `contextInjection` off for Opus sessions trades pi-lens's injected findings for the cache. Measure that with an experiment arm rather than guess.
2. **Size thinking at its billed size in the metrics.**
   - In `extensions/metrics/blocks.ts` (`blocksOf`, assistant case), use the message's `usage.reasoning`, split across its thinking blocks. Fall back to the current estimate only when it is missing (19 blocks today).
   - Effect: the dashboard's "thinking" falls from 21.6% to ~11%. Tool results and the other categories get the ~$42 the estimate took from them.
   - Also have the indexer read `anthropic_input_transformations` and price the dropped blocks at 0. That gives the 8.2% lower bound. Update the metrics open points ([roadmap](../../roadmap.md#metrics)).
3. **Do not build "drop thinking at cache loss" now.**
   - Its realistic saving is 0.4% of spend (idle expiry and compaction only), and it costs reasoning.
   - If idle expiries grow, add it where Pi already knows the cache is cold: the `compaction.coldCache` path / cache-warming decision in `agent-session.ts`, at a user-turn start only.
   - The edit itself: drop *all* thinking before the latest user message, never one in the middle, in `anthropic-messages.ts` `convertMessages` behind a per-request flag.
4. **Make the classifier stop guessing.**
   - In `attribution.ts` `rebuildCause`, when no block digest differs, report "prefix changed outside the session file (request rewritten by an extension, or provider)". Do not report a prompt update or "no change".
   - Better: record a digest list of the actual provider payload per request (a `before_provider_request` hook appending a custom entry) and compare that. This would have pointed at pi-lens directly.
   - Also detect process starts (`model_change` + `session_info` mid-session) and harness reloads: the release extension can append a `harness-release` entry. Name these as causes.
   - `idle_pauses.outcome = 'cold'` also counts these rewrites. For example, the 9-, 29- and 33-minute pauses on 1 h caches in 01a1d0a9 and 01a1d04d are ledger losses, not expiry. Use the corrected cause there too.
5. **Stop re-sending `project_context` on every release.**
   - Point the AGENTS.md path in `extensions/prompt/index.ts` at a stable location (`~/.pi/agent/harness/current/prompt/AGENTS.md` or the source repo), not `releases/<commit>/`.
   - Small in tokens, but it removes a system update per commit per session and the false "prompt updated" label.
   - Separately, pi-lens logs `PILENS_CFG_0004` in this repo: it reads `config/pi-lens.json` as a project config and ignores `contextInjection`. That warning is harmless here, because the merged config reaches pi-lens via `PI_LENS_CONFIG_PATH` and retention was active, but it is noise.
6. **Revisit `drop_block` on every Opus 5.5 request.** The docs advise sending it only after a 400. Keep it (it avoids hard failures), but surface `thinking_dropped` counts in `/harness stats` as a quality signal. Today 2,003 dropped blocks were invisible.
7. **Idle expiry ($5.15).** Pi's warming cannot run when t3 has unloaded the process. If this grows, have t3's idle unload wait out the pending warm, or accept it. It is small next to item 1.

## Threats to validity

- **One day, one user.** 114 Pi sessions, mostly Opus 5.5 through the gateway at list prices.
- **Billing measurement:**
  - It relies on prompt growth in tool loops. Across user messages the sample is small (52 pairs) and noisy, though consistent with the docs.
  - The split of a message's reported thinking tokens across its blocks uses the old estimate's proportions.
- **Before 21:06 UTC there is no pi-lens telemetry.** The A2 events are attributed by their signature (resumed process, `retain` on, read = tools + system, prefix unchanged in the session file) and the 8/8 vs 539/540 separation after 21:06.
- **The thinking-drop simulation keeps the session's later history as it was.** Dropped reasoning could change later output; that is not priced.
