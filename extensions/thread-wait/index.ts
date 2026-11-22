// Refuses two kinds of `t3_thread_wait` (wait.ts has the rules and their history): a wait on the
// session's own delegated child, whose end wakes it anyway, and an idle re-wait, the same wait again
// right after one that timed out, with no other tool call or message in between.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { idleRewait, isThreadWait, ownChildWait } from "./wait.ts";

export default function threadWait(pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		// A script's own call (a workflow's wait slices, codemode) is no decision of the model.
		if (event.parentToolCallId !== undefined || !isThreadWait(event.toolName)) return;
		const branch = ctx.sessionManager.getBranch();
		const reason = ownChildWait(branch, event.input) ?? idleRewait(branch, event.input, Date.now());
		if (reason) return { block: true, reason };
	});
}
