/**
 * Real pi processes sharing one agent directory: the prefix cache registry and fork bases work
 * across processes. The provider is a fixture extension that simulates Anthropic's prompt cache in
 * a directory every process shares (test/fixtures/prefix-cache-provider.ts).
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ForkBaseMeta } from "../src/core/fork-base.ts";
import type { PrefixCacheRecord } from "../src/core/prefix-cache.ts";
import type { FileEntry, SessionHeader } from "../src/core/session-manager.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const resolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const provider = resolve(__dirname, "fixtures/prefix-cache-provider.ts");
const TTL_SECONDS = 8;
const BIG = "word ".repeat(32_000);

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-prefix-processes-")));
const agentDir = join(root, "agent");
const projectDir = join(root, "project");
const simDir = join(root, "sim");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function pi(args: string[], env: Record<string, string> = {}): Promise<void> {
	return new Promise((done, fail) => {
		const child = spawn(process.execPath, ["--import", resolverUrl, cliPath, "-e", provider, ...args], {
			cwd: projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				PI_OFFLINE: "1",
				SIM_CACHE_DIR: simDir,
				SIM_TTL_SECONDS: String(TTL_SECONDS),
				...env,
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", fail);
		child.on("close", (code) => (code === 0 ? done() : fail(new Error(`pi exited ${code}: ${stderr}`))));
	});
}

const sessionFiles = (): string[] => {
	const dir = join(agentDir, "sessions");
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(dir, name));
};
const entries = (file: string): FileEntry[] =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as FileEntry);
const header = (file: string) => entries(file)[0] as SessionHeader;
const requests = () =>
	readFileSync(join(simDir, "requests.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { pid: number; model: string; maxTokens?: number; cacheRead: number });
const registry = (): PrefixCacheRecord[] =>
	readdirSync(join(agentDir, "prefix-cache")).map(
		(name) => JSON.parse(readFileSync(join(agentDir, "prefix-cache", name), "utf8")) as PrefixCacheRecord,
	);

describe("pi processes sharing the prefix cache registry", () => {
	it("a fork's read warms its source across processes; cold parallel forks share one base", async () => {
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "simcache",
				defaultModel: "main",
				cacheRetention: "short",
				cacheWarming: "off",
				compaction: { keepRecentTokens: 1_000, economic: { model: "simcache/summary", minSaving: 0 } },
			}),
		);

		await pi(["-p", `first ${BIG}`]);
		const [source] = sessionFiles();
		await pi(["--session", source!, "-p", `second ${BIG}`]);
		const sourceIds = new Set(entries(source!).map((entry) => (entry as { id: string }).id));
		const sourceRecords = registry();
		expect(sourceRecords.length).toBeGreaterThan(0);

		// A warm fork in another process keeps the full history; its first request read the
		// source's last prompt, which the registry records against the source's entry.
		await pi(["--fork", source!, "-p", "warm task"]);
		const warmFork = sessionFiles().find((file) => file !== source)!;
		expect(header(warmFork).fork).toMatchObject({ base: "full" });
		const lastSourceWrite = Math.max(...sourceRecords.map((record) => record.at));
		const refreshed = registry().filter(
			(record) => sourceIds.has(record.entryId) && record.cache === "read" && record.at > lastSourceWrite,
		);
		expect(refreshed).toHaveLength(1);
		expect(refreshed[0]!.tokens).toBeGreaterThan(20_000);

		// Past the lifetime both forks find the point cold; one compacts, the other waits for the base.
		await new Promise((done) => setTimeout(done, (TTL_SECONDS + 1) * 1000));
		const known = new Set(sessionFiles());
		const before = requests().length;
		await Promise.all([
			pi(["--fork", source!, "-p", "cold task 1"], { SIM_SUMMARY_DELAY_MS: "3000" }),
			pi(["--fork", source!, "-p", "cold task 2"], { SIM_SUMMARY_DELAY_MS: "3000" }),
		]);
		const coldForks = sessionFiles().filter((file) => !known.has(file));
		expect(coldForks).toHaveLength(2);
		const bases = coldForks.map((file) => header(file).fork?.base);
		expect(bases[0]).toMatch(/^[0-9a-f]{40}$/);
		expect(bases[1]).toBe(bases[0]);
		const added = requests().slice(before);
		const summaries = added.filter((request) => request.model === "summary");
		expect(summaries.length).toBeGreaterThan(0);
		expect(new Set(summaries.map((request) => request.pid)).size).toBe(1);
		const meta = JSON.parse(readFileSync(join(agentDir, "fork-bases", `${bases[0]}.json`), "utf8")) as ForkBaseMeta;
		expect(meta.forks).toHaveLength(2);
		expect(meta.primes).toHaveLength(1);
		// Both forks' first answers read the primed base prefix.
		const answers = added.filter((request) => request.model === "main" && request.maxTokens !== 1);
		expect(answers).toHaveLength(2);
		for (const answer of answers) expect(answer.cacheRead).toBeGreaterThanOrEqual(meta.primes[0]!.tokens);
	}, 120_000);
});
