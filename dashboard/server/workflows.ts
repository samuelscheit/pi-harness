// Workflow runs in the dashboard: /workflows lists recent runs, /workflows/<id> is a run's page
// (the same renderer as the thread's snapshots, extensions/workflow/render.ts) that updates live:
// /workflows/<id>/events sends the page's body as a server-sent event on every journal append.

import { existsSync, type FSWatcher, readFileSync, watch } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { journalPath, listRuns, parseJournal, RUN_ID, runDir } from "../../extensions/workflow/journal.ts";
import { duration, renderWorkflow, renderWorkflowBody, type ViewOptions, viewOf } from "../../extensions/workflow/render.ts";
import { lockHeld } from "../../extensions/workflow/stop.ts";

/** t3's theme variables (dark), so the page looks as in the thread. */
const THEME = `:root{color-scheme:dark;--background:#0b0b0d;--foreground:#ececef;--muted:#1c1c21;--muted-foreground:#9a9aa3;--card:#141418;--card-foreground:#ececef;--border:#2a2a31;--primary:#8ab4ff;--info:#6aa7ff;--success:#4fc28a;--warning:#e5b04d;--destructive:#f06a6a;--radius:8px;--font-sans:ui-sans-serif,system-ui,-apple-system,sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,monospace}
body{margin:0;padding:24px;background:var(--background);color:var(--foreground);font-family:var(--font-sans)}
a{color:var(--primary)}
table{border-collapse:collapse;font-size:13px;width:100%}td,th{text-align:left;padding:6px 10px;border-bottom:1px solid var(--border)}th{color:var(--muted-foreground);font-weight:500}`;
/** Comments that keep an idle event stream open through proxies. */
const HEARTBEAT_MS = 15_000;
/** Appends come in bursts (start, meta, done): one update per burst. */
const DEBOUNCE_MS = 50;

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const liveScript = (id: string) => `<script>
const events = new EventSource(${JSON.stringify(`/workflows/${id}/events`)});
events.onmessage = (event) => { const current = document.querySelector(".wf"); if (current) current.outerHTML = JSON.parse(event.data).body; };
</script>`;

/** What the journal does not say: whether a process still runs the run (a run whose process died has no end). */
const viewOptions = (agentDir: string, id: string): ViewOptions => ({ processEnded: !lockHeld(agentDir, id) });

/** The run's page with the theme and the live updates around the renderer's output. */
export function livePage(entries: Parameters<typeof renderWorkflow>[0], id: string, options: ViewOptions = {}): string {
	return renderWorkflow(entries, options).replace("</head>", `<style>${THEME}</style></head>`).replace("</body>", `${liveScript(id)}</body>`);
}

function listPage(agentDir: string): string {
	const rows = listRuns(agentDir)
		.slice(0, 100)
		.map((run) => {
			let cost = "";
			let took = "";
			let status = run.end?.status ?? "running";
			try {
				const view = viewOf(parseJournal(readFileSync(journalPath(agentDir, run.id), "utf8")), viewOptions(agentDir, run.id));
				cost = `$${view.cost.toFixed(4)} of $${view.header.budget.toFixed(2)}`;
				took = duration(view.lastAt - view.startAt);
				status = view.status;
			} catch {
				// Removed meanwhile.
			}
			return `<tr><td><a href="/workflows/${run.id}">${run.id}</a></td><td>${escape(run.header.entry.name ?? "inline")}</td><td>${escape(status)}</td><td>${took}</td><td>${cost}</td><td>${escape(run.header.cwd)}</td></tr>`;
		});
	return `<!doctype html><html><head><meta charset="utf-8"><title>Workflow runs</title><style>${THEME}</style></head><body><h1 style="font-size:16px">Workflow runs</h1><table><tr><th>Run</th><th>Workflow</th><th>Status</th><th>Time</th><th>Cost</th><th>Directory</th></tr>${rows.join("") || '<tr><td colspan="6">No runs yet.</td></tr>'}</table></body></html>`;
}

function send(res: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8") {
	res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
	res.end(body);
}

/** Stream the run's page body on every change of its journal. */
function events(req: IncomingMessage, res: ServerResponse, agentDir: string, id: string) {
	res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
	const path = journalPath(agentDir, id);
	let sent = "";
	const push = () => {
		try {
			const body = renderWorkflowBody(parseJournal(readFileSync(path, "utf8")), viewOptions(agentDir, id));
			if (body === sent) return;
			sent = body;
			res.write(`data: ${JSON.stringify({ body })}\n\n`);
		} catch {
			// Removed by the sweep: nothing more will come.
		}
	};
	let timer: NodeJS.Timeout | undefined;
	const changed = () => {
		clearTimeout(timer);
		timer = setTimeout(push, DEBOUNCE_MS);
	};
	let watcher: FSWatcher | undefined;
	try {
		watcher = watch(runDir(agentDir, id), changed);
	} catch {
		// Gone.
	}
	// Also looks again: a process that died writes nothing, and its run shows as interrupted from then on.
	const heartbeat = setInterval(() => {
		res.write(": keep-alive\n\n");
		push();
	}, HEARTBEAT_MS);
	push();
	req.on("close", () => {
		watcher?.close();
		clearInterval(heartbeat);
		clearTimeout(timer);
	});
}

/** Answer /workflows routes; false for other paths. */
export function handleWorkflows(req: IncomingMessage, res: ServerResponse, pathname: string, agentDir: string): boolean {
	const match = /^\/workflows(?:\/([^/]+)(\/events)?)?\/?$/.exec(pathname);
	if (!match) return false;
	const [, id, stream] = match;
	if (!id) {
		send(res, 200, listPage(agentDir));
		return true;
	}
	if (!RUN_ID.test(id) || !existsSync(journalPath(agentDir, id))) {
		send(res, 404, `<!doctype html><title>Not found</title><p>No workflow run ${escape(id)}.</p>`);
		return true;
	}
	if (stream) events(req, res, agentDir, id);
	else send(res, 200, livePage(parseJournal(readFileSync(journalPath(agentDir, id), "utf8")), id, viewOptions(agentDir, id)));
	return true;
}
