/**
 * A language server's report that its toolchain or the filesystem failed,
 * not that the code is wrong.
 *
 * Lean's file worker runs `lake setup-file` before it elaborates a file. When
 * lake cannot write its build directory (a worktree whose `.lake/build` is
 * owned elsewhere: `permission denied (error code: 13)`), or the toolchain it
 * names is not installed, the worker publishes ONE severity-1 diagnostic at
 * line 1 carrying lake's stderr, and never checks the file. pi-lens rendered
 * it as a 🔴 STOP on every edit (2026-11-13); no edit of the file can fix it.
 *
 * Such a row is no verdict about the code: the runner drops it and reports the
 * run as reaching no verdict (the coverage notice says the file was not
 * checked), and records the cause once per session.
 *
 * The same holds when lake cannot load a native plugin its build produced:
 * `error loading plugin, initializer not found 'initialize_<pkg>_<Module>'`
 * (2026-11-12, a project that builds through its own wrapper into a separate
 * build directory, so `repo/.lake` held a stale shared library). Lean prints
 * that line only when `dlopen`/`dlsym` of a `--plugin`/`--load-dynlib` library
 * fails, never for a source error, and it named every file of the project.
 *
 * Fail closed: only a `lake setup-file` failure whose stderr names a
 * filesystem permission or capacity errno, a missing toolchain, or a native
 * plugin that failed to load is admitted. A setup-file failure for any other
 * reason — a bad import, a
 * missing source file (`no such file or directory (error code: 2)`), a
 * dependency that does not compile — stays a code diagnostic.
 */

const LAKE_SETUP_FILE_FAILED = /`[^`]*\blake\b[^`]*\bsetup-file\b[^`]*` failed/;

/** EPERM (1), EACCES (13), ENOSPC (28), EROFS (30), in lake's and libc's words. */
const ENVIRONMENT_ERRNO =
	/\(error code: (?:1|13|28|30)\b|permission denied|operation not permitted|read-only file system|no space left on device|\bEACCES\b|\bEPERM\b|\bEROFS\b|\bENOSPC\b/i;

const MISSING_TOOLCHAIN = /\btoolchain '[^']+' is not installed\b/i;

/** Lean's `loadPlugin`/`loadDynlib` failure: the library or its initializer. */
const PLUGIN_LOAD_FAILURE = /\berror loading (?:plugin|library)\b/i;

/** Each admitted cause; the record's cause is the first line one matches. */
const ENVIRONMENT_CAUSES = [
	ENVIRONMENT_ERRNO,
	MISSING_TOOLCHAIN,
	PLUGIN_LOAD_FAILURE,
] as const;

export const TOOLCHAIN_FAILURE_NOTICE =
	"[toolchain or filesystem failure, not a code finding: the file was not checked]";

/** Whether a diagnostic message is a toolchain or filesystem failure. */
export function isToolchainEnvironmentFailure(message: string): boolean {
	return (
		LAKE_SETUP_FILE_FAILED.test(message) &&
		ENVIRONMENT_CAUSES.some((cause) => cause.test(message))
	);
}

/** A one-line cause for the degradation record: the first matching line. */
export function toolchainFailureCause(message: string): string {
	const line =
		message
			.split("\n")
			.find((l) => ENVIRONMENT_CAUSES.some((cause) => cause.test(l))) ??
		message;
	return line.trim().slice(0, 200);
}
