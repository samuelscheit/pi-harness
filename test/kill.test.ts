// Refusal of killing processes by name (extensions/bash/kill.ts).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { killRefusal, killsByName } from "../extensions/bash/kill.ts";

describe("refused: kill by name", () => {
	for (const [command, kills] of [
		['pkill -f "kernel serve" -P 1', ['pkill -f "kernel serve" -P 1']],
		["pkill node", ["pkill node"]],
		["pkill -9 -f vite", ["pkill -9 -f vite"]],
		["killall node", ["killall node"]],
		["killall -9 Dock", ["killall -9 Dock"]],
		["sudo pkill -f x", ["sudo pkill -f x"]],
		["/usr/bin/pkill -f x", ["/usr/bin/pkill -f x"]],
		["env A=1 nohup pkill x", ["env A=1 nohup pkill x"]],
		["cd x && pkill -f server; echo done", ["pkill -f server"]],
		["pkill -f a || true", ["pkill -f a"]],
		["echo $(pkill -f a)", ["pkill -f a"]],
		["bash -c 'pkill -f a'", ["pkill -f a"]],
		["eval 'killall x'", ["killall x"]],
		["for n in a b; do pkill $n; done", ["pkill $n"]],
		["if pgrep x; then pkill x; fi", ["pkill x"]],
		["pkill -f a &", ["pkill -f a"]],
		["f() { killall x; }; f", ["killall x"]],
		["pgrep -f x | xargs kill; killall5 -9", ["killall5 -9"]],
		["skill -9 -u bob", ["skill -9 -u bob"]],
		["pkill a; killall b", ["pkill a", "killall b"]],
	] as const) {
		test(command, () => {
			assert.deepEqual(killsByName(command), kills);
			assert.match(killRefusal(command)!, /^Not run: this command kills processes by name or command line:\n.*kill <pid>/s);
		});
	}
});

describe("allowed", () => {
	for (const command of [
		"kill 123",
		"kill -9 123 456",
		"kill $(pgrep -f 'my own')",
		"pgrep -fl kernel",
		"grep pkill notes.md",
		'echo "pkill -f x" "killall y"',
		"echo 'killall node'",
		"cat <<'EOF'\npkill -f x\nEOF",
		"# pkill x in a comment",
		"git commit -m 'refuse pkill and killall'",
		"git commit -F - <<'EOF'\nfix: pkill -f is refused\nEOF",
		"ls pkill-notes killall.txt",
		"mypkill x",
		"cat killall",
	]) {
		test(command, () => assert.equal(killRefusal(command), undefined));
	}
});
