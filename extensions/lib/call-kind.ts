// What a tool call does, from its tool and (for bash) its command: explore (read-only), edit, check
// (tests, builds, linters, type checks), edit+check (one bash call that changes files and runs a
// check), wait (sleep, polling, goal, task status), vcs (git writes), delegate (subagents, scripts),
// interact (questions, reports) or other. scripts/evidence/turns.ts classifies past turns with it;
// extensions/explore nudges on consecutive explore turns with it.

export type CallKind = "explore" | "edit" | "check" | "edit+check" | "wait" | "vcs" | "delegate" | "interact" | "other";

export const CHECK = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|check|typecheck|tsc|verify|ci)\b|npx\s+(?:tsc|vitest|jest|eslint|biome|playwright)|vitest|jest\b|pytest|python3?\s+-m\s+(?:pytest|unittest|mypy)|\btsc\b|cargo\s+(?:test|build|check|clippy)|go\s+(?:test|build|vet)|\bmake\b|eslint|biome\s+(?:check|lint|ci)|ruff\s+check|mypy|node\s+--test|swift\s+(?:build|test)|xcodebuild|gradlew?|flutter\s+(?:test|analyze)|dart\s+analyze|lake\s+build|tox\b)/;
export const WAIT = /(?:^|[\s;&|(])sleep\s+\d|\buntil\b[^]*\bdo\b|\bwhile\b[^]*\bdo\b[^]*sleep|gh\s+run\s+watch|gh\s+pr\s+checks|\bwait\s*(?:$|[;&)])|tail\s+-f/;
export const VCS = /\bgit\s+(?:commit|push|add|rebase|merge|cherry-pick|checkout|switch|worktree|tag|reset|restore)\b|\bgh\s+pr\s+(?:create|merge)/;

const EXPLORE_TOOLS = new Set(["read", "grep", "find", "ls", "explore", "web_search", "web_fetch", "lens_diagnostics", "tool_search", "mcp__t3-code__t3_thread_read", "mcp__t3-code__t3_thread_search", "mcp__t3-code__orchestrator_capabilities", "mcp__t3-code__t3_worktree_list", "mcp__t3-code__html_preview", "mcp__t3-code__preview_snapshot", "mcp__t3-code__preview_evaluate"]);
const WAIT_TOOLS = new Set(["goal", "keep_warm", "mcp__t3-code__task_status", "mcp__t3-code__t3_thread_wait", "mcp__t3-code__t3_background_wait"]);
const DELEGATE_TOOLS = new Set(["workflow", "fix_loop", "codemode", "mcp__t3-code__delegate_task", "mcp__t3-code__t3_thread_send", "mcp__t3-code__task_cancel", "land"]);
const INTERACT_TOOLS = new Set(["ask_user", "submit_result", "note_improvement", "mcp__t3-code__t3_pending_request", "mcp__t3-code__html_render"]);

/** The kind of one call; `command` is bash's command (or its start), `mutates` whether it changes files. */
export function callKind(tool: string, command: string, mutates: boolean): CallKind {
	if (tool === "edit" || tool === "write") return "edit";
	if (EXPLORE_TOOLS.has(tool)) return "explore";
	if (WAIT_TOOLS.has(tool)) return "wait";
	if (DELEGATE_TOOLS.has(tool)) return "delegate";
	if (INTERACT_TOOLS.has(tool)) return "interact";
	if (tool !== "bash") return "other";
	if (WAIT.test(command)) return "wait";
	const check = CHECK.test(command);
	if (VCS.test(command)) return "vcs";
	if (mutates) return check ? "edit+check" : "edit";
	return check ? "check" : "explore";
}
