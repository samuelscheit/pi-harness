import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "../app";
import { api, type IndexStatus, type Params } from "../api";
import fixtures from "./fixtures.json";
import { bucketLabel, delta, projectName, tokens, usd } from "./format";
import { compressedScale } from "./timeline";
import { foldDiff } from "./versions";

const status: IndexStatus = { app: "pi-harness-dashboard", indexing: false, claudeIndexed: false, agyIndexed: false, lastIndexed: Date.now(), indexed: 0, failed: [], error: null, generation: 1, release: null, pid: 1 };

let calls: { view: string; params: Params }[] = [];
let posts: { view: string; params: Params }[] = [];
let current: IndexStatus;
let failing: string | undefined;

function respond(view: string, params: Params): unknown {
	if (view === failing) throw new Error("database is locked");
	if (view === "status") return current;
	if (view === "overview") return fixtures.overview;
	if (view === "breakdown") return params.group === "model" ? fixtures.models : { ...fixtures.content, group: params.group };
	if (view === "context") return fixtures.context;
	if (view === "sessions") return fixtures.sessions;
	if (view === "sessions/A") return fixtures.sessionA;
	if (view === "sessions/C") return fixtures.sessionC;
	if (view === `sessions/${encodeURIComponent("X/agent1")}`) return fixtures.sessionX1;
	if (view === "waste") return fixtures.waste;
	if (view === "subagents") return fixtures.subagents;
	if (view === "versions") return fixtures.versions;
	if (view === "versions/diff") return fixtures.diff;
	if (view === "options") return fixtures.options;
	throw new Error(`unexpected view ${view}`);
}

beforeEach(() => {
	calls = [];
	posts = [];
	failing = undefined;
	current = { ...status };
	vi.spyOn(api, "get").mockImplementation(async (view: string, params: Params = {}) => {
		calls.push({ view, params });
		return respond(view, params) as never;
	});
	vi.spyOn(api, "post").mockImplementation(async (view: string, params: Params = {}) => {
		posts.push({ view, params });
		current = { ...current, indexing: true };
		return current as never;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

const open = (path: string) => {
	window.history.replaceState({}, "", path);
	return render(<App />);
};
const nav = () => screen.getByRole("navigation", { name: "Sections" });
const lastCall = (view: string) => calls.filter((c) => c.view === view).at(-1);

describe("overview", () => {
	test("ranks what drove spend in dollars and links each finding to its view", async () => {
		open("/");
		expect(await screen.findByRole("heading", { name: "Usage" })).toBeInTheDocument();
		const panel = (await screen.findByRole("heading", { name: "What drove spend" })).closest("section") as HTMLElement;
		const links = within(panel).getAllByRole("link");
		expect(links).toHaveLength(fixtures.overview.findings.length);
		expect(links[0]).toHaveTextContent(fixtures.overview.findings[0]!.title);
		expect(links[0]).toHaveTextContent(usd(fixtures.overview.findings[0]!.cost));
		const large = links.find((l) => l.textContent?.includes("Contexts past"))!;
		expect(large).toHaveAttribute("href", expect.stringContaining("/drivers?group=context"));
		expect(screen.getByRole("img", { name: /Cache read/ })).toBeInTheDocument();
		expect(screen.getByRole("img", { name: "Spend over time by billing rate" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Parent work" })).toHaveAttribute("href", "/sessions/A");
		expect(screen.getByText(`All ${fixtures.overview.kpis.sessions} sessions →`)).toBeInTheDocument();
		expect(screen.getByText(/Prompt-content analysis covers/)).toBeInTheDocument();
	});

	test("a failing view shows the error, not an empty page", async () => {
		failing = "overview";
		open("/");
		// One retry, then the error.
		expect(await screen.findByRole("alert", {}, { timeout: 4000 })).toHaveTextContent("database is locked");
	});
});

describe("filters", () => {
	test("live in the URL, go with every view and survive navigation", async () => {
		const user = userEvent.setup();
		open("/");
		await screen.findByRole("heading", { name: "What drove spend" });
		expect(lastCall("overview")!.params.source).toBe("pi");
		const week = Number(lastCall("overview")!.params.end) - Number(lastCall("overview")!.params.start);
		expect(week).toBe(7 * 24 * 3_600_000);

		await user.click(screen.getByRole("button", { name: "30 days" }));
		await user.selectOptions(await screen.findByLabelText("Project"), "/p1");
		expect(window.location.search).toContain("range=30d");
		expect(window.location.search).toContain("project=%2Fp1");
		await waitFor(() => {
			const call = lastCall("overview")!;
			expect(call.params.project).toBe("/p1");
			expect(Number(call.params.end) - Number(call.params.start)).toBe(30 * 24 * 3_600_000);
		});

		await user.click(within(nav()).getByRole("link", { name: "Waste" }));
		expect(window.location.pathname).toBe("/waste");
		expect(window.location.search).toContain("project=%2Fp1");
		await waitFor(() => expect(lastCall("waste")?.params.project).toBe("/p1"));

		await user.click(screen.getByRole("button", { name: "Clear filters" }));
		expect(window.location.search).not.toContain("project=");
		expect(window.location.search).toContain("range=30d");
	});

	test("all time sends no window; a custom range sends its own", async () => {
		const user = userEvent.setup();
		open("/?range=all");
		await screen.findByRole("heading", { name: "What drove spend" });
		expect(lastCall("overview")!.params.start).toBeUndefined();
		await user.click(screen.getByRole("button", { name: "Custom" }));
		expect(window.location.search).toContain("range=custom");
		expect(screen.getByLabelText("From")).toBeInTheDocument();
		await waitFor(() => expect(lastCall("overview")!.params.start).toEqual(expect.any(Number)));
	});

	test("choosing Claude Code imports its transcripts once and shows the import running", async () => {
		const user = userEvent.setup();
		open("/");
		await screen.findByRole("heading", { name: "What drove spend" });
		await user.click(screen.getByRole("button", { name: "Claude Code" }));
		await waitFor(() => expect(posts).toEqual([{ view: "refresh", params: { source: "claude-code" } }]));
		expect(await screen.findByRole("status")).toHaveTextContent("Importing Claude Code sessions");
		expect(lastCall("overview")!.params.source).toBe("claude-code");
		await user.click(screen.getByRole("button", { name: "All" }));
		expect(posts).toHaveLength(1);
	});

	test("a finished index refetches the views", async () => {
		const user = userEvent.setup();
		open("/");
		await screen.findByRole("heading", { name: "What drove spend" });
		const before = calls.filter((c) => c.view === "overview").length;
		await user.click(screen.getByRole("button", { name: /Refresh/ }));
		expect(posts.at(-1)).toEqual({ view: "refresh", params: { source: "pi" } });
		current = { ...current, indexing: false, generation: current.generation + 1 };
		await waitFor(() => expect(calls.filter((c) => c.view === "overview").length).toBeGreaterThan(before), { timeout: 4000 });
	});
});

describe("cost drivers", () => {
	test("switch grouping in the URL and narrow the dashboard to a model by clicking its row", async () => {
		const user = userEvent.setup();
		open("/drivers");
		expect(await screen.findByRole("heading", { name: "Spend by prompt content" })).toBeInTheDocument();
		const details = (await screen.findByRole("heading", { name: "Details" })).closest("section") as HTMLElement;
		expect(within(details).getByText("tool result: bash")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Model" }));
		expect(window.location.search).toContain("group=model");
		await waitFor(() => expect(lastCall("breakdown")!.params.group).toBe("model"));
		await screen.findByRole("heading", { name: "Spend by model" });
		await user.click(screen.getAllByText("claude-sonnet")[0]!);
		expect(window.location.search).toContain("model=claude-sonnet");
	});
});

describe("sessions", () => {
	test("a session shows its timeline, subagents and largest results, and links to them", async () => {
		open("/sessions/A?range=all");
		expect(await screen.findByRole("heading", { name: "Parent work" })).toBeInTheDocument();
		expect(screen.getByRole("img", { name: /Prompt size and cost per request/ })).toBeInTheDocument();
		expect(screen.getByText("Compaction: threshold")).toBeInTheDocument();
		expect(screen.getByText("Pause: cache rebuilt on resume")).toBeInTheDocument();
		const tree = screen.getByRole("heading", { name: "Subagents" }).closest("section") as HTMLElement;
		expect(within(tree).getByRole("link", { name: "Scout" })).toHaveAttribute("href", "/sessions/C?range=all");
		const results = screen.getByRole("heading", { name: "Largest tool results in this session" }).closest("section") as HTMLElement;
		expect(within(results).getByText("p1/a.ts")).toBeInTheDocument();
		expect(within(results).getByText("never")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /Cost drivers of this session/ })).toHaveAttribute("href", "/drivers?range=all&session=A");
	});

	test("a subagent links back to its parent; ids with a slash are encoded once", async () => {
		open(`/sessions/${encodeURIComponent("X/agent1")}`);
		expect(await screen.findByText("Subagent of")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Claude Code task." })).toHaveAttribute("href", "/sessions/X");
		expect(calls.some((c) => c.view === `sessions/${encodeURIComponent("X/agent1")}`)).toBe(true);
	});

	test("the list pages and sorts in the URL", async () => {
		const user = userEvent.setup();
		open("/sessions");
		await screen.findByRole("heading", { name: "Sessions", level: 2 });
		await user.click(screen.getByRole("button", { name: "Recent" }));
		expect(window.location.search).toContain("sort=recent");
		await waitFor(() => expect(lastCall("sessions")!.params.sort).toBe("recent"));
	});
});

describe("waste, subagents and versions", () => {
	test("waste explains each rebuild cause and lists cold resumes and compaction opportunities", async () => {
		open("/waste");
		const advice = (await screen.findByRole("heading", { name: "What to change" })).closest("section") as HTMLElement;
		expect(within(advice).getByText(/Switching models starts a new cache/)).toBeInTheDocument();
		expect(screen.getByText(`blocks in ${fixtures.waste.thinkingDropped.requests} requests, reasoning the model lost`)).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Best single compaction per session" })).toBeInTheDocument();
		const cold = screen.getByRole("heading", { name: "Cold resumes" }).closest("section") as HTMLElement;
		expect(within(cold).getByRole("link", { name: "Parent work" })).toBeInTheDocument();
	});

	test("subagents compare new against resuming the idle sibling", async () => {
		open("/subagents");
		expect(await screen.findByRole("img", { name: "new was cheaper or resuming would save" })).toBeInTheDocument();
		const row = fixtures.subagents.rows.find((r) => r.alternative)!;
		expect(screen.getByText(`new −${usd(-row.difference)}`)).toBeInTheDocument();
		expect(screen.getAllByText("none idle")).toHaveLength(fixtures.subagents.rows.length - 1);
	});

	test("versions of one project, with what changed as a line diff", async () => {
		const user = userEvent.setup();
		open("/versions");
		expect(await screen.findByRole("heading", { name: "What changed in v2" })).toBeInTheDocument();
		expect(await screen.findByText(/^\+ Be thorough\.$/)).toBeInTheDocument();
		expect(screen.getByText(/^− Be brief\.$/)).toBeInTheDocument();
		expect(screen.getByLabelText("Versions of project")).toHaveValue("/p1");
		expect(screen.queryByText("v9")).not.toBeInTheDocument();
		expect(lastCall("versions/diff")!.params).toEqual({ from: "v1", to: "v2" });
		await user.selectOptions(screen.getByLabelText("Versions of project"), "/p2");
		expect(window.location.search).toContain("project=%2Fp2");
	});
});

describe("helpers", () => {
	test("diffs fold long unchanged runs, keeping two lines around each change", () => {
		const same = (n: number) => Array.from({ length: n }, (_, i) => ({ op: "same" as const, text: `s${i}` }));
		const folded = foldDiff([...same(10), { op: "add", text: "new" }, ...same(10)]);
		expect(folded.map((l) => l.op)).toEqual(["fold", "same", "same", "add", "same", "same", "fold"]);
		expect(folded[0]).toEqual({ op: "fold", count: 8 });
		expect(foldDiff(same(3))).toEqual([{ op: "fold", count: 3 }]);
		expect(foldDiff([])).toEqual([]);
	});

	test("the timeline scale caps gaps between events and maps back to clock time", () => {
		const scale = compressedScale([0, 60_000, 3_600_000, 3_660_000]);
		expect(scale.span).toBe(60_000 + 6 * 60_000 + 60_000);
		expect(scale.at(60_000)).toBe(60_000);
		expect(scale.at(3_600_000)).toBe(7 * 60_000);
		expect(scale.at(-5)).toBe(0);
		expect(scale.at(10 ** 9)).toBe(scale.span);
		expect(scale.from(7 * 60_000)).toBe(3_600_000);
		expect(compressedScale([]).span).toBe(1);
	});

	test("formats money, tokens, changes, projects and buckets", () => {
		expect([usd(0), usd(0.0042), usd(0.5), usd(12.345), usd(250), usd(1234), usd(-2)]).toEqual(["$0", "$0.0042", "$0.500", "$12.35", "$250", "$1.23k", "−$2.00"]);
		expect([tokens(950), tokens(1500), tokens(25_000), tokens(2_500_000)]).toEqual(["950", "1.5k", "25k", "2.5M"]);
		expect([delta(110, 100), delta(90, 100), delta(100, 100), delta(5, 0), delta(5, null)]).toEqual(["+10%", "−10%", "±0%", null, null]);
		expect([projectName("/Users/me/dev/app"), projectName("/tmp"), projectName("/"), projectName("")]).toEqual(["dev/app", "/tmp", "/", "—"]);
		expect(bucketLabel("2026-11-12", "day")).toBe("12 Nov");
		expect(bucketLabel("2026-11-12T14:00:00", "hour")).toBe("14:00");
	});
});
