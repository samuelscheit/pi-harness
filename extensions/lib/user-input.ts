// Whether input a session receives is the user's words or a notification t3 wrote (a delegated task
// finished or asks, a watched PR changed, a turn is continued). A patched t3 marks its own messages
// `origin: "notification"` (scripts/patch-t3.ts, notification-origin), which Pi gives extensions as
// input source "notification". A t3 without that patch (after an update, until t3 restarts) sends
// them as plain "rpc" input, so those are still told apart by their fixed text.
import type { InputEvent } from "@earendil-works/pi-coding-agent";

// t3's server-written messages (apps/server/src/orchestration-v2: Orchestrator.ts
// delegatedCompletionWakeDetail, ProviderContinuationService.ts, DelegatedTaskQuestionReactor.ts,
// pullRequestWatch.ts, UsageLimitRecoveryWorker.ts), each matched from its first line to its exact
// wording, so a user's reply that quotes one, mentions one or starts like one is still a reply.
const T3_NOTIFICATIONS = [
	// A delegated task's completion wake, one block per task: "Delegated task <id> (<title>) [<status>]:\n<result>" or "…]. Use task_status …".
	/^Delegated task \S+(?: \(.*\))? \[[a-z_]+\](?::\n|\. Use task_status with taskId \S+ to read the result\.)/,
	/^Delegated task \S+ reached a terminal state\. Use task_status with taskId \S+ to read the result\./,
	/^Delegated tasks \S+(?:, \S+)* reached terminal states\. Use task_status with each taskId to read the results\.$/,
	/^Delegated task \S+ (?:asked a question and is still working|is blocked on a question and cannot continue until it is answered)\. Read it with t3_pending_request /,
	/^Update on pull request #\d+ \(\S+\), which T3 Code is watching for you:\n/,
	/^Background task completed\.$/,
	/^Continue where you left off\.$/,
];

/** Whether a message's text is a notification t3 wrote (the fallback for an unpatched t3). */
export const isT3Notification = (text: string) => T3_NOTIFICATIONS.some((shape) => shape.test(text));

/** Whether input is the user's words: not an extension's message, not a client's notification. */
export const isUserInput = (event: Pick<InputEvent, "source" | "text">) =>
	event.source !== "extension" && event.source !== "notification" && !(event.source === "rpc" && isT3Notification(event.text));
