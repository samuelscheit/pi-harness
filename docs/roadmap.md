# Roadmap and open questions

What is known to be missing or imprecise, in rough priority order.

## Harness

- **Judge pi-lens from the metrics.** pi-lens is on trial. Use the metrics (its tools, result sizes, the cache effect of its injections, harness versions per project) to trim what costs more than it helps, globally or per project.
- **Adapt T3 Code's tools.** Decide which `mcp__t3-code__*` tools to hide, re-describe or wrap. Measured: T3's tool definitions and its orchestration section cost 1–2% of every request, and an `orchestrator_capabilities` result is 1.6k tokens that stay in context for about 75 requests.
- **Subagent decisions from data.** T3's orchestration instructions say to always start a new delegate and never resume one. The subagent metrics already estimate when resuming a warm child would be cheaper. Feed those numbers into the decision instead of a fixed rule.
- **Setting experiments.** Experiments can vary prompt sections and tools. Varying a setting, such as the compaction threshold, is designed (see [`experiments.ts`](../extensions/lib/experiments.ts)) but not built.
- **Visibility inside T3:** a status line, notices when a release is deployed, a `/harness` card through `html_render`, and the dashboard in T3's preview panel.
- **Re-tune cache settings** (`cacheWarmingIdleMinutes`, the cold-compaction threshold) once there is enough history of idle pauses.

## Metrics

- **Reloads leave no session entry.** A rebuild caused by a harness reload is recognised only by a coincident prompt update. A `harness-release` custom entry, or a digest of the real provider payload per request, would name it.
- **Blocks model Pi's messages, not the payload.** Errored or aborted replies and other models' thinking are priced although Pi does not send them. Models without mid-conversation system messages get the prompt replayed, which the block order does not model either. `payload.ts` already knows the real layout, so `blocks.ts` could reuse it.
- **Cold resumes are over-counted.** A rebuild caused outside the session file after a short pause still counts as a cold resume.

## Providers

- **Tools loaded mid-session.** On models behind the gateway, a tool loaded by `tool_search` goes into the top-level `tools` list and invalidates the cache. Pi's `supportsAdditionalTools` would fix this if the gateway forwards `additional_tools` on every backend (untested).
- **Gemini prompt updates.** Gemini follows mid-conversation prompt updates, but a gateway that folds every system message into `systemInstruction` loses the cache. The fix belongs in the gateway: keep mid-conversation instructions in place.

## Upstream candidates

The Pi patches listed in [install.md](install.md#bundled-pi-and-pi-lens) (`requestReload`, reloading changed JavaScript extensions, the cache lookback bridge, the questions dialog, background work) are general and could be proposed upstream. The T3 Code adapter fixes in [`scripts/patch-t3.ts`](../scripts/patch-t3.ts) mirror branches prepared for T3 Code.
