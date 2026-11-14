// A `ps` whose listings exceed child_process's default output limit (1 MB): the real `ps`, and for
// a listing of every process (-A, -ax…) another 50,000 processes, and 2 MB of command line when
// the listing asks for command lines. Code that asks `ps` only for what it needs works with it.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = `#!/bin/bash
/bin/ps "$@"
status=$?
case " $* " in
*" -A "* | *" -ax"*)
	awk 'BEGIN { for (i = 0; i < 50000; i++) printf "%d 1 %d S\\n", 90000000 + i, 90000000 + i }'
	case "$*" in *command* | *args*) head -c 2000000 /dev/zero | tr '\\0' x; echo ;; esac
	;;
esac
exit $status
`;

/** Run `fn` with the huge `ps` first on PATH. */
export async function withHugePs<T>(fn: () => T | Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "huge-ps-"));
	writeFileSync(join(dir, "ps"), SCRIPT);
	chmodSync(join(dir, "ps"), 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${dir}:${path}`;
	try {
		return await fn();
	} finally {
		process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
	}
}
