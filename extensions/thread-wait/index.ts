// Refuses an idle re-wait on a t3 thread: the same `t3_thread_wait` again right after one that timed
// out, with no other tool call or message in between (wait.ts has the rule and its history).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { idleRewait, isThreadWait } from "./wait.ts";

export default function threadWait(pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		// A script's own call (a workflow's wait slices, codemode) is no decision of the model.
		if (event.parentToolCallId !== undefined || !isThreadWait(event.toolName)) return;
		const reason = idleRewait(ctx.sessionManager.getBranch(), event.input, Date.now());
		if (reason) return { block: true, reason };
	});
}
