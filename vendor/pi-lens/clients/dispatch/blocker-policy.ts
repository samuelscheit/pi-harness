/**
 * Which linter findings may stop the agent.
 *
 * A linter's own level says how loudly its configuration wants a finding
 * reported. It does not say that the code is broken. Before this policy every
 * runner mapped that level straight onto a blocker (`semanticFor`), so:
 *
 * - ruff (0.17) stamps `"severity": "error"` on EVERY rule, so import order
 *   (I001), `str.split` literals (SIM905) and unnecessary generators (C401)
 *   stopped the agent;
 * - yamllint's built-in default config sets `line-length` (80 columns) to
 *   `error`, so a repo with no `.yamllint` that uses 120 columns got 25–1900
 *   blockers per edit, all on lines the edit never touched.
 *
 * The policy runs once per runner result, in the dispatcher's `runRunner`, so
 * the inline and the collect-later lanes read the same verdict. It changes
 * only blocking findings of linter runners ({@link LINTER_RUNNER_IDS}); type
 * checkers, compilers and language servers keep their verdicts, because an
 * edit can cause a type error on a line it never touched.
 *
 * 1. A blocking finding on a line the edit did not change never blocks. It
 *    leaves as `outOfEditScope`, still observed, so a blocker recorded while
 *    its line was edited stays pending until a run no longer observes it.
 *    This comes first, so the cross-tool class merge (#5416) cannot raise a
 *    demoted copy back. A write of an existing file marks the lines it
 *    changed against the bytes before it (`write-line-baseline.ts`); a
 *    created file, or one without that baseline, marks every line.
 * 2. On an edited line, a parse error always blocks: the file does not load.
 * 3. Without a project config for a style linter
 *    ({@link STYLE_LINTER_CONFIG}), the findings come from the tool's or
 *    pi-lens's defaults, not from the project: advisory.
 * 4. A rule outside the tool's correctness set ({@link BLOCKABLE_RULES}) is a
 *    convention (layout, ordering, simplification): advisory, config or not.
 *
 * This replaced the #4483 pre-edit seed, which ran the linters in `tool_call`
 * to tell old findings from new and stopped classifying past 1000 of them.
 *
 * A demoted finding keeps its message, rule and line, so dispositions, inline
 * suppressions and the delta baseline identify it as before.
 */

import * as path from "node:path";
import { hasToolConfig, type ToolConfigId } from "../tool-config-presence.js";
import {
	BLOCKING_DIAGNOSTICS_FAILURE_KIND,
	type Diagnostic,
	type DispatchContext,
	type RunnerResult,
	spanOverlapsModifiedRanges,
} from "./types.js";

/**
 * The dispatch runners that are linters: the lanes
 * `tests/clients/dispatch/edit-scope-census.test.ts` classifies as
 * `dispatcher-gated`. That census fails when the two sets differ.
 */
export const LINTER_RUNNER_IDS: ReadonlySet<string> = new Set([
	"actionlint",
	"biome-check-json",
	"credo",
	"detekt",
	"eslint",
	"golangci-lint",
	"hadolint",
	"htmlhint",
	"ktlint",
	"markdownlint",
	"oxlint",
	"psscriptanalyzer",
	"rubocop",
	"ruff-lint",
	"rust-clippy",
	"shellcheck",
	"spellcheck",
	"sqlfluff",
	"stylelint",
	"swiftlint",
	"tflint",
	"vale",
	"yamllint",
]);

/**
 * Linters whose defaults are conventions (line length, layout, ordering,
 * prose style) and that run without a project config (the tool's built-in
 * rules, or pi-lens's bundled fallback such as `config/ruff/core.toml`). Their
 * findings block only under a config the project carries.
 *
 * Not listed: linters that do not run without a config (eslint), and linters
 * whose `error` tier is reserved for definite defects (shellcheck,
 * golangci-lint, clippy and the rest), whose level stands.
 */
const STYLE_LINTER_CONFIG: Readonly<Record<string, ToolConfigId>> = {
	"biome-check-json": "biome",
	markdownlint: "markdownlint",
	"ruff-lint": "ruff",
	sqlfluff: "sqlfluff",
	stylelint: "stylelint",
	vale: "vale",
	yamllint: "yamllint",
};

/**
 * Per tool, the rules that report defects rather than conventions. A tool not
 * listed keeps its own level for every rule its config raises to `error`.
 */
const BLOCKABLE_RULES: Readonly<Record<string, (rule: string) => boolean>> = {
	// Pyflakes (undefined names, unused imports, …), pycodestyle's E9 runtime
	// errors and pylint's error class. Everything else (I, E1–E7, W, SIM, C4,
	// UP, PIE, B, S, …) is style, simplification or a heuristic.
	ruff: (rule) => /^(?:F|E9|PLE)\d/.test(rule),
	// A duplicated key silently drops a value; every other yamllint rule is
	// layout.
	yamllint: (rule) => rule === "key-duplicates",
};

/** A finding that says the file does not parse. */
export function isParseError(d: Pick<Diagnostic, "rule" | "message">): boolean {
	const rule = d.rule ?? "";
	return (
		rule === "syntax" || // yamllint
		rule === "invalid-syntax" || // ruff
		/^SC1\d{3}$/.test(rule) || // shellcheck parser
		/^(?:SyntaxError\b|Parsing error:)/.test(d.message) // ruff (old), eslint
	);
}

/** Whether a finding's rule may block at all (steps 2–4 of the module doc). */
export function lintRuleMayBlock(
	d: Pick<Diagnostic, "tool" | "rule" | "message">,
	projectConfigured: boolean,
): boolean {
	if (isParseError(d)) return true;
	if (!projectConfigured) return false;
	const blockable = BLOCKABLE_RULES[d.tool];
	return blockable === undefined || blockable(d.rule ?? "");
}

function projectConfiguresLinter(
	runnerId: string,
	filePath: string,
	cwd: string,
): boolean {
	const configId = STYLE_LINTER_CONFIG[runnerId];
	if (configId === undefined) return true;
	return hasToolConfig(configId, path.dirname(path.resolve(cwd, filePath)));
}

/**
 * Apply the policy to one runner's result. `ctx` is the runner's own context,
 * so `modifiedRanges` includes the lines owed to it. Returns `result` itself
 * when nothing changes.
 */
export function applyLinterBlockerPolicy(
	result: RunnerResult,
	ctx: Pick<DispatchContext, "filePath" | "cwd" | "modifiedRanges">,
	runnerId: string,
): RunnerResult {
	if (!LINTER_RUNNER_IDS.has(runnerId)) return result;
	if (
		!result.diagnostics.some(
			(d) => d.semantic === "blocking" && d.runnerFault !== true,
		)
	)
		return result;

	let configured: boolean | undefined;
	const editedFile = path.resolve(ctx.cwd, ctx.filePath);
	const kept: Diagnostic[] = [];
	const outOfEditScope: Diagnostic[] = [...(result.outOfEditScope ?? [])];
	let changed = false;
	for (const d of result.diagnostics) {
		if (d.semantic !== "blocking" || d.runnerFault === true) {
			kept.push(d);
			continue;
		}
		// Scope first: a finding withheld here is never delivered, so the
		// cross-tool class merge (#5416) cannot raise it back to a blocker.
		const onEditedFile =
			d.filePath === undefined ||
			path.resolve(ctx.cwd, d.filePath) === editedFile;
		if (
			onEditedFile &&
			d.line !== undefined &&
			!spanOverlapsModifiedRanges(d.line, d.line, ctx.modifiedRanges)
		) {
			outOfEditScope.push(d);
			changed = true;
			continue;
		}
		configured ??= projectConfiguresLinter(runnerId, ctx.filePath, ctx.cwd);
		if (!lintRuleMayBlock(d, configured)) {
			kept.push({ ...d, severity: "warning", semantic: "warning" });
			changed = true;
			continue;
		}
		kept.push(d);
	}
	if (!changed) return result;

	const next: RunnerResult = {
		...result,
		diagnostics: kept,
		...(outOfEditScope.length > 0 && { outOfEditScope }),
	};
	if (kept.some((d) => d.semantic === "blocking")) return next;
	// The run failed only on findings that no longer block: it succeeded.
	if (next.semantic === "blocking")
		next.semantic = kept.length > 0 ? "warning" : "none";
	if (next.failureKind === BLOCKING_DIAGNOSTICS_FAILURE_KIND) {
		next.status = "succeeded";
		delete next.failureKind;
	}
	return next;
}
