// Harness releases: deploying committed code only, refusing commits that do not load, atomic
// switching, locking, pruning, and sessions reloading into a new release when idle.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { linkModules, piBuildOf, piBuildsDir, piLink } from "../extensions/lib/pi-build.ts";
import { builtPi, commitToSource, currentLink, currentRelease, type DeployResult, deploy, harnessDir, holdRelease, holds, piTree, switchTo } from "../extensions/lib/release.ts";
import { inSource, type ReleaseMarker } from "../extensions/lib/repository.ts";
import release from "../extensions/release/index.ts";

let dir: string;
let source: string;
let agentDir: string;
/** The content of core.txt each Pi build saw in its build directory, in order. */
let piBuilds: string[];
beforeEach(() => {
	piBuilds = [];
	dir = realpathSync(mkdtempSync(join(tmpdir(), "release-")));
	source = join(dir, "source");
	agentDir = join(dir, "agent");
	mkdirSync(join(source, "extensions", "a"), { recursive: true });
	mkdirSync(join(source, "vendor", "pi"), { recursive: true });
	writeFileSync(join(source, "extensions", "a", "index.ts"), 'import { value } from "../../lib/value.ts";\nexport default () => value;\n');
	mkdirSync(join(source, "lib"));
	writeFileSync(join(source, "lib", "value.ts"), 'export const value = "one";\n');
	writeFileSync(join(source, "vendor", "pi", "core.txt"), "pi 1\n");
	writeFileSync(join(source, "package.json"), '{ "type": "module" }\n');
	git("init", "-q", "-b", "main");
	commit("first");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function git(...args: string[]): string {
	return execFileSync("git", ["-C", source, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
}
function commit(message: string): string {
	git("add", "-A");
	git("commit", "-qm", message);
	return git("rev-parse", "HEAD");
}
/** Wait until `done` holds (polling), failing after `ms`. */
async function until(done: () => boolean, ms = 15_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!done()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((wait) => setTimeout(wait, 25));
	}
}
/** A pid no process has: a short-lived child that has exited. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;
/** A Pi build that records what it saw in `into` and writes its output next to it. */
const recordingBuild = (into: string[]) => async (build: string) => {
	const core = readFileSync(join(build, "core.txt"), "utf8");
	into.push(core);
	writeFileSync(join(build, "built.txt"), `built from ${core}`);
};
const buildPi = (build: string) => recordingBuild(piBuilds)(build);
const deployMain = (validate?: (root: string) => Promise<void>, build = buildPi) => deploy({ source, branch: "main", agentDir, buildPi: build, ...(validate ? { validate } : {}) });
/** deployMain bound to this test's repository, agent dir and builds: a session's poll still running after its test must not deploy into the next test's. */
const boundDeploy = () => {
	const at = { source, agentDir, builds: piBuilds };
	return () => deploy({ source: at.source, branch: "main", agentDir: at.agentDir, buildPi: recordingBuild(at.builds) });
};

describe("deploy", () => {
	test("builds a snapshot of the branch's commit; uncommitted edits stay out; shared parts are links", async () => {
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "uncommitted";\n');
		writeFileSync(join(source, "untracked.txt"), "x");
		const result = await deployMain();
		const head = git("rev-parse", "HEAD");
		assert.deepEqual(result, { status: "deployed", commit: head });
		const root = realpathSync(currentLink(agentDir));
		assert.equal(root, realpathSync(join(harnessDir(agentDir), "releases", head)));
		assert.equal(readFileSync(join(root, "lib", "value.ts"), "utf8"), 'export const value = "one";\n', "the committed content");
		assert.equal(existsSync(join(root, "untracked.txt")), false);
		assert.ok(lstatSync(join(root, "vendor")).isSymbolicLink(), "vendor is the source's, not copied");
		assert.equal(readFileSync(join(root, "vendor", "pi", "core.txt"), "utf8"), "pi 1\n");
		const tree = await piTree(source, head);
		assert.equal(readlinkSync(join(root, "node_modules")), join(realpathSync(piBuildsDir(harnessDir(agentDir))), tree!, "node_modules"), "Pi's packages are the commit's Pi build");
		const marker = currentRelease(agentDir)!;
		assert.deepEqual({ commit: marker.commit, source: marker.source, branch: marker.branch, subject: marker.subject }, { commit: head, source, branch: "main", subject: "first" });
		assert.deepEqual(await deployMain(), { status: "current", commit: head });
	});

	test("a commit that does not load is refused once and remembered; the running release stays", async () => {
		const good = (await deployMain()).commit;
		writeFileSync(join(source, "extensions", "a", "index.ts"), 'import { missing } from "../../lib/nope.ts";\nexport default () => missing;\n');
		const bad = commit("broken import");
		const failed = (await deployMain()) as Extract<DeployResult, { status: "failed" }>;
		assert.equal(failed.status, "failed");
		assert.equal(failed.fresh, true);
		assert.match(failed.error, /nope\.ts/);
		assert.match(failed.error, new RegExp(`releases/${bad.slice(0, 9)}/extensions/a/index\\.ts`), "names the release, not the build directory");
		assert.doesNotMatch(failed.error, /releases\/\./);
		assert.equal(currentRelease(agentDir)!.commit, good);
		assert.equal(existsSync(join(harnessDir(agentDir), "releases", bad)), false, "no half-built release left");
		const again = (await deployMain()) as Extract<DeployResult, { status: "failed" }>;
		assert.deepEqual([again.status, again.fresh], ["failed", false]);
		writeFileSync(join(source, "extensions", "a", "index.ts"), 'import { value } from "../../lib/value.ts";\nexport default () => value;\n');
		const fixed = commit("fix");
		assert.deepEqual(await deployMain(), { status: "deployed", commit: fixed, previous: good });
	});

	test("a syntax error or a throwing module also fails the import check", async () => {
		await deployMain();
		writeFileSync(join(source, "lib", "value.ts"), "export const value = ;\n");
		commit("syntax");
		assert.equal((await deployMain()).status, "failed");
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = 1;\nthrow new Error("boom at import");\n');
		commit("throws");
		const thrown = (await deployMain()) as Extract<DeployResult, { status: "failed" }>;
		assert.match(thrown.error, /boom at import/);
	});

	test("only the deployed branch counts; another branch's commits are not deployed", async () => {
		const main = (await deployMain()).commit;
		git("checkout", "-qb", "feature");
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "feature";\n');
		commit("feature work");
		assert.deepEqual(await deployMain(), { status: "current", commit: main });
	});

	const lockDir = () => join(harnessDir(agentDir), ".lock");
	const holdLock = (pid: number, touchedMsAgo = 0) => {
		mkdirSync(lockDir(), { recursive: true });
		writeFileSync(join(lockDir(), "pid"), String(pid));
		const at = new Date(Date.now() - touchedMsAgo);
		utimesSync(lockDir(), at, at);
	};

	test("a lock held by a live process with a fresh heartbeat makes others wait", async () => {
		holdLock(process.pid);
		assert.equal((await deployMain()).status, "busy");
		assert.equal(existsSync(lockDir()), true, "a live holder's lock stays");
	});

	test("a lock whose holder died is taken over at once, also with a fresh heartbeat", async () => {
		holdLock(deadPid());
		assert.equal((await deployMain()).status, "deployed");
		assert.equal(existsSync(lockDir()), false, "released after deploying");
		assert.deepEqual(readdirSync(harnessDir(agentDir)).filter((n) => n.startsWith(".lock")), [], "nothing moved aside is left");
	});

	test("a lock without a heartbeat for 15 s is taken over even if its pid runs (reused or hung)", async () => {
		holdLock(process.pid, 20_000);
		assert.equal((await deployMain()).status, "deployed");
		mkdirSync(lockDir());
		assert.equal((await deployMain(async () => {})).status, "current", "a deployed commit needs no lock");
		rmSync(lockDir(), { recursive: true });
		holdLock(process.pid, 10_000);
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "next";\n');
		commit("next");
		assert.equal((await deployMain()).status, "busy", "10 s without a touch is not yet abandoned");
	});

	test("a lock just created, its pid not yet written, makes others wait", async () => {
		mkdirSync(lockDir(), { recursive: true });
		assert.equal((await deployMain()).status, "busy");
	});

	test("the holder touches the lock while deploying, so a slow deploy is not taken over", async () => {
		const touches: number[] = [];
		const result = await deployMain(async () => {
			const first = statSync(lockDir()).mtimeMs;
			await new Promise((r) => setTimeout(r, 4_500));
			touches.push(first, statSync(lockDir()).mtimeMs);
			assert.equal(readFileSync(join(lockDir(), "pid"), "utf8"), String(process.pid));
		});
		assert.equal(result.status, "deployed");
		assert.ok(touches[1]! > touches[0]!, "touched during the validation");
	});

	test("builds left by dead processes are removed; a live process's build stays", async () => {
		const releases = join(harnessDir(agentDir), "releases");
		const orphan = join(releases, `.${"a".repeat(40)}.${deadPid()}`);
		const running = join(releases, `.${"b".repeat(40)}.${process.ppid}`);
		mkdirSync(orphan, { recursive: true });
		mkdirSync(running, { recursive: true });
		assert.equal((await deployMain()).status, "deployed");
		assert.equal(existsSync(orphan), false);
		assert.equal(existsSync(running), true);
	});

	test("two deploys at once: one deploys, the other waits; one release results", async () => {
		const results = await Promise.all([deployMain(), deployMain()]);
		assert.deepEqual(results.map((r) => r.status).sort(), ["busy", "deployed"]);
		assert.equal(readdirSync(join(harnessDir(agentDir), "releases")).filter((n) => !n.startsWith(".")).length, 1);
		assert.equal((await deployMain()).status, "current");
	});

	test("keeps the current release and the five newest others", async () => {
		const validate = async () => {};
		const commits: string[] = [];
		for (let i = 0; i < 8; i++) {
			writeFileSync(join(source, "lib", "value.ts"), `export const value = ${i};\n`);
			commits.push(commit(`c${i}`));
			await deployMain(validate);
		}
		const kept = readdirSync(join(harnessDir(agentDir), "releases")).sort();
		assert.equal(kept.length, 6);
		assert.ok(kept.includes(commits.at(-1)!));
		assert.ok(!kept.includes(commits[0]!) && !kept.includes(commits[1]!));
		// Going back is switching the link.
		switchTo(agentDir, commits.at(-2)!);
		assert.equal(currentRelease(agentDir)!.commit, commits.at(-2));
	});

	test("a release a live process holds is never pruned; holds of exited processes are dropped", async () => {
		const validate = async () => {};
		const first = (await deployMain(validate)).commit;
		holdRelease(agentDir, [first], undefined, process.ppid);
		writeFileSync(join(source, "lib", "value.ts"), "export const value = 'second';\n");
		const second = commit("second");
		await deployMain(validate);
		holdRelease(agentDir, [second], undefined, deadPid());
		for (let i = 0; i < 7; i++) {
			writeFileSync(join(source, "lib", "value.ts"), `export const value = ${i};\n`);
			commit(`c${i}`);
			await deployMain(validate);
		}
		const kept = readdirSync(join(harnessDir(agentDir), "releases"));
		assert.ok(kept.includes(first), "held by a live process: kept although older than the five newest");
		assert.ok(!kept.includes(second), "its holder exited: pruned like any other");
		assert.equal(kept.length, 7, "current, five newest, and the held one");
		assert.deepEqual([...holds(agentDir).releases], [first]);
		assert.deepEqual(readdirSync(join(harnessDir(agentDir), "in-use")), [String(process.ppid)], "the dead holder's file is gone");
		// The holder reloads into the current release: the old one becomes prunable.
		holdRelease(agentDir, [currentRelease(agentDir)!.commit], undefined, process.ppid);
		writeFileSync(join(source, "lib", "value.ts"), "export const value = 'last';\n");
		commit("last");
		await deployMain(validate);
		assert.ok(!readdirSync(join(harnessDir(agentDir), "releases")).includes(first));
	});

	test("a hold names the release loaded last, the Pi, then the others; every release in it is held, also in a one-line hold", () => {
		const [a, b, c, d] = ["a", "b", "c", "d"].map((x) => x.repeat(40));
		holdRelease(agentDir, [a!, b!, a!, c!], "pi-tree", process.ppid);
		const file = join(harnessDir(agentDir), "in-use", String(process.ppid));
		assert.equal(readFileSync(file, "utf8"), `${a}\npi-tree\n${b}\n${c}\n`, "releases before Pi holds read the first two lines as release and Pi");
		// A process on a release from before holds named their Pi: one line.
		writeFileSync(join(harnessDir(agentDir), "in-use", String(process.pid)), d!);
		assert.deepEqual(holds(agentDir), { releases: new Set([a, b, c, d]), pis: new Set(["pi-tree"]) });
		holdRelease(agentDir, [b!], undefined, process.ppid);
		assert.equal(readFileSync(file, "utf8"), `${b}\n\n`, "rewritten whole");
		assert.deepEqual(readdirSync(harnessDir(agentDir)).filter((name) => name.startsWith(".in-use")), [], "no temporary file left");
		assert.deepEqual(readdirSync(join(harnessDir(agentDir), "in-use")).sort(), [String(process.pid), String(process.ppid)].sort());
	});
});

describe("holds of running sessions", () => {
	type Handler = (event: unknown, ctx: unknown) => unknown;
	const validate = async () => {};
	const released = () => readdirSync(join(harnessDir(agentDir), "releases"));
	const held = () => readFileSync(join(harnessDir(agentDir), "in-use", String(process.pid)), "utf8").split("\n").filter(Boolean);
	/** A new commit, deployed. */
	const next = async (label: string) => {
		writeFileSync(join(source, "lib", "value.ts"), `export const value = ${JSON.stringify(label)};\n`);
		commit(label);
		return (await deployMain(validate)).commit;
	};
	/** A session of this process loading the release extension on `loaded` (not started: no polling). */
	function load(loaded: string) {
		const handlers = new Map<string, Handler>();
		release({ on: (name: string, handler: Handler) => handlers.set(name, handler), requestReload: () => {} } as never, {
			agentDir,
			release: { commit: loaded, source, branch: "main", subject: "s", deployedAt: "" },
			pi: builtPi(agentDir),
		});
		return { end: () => handlers.get("session_shutdown")!({ reason: "reload" }, {}) };
	}
	afterEach(() => {
		delete (globalThis as { __harnessRelease?: unknown }).__harnessRelease;
	});

	test("a reload into a new release holds it and frees the old one, but not before the new one loaded", async () => {
		const first = (await deployMain(validate)).commit;
		const old = load(first);
		const second = await next("second");
		old.end();
		assert.deepEqual(held(), [first, builtPi(agentDir)], "between the session's end and its reload, the release it ran stays held");
		load(second);
		assert.deepEqual(held(), [second, builtPi(agentDir)]);
		for (let i = 0; i < 6; i++) await next(`c${i}`);
		assert.ok(!released().includes(first), "the old release is pruned like any other");
		assert.ok(released().includes(second), "the reloaded one is held although older than the five newest");
	});

	test("two sessions of one process on different releases hold both until each ends", async () => {
		const first = (await deployMain(validate)).commit;
		const parent = load(first);
		const second = await next("second");
		const child = load(second);
		assert.deepEqual(held(), [second, builtPi(agentDir), first]);
		for (let i = 0; i < 6; i++) await next(`c${i}`);
		assert.ok(released().includes(first) && released().includes(second), "both kept while their sessions run");
		parent.end();
		assert.deepEqual(held(), [second, builtPi(agentDir)]);
		await next("after parent");
		assert.ok(!released().includes(first), "the parent's release goes once it ended");
		child.end();
		await next("after child");
		assert.ok(released().includes(second), "the release loaded last stays held while the process lives: its `tool` command's bridge");
	});

	test("a dead process's hold holds nothing, however many releases it names", async () => {
		const first = (await deployMain(validate)).commit;
		const second = await next("second");
		holdRelease(agentDir, [second, first], builtPi(agentDir), deadPid());
		for (let i = 0; i < 6; i++) await next(`c${i}`);
		assert.ok(!released().includes(first) && !released().includes(second));
		assert.deepEqual(readdirSync(join(harnessDir(agentDir), "in-use")), [], "its file is gone");
	});
});

describe("the global Pi build", () => {
	const builds = () => join(harnessDir(agentDir), "pi-builds");
	/** The build directory the global Pi runs. */
	const globalPi = () => realpathSync(piLink(harnessDir(agentDir)));
	const newPi = (content: string, message = "new pi") => {
		writeFileSync(join(source, "vendor", "pi", "core.txt"), content);
		return commit(message);
	};

	test("the first deploy builds the commit's vendor/pi and points the global Pi at it; commits that keep it build nothing", async () => {
		const first = (await deployMain()).commit;
		const tree = (await piTree(source, first))!;
		assert.deepEqual(piBuilds, ["pi 1\n"]);
		assert.equal(builtPi(agentDir), tree);
		assert.equal(globalPi(), join(realpathSync(builds()), tree));
		assert.equal(readFileSync(join(globalPi(), "built.txt"), "utf8"), "built from pi 1\n", "built in place");
		assert.equal(readFileSync(join(harnessDir(agentDir), "pi-build"), "utf8"), `${tree}\n`, "recorded for releases from before builds");
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "two";\n');
		commit("harness only");
		assert.equal((await deployMain()).status, "deployed");
		assert.deepEqual(piBuilds, ["pi 1\n"], "no rebuild for a harness-only commit");
	});

	test("a commit deploys although the working tree's vendor/pi differs: the built Pi is the commit's tree", async () => {
		await deployMain();
		const second = newPi("pi 2\n");
		// Another agent's edits in vendor/pi, uncommitted and untracked.
		writeFileSync(join(source, "vendor", "pi", "core.txt"), "pi 3, uncommitted\n");
		writeFileSync(join(source, "vendor", "pi", "untracked.txt"), "x");
		const order: string[] = [];
		const result = await deployMain(
			async (root) => {
				order.push("validate");
				assert.equal(readFileSync(join(realpathSync(join(root, "node_modules")), "..", "core.txt"), "utf8"), "pi 2\n", "the check resolves Pi's packages from the commit's build");
			},
			async (build) => {
				order.push("build");
				await buildPi(build);
			},
		);
		assert.deepEqual(result, { status: "deployed", commit: second, previous: git("rev-parse", "HEAD~1") });
		assert.deepEqual(order, ["build", "validate"]);
		assert.deepEqual(piBuilds, ["pi 1\n", "pi 2\n"]);
		const tree = (await piTree(source, second))!;
		assert.equal(builtPi(agentDir), tree);
		assert.equal(readFileSync(join(globalPi(), "core.txt"), "utf8"), "pi 2\n");
		assert.equal(existsSync(join(globalPi(), "untracked.txt")), false);
		// The build directory holds exactly the commit's tree, plus the build's output and node_modules.
		const files = execFileSync("git", ["-C", source, "ls-tree", "-r", "--name-only", tree], { encoding: "utf8" }).trim().split("\n");
		assert.deepEqual(readdirSync(globalPi()).sort(), [...files, "built.txt", "node_modules"].sort());
		assert.equal(readFileSync(join(source, "vendor", "pi", "core.txt"), "utf8"), "pi 3, uncommitted\n", "the working tree is untouched");
	});

	test("a failed build keeps the old one: global Pi, release, nothing half-built left", async () => {
		const first = (await deployMain()).commit;
		const before = globalPi();
		newPi("pi 2\n");
		const result = (await deployMain(undefined, async () => {
			throw new Error("building Pi (vendor/pi) failed:\ntsc: error");
		})) as Extract<DeployResult, { status: "failed" }>;
		assert.equal(result.status, "failed");
		assert.match(result.error, /tsc: error/);
		assert.equal(currentRelease(agentDir)!.commit, first);
		assert.equal(builtPi(agentDir), await piTree(source, first));
		assert.equal(globalPi(), before);
		assert.deepEqual(readdirSync(builds()), [await piTree(source, first)], "no build directory for the failed tree");
	});

	test("a commit whose import check fails keeps the global Pi; its build stays for the fix", async () => {
		const first = (await deployMain()).commit;
		newPi("pi 2\n");
		writeFileSync(join(source, "lib", "value.ts"), "export const value = ;\n");
		const broken = commit("broken on new pi");
		assert.equal((await deployMain()).status, "failed");
		assert.equal(builtPi(agentDir), await piTree(source, first), "the global Pi stays with the running release");
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "fixed";\n');
		const fixed = commit("fix");
		assert.equal((await deployMain()).status, "deployed");
		assert.deepEqual(piBuilds, ["pi 1\n", "pi 2\n"], "the fix reuses the build");
		assert.equal(builtPi(agentDir), await piTree(source, fixed));
		assert.equal(await piTree(source, broken), await piTree(source, fixed));
	});

	test("a deployed release whose Pi is not the global Pi deploys again: the Pi is built and switched", async () => {
		const first = (await deployMain()).commit;
		rmSync(piLink(harnessDir(agentDir)));
		rmSync(builds(), { recursive: true });
		assert.deepEqual(await deployMain(), { status: "deployed", commit: first, previous: first });
		assert.equal(builtPi(agentDir), await piTree(source, first));
		assert.deepEqual(await deployMain(), { status: "current", commit: first });
	});

	test("pruning keeps the builds kept releases use and those live processes run", async () => {
		const validate = async () => {};
		const trees: string[] = [];
		for (let i = 1; i <= 9; i++) {
			if (i > 1) newPi(`pi ${i}\n`, `pi ${i}`);
			const { commit: deployed } = await deployMain(validate);
			trees.push((await piTree(source, deployed))!);
			// A process started on pi 1 runs it still; one started on pi 2 exited; one runs pi 3 under a release pruned meanwhile.
			if (i === 1) holdRelease(agentDir, [deployed], trees[0], process.ppid);
			if (i === 2) holdRelease(agentDir, [deployed], trees[1], deadPid());
			if (i === 3) holdRelease(agentDir, ["f".repeat(40)], trees[2], process.pid);
		}
		const kept = new Set(readdirSync(builds()));
		// Releases kept: current (9), the five newest others (4-8) and the held one (1).
		for (const i of [1, 3, 4, 5, 6, 7, 8, 9]) assert.ok(kept.has(trees[i - 1]!), `pi ${i} kept`);
		assert.ok(!kept.has(trees[1]!), "pi 2: its release was pruned and its process exited");
		assert.equal(kept.size, 8);
		assert.equal(builtPi(agentDir), trees[8]);
	});

	test("a build left by a dead process is removed; a live process's build in progress stays", async () => {
		mkdirSync(builds(), { recursive: true });
		const orphan = join(builds(), `.${"a".repeat(40)}.${deadPid()}`);
		const running = join(builds(), `.${"b".repeat(40)}.${process.ppid}`);
		mkdirSync(orphan);
		mkdirSync(running);
		assert.equal((await deployMain()).status, "deployed");
		assert.equal(existsSync(orphan), false);
		assert.equal(existsSync(running), true);
	});

	test("node_modules: workspace packages link into the build, other dependencies to the source's", async () => {
		writeFileSync(join(source, ".gitignore"), "node_modules\n");
		mkdirSync(join(source, "vendor", "pi", "packages", "ws"), { recursive: true });
		writeFileSync(join(source, "vendor", "pi", "packages", "ws", "package.json"), '{ "name": "@pi/ws" }\n');
		commit("workspace");
		const modules = join(source, "vendor", "pi", "node_modules");
		mkdirSync(join(modules, "@pi"), { recursive: true });
		mkdirSync(join(modules, "dep"));
		mkdirSync(join(modules, ".bin"));
		symlinkSync("../../packages/ws", join(modules, "@pi", "ws"));
		symlinkSync(join(modules, "dep"), join(modules, "@pi", "linked-dep"));
		mkdirSync(join(source, "vendor", "pi", "packages", "ws", "node_modules"));
		const build = join(dir, "build");
		mkdirSync(join(build, "packages", "ws"), { recursive: true });
		linkModules(join(source, "vendor", "pi"), build);
		assert.equal(readlinkSync(join(build, "node_modules", "@pi", "ws")), join("..", "..", "packages", "ws"));
		assert.equal(realpathSync(join(build, "node_modules", "@pi", "ws")), join(build, "packages", "ws"));
		assert.equal(readlinkSync(join(build, "node_modules", "dep")), join(modules, "dep"));
		assert.equal(readlinkSync(join(build, "node_modules", "@pi", "linked-dep")), join(modules, "@pi", "linked-dep"), "a link to another dependency stays the source's");
		assert.equal(readlinkSync(join(build, "node_modules", ".bin")), join(modules, ".bin"));
		assert.equal(readlinkSync(join(build, "packages", "ws", "node_modules")), join(source, "vendor", "pi", "packages", "ws", "node_modules"));
		// The deploy's build gets the same links.
		await deployMain();
		assert.equal(realpathSync(join(globalPi(), "node_modules", "@pi", "ws")), join(globalPi(), "packages", "ws"));
	});

	test("piBuildOf names the build a Pi package was loaded from; a checkout is none", async () => {
		await deployMain();
		const tree = builtPi(agentDir)!;
		mkdirSync(join(globalPi(), "packages", "coding-agent"), { recursive: true });
		assert.equal(piBuildOf(harnessDir(agentDir), join(piLink(harnessDir(agentDir)), "packages", "coding-agent")), tree);
		assert.equal(piBuildOf(harnessDir(agentDir), join(source, "vendor", "pi")), undefined);
		assert.equal(piBuildOf(join(dir, "nowhere"), source), undefined);
	});

	test("a refusal by a release from before builds left the working tree is tried again", async () => {
		await deployMain();
		const second = newPi("pi 2\n");
		mkdirSync(join(harnessDir(agentDir), "failed"), { recursive: true });
		writeFileSync(join(harnessDir(agentDir), "failed", `${second}.txt`), `vendor/pi in ${source} has changes not in ${second.slice(0, 9)}; commit them, or run scripts/install.mjs to build Pi from the working tree`);
		assert.equal((await deployMain()).status, "deployed");
	});

	test("the vendor/pi id comes from the commit alone, whatever the working tree holds", async () => {
		const first = git("rev-parse", "HEAD");
		const id = await piTree(source, first);
		assert.match(id!, /^[0-9a-f]{40}$/);
		// A working tree whose vendor/ is a symlink (as in a clone wired to another checkout) plays no part.
		rmSync(join(source, "vendor"), { recursive: true });
		mkdirSync(join(dir, "elsewhere"));
		execFileSync("ln", ["-s", join(dir, "elsewhere"), join(source, "vendor")]);
		assert.equal(await piTree(source, first), id);
		assert.equal(await piTree(source, "HEAD~0"), id);
		rmSync(join(source, "vendor"));
		git("rm", "-rq", "--cached", "vendor");
		const without = commit("no vendor");
		assert.equal(await piTree(source, without), undefined, "absent");
		// git that fails to run (a spawn failure under memory pressure, a missing repository) is no answer.
		await assert.rejects(piTree(join(dir, "no-such-repository"), first), /Command failed: git/);
	});

	test("'has no vendor/pi' recorded when git could not run is tried again; a commit really without vendor/pi is refused anew", async () => {
		await deployMain();
		const second = newPi("pi 2\n");
		mkdirSync(join(harnessDir(agentDir), "failed"), { recursive: true });
		writeFileSync(join(harnessDir(agentDir), "failed", `${second}.txt`), `${second.slice(0, 9)} has no vendor/pi`);
		assert.equal((await deployMain()).status, "deployed", "the spurious record is no refusal");
		rmSync(join(source, "vendor"), { recursive: true });
		git("rm", "-rq", "--cached", "vendor");
		const without = commit("no vendor");
		const refused = await deployMain();
		assert.deepEqual(refused, { status: "failed", commit: without, error: `${without.slice(0, 9)} has no vendor/pi`, fresh: true });
		assert.equal(currentRelease(agentDir)?.commit, second, "the running release stays");
	});
});

describe("source writes", () => {
	test("paths in a release map to the same paths in the source", () => {
		assert.equal(inSource("/agent/harness/releases/abc/prompt/experiments/x.md", "/agent/harness/releases/abc", "/repo"), "/repo/prompt/experiments/x.md");
	});

	test("commitToSource commits only the given paths and leaves other staged work alone", () => {
		writeFileSync(join(source, "staged.txt"), "someone else's work\n");
		git("add", "staged.txt");
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "stopped";\n');
		const text = commitToSource(source, [join(source, "lib", "value.ts")], "chore(experiments): stop x");
		assert.match(text, /^Committed [0-9a-f]{9} \(chore\(experiments\): stop x\)/);
		assert.equal(git("log", "-1", "--format=%s"), "chore(experiments): stop x");
		assert.deepEqual(git("show", "--name-only", "--format=", "HEAD").split("\n"), ["lib/value.ts"]);
		assert.match(git("status", "--short"), /^A {2}staged\.txt$/m, "still staged, not committed");
		assert.match(commitToSource(source, [join(source, "nope.txt")], "x"), /^Not committed/);
	});
});

describe("release extension", () => {
	type Handler = (event: unknown, ctx: unknown) => unknown;
	const marker = (commit: string): ReleaseMarker => ({ commit, source, branch: "main", subject: "s", deployedAt: "" });

	/** The extension with a fake Pi that counts reload requests; by default the process runs the global Pi's build. */
	function load(loaded: string, options: { deploy?: () => Promise<DeployResult>; pi?: string } = {}) {
		const handlers = new Map<string, Handler>();
		const notes: [string, string][] = [];
		const restarted: string[] = [];
		const reloads = { requested: 0 };
		const ctx = { ui: { notify: (text: string, level: string) => notes.push([text, level]) } };
		const pi = {
			on: (name: string, handler: Handler) => handlers.set(name, handler),
			requestReload: () => reloads.requested++,
		};
		release(pi as never, {
			agentDir,
			pollMs: 20,
			release: marker(loaded),
			pi: "pi" in options ? options.pi : builtPi(agentDir),
			deploy: options.deploy ?? boundDeploy(),
			ensureDashboard: async () => restarted.push(currentRelease(agentDir)!.commit),
		});
		const start = async (reason = "startup") => {
			await handlers.get("session_start")!({ reason }, ctx);
		};
		return { handlers, reloads, notes, restarted, ctx, start, stop: () => handlers.get("session_shutdown")?.({}, ctx) };
	}
	afterEach(() => {
		delete (globalThis as { __harnessRelease?: unknown }).__harnessRelease;
	});

	test("a session deploys a new commit and requests a reload into it, idle or running; the dashboard follows", async () => {
		const first = (await deployMain()).commit;
		const session = load(first);
		assert.equal(readFileSync(join(harnessDir(agentDir), "in-use", String(process.pid)), "utf8"), `${first}\n${builtPi(agentDir)}\n`, "loading holds the release and its Pi");
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "two";\n');
		const second = commit("second");
		await session.start();
		await until(() => session.reloads.requested > 0 && session.restarted.length > 0);
		session.stop();
		assert.equal(currentRelease(agentDir)!.commit, second);
		assert.deepEqual(session.restarted, [second]);
		assert.deepEqual([...session.handlers.keys()].sort(), ["session_shutdown", "session_start"], "no waiting for the run to settle: Pi picks the moment");
	});

	test("an up-to-date session does nothing; a failed commit is reported once", async () => {
		const first = (await deployMain()).commit;
		const session = load(first);
		await session.start();
		await new Promise((wait) => setTimeout(wait, 100));
		assert.equal(session.reloads.requested, 0);
		writeFileSync(join(source, "lib", "value.ts"), "export const value = ;\n");
		const bad = commit("broken");
		await until(() => session.notes.length > 0);
		await new Promise((wait) => setTimeout(wait, 100));
		session.stop();
		assert.equal(session.reloads.requested, 0, "stays on the release that loads");
		assert.equal(session.notes.length, 1);
		assert.match(session.notes[0]![0], new RegExp(`Harness commit ${bad.slice(0, 9)} was not deployed; this session keeps ${first.slice(0, 9)}`));
	});

	test("after a reload it says what changed", async () => {
		const first = (await deployMain()).commit;
		const old = load(first);
		await old.start();
		await new Promise((wait) => setTimeout(wait, 100));
		old.stop();
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "two";\n');
		const second = commit("harness only");
		// The old session's last poll may still be deploying it: then this one finds the lock taken.
		while ((await deployMain()).status === "busy") await new Promise((wait) => setTimeout(wait, 25));
		assert.equal(currentRelease(agentDir)!.commit, second);
		const reloaded = load(second, { deploy: async () => ({ status: "current", commit: second }) });
		await reloaded.start("reload");
		await until(() => reloaded.notes.length >= 1);
		await new Promise((wait) => setTimeout(wait, 100));
		reloaded.stop();
		assert.deepEqual(reloaded.notes.map(([text]) => text), [`Harness reloaded: ${first.slice(0, 9)} → ${second.slice(0, 9)} s`]);
		assert.equal(reloaded.reloads.requested, 0, "it runs the deployed release");
	});

	test("a process whose Pi build is unknown reloads into nothing: it says once that Pi needs a restart", async () => {
		const first = (await deployMain()).commit;
		const session = load(first, { pi: undefined });
		await session.start();
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "two";\n');
		const second = commit("harness only");
		await until(() => session.notes.length > 0);
		session.stop();
		assert.equal(session.reloads.requested, 0);
		assert.match(session.notes[0]![0], new RegExp(`Harness ${second.slice(0, 9)} needs another Pi build`));
	});

	test("a release that changed Pi itself is not loaded into a running process; it says once that Pi needs a restart", async () => {
		const first = (await deployMain()).commit;
		const session = load(first);
		await session.start();
		writeFileSync(join(source, "vendor", "pi", "core.txt"), "pi 2\n");
		const newPi = commit("new pi");
		await until(() => session.notes.length > 0);
		assert.equal(currentRelease(agentDir)!.commit, newPi);
		// Later releases need the new Pi too: still no reload, and no repeated notice. Nor does this
		// process deploy them: it runs older code than the deployed release, whose pruning may misread holds.
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "three";\n');
		const later = commit("harness on new pi");
		await new Promise((wait) => setTimeout(wait, 300));
		assert.equal(currentRelease(agentDir)!.commit, newPi, "left to a process on the deployed release");
		assert.equal((await deployMain()).status, "deployed");
		assert.equal(currentRelease(agentDir)!.commit, later);
		for (let i = 0; i < 6; i++) {
			writeFileSync(join(source, "lib", "value.ts"), `export const value = ${i};\n`);
			commit(`c${i}`);
			await deployMain();
		}
		await new Promise((wait) => setTimeout(wait, 100));
		session.stop();
		assert.equal(session.reloads.requested, 0);
		assert.ok(readdirSync(join(harnessDir(agentDir), "releases")).includes(first), "the release it cannot leave stays held");
		assert.deepEqual(session.notes, [
			[`Harness ${newPi.slice(0, 9)} needs another Pi build than this process runs (vendor/pi changed); this session keeps ${first.slice(0, 9)}. Restart Pi to run it.`, "warning"],
		]);
	});

	test("a session on an older release only follows: it reloads but deploys nothing", async () => {
		const first = (await deployMain()).commit;
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "two";\n');
		const second = commit("second");
		await deployMain();
		const session = load(first);
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "three";\n');
		commit("third");
		await session.start();
		await until(() => session.reloads.requested > 0);
		await new Promise((wait) => setTimeout(wait, 200));
		session.stop();
		assert.equal(currentRelease(agentDir)!.commit, second, "the new commit waits for a session on the deployed release");
	});

	test("a process started on the rebuilt Pi reloads into later releases on that Pi", async () => {
		await deployMain();
		writeFileSync(join(source, "vendor", "pi", "core.txt"), "pi 2\n");
		commit("new pi");
		const deployedPi = (await deployMain()).commit;
		assert.deepEqual(piBuilds, ["pi 1\n", "pi 2\n"]);
		const session = load(deployedPi);
		await session.start();
		writeFileSync(join(source, "lib", "value.ts"), 'export const value = "three";\n');
		commit("harness on new pi");
		await until(() => session.reloads.requested > 0);
		session.stop();
		assert.deepEqual(session.notes, []);
	});

	test("running from a repository checkout it does nothing", () => {
		const handlers: string[] = [];
		release({ on: (name: string) => handlers.push(name), requestReload: () => handlers.push("reload") } as never, { agentDir });
		assert.deepEqual(handlers, []);
	});
});
