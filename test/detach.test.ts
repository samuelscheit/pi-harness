// Detached jobs (extensions/bash/detach.ts): which commands detach a job, and the refusal's text.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { detaches, refusal, systemGuideline } from "../extensions/bash/detach.ts";

const kinds = (command: string) => detaches(command).map((d) => `${d.kind}: ${d.text}`);

describe("commands that detach a job", () => {
	test("the reported case: setsid, nohup and a trailing & through bash -c", () => {
		assert.deepEqual(kinds("setsid nohup bash -c 'cd /repo && python3 index.py embed --all' > embed.log 2>&1 &"), [
			"setsid: setsid nohup bash -c 'cd /repo && python3 index.py embed --all' > embed.log 2>&1",
			"background: setsid nohup bash -c 'cd /repo && python3 index.py embed --all' > embed.log 2>&1 &",
		]);
	});

	for (const [command, expected] of [
		["sleep 30 &", ["background: sleep 30 &"]],
		["nohup ./server > log 2>&1 &", ["background: nohup ./server > log 2>&1 &"]],
		["server & sleep 2; curl localhost:3000", ["background: server &"]],
		["(cd sub && make) &", ["background: (cd sub && make) &"]],
		["{ make; } &", ["background: { make; } &"]],
		["echo start\n  long-job > out.log &\necho started", ["background: long-job > out.log &"]],
		["make && ./run &", ["background: make && ./run &"]],
		["a | b &", ["background: a | b &"]],
		["x=$(server &); echo $x", ["background: server &"]],
		["start() { server & }; start", ["background: server &"]],
		["for i in 1 2; do job $i & done", ["background: job $i &"]],
		["if true; then job & fi", ["background: job &"]],
		["job & disown", ["disown: disown", "background: job &"]],
		["setsid job", ["setsid: setsid job"]],
		["/usr/bin/setsid -f job", ["setsid: /usr/bin/setsid -f job"]],
		["env FOO=1 setsid job", ["setsid: env FOO=1 setsid job"]],
		["sudo nice -n 10 setsid job", ["setsid: sudo nice -n 10 setsid job"]],
		["timeout 60 setsid job", ["setsid: timeout 60 setsid job"]],
		["bash -c 'job &'", ["background: job &"]],
		["sh -lc \"setsid job\"", ["setsid: setsid job"]],
		["nohup bash -ec 'job & echo $!' > log", ["background: job &"]],
		["wait; job &", ["background: job &"]],
		["bash -c 'job &'; wait", ["background: job &"]],
	] as const) {
		test(`detaches: ${JSON.stringify(command)}`, () => assert.deepEqual(kinds(command), expected));
	}
});

describe("commands that do not detach", () => {
	for (const command of [
		"a && b",
		"a || b &&c",
		"make 2>&1 | tee build.log",
		"make |& tee build.log",
		"cmd &> log",
		"cmd &>> log",
		"echo oops >&2",
		"exec 3>&1 4>&2",
		"cmd 2>&-",
		"echo 'a & b' \"c & d\" $'e & f'",
		"echo a\\&b",
		"grep -E 'x|y&' file",
		"cat <<'EOF'\nserver &\nsetsid job\nEOF",
		"python3 - <<EOF\nprint('a & b')\nEOF\necho done",
		"tool edit - <<'EOF'\nf.ts\n<<<<<<< SEARCH\na &\n=======\nb &\n>>>>>>> REPLACE\nEOF\nnpm test",
		"[[ -f a && -f b ]] && echo both",
		"(( x & 1 )) && echo odd",
		"case $x in a) echo a ;& b) echo b ;; esac",
		"# a comment with & and setsid\necho ok",
		"a & b & wait",
		"server & pid=$!; sleep 1; curl localhost; kill $pid",
		"server & sleep 1; pkill -f server",
		"trap 'kill $(jobs -p)' EXIT; server & sleep 1; curl localhost",
		"echo hi; (sleep 0.1) & wait",
		"nohup make > log 2>&1",
		"grep -rn setsid src",
		"man disown",
		"echo setsid nohup disown",
		"bash -c 'job & wait'",
		"bash script.sh",
		"curl -s 'https://x.test/?a=1&b=2'",
		"echo \"$(date) & more\"",
		"",
	]) {
		test(`does not detach: ${JSON.stringify(command)}`, () => assert.deepEqual(detaches(command), []));
	}
});

describe("messages", () => {
	test("the refusal names what detaches, says the tool backgrounds commands itself and to run it in the foreground", () => {
		const text = refusal(detaches("setsid nohup bash -c 'job' > embed.log &"), 120_000, "darwin");
		assert.match(text, /^Not run: this command detaches a job/);
		assert.match(text, /- `setsid nohup bash -c 'job' > embed\.log`: `setsid` does not exist on macOS \(command not found\), so the job would never start/);
		assert.match(text, /- `setsid nohup bash -c 'job' > embed\.log &`: runs in the background \(`&`\)/);
		assert.match(text, /still running after 2 minutes, .* moves to the background, keeps running, and its end reaches you as a new message/);
		assert.match(text, /Run the command in the foreground instead/);
		assert.doesNotMatch(text, /On macOS `setsid` does not exist\./, "said once, in the setsid line");
	});

	test("on macOS a refusal without setsid still says that setsid does not exist; elsewhere it does not", () => {
		assert.match(refusal(detaches("job &"), 120_000, "darwin"), /On macOS `setsid` does not exist\./);
		const linux = refusal(detaches("setsid job &"), 120_000, "linux");
		assert.doesNotMatch(linux, /macOS/);
		assert.match(linux, /`setsid` moves it out of the tool's process group/);
	});

	test("the same finding twice is listed once; long commands are clipped", () => {
		const text = refusal([...detaches("job &"), ...detaches("job &"), ...detaches(`${"x".repeat(300)} &`)], 120_000, "linux");
		assert.equal(text.match(/`job &`/g)?.length, 1);
		assert.match(text, /`x{119}…`/);
	});

	test("the system guideline names the OS and the BSD userland on macOS", () => {
		assert.match(systemGuideline("darwin"), /macOS with its BSD userland.*no `setsid`.*sed -i ''/);
		assert.match(systemGuideline("linux"), /Linux with the GNU userland/);
		assert.match(systemGuideline("freebsd"), /freebsd/);
	});
});
