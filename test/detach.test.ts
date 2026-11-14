// `setsid` refusal (extensions/bash/detach.ts): which commands use it, and the refusal's text.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { refusal, setsidCommands, systemGuideline } from "../extensions/bash/detach.ts";

describe("commands that use setsid", () => {
	for (const [command, expected] of [
		["setsid nohup bash -c 'cd /repo && python3 index.py embed --all' > embed.log 2>&1 &", ["setsid nohup bash -c 'cd /repo && python3 index.py embed --all' > embed.log 2>&1"]],
		["setsid job", ["setsid job"]],
		["/usr/bin/setsid -f job", ["/usr/bin/setsid -f job"]],
		["env FOO=1 setsid job", ["env FOO=1 setsid job"]],
		["sudo nice -n 10 setsid job", ["sudo nice -n 10 setsid job"]],
		["timeout 60 setsid job", ["timeout 60 setsid job"]],
		["nohup setsid job &", ["nohup setsid job"]],
		["sh -lc \"setsid job\"", ["setsid job"]],
		["bash -c 'echo a; setsid job'", ["setsid job"]],
		["start() { setsid server; }; start", ["setsid server"]],
		["x=$(setsid job)", ["setsid job"]],
		["if true; then setsid a; fi; setsid b", ["setsid a", "setsid b"]],
		["eval 'setsid job &'", ["setsid job"]],
		["cd x && env -i nohup setsid job &", ["env -i nohup setsid job"]],
	] as const) {
		test(`uses setsid: ${JSON.stringify(command)}`, () => assert.deepEqual(setsidCommands(command), expected));
	}
});

describe("commands that do not", () => {
	for (const command of [
		"sleep 30 &",
		"nohup ./server > log 2>&1 &",
		"job & disown",
		"server & sleep 2; curl localhost:3000",
		"(cd sub && make) &",
		"grep -rn setsid src",
		"man setsid",
		"echo setsid nohup disown",
		"echo 'setsid job' \"setsid job\"",
		"cat <<'EOF'\nsetsid job\nEOF",
		"# setsid in a comment\necho ok",
		"python3 -c 'import os; os.setsid()'",
		"bash script.sh",
		"",
	]) {
		test(`no setsid: ${JSON.stringify(command)}`, () => assert.deepEqual(setsidCommands(command), []));
	}
});

describe("messages", () => {
	test("the refusal names the command, why per platform, and says to use & with a redirect", () => {
		const mac = refusal(setsidCommands("setsid nohup bash -c 'job' > embed.log &"), "darwin");
		assert.match(mac, /^Not run: this command uses `setsid`:\n- `setsid nohup bash -c 'job' > embed\.log`\n`setsid` does not exist on macOS/);
		assert.match(mac, /Start the job with `&` instead \(`nohup` is not needed\), its output redirected to a file, e\.g\. `\.\/job > job\.log 2>&1 &`/);
		assert.match(mac, /wakes you with a message when each one ends, also after your turn/);
		const linux = refusal(["setsid job"], "linux");
		assert.doesNotMatch(linux, /macOS/);
		assert.match(linux, /moves the job out of the command's process group/);
	});

	test("the same command twice is listed once; long commands are clipped", () => {
		const text = refusal(["setsid job", "setsid job", `setsid ${"x".repeat(300)}`], "linux");
		assert.equal(text.match(/`setsid job`/g)?.length, 1);
		assert.match(text, /`setsid x{112}…`/);
	});

	test("the system guideline names the OS and the BSD userland on macOS", () => {
		assert.match(systemGuideline("darwin"), /macOS with its BSD userland.*no `setsid`.*sed -i ''/);
		assert.match(systemGuideline("linux"), /Linux with the GNU userland/);
		assert.match(systemGuideline("freebsd"), /freebsd/);
	});
});
