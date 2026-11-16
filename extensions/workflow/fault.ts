// A harness fault: a workflow ran into a broken invariant of the harness itself (a child's run that
// t3 ended but the child never reported, a /compact that did not happen), not into an error of the
// script or of a child's work. Such a failure was left for the user to spot and bring back by hand
// (2026-11-16: "delegate 3: the child reported no end of run 1", a premature delegate result). Each
// one now also becomes a note in the harness's improvement backlog, which dreaming reads and fixes,
// with the run, its journal and the child's thread: it gets caught without anybody reporting it.
// A resumed run answers a failed call from its journal and does not note it again.

import { appendNote, backlogPath, formatNote } from "../improvements/index.ts";

export class HarnessFault extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HarnessFault";
	}
}

export interface FaultContext {
	/** The harness backlog notes go to; default the harness repository's. */
	backlog?: string;
	cwd: string;
	sessionId?: string;
	runId: string;
	journal: string;
}

/** Note the fault in the harness backlog and return it as the error to throw. Noting never throws. */
export function harnessFault(message: string, context: FaultContext): HarnessFault {
	const fault = new HarnessFault(message);
	try {
		const observation = `Harness fault, noted automatically by the workflow runtime: ${message}\nWorkflow run ${context.runId}; journal ${context.journal}.`;
		const proposal =
			"Find the root cause in the workflow runtime (extensions/workflow: delegate.ts, child.ts, t3.ts) from the journal and the child's thread, fix it so this cannot recur, and add a test that reproduces it.";
		appendNote(context.backlog ?? backlogPath("harness", context.cwd), formatNote({ scope: "harness", observation, proposal }, new Date(), context.sessionId ?? "unknown", context.cwd));
	} catch (error) {
		console.error("[workflow] cannot note a harness fault:", error);
	}
	return fault;
}
