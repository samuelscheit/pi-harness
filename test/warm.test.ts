// Cache warming holds (extensions/warm): parsing and texts, then real Pi sessions on a faux model
// whose prompt cache lives 11 seconds (a refresh every second), with the `cacheWarming` setting
// "off" so that every refresh comes from the hold. Refreshes keep coming while a hold runs and stop
// at its end, with off, and when its budget is used up; a reload and a new process keep it; the
// default hold ends with the next request, an explicit one does not; the tool and the command;
// without a hold nothing changes.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, getApiProvider, registerApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	type CacheWarmingStatus,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionUIContext,
	ModelRuntime,
	type SessionEntry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_HOLD_MS,
	estimateText,
	formatClock,
	type Hold,
	HOLD_ENTRY,
	holdState,
	newHold,
	parseCommand,
	parseDuration,
	parseUntil,
	refreshesLeft,
	statusLine,
} from "../extensions/warm/hold.ts";
import warm, { STATUS_KEY } from "../extensions/warm/index.ts";
import { priced } from "./priced.ts";

const H = 3_600_000;
const M = 60_000;

describe("hold parsing", () => {
	test("durations: hours, minutes, seconds, combined, decimals; anything else is refused", () => {
		assert.deepEqual(["3h", "90m", "2h30m", "2h 30m", "1.5h", "45s", "1h1m1s", "10min", "2 hours"].map(parseDuration), [3 * H, 90 * M, 2.5 * H, 2.5 * H, 1.5 * H, 45_000, H + M + 1000, 10 * M, 2 * H]);
		for (const bad of ["", "3", "h", "3x", "-1h", "0m", "3h foo", "until 18:00"]) assert.equal(parseDuration(bad), undefined, bad);
	});

	test("until: a time of day today, or tomorrow when already past; ISO in the future", () => {
		const now = new Date(2026, 10, 14, 15, 30).getTime();
		assert.equal(parseUntil("18:00", now), new Date(2026, 10, 14, 18, 0).getTime());
		assert.equal(parseUntil("9:05", now), new Date(2026, 10, 15, 9, 5).getTime(), "past today: tomorrow");
		assert.equal(parseUntil("15:30", now), new Date(2026, 10, 15, 15, 30).getTime(), "now is past");
		assert.equal(parseUntil("2026-11-14T20:00:00Z", now), Date.parse("2026-11-14T20:00:00Z"));
		assert.match((parseUntil("24:00", now) as { error: string }).error, /not a time of day/);
		assert.match((parseUntil("2020-01-01T00:00:00Z", now) as { error: string }).error, /in the past/);
		assert.match((parseUntil("soon", now) as { error: string }).error, /neither HH:MM nor an ISO/);
	});

	test("the command: show, off, on, durations, until, --max, errors", () => {
		const now = new Date(2026, 10, 14, 15, 30).getTime();
		assert.deepEqual(parseCommand("", now), { action: "show" });
		assert.deepEqual(parseCommand("  off ", now), { action: "off" });
		assert.deepEqual(parseCommand("on", now), { action: "set" });
		assert.deepEqual(parseCommand("--max $2", now), { action: "set", maxUsd: 2 });
		assert.deepEqual(parseCommand("2h 30m --max 0.5", now), { action: "set", forMs: 2.5 * H, maxUsd: 0.5 });
		assert.deepEqual(parseCommand("--max $1.5 until 18:00", now), { action: "set", maxUsd: 1.5, until: new Date(2026, 10, 14, 18).getTime() });
		assert.match((parseCommand("--max lots 3h", now) as { error: string }).error, /--max needs an amount/);
		assert.match((parseCommand("until", now) as { error: string }).error, /Usage: \/warm until/);
		assert.match((parseCommand("forever", now) as { error: string }).error, /not a duration/);
	});

	test("a new hold: the default lasts until the next request, at most 4 hours; at most 24 hours; not both a duration and an end", () => {
		assert.deepEqual(newHold({}, 1000, "user", "a"), { id: "a", startedAt: 1000, until: 1000 + DEFAULT_HOLD_MS, untilNextRequest: true, setBy: "user" });
		assert.deepEqual(newHold({ forMs: H, maxUsd: 2 }, 0, "agent", "b"), { id: "b", startedAt: 0, until: H, maxUsd: 2, setBy: "agent" });
		assert.match((newHold({ forMs: 25 * H }, 0, "user", "c") as { error: string }).error, /at most 24 hours/);
		assert.match((newHold({ forMs: H, until: 2 * H }, 0, "user", "c") as { error: string }).error, /not both/);
	});
});

describe("hold state and texts", () => {
	let n = 0;
	const holdEntry = (hold: Hold | null): SessionEntry => ({ type: "custom", customType: HOLD_ENTRY, data: { hold }, id: `e${++n}`, parentId: null, timestamp: "" }) as SessionEntry;
	const warmEntry = (usd: number, at = 0): SessionEntry => ({ type: "usage", kind: "cache_warm", id: `e${++n}`, parentId: null, timestamp: new Date(at).toISOString(), provider: "p", model: "m", usage: { cost: { total: usd } } }) as unknown as SessionEntry;
	const HOLD: Hold = { id: "h1", startedAt: 0, until: H, setBy: "user" };

	test("spend counts the cache_warm entries after the hold started, per hold, until its end", () => {
		assert.deepEqual(holdState([warmEntry(1)]), { hold: undefined, spent: 0, lastWarmCost: 1 });
		assert.deepEqual(holdState([warmEntry(1), holdEntry(HOLD), warmEntry(0.25), warmEntry(0.5), warmEntry(9, 2 * H)]), { hold: HOLD, spent: 0.75, lastWarmCost: 9 });
		assert.deepEqual(holdState([holdEntry(HOLD), warmEntry(0.25), holdEntry({ ...HOLD, id: "h2" }), warmEntry(0.5)]).spent, 0.5, "a new hold starts at zero");
		assert.equal(holdState([holdEntry(HOLD), holdEntry(null)]).hold, undefined);
	});

	const status = (over: Partial<CacheWarmingStatus> = {}): CacheWarmingStatus => ({
		state: "scheduled",
		nextWarmAt: 54 * M,
		decision: { phase: "idle", warmCost: 0.05, missCost: 1, continuationProbability: 1, expectedSavings: 0.95, economicsAvailable: true, held: true, action: "warm" },
		cache: { ttlMs: H, delayMs: 54 * M, retention: "long" },
		...over,
	});

	test("the estimate: per refresh and until the end, the budget, the five-minute cache hint", () => {
		const hold: Hold = { ...HOLD, until: 3 * H, maxUsd: 0.1 };
		assert.equal(refreshesLeft(hold, status(), 0), 3, "at 54, 108 and 162 minutes");
		assert.equal(estimateText(hold, status(), undefined, 0), "A refresh every 54 min at about $0.050: about 3 until it ends, $0.150 in total (budget $0.100, about 2 refreshes).");
		const short = status({ nextWarmAt: 270_000, cache: { ttlMs: 5 * M, delayMs: 270_000, retention: "short" } });
		const hinted = estimateText({ ...HOLD, until: H }, short, { promptCache: { short: 300, long: 3600 } }, 0);
		assert.match(hinted, /^A refresh every 4\.5 min at about \$0\.050: about 13 until it ends, \$0\.650 in total\./);
		assert.match(hinted, /set "cacheRetention": "long" in ~\/\.pi\/agent\/settings\.json \(or in this project's \.pi\/settings\.json, which takes precedence\) and run \/reload; the next real request then writes the one-hour cache/);
		assert.match(hinted, /PI_CACHE_RETENTION=long in Pi's environment does the same when no settings file sets cacheRetention/);
		assert.match(estimateText(HOLD, short, { promptCache: { short: 300 } }, 0), /the model has no one-hour cache tier/);
		assert.match(estimateText(HOLD, { state: "inactive", reason: "waiting for first request" }, undefined, 0), /^Its cost is known after the next request/);
		assert.match(estimateText(HOLD, status({ state: "inactive", reason: "cache warming disabled", nextWarmAt: undefined }), undefined, 0), /Warming is not running now \(cache warming disabled\); it starts with the next request\./);
	});

	test("the status line: end, next refresh, spend", () => {
		const now = new Date(2026, 10, 14, 12, 0).getTime();
		const hold: Hold = { ...HOLD, startedAt: now, until: now + 3 * H, maxUsd: 2 };
		assert.equal(statusLine(hold, 0.123, status({ nextWarmAt: now + 54 * M }), now), "warm until 15:00 · next refresh 12:54 · $0.123 spent of $2.00");
		assert.equal(statusLine({ ...hold, untilNextRequest: true, maxUsd: undefined }, 0, { state: "inactive", reason: "waiting for first request" }, now), "warm until the next request (at most 15:00) · waiting for a request (waiting for first request) · $0.000 spent");
		assert.match(formatClock(now + 20 * H, now), /^[A-Z][a-z]{2} 08:00$/, "another day shows its weekday");
	});
});

// Real sessions.

const PER_REFRESH = 0.01;
let faux: ReturnType<typeof registerFauxProvider>;
let runtime: ModelRuntime;
let dir: string;
const open: AgentSession[] = [];
const extensionErrors: string[] = [];
/** Replies of real requests, in order; refreshes (one output token) get a short reply. */
let script: string[] = [];

before(async () => {
	faux = registerFauxProvider({ models: [{ id: "warm-1" }] });
	runtime = await ModelRuntime.create({ authPath: join(mkdtempSync(join(tmpdir(), "warm-runtime-")), "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: [{ id: "warm-1", name: "Warm", api: faux.api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8000, promptCache: { short: 11 } }],
	});
});
after(() => faux.unregister());
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warm-"));
	mkdirSync(join(dir, "repo"));
	script = [];
	faux.setResponses(Array.from({ length: 500 }, () => (_context: unknown, options: { maxTokens?: number } | undefined) => {
		if (options?.maxTokens === 1) return fauxAssistantMessage("w");
		const next = script.shift();
		if (next === undefined) return fauxAssistantMessage("ok");
		return next.startsWith("{") ? fauxAssistantMessage([fauxToolCall("keep_warm", JSON.parse(next))], { stopReason: "toolUse" }) : fauxAssistantMessage(next);
	}));
});
afterEach(() => {
	assert.deepEqual(extensionErrors.splice(0), [], "no extension errors");
	for (const session of open.splice(0)) session.dispose();
	rmSync(dir, { recursive: true, force: true });
});

function recordingUi() {
	const ui = { statuses: new Map<string, string | undefined>(), notices: [] as string[] };
	const methods = { setStatus: (key: string, text: string | undefined) => ui.statuses.set(key, text), notify: (text: string) => ui.notices.push(text) };
	const context = new Proxy(methods, { get: (target, name) => (name in target ? target[name as keyof typeof target] : () => undefined) }) as unknown as ExtensionUIContext;
	return { ui, context };
}

/** A session with the warm extension; `cacheWarming` "off", so only a hold warms. Each refresh costs PER_REFRESH. */
async function newSession(sessionManager = SessionManager.create(join(dir, "repo"), join(dir, "sessions")), cacheWarming: "off" | "idle" = "off") {
	const cwd = join(dir, "repo");
	// The model has only a short cache tier; PI_CACHE_RETENTION=long in the environment must not apply.
	const settingsManager = SettingsManager.inMemory({ cacheWarming, cacheRetention: "short" });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, extensionFactories: [warm] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir: dir, model: runtime.getModel("faux", "warm-1"), modelRuntime: priced(runtime, PER_REFRESH), resourceLoader, sessionManager, settingsManager });
	const { ui, context } = recordingUi();
	await session.bindExtensions({ uiContext: context, onError: (error) => extensionErrors.push(`${error.event}: ${error.error}`) });
	open.push(session);
	return { s: session, ui };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const warms = (s: AgentSession) => s.sessionManager.getEntries().filter((e) => e.type === "usage" && e.kind === "cache_warm").length;
const holdEnds = (s: AgentSession) => s.sessionManager.getEntries().flatMap((e) => (e.type === "custom" && e.customType === HOLD_ENTRY && (e.data as { hold: Hold | null }).hold === null ? [(e.data as { reason: string }).reason] : []));
const toolTexts = (s: AgentSession) => s.messages.flatMap((m) => (m.role === "toolResult" ? [`${m.isError ? "error: " : ""}${m.content.map((c) => (c.type === "text" ? c.text : "")).join("")}`] : []));
async function reload(s: AgentSession) {
	const provider = getApiProvider(faux.api);
	await s.reload();
	if (!getApiProvider(faux.api)) registerApiProvider(provider as never);
}

describe("a hold in a real session", () => {
	test("without a hold nothing changes: no refreshes with the setting off, and none on unknown economics with it on", async () => {
		for (const mode of ["off", "idle"] as const) {
			const { s, ui } = await newSession(undefined, mode);
			await s.prompt("hi");
			await sleep(2_200);
			assert.equal(warms(s), 0, mode);
			assert.equal(ui.statuses.get(STATUS_KEY), undefined);
			assert.equal(s.cacheWarmingStatus?.holdUntil, undefined);
		}
	});

	test("/warm 3s: refreshes every second until its end, then stop; the notice tells the cost; the status line follows", async () => {
		const { s, ui } = await newSession();
		await s.prompt("hi");
		await s.prompt("/warm 3s");
		assert.match(ui.notices.at(-1)!, /^Prompt cache held warm until \d\d:\d\d\.\nA refresh every 1 s, about 3 until it ends; the price of a refresh is unknown for this model\.\nThis cache lives 11 s and the model has no one-hour cache tier, so a long hold refreshes it every 1 s\.$/);
		assert.match(ui.statuses.get(STATUS_KEY)!, /^warm until \d\d:\d\d · next refresh \d\d:\d\d · \$0\.000 spent$/);
		await sleep(1_500);
		assert.match(ui.statuses.get(STATUS_KEY)!, /· \$0\.010 spent$/, "the status line counts the refresh");
		await sleep(2_500);
		const done = warms(s);
		assert.ok(done >= 2 && done <= 3, `refreshes: ${done}`);
		assert.match(ui.notices.at(-1)!, /^The cache warming hold ended at \d\d:\d\d: \$0\.0[23]0 spent on refreshes\.$/);
		assert.equal(ui.statuses.get(STATUS_KEY), undefined);
		await sleep(1_500);
		assert.equal(warms(s), done, "no refresh after the end");
		assert.equal(s.cacheWarmingStatus?.state, "inactive");
	});

	test("/warm off ends it at once; /warm shows the state; bad input is refused", async () => {
		const { s, ui } = await newSession();
		await s.prompt("/warm");
		assert.match(ui.notices.pop()!, /^No cache warming hold: Pi's normal rules apply \(inactive: cache warming disabled\)\./);
		await s.prompt("/warm forever");
		assert.match(ui.notices.pop()!, /not a duration/);
		await s.prompt("/warm 30h");
		assert.match(ui.notices.pop()!, /at most 24 hours/);
		await s.prompt("/warm off");
		assert.equal(ui.notices.pop(), "No cache warming hold is running.");

		await s.prompt("hi");
		await s.prompt("/warm 1h");
		await sleep(1_500);
		await s.prompt("/warm");
		assert.match(ui.notices.pop()!, /^Cache held warm until \d\d:\d\d, set by the user: next refresh \d\d:\d\d, \$0\.010 spent\.\nA refresh every 1 s/);
		await s.prompt("/warm off");
		assert.equal(ui.notices.pop(), "Cache warming hold ended: $0.010 spent on refreshes. Pi's normal warming rules apply again.");
		assert.deepEqual(holdEnds(s), ["off"]);
		assert.equal(ui.statuses.get(STATUS_KEY), undefined);
		await sleep(1_500);
		assert.equal(warms(s), 1);
	});

	test("--max: the refresh that would go over the budget is not sent, and the hold ends", async () => {
		const { s, ui } = await newSession();
		await s.prompt("hi");
		await s.prompt("/warm 1h --max $0.025");
		await sleep(4_500);
		assert.equal(warms(s), 2, "$0.010 + $0.010; a third, priced like the last one, would make $0.030");
		assert.deepEqual(holdEnds(s), ["budget"]);
		assert.match(ui.notices.at(-1)!, /^The cache warming hold ended: its budget of \$0\.025 is used up \(\$0\.020 spent, the next refresh costs about \$0\.010\)\.$/);
		assert.equal(ui.statuses.get(STATUS_KEY), undefined);
		await sleep(1_200);
		assert.equal(warms(s), 2);
	});

	test("a reload keeps the hold, and so does a new process on the session file", async () => {
		const { s, ui } = await newSession();
		await s.prompt("hi");
		await s.prompt("/warm 1h");
		await sleep(1_300);
		await reload(s);
		assert.match(ui.statuses.get(STATUS_KEY)!, /^warm until/, "the reloaded extension shows it");
		const before = warms(s);
		await sleep(2_200);
		assert.ok(warms(s) >= before + 2, "refreshes go on after the reload");
		const file = s.sessionManager.getSessionFile()!;
		s.dispose();
		open.splice(open.indexOf(s), 1);

		const next = await newSession(SessionManager.open(file, join(dir, "sessions")));
		const holdUntil = next.s.cacheWarmingStatus?.holdUntil;
		assert.ok(holdUntil && holdUntil > Date.now() + 50 * M, "re-armed in the new process");
		assert.match(next.ui.statuses.get(STATUS_KEY)!, /· waiting for a request \(waiting for first request\) · \$0\.0\d0 spent$/);
		await next.s.prompt("back");
		const after = warms(next.s);
		await sleep(2_200);
		assert.ok(warms(next.s) >= after + 2, "the next request is warmed under the hold, with the setting off");
		assert.deepEqual(holdEnds(next.s), [], "a real request does not end an explicit hold");
	});

	test("the default hold (/warm on) ends with the next request; warming then follows the normal rules", async () => {
		const { s, ui } = await newSession();
		await s.prompt("hi");
		await s.prompt("/warm on");
		assert.match(ui.notices.at(-1)!, /^Prompt cache held warm until the next request, at most until (\w{3} )?\d\d:\d\d\./);
		assert.match(ui.statuses.get(STATUS_KEY)!, /^warm until the next request \(at most/);
		await sleep(1_300);
		assert.equal(warms(s), 1);
		await s.prompt("back");
		assert.deepEqual(holdEnds(s), ["next request"]);
		assert.equal(ui.statuses.get(STATUS_KEY), undefined);
		await sleep(1_500);
		assert.equal(warms(s), 1, "the setting is off");
	});

	test("the keep_warm tool: for, until, off, budget; errors go back to the agent", async () => {
		const { s, ui } = await newSession();
		script = ['{"until":"25:00"}', '{"for":"2h","until":"18:00"}', '{"for":"2h","max_usd":1}', "Holding."];
		await s.prompt("I'll be back in two hours");
		const [badUntil, both, held] = toolTexts(s);
		assert.match(badUntil!, /^error: 25:00 is not a time of day/);
		assert.match(both!, /^error: Give a duration or an end time, not both\./);
		assert.match(held!, /^Prompt cache held warm until (\w{3} )?\d\d:\d\d\.\nA refresh every 1 s, about \d+ until it ends/);
		assert.equal(ui.notices.at(-1), held, "the user sees the cost too");
		const { hold } = holdState(s.sessionManager.getBranch());
		assert.equal(hold?.setBy, "agent");
		assert.equal(hold?.maxUsd, 1);
		assert.ok(Math.abs(hold!.until - hold!.startedAt - 2 * H) < 10);
		await sleep(1_300);
		assert.ok(warms(s) >= 1);

		script = ['{"off":true}', "Done."];
		await s.prompt("never mind");
		assert.match(toolTexts(s).at(-1)!, /^Cache warming hold ended: \$0\.0\d0 spent on refreshes\./);
		assert.deepEqual(holdEnds(s), ["off"]);
		assert.ok(s.getAllTools().find((t) => t.name === "keep_warm"));
	});
});
