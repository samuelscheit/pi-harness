/**
 * Python files that extend `sys.path` at runtime.
 *
 * A study script that runs `sys.path.insert(0, "tools/kernel")` and then
 * `import syntax` imports a module Pyright cannot find: its import roots are
 * the configured ones, not the ones the script builds while it runs. Pyright
 * reports `Import "syntax" could not be resolved` (reportMissingImports) and,
 * when another module of that name shadows it, `"load" is not a known
 * attribute of module "klammer"` (reportAttributeAccessIssue). Both said
 * nothing about the code, yet stopped the agent on every edit (2026-11-13).
 *
 * In a file that changes `sys.path`, those two findings are an environment
 * gap, the class `lsp/environment-gap.ts` already demotes for TypeScript: the
 * finding keeps its line and code, loses blocking authority, and its text
 * names why. The same unresolved import in a file that does not touch
 * `sys.path` is a real error and keeps its severity.
 */

/** A statement that changes the import roots while the program runs. */
const SYS_PATH_MUTATION =
	/\bsys\.path\s*(?:\.\s*(?:insert|append|extend)\s*\(|(?:\[[^\]\n]*\]\s*)?\+?=(?!=))|\bsite\.addsitedir\s*\(/;

export const RUNTIME_PATH_NOTICE =
	"[this file extends sys.path at runtime, which static import resolution cannot follow; not blocking]";

/** Whether `content` changes `sys.path` (or adds a site dir) anywhere. */
export function modifiesSysPath(content: string): boolean {
	return SYS_PATH_MUTATION.test(content);
}

/**
 * Whether a Pyright finding is about import resolution: an unresolved import,
 * or a missing attribute of a MODULE (the shadowed-module form). A missing
 * attribute of a class or an instance is a type error and is not admitted.
 */
export function isImportResolutionFinding(
	rule: string | undefined,
	message: string,
): boolean {
	if (rule === "reportMissingImports") return true;
	return (
		rule === "reportAttributeAccessIssue" &&
		/is not a known attribute of module\b/.test(message)
	);
}
