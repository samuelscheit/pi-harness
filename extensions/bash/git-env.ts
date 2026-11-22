// Git run by the bash tool does not use fsmonitor.
//
// With `core.fsmonitor=true` (law-formalization worktrees, 2026-11-21) git asks a daemon which files
// changed instead of checking them, and two agent sessions lost to it:
// - `sed -i ''` edits to 5 of 11 files did not show in `git status` or `git commit -a`, also after
//   `git update-index --really-refresh`; only `git -c core.fsmonitor=false status` showed them, so
//   a commit silently left 5 files out;
// - `git commit` hung for more than 5 minutes, twice, after git started
//   `git fsmonitor--daemon run --detach`; with fsmonitor off the same commit took 1.6 s.
// So every shell the tool spawns gets `core.fsmonitor=false` as command-line config through the
// environment (`GIT_CONFIG_COUNT`/`KEY_<n>`/`VALUE_<n>`), appended after the entries already set,
// so the user's other entries stay and this one wins over them and every config file. A `git -c
// core.fsmonitor=…` the agent writes still wins (git reads `-c` after these). A bogus count is left
// as it is: git refuses it either way, and the error then names the user's own value.

/** Config every git the bash tool runs gets. */
export const GIT_CONFIG: readonly (readonly [key: string, value: string])[] = [["core.fsmonitor", "false"]];

/** `env` with `entries` appended to its `GIT_CONFIG_COUNT` entries (a new object; `env` is not changed). */
export function withGitConfig(env: NodeJS.ProcessEnv, entries: readonly (readonly [string, string])[] = GIT_CONFIG): NodeJS.ProcessEnv {
	const raw = env.GIT_CONFIG_COUNT?.trim() ?? "";
	if (!/^\d*$/.test(raw)) return env;
	const count = raw === "" ? 0 : Number(raw);
	const next: NodeJS.ProcessEnv = { ...env, GIT_CONFIG_COUNT: String(count + entries.length) };
	entries.forEach(([key, value], i) => {
		next[`GIT_CONFIG_KEY_${count + i}`] = key;
		next[`GIT_CONFIG_VALUE_${count + i}`] = value;
	});
	return next;
}
