// Refusal of a command that waits idly in the foreground (extensions/bash/wait.ts).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { commandsIn } from "../extensions/bash/commands.ts";
import { foregroundWaits, sleepSeconds, waitRefusal } from "../extensions/bash/wait.ts";

describe("refused: a foreground wait", () => {
	for (const [command, waits] of [
		// The incidents of 2026-11-17.
		["timeout 3000 gh run watch 44057234072 > /dev/null 2>&1; gh run view 44057234072 --json conclusion -q .conclusion", ["timeout 3000 gh run watch 44057234072 > /dev/null 2>&1"]],
		["cd wt && timeout 3000 gh run watch 44110107319 --exit-status > /tmp/x.log 2>&1; echo exit=$?", ["timeout 3000 gh run watch 44110107319 --exit-status > /tmp/x.log 2>&1"]],
		["gh pr merge 521 --merge; sleep 20; R=$(gh run list --branch main --limit 1)", ["sleep 20"]],
		["(bun mockup > /tmp/r3-mockup.log 2>&1 &) ; sleep 100; tail -25 /tmp/r3-mockup.log", ["sleep 100"]],
		["sleep 20; cat job.log", ["sleep 20"]],
		// CI watches, wherever they run in the foreground.
		["gh run watch", ["gh run watch"]],
		["gh run watch 1 --exit-status && echo ok", ["gh run watch 1 --exit-status"]],
		["gh pr checks 12 --watch", ["gh pr checks 12 --watch"]],
		["gh pr checks --watch --fail-fast -i 30", ["gh pr checks --watch --fail-fast -i 30"]],
		["/opt/homebrew/bin/gh run watch 1", ["/opt/homebrew/bin/gh run watch 1"]],
		["env GH_REPO=a/b nohup gh run watch 1", ["env GH_REPO=a/b nohup gh run watch 1"]],
		["gh run watch 1 | tail -5", ["gh run watch 1"]],
		["x=$(gh run watch 1 --exit-status); echo $x", ["gh run watch 1 --exit-status"]],
		["bash -c 'gh run watch 1'", ["gh run watch 1"]],
		["sh -lc \"cd repo && gh run watch 1\"", ["gh run watch 1"]],
		["eval 'gh run watch 1'", ["gh run watch 1"]],
		["(gh run watch 1)", ["gh run watch 1"]],
		["{ gh run watch 1; }", ["gh run watch 1"]],
		["f() { gh run watch \"$1\"; }; f 1", ['gh run watch "$1"']],
		["job & gh run watch 1", ["gh run watch 1"]],
		["if gh run watch 1 --exit-status; then git push; fi", ["gh run watch 1 --exit-status"]],
		// Sleeps of 10 s or more, summed over arguments and over the command.
		["sleep 10", ["sleep 10"]],
		["sleep 10s", ["sleep 10s"]],
		["sleep 0.2m", ["sleep 0.2m"]],
		["sleep 1m", ["sleep 1m"]],
		["sleep 1h", ["sleep 1h"]],
		["sleep 1d", ["sleep 1d"]],
		["sleep .5m", ["sleep .5m"]],
		["sleep infinity", ["sleep infinity"]],
		["sleep 5 5", ["sleep 5 5"]],
		["sleep 5; echo a; sleep 5", ["sleep 5", "sleep 5"]],
		["timeout 30 sleep 60", ["timeout 30 sleep 60"]],
		["bash -c 'sleep 30'", ["sleep 30"]],
		["echo $(sleep 15; date)", ["sleep 15"]],
		// A loop that polls every 10 s or more: per iteration.
		["until gh run view 1 --json status -q .status | grep -q completed; do sleep 30; done", ["sleep 30"]],
		["while true; do sleep 5; curl -s x; sleep 5; done", ["sleep 5", "sleep 5"]],
		["for i in 1 2 3; do sleep 10; done", ["sleep 10"]],
		["while sleep 15; do check; done", ["sleep 15"]],
		// A loop's own sleeps are counted apart from those outside it.
		["sleep 9; until ready; do sleep 1; done", []],
		["sleep 9; sleep 1; until ready; do sleep 1; done", ["sleep 9", "sleep 1"]],
	] as const) {
		test(JSON.stringify(command), () => assert.deepEqual(foregroundWaits(command), waits));
	}
});

describe("allowed", () => {
	for (const command of [
		// In a background job.
		"gh run watch 1 --exit-status > ci.log 2>&1 &",
		"nohup gh run watch 1 > ci.log 2>&1 &",
		"(sleep 20; gh run watch \"$(gh run list --limit 1 --json databaseId -q '.[0].databaseId')\" --exit-status) > ci.log 2>&1 &",
		"{ sleep 20; gh run watch 1; } > ci.log 2>&1 &",
		"bash -c 'sleep 60; gh run watch 1' > ci.log 2>&1 &",
		"cd repo && git push && (gh run watch 1 > ci.log 2>&1 &) ; echo next",
		"gh run watch 1 > a.log 2>&1 & gh pr checks 2 --watch > b.log 2>&1 & echo started",
		"sleep 30 &",
		"coproc sleep 60",
		"if true; then sleep 60; fi &",
		"while true; do sleep 60; poll; done > poll.log 2>&1 &",
		// Short sleeps, readiness loops.
		"sleep 9",
		"sleep 9.9",
		"sleep 0.15m",
		"sleep 2 && curl -s localhost:3000",
		"sleep 4 4",
		"until curl -s localhost:3000; do sleep 1; done",
		"for i in $(seq 30); do curl -s x && break; sleep 2; done",
		"npm run dev > dev.log 2>&1 & until curl -s localhost:3000; do sleep 0.5; done; npm test",
		// Not a literal duration.
		"sleep $DELAY",
		"sleep \"$n\"",
		"sleep --help",
		// Other gh commands.
		"gh pr checks 12",
		"gh pr checks 12 -w",
		"gh run view 44057234072 --json conclusion -q .conclusion",
		"gh run list --branch main --limit 1",
		"gh run view 1 --log-failed | tail -50",
		"gh watch",
		// Text that only names the commands.
		"echo 'gh run watch 1' \"sleep 60\"",
		"grep -rn 'gh run watch' docs",
		"cat <<'EOF'\ngh run watch 1\nsleep 60\nEOF",
		"git commit -m 'feat: refuse gh run watch and sleep 60' a.ts",
		"# sleep 60\necho ok",
		"python3 -c 'import time; time.sleep(60)'",
		"",
	]) {
		test(JSON.stringify(command), () => {
			assert.deepEqual(foregroundWaits(command), []);
			assert.equal(waitRefusal(command), undefined);
		});
	}
});

describe("sleep durations", () => {
	for (const [args, seconds] of [
		[["10"], 10],
		[["0.5"], 0.5],
		[["1.5m"], 90],
		[["2h"], 7200],
		[["1d"], 86_400],
		[["5", "5s", "0.1m"], 16],
		[["infinity"], Number.POSITIVE_INFINITY],
		[[], 0],
		[["$n"], undefined],
		[["10x"], undefined],
		[["-5"], undefined],
	] as const) {
		test(JSON.stringify(args), () => assert.equal(sleepSeconds(args), seconds));
	}
});

describe("where commands run", () => {
	test("background and loop are set for the commands under `&` and in loops, also through scripts", () => {
		const found = commandsIn("a; b &\n(c; d) &\n{ e; } & f\nwhile g; do h; done\nbash -c 'i' &\nfor x in 1; do bash -c 'j'; done");
		const where = Object.fromEntries(found.map((c) => [c.name, [c.background ?? false, c.loop?.type]]));
		assert.deepEqual(where, {
			a: [false, undefined],
			b: [true, undefined],
			c: [true, undefined],
			d: [true, undefined],
			e: [true, undefined],
			f: [false, undefined],
			g: [false, "While"],
			h: [false, "While"],
			bash: [false, "For"],
			i: [true, undefined],
			j: [false, "For"],
		});
	});
});

describe("message", () => {
	test("names the waits, says why and what to do instead", () => {
		const text = waitRefusal("timeout 3000 gh run watch 1 --exit-status; sleep 5; sleep 5")!;
		assert.match(text, /^Not run: this command waits idly in the foreground \(CI watch, or 10s or more of `sleep`\):\n- `timeout 3000 gh run watch 1 --exit-status`\n- `sleep 5`\n/);
		assert.equal(text.match(/- `sleep 5`/g)?.length, 1, "the same command is listed once");
		assert.match(text, /2026-11-17/);
		assert.match(text, /`gh run watch <id> --exit-status > ci\.log 2>&1 &`/);
		assert.match(text, /collect all CI failures and fix them in one pass at the end/);
		assert.match(text, /\(sleep 20; gh run watch "\$\(gh run list/);
		assert.match(text, /until curl -s localhost:3000; do sleep 1; done/);
	});
});
