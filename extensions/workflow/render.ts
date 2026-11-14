// The page of a workflow run, from its journal alone: `renderWorkflow(entries)` is pure, so the
// same journal always gives byte-identical HTML (no clock, no randomness; times are the journal's,
// order is the journal's). t3 shows it in the thread (html_render) and the dashboard serves it live
// (dashboard/server/workflows.ts).
//
// Layout: calls whose times overlap form a parallel group, drawn as lanes side by side (each call
// in the first lane free at its start); groups follow each other top to bottom. A node shows the
// call's kind, a short label, its status (running, done, failed, replayed from the journal,
// interrupted, stopped, unused by edited code), duration and cost; an agent node its model and t3
// thread. The header has the total time, the cost against the budget, and open against done calls.
// A run resumed with edited code shows "new code from here" where each version took over, and its
// versions with their code.
//
// Styling follows t3's html_render rules: only its theme variables, no page background, fluid
// widths, no vh units.

import { type CallKind, codeHash, type JournalEntry, type RunHeader } from "./journal.ts";

export type CallStatus = "running" | "done" | "failed" | "replayed" | "interrupted" | "stopped" | "unused";

export interface CallView {
	key: string;
	kind: CallKind;
	label: string;
	model?: string;
	status: CallStatus;
	startAt: number;
	/** Undefined while running or interrupted. */
	endAt?: number;
	cost: number;
	/** An agent's t3 thread link (`t3-thread://…`) or thread id. */
	link?: string;
	error?: string;
	/** The code version whose live part made the call (1: the start's). */
	version: number;
}

/** One version of the run's code: the start's, then one per resume with code. */
export interface CodeVersion {
	n: number;
	hash: string;
	at: number;
	source: string;
	/** The attempt that brought it (absent for the first). */
	attempt?: number;
	/** Where it took over from the recorded calls, and how many it left unused. */
	takeover?: { at: number; label?: string; replayed: number; unused: number };
}

export interface RunView {
	header: RunHeader;
	status: string;
	attempts: number;
	calls: CallView[];
	versions: CodeVersion[];
	startAt: number;
	/** The end, or the journal's last time while it runs. */
	lastAt: number;
	cost: number;
	open: number;
	done: number;
	unused: number;
}

/** The URL of a markdown link `[title](url)` (t3 returns links so), or the text itself. */
export const linkUrl = (link: string) => /\]\(([^)\s]+)\)\s*$/.exec(link)?.[1] ?? link;

/** What the journal says about a run. Throws when the journal has no run header. */
export function viewOf(entries: readonly JournalEntry[]): RunView {
	const header = entries[0];
	if (header?.t !== "run") throw new Error("not a workflow journal: the first entry is no run header");
	// Calls by view id: the key, until edited code leaves the call unused and may make a call with the same key again.
	const calls = new Map<string, CallView>();
	const order: string[] = [];
	const versions: CodeVersion[] = [{ n: 1, hash: codeHash(header.entry.source), at: header.at, source: header.entry.source }];
	let live = 1;
	let attempts = 0;
	let end: Extract<JournalEntry, { t: "end" }> | undefined;
	/** Agent runs a stop left running: still running at the next attempt. */
	let lingering = new Set<string>();
	let lastAt = header.at;
	for (const entry of entries) {
		if ("at" in entry) lastAt = Math.max(lastAt, entry.at);
		switch (entry.t) {
			case "attempt":
				attempts = entry.n;
				end = undefined;
				// Calls still open were in flight when the last attempt's process ended.
				for (const call of calls.values()) if (call.status === "running" && !lingering.has(call.key)) call.status = "interrupted";
				// Calls the earlier attempts finished are answered from the journal from now on.
				if (entry.n > 1) for (const call of calls.values()) if (call.status === "done" || call.status === "failed") call.status = "replayed";
				break;
			case "edit":
				versions.push({ n: versions.length + 1, hash: entry.hash, at: entry.at, source: entry.source, attempt: entry.n });
				break;
			case "takeover": {
				const version = versions.at(-1)!;
				version.takeover = { at: entry.at, ...(entry.label ? { label: entry.label } : {}), replayed: entry.replayed, unused: entry.dropped.length };
				live = version.n;
				for (const key of entry.dropped) {
					const call = calls.get(key);
					if (!call) continue;
					call.status = "unused";
					const id = `${key}@${version.n}`;
					calls.delete(key);
					calls.set(id, call);
					order[order.indexOf(key)] = id;
				}
				break;
			}
			case "start": {
				const known = calls.get(entry.key);
				if (!known) order.push(entry.key);
				calls.set(entry.key, {
					key: entry.key,
					kind: entry.kind,
					label: entry.label,
					...(entry.model ? { model: entry.model } : {}),
					status: "running",
					startAt: entry.at,
					cost: 0,
					...(known?.link ? { link: known.link } : {}),
					version: known?.version ?? live,
				});
				break;
			}
			case "meta": {
				const call = calls.get(entry.key);
				const link = entry.data.link ?? entry.data.threadId;
				if (call && typeof link === "string") call.link = linkUrl(link);
				break;
			}
			case "done":
			case "failed": {
				const call = calls.get(entry.key);
				if (!call) break;
				call.status = entry.t === "done" ? "done" : "failed";
				call.endAt = entry.at;
				call.cost = entry.cost ?? 0;
				if (entry.t === "failed") call.error = `${entry.error.name}: ${entry.error.message}`;
				break;
			}
			case "end":
				end = entry;
				lingering = new Set(entry.lingering);
				for (const call of calls.values()) if (call.status === "running" && !lingering.has(call.key)) call.status = entry.status === "stopped" ? "stopped" : "interrupted";
				break;
		}
	}
	const list = order.map((key) => calls.get(key)!);
	const open = list.filter((c) => c.status === "running" || c.status === "interrupted" || c.status === "stopped").length;
	const unused = list.filter((c) => c.status === "unused").length;
	return {
		header,
		status: end?.status ?? (attempts > 0 ? "running" : "starting"),
		attempts,
		calls: list,
		versions,
		startAt: header.at,
		lastAt: end?.at ?? lastAt,
		cost: list.reduce((sum, c) => sum + c.cost, 0),
		open,
		done: list.length - open - unused,
		unused,
	};
}

/** Parallel groups of lanes: calls overlapping in time are side by side. */
export function layout(calls: readonly CallView[]): CallView[][][] {
	const sorted = calls.map((call, index) => ({ call, index })).sort((a, b) => a.call.startAt - b.call.startAt || a.index - b.index);
	const groups: CallView[][][] = [];
	let groupEnd = -Infinity;
	let laneEnds: number[] = [];
	for (const { call } of sorted) {
		const end = call.endAt ?? Infinity;
		if (call.startAt >= groupEnd || groups.length === 0) {
			groups.push([]);
			laneEnds = [];
			groupEnd = -Infinity;
		}
		const lanes = groups.at(-1)!;
		let lane = laneEnds.findIndex((laneEnd) => laneEnd <= call.startAt);
		if (lane < 0) {
			lane = lanes.length;
			lanes.push([]);
			laneEnds.push(end);
		}
		lanes[lane]!.push(call);
		laneEnds[lane] = end;
		groupEnd = Math.max(groupEnd, end);
	}
	return groups;
}

export const duration = (ms: number) => {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)} s`;
	const whole = Math.round(s);
	if (whole < 3600) return `${Math.floor(whole / 60)} min ${whole % 60} s`;
	return `${Math.floor(whole / 3600)} h ${Math.floor((whole % 3600) / 60)} min`;
};
const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (text: string, max: number) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const STATUS_TEXT: Record<CallStatus, string> = { running: "running", done: "done", failed: "failed", replayed: "replayed", interrupted: "interrupted", stopped: "stopped", unused: "unused by the new code" };

const STYLE = `
.wf{font-family:var(--font-sans);color:var(--foreground);display:flex;flex-direction:column;gap:12px}
.wf header{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline}
.wf h1{font-size:15px;font-weight:600;margin:0}
.wf .stat{font-size:12px;color:var(--muted-foreground)}
.wf .stat b{color:var(--foreground);font-weight:600}
.wf .run-status{font-size:12px;font-weight:600}
.wf .groups{display:flex;flex-direction:column;gap:8px}
.wf .group{display:flex;gap:8px;align-items:flex-start}
.wf .group.parallel{border-left:2px solid var(--border);padding-left:8px}
.wf .lane{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:6px}
.wf .node{background:var(--card);color:var(--card-foreground);border:1px solid var(--border);border-left:3px solid var(--border);border-radius:var(--radius);padding:8px 10px;display:flex;flex-direction:column;gap:3px;min-width:0}
.wf .row{display:flex;gap:8px;align-items:baseline;min-width:0}
.wf .kind{font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground);flex:none}
.wf .label{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.wf .meta{font-size:11px;color:var(--muted-foreground);display:flex;flex-wrap:wrap;gap:4px 10px}
.wf .meta a{color:var(--primary)}
.wf .error{font-family:var(--font-mono);font-size:11px;color:var(--destructive);overflow-wrap:anywhere}
.wf .s-running{border-left-color:var(--info)}.wf .s-running .st{color:var(--info)}
.wf .s-done{border-left-color:var(--success)}.wf .s-done .st{color:var(--success)}
.wf .s-failed{border-left-color:var(--destructive)}.wf .s-failed .st{color:var(--destructive)}
.wf .s-replayed{border-left-color:var(--muted-foreground)}.wf .s-replayed .st{color:var(--muted-foreground)}
.wf .s-interrupted{border-left-color:var(--warning)}.wf .s-interrupted .st{color:var(--warning)}
.wf .s-stopped{border-left-color:var(--warning)}.wf .s-stopped .st{color:var(--warning)}
.wf .s-unused{opacity:.55;border-style:dashed}.wf .s-unused .st{color:var(--muted-foreground)}
.wf .edit-marker{display:flex;gap:8px;align-items:center;font-size:12px;font-weight:600;color:var(--primary)}
.wf .edit-marker::before,.wf .edit-marker::after{content:"";flex:1;border-top:1px dashed var(--primary)}
.wf .versions{font-size:12px;color:var(--muted-foreground)}
.wf .versions pre{font-family:var(--font-mono);font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:6px 8px;margin:4px 0 8px}
.wf code{font-family:var(--font-mono);font-size:11px}
.wf .empty{font-size:12px;color:var(--muted-foreground)}
`.trim();

function node(call: CallView, lastAt: number): string {
	const took = duration((call.endAt ?? lastAt) - call.startAt);
	const meta = [`<span class="st">${STATUS_TEXT[call.status]}</span>`, `<span>${call.endAt === undefined ? "for " : ""}${took}</span>`];
	if (call.cost > 0) meta.push(`<span>${usd(call.cost)}</span>`);
	if (call.model) meta.push(`<span>${escape(call.model)}</span>`);
	if (call.link) meta.push(call.link.includes("://") ? `<a href="${escape(call.link)}">thread</a>` : `<span>thread ${escape(clip(call.link, 40))}</span>`);
	return [
		`<div class="node k-${call.kind} s-${call.status}" data-key="${escape(call.key)}">`,
		`<div class="row"><span class="kind">${call.kind}</span><span class="label" title="${escape(call.label)}">${escape(clip(call.label, 160))}</span></div>`,
		`<div class="meta">${meta.join("")}</div>`,
		call.error ? `<div class="error">${escape(clip(call.error, 300))}</div>` : "",
		"</div>",
	].join("");
}

/** The body of the page: the header and the groups (no document around it). */
export function renderWorkflowBody(entries: readonly JournalEntry[]): string {
	const view = viewOf(entries);
	const name = view.header.entry.name ?? "inline workflow";
	const stats = [
		`<span class="run-status">${escape(view.status)}</span>`,
		`<span class="stat"><b>${duration(view.lastAt - view.startAt)}</b> total</span>`,
		`<span class="stat"><b>${usd(view.cost)}</b> of ${usd(view.header.budget)}</span>`,
		`<span class="stat"><b>${view.open}</b> open · <b>${view.done}</b> done${view.unused ? ` · <b>${view.unused}</b> unused` : ""}</span>`,
	];
	if (view.attempts > 1) stats.push(`<span class="stat">resumed ${view.attempts - 1}×</span>`);
	if (view.versions.length > 1) stats.push(`<span class="stat">code v${view.versions.length}</span>`);
	// "new code from here" before the first group with a call of the version that took over (at the end without one).
	const marker = (version: CodeVersion) => `<div class="edit-marker" data-version="${version.n}">new code from here · v${version.n} <code>${version.hash}</code></div>`;
	const markers = view.versions.filter((version) => version.takeover);
	const rows: string[] = [];
	let next = 0;
	for (const lanes of layout(view.calls)) {
		const newest = Math.max(...lanes.flat().map((call) => call.version));
		while (next < markers.length && markers[next]!.n <= newest) rows.push(marker(markers[next++]!));
		rows.push(`<div class="group${lanes.length > 1 ? " parallel" : ""}">${lanes.map((lane) => `<div class="lane">${lane.map((call) => node(call, view.lastAt)).join("")}</div>`).join("")}</div>`);
	}
	while (next < markers.length) rows.push(marker(markers[next++]!));
	return [
		`<div class="wf" data-run="${escape(view.header.id)}">`,
		`<header><h1>${escape(name)} <span class="stat">${escape(view.header.id)}</span></h1>${stats.join("")}</header>`,
		`<div class="groups">${rows.join("") || '<div class="empty">No calls yet.</div>'}</div>`,
		view.versions.length > 1 ? versionsSection(view.versions) : "",
		"</div>",
	].join("");
}

/** Every version of the run's code, with where it took over. */
function versionsSection(versions: readonly CodeVersion[]): string {
	const item = (version: CodeVersion) => {
		const from = version.attempt === undefined ? "the start" : `resume ${version.attempt - 1}`;
		const took = version.takeover
			? `, new code from ${version.takeover.label ? `<code>${escape(clip(version.takeover.label, 80))}</code>` : "its return"} after ${version.takeover.replayed} replayed call${version.takeover.replayed === 1 ? "" : "s"}${version.takeover.unused ? `, ${version.takeover.unused} recorded call${version.takeover.unused === 1 ? "" : "s"} unused` : ""}`
			: version.attempt === undefined
				? ""
				: ", replaying";
		return `<li>v${version.n} <code>${version.hash}</code> from ${from}${took}<pre>${escape(version.source)}</pre></li>`;
	};
	return `<details class="versions"><summary>${versions.length} versions of the code</summary><ol>${versions.map(item).join("")}</ol></details>`;
}

/** The self-contained page of a run. Pure: the same journal gives the same bytes. */
export function renderWorkflow(entries: readonly JournalEntry[]): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>workflow ${escape((entries[0] as RunHeader | undefined)?.id ?? "")}</title><style>${STYLE}</style></head><body>${renderWorkflowBody(entries)}</body></html>`;
}

/** A frame height for html_render that fits the page (t3 refits it to the content). */
export function pageHeight(entries: readonly JournalEntry[]): number {
	const view = viewOf(entries);
	const rows = layout(view.calls).reduce((sum, lanes) => sum + Math.max(...lanes.map((lane) => lane.length)), 0);
	const markers = view.versions.filter((version) => version.takeover).length;
	return Math.min(2000, Math.max(80, 60 + rows * 72 + markers * 28 + (view.versions.length > 1 ? 30 : 0)));
}
