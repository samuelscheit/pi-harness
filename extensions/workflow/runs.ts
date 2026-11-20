// Workflow runs as the session, the thread and the dashboard see them.
//
// - The session records each run's start and end (`workflow-run` entries). A run that started and
//   never ended there, whose journal has no end and whose lock no process holds, died with its
//   process: when the session starts again, the agent gets a message naming it and how to resume it
//   (`offerInterrupted`). Resuming needs the session's tools (t3's for agents), which only a tool
//   call has, so the agent resumes it with `workflow { resume }`.
// - The thread shows the run's page (render.ts) through t3's html_render, called by the harness as
//   a nested call of the workflow's own tool call: at the start, in the run that called it, and at
//   the end in the run its result message wakes (at its first finished assistant message), since t3
//   takes a page only while a run of the thread is active ("parent_not_active" otherwise, tested
//   2026-11-14; at the woken run's turn_start t3 had not adopted it yet, so a refused page waits for
//   the next message, up to END_RENDER_ATTEMPTS times). When the
//   call's context went stale (its session was replaced or disposed; a reload keeps it), the result
//   asks the agent to show the page.
// - The dashboard serves the same page live at /workflows/<id> (dashboard/server/workflows.ts); in
//   t3 it opens in the preview panel at the start.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { journalPath, readJournal, runDir, runState } from "./journal.ts";
import { pageHeight, renderWorkflow, viewOf } from "./render.ts";
import type { ToolOutcome } from "./run.ts";
import { lockHeld } from "./stop.ts";

export const RUN_ENTRY = "workflow-run";
export const RESUME_MESSAGE = "workflow-interrupted";
export const DEFAULT_DASHBOARD = "http://127.0.0.1:4317";
export const HTML_RENDER = "mcp__t3-code__html_render";
export const PREVIEW_OPEN = "mcp__t3-code__preview_open";
export const PAGE_FILE = "page.html";
const RENDER_TIMEOUT_MS = 60_000;
/** How often an end page refused for lack of an active run is tried again, at later messages. */
const END_RENDER_ATTEMPTS = 3;

export type Executor = (name: string, args: unknown, signal: AbortSignal) => Promise<ToolOutcome>;

export interface RunEntryData {
	id: string;
	state: "started" | "ended" | "offered";
	status?: string;
}

// Process state: it outlives the extension instance (a harness reload) a run started in.
const state = globalThis as { __harnessWorkflowApis?: Map<string, ExtensionAPI>; __harnessWorkflowRenders?: Map<string, EndRender[]> };

/** An end page waiting for an active run: its render resolves to the problem, if any. */
interface EndRender {
	render: () => Promise<string | undefined>;
	attempts: number;
}
const apis = () => (state.__harnessWorkflowApis ??= new Map());
const endRenders = (): Map<string, EndRender[]> => (state.__harnessWorkflowRenders ??= new Map());

/** The extension API loaded last for a session: the one a run that outlived a reload reports through. */
export function setLatestApi(sessionId: string, pi: ExtensionAPI): void {
	apis().set(sessionId, pi);
}

/** The extension API loaded last for a session, if any. */
export const latestApi = (sessionId: string): ExtensionAPI | undefined => apis().get(sessionId);

/** Record a run's start or end in its session. Never throws: it may run after the session ended. */
export function recordRun(pi: ExtensionAPI, sessionId: string, data: RunEntryData): void {
	for (const api of new Set([apis().get(sessionId), pi])) {
		if (!api) continue;
		try {
			api.appendEntry(RUN_ENTRY, data);
			return;
		} catch {
			// Stale: try the other one.
		}
	}
}

export const liveUrl = (dashboardUrl: string, id: string) => `${dashboardUrl}/workflows/${id}`;
export const runHeadline = (id: string, attempt: number, dashboardUrl: string) => `Workflow run ${id}${attempt > 1 ? ` (resume ${attempt - 1})` : ""} · live view ${liveUrl(dashboardUrl, id)}`;

/** Whether a tool context can still call tools (replacing or disposing its session makes it stale; a reload does not). */
export function contextLive(ctx: ExtensionToolContext): boolean {
	try {
		void ctx.tools;
		return true;
	} catch {
		return false;
	}
}

/** Write the run's page next to its journal; returns its path and frame height. */
function writePage(agentDir: string, id: string): { path: string; height: number; status: string } {
	const entries = readJournal(journalPath(agentDir, id));
	const path = join(runDir(agentDir, id), PAGE_FILE);
	writeFileSync(path, renderWorkflow(entries));
	return { path, height: pageHeight(entries), status: viewOf(entries).status };
}

/** Show the run's page in the thread through html_render; resolves to the problem, if any. */
async function renderPage(agentDir: string, id: string, execute: Executor, title: string): Promise<string | undefined> {
	try {
		const entries = readJournal(journalPath(agentDir, id));
		const outcome = await execute(HTML_RENDER, { title, html: renderWorkflow(entries), height: pageHeight(entries) }, AbortSignal.timeout(RENDER_TIMEOUT_MS));
		return outcome.isError ? outcome.text || "html_render failed" : undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** The run's saved workflow; undefined for an inline script. */
export const runName = (agentDir: string, id: string): string | undefined => {
	const header = readJournal(journalPath(agentDir, id))[0];
	return header?.t === "run" ? header.entry.name : undefined;
};

const titleOf = (agentDir: string, id: string, when: string) => `${runName(agentDir, id) ?? "workflow"} ${id} · ${when}`;

export interface ViewTarget {
	agentDir: string;
	id: string;
	/** The tools the session can call: t3's views need t3's tools. */
	toolNames: readonly string[];
	execute: Executor;
	dashboardUrl: string;
}

/** At a run's start: its page in the thread and its live view in the preview panel (t3 only). Does not wait. */
export function startViews({ agentDir, id, toolNames, execute, dashboardUrl }: ViewTarget): void {
	if (toolNames.includes(HTML_RENDER)) void renderPage(agentDir, id, execute, titleOf(agentDir, id, "started"));
	if (toolNames.includes(PREVIEW_OPEN)) void execute(PREVIEW_OPEN, { url: liveUrl(dashboardUrl, id) }, AbortSignal.timeout(RENDER_TIMEOUT_MS)).catch(() => undefined);
}

/**
 * At a run's end: the page goes to the thread in the run the result wakes (flushEndRenders), or,
 * when the call's context is stale, the result asks the agent to show it. Returns the result text.
 */
export function renderEnd(target: Omit<ViewTarget, "dashboardUrl"> & { sessionId: string; live: () => boolean; text: string }): string {
	const { agentDir, id, toolNames, execute, sessionId, text } = target;
	let page: { path: string; height: number };
	try {
		page = writePage(agentDir, id);
	} catch {
		return text;
	}
	if (!toolNames.includes(HTML_RENDER)) return text;
	if (target.live()) {
		const queue = endRenders().get(sessionId) ?? [];
		queue.push({ render: () => renderPage(agentDir, id, execute, titleOf(agentDir, id, "ended")), attempts: 0 });
		endRenders().set(sessionId, queue);
		return text;
	}
	return `${text}\n\nShow this run's page in the thread before you reply: call ${HTML_RENDER} with path "${page.path}", height ${page.height} and title "${titleOf(agentDir, id, "ended")}".`;
}

/** Show the end pages waiting for an active run of the session; one t3 refused for lack of an active run waits for the next message. */
export function flushEndRenders(sessionId: string): void {
	const queue = endRenders().get(sessionId);
	if (!queue?.length) return;
	endRenders().delete(sessionId);
	for (const page of queue) {
		void page.render().then((problem) => {
			if (!problem?.includes("parent_not_active") || ++page.attempts >= END_RENDER_ATTEMPTS) return;
			endRenders().set(sessionId, [...(endRenders().get(sessionId) ?? []), page]);
		});
	}
}

/** `workflow { show }`: the run's page in the thread now; returns the tool's text. */
export async function showRun({ agentDir, id, toolNames, execute, dashboardUrl }: ViewTarget): Promise<string> {
	runState(agentDir, id);
	const page = writePage(agentDir, id);
	const where = `Run ${id} is ${page.status}. Live view: ${liveUrl(dashboardUrl, id)}. Page: ${page.path}.`;
	if (!toolNames.includes(HTML_RENDER)) return where;
	const problem = await renderPage(agentDir, id, execute, titleOf(agentDir, id, page.status));
	return problem ? `${where}\nhtml_render failed: ${problem}` : `${where}\nShown in the thread.`;
}


/**
 * The runs this session started that stopped with their process: started and never recorded as
 * ended (the process died), or ended as interrupted (the session ended, so its result message
 * reached no one), and not offered since; whose journal has no end or an interrupted one, and that
 * no process runs.
 */
export function interruptedRuns(ctx: ExtensionContext, agentDir: string): string[] {
	const latest = new Map<string, RunEntryData>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === RUN_ENTRY) {
			const data = entry.data as RunEntryData | undefined;
			if (data?.id) latest.set(data.id, data);
		}
	}
	return [...latest.values()]
		.filter((data) => data.state === "started" || (data.state === "ended" && data.status === "interrupted"))
		.map((data) => data.id)
		.filter((id) => {
			try {
				const end = runState(agentDir, id).end;
				return (!end || end.status === "interrupted") && !lockHeld(agentDir, id);
			} catch {
				return false;
			}
		});
}

/** Tell the agent about runs that died with their process, once per run. */
export function offerInterrupted(pi: ExtensionAPI, ctx: ExtensionContext, agentDir: string): void {
	const ids = interruptedRuns(ctx, agentDir);
	if (!ids.length) return;
	const lines = ids.map((id) => {
		const view = viewOf(runState(agentDir, id).entries);
		const open = view.calls.filter((call) => call.status === "running" || call.status === "interrupted");
		const done = view.calls.length - open.length;
		const inFlight = open.length ? `; in flight: ${open.map((call) => `${call.kind} ${call.label}`).join(", ")}` : "";
		return `- ${id} (${view.header.entry.name ?? "inline workflow"}): ${done} call${done === 1 ? "" : "s"} done${inFlight}`;
	});
	for (const id of ids) recordRun(pi, ctx.sessionManager.getSessionId(), { id, state: "offered" });
	pi.sendMessage(
		{
			customType: RESUME_MESSAGE,
			content: [
				`${ids.length === 1 ? "A workflow run" : "Workflow runs"} of this session stopped when its Pi process ended:`,
				...lines,
				'Resume each with the workflow tool and resume: "<id>": its recorded calls are not repeated, agents in flight reattach. In-flight shell or tools calls need inFlight: "rerun" or "fail" (the resume names them). Leave a run alone if it is no longer wanted.',
			].join("\n"),
			display: true,
		},
		{ triggerTurn: true },
	);
}
