import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

// An extension command opens dialogs that Pi closes itself, and one the client answers.
const EXTENSION = `
export default function (pi) {
	pi.registerCommand("dialogs", {
		description: "dialogs Pi closes itself",
		handler: async (_args, ctx) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 100);
			const aborted = await ctx.ui.select("aborted", ["a"], { signal: controller.signal });
			const timedOut = await ctx.ui.input("timed out", undefined, { timeout: 100 });
			const preAborted = await ctx.ui.confirm("pre-aborted", "", { signal: AbortSignal.abort() });
			const answered = await ctx.ui.input("answered", undefined, { timeout: 60_000 });
			const shown = (value) => (value === undefined ? "undefined" : value);
			ctx.ui.notify(JSON.stringify({ aborted: shown(aborted), timedOut: shown(timedOut), preAborted, answered }));
		},
	});
}
`;

describe("RPC dialogs Pi closes itself", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	test("are announced as dismiss with the dialog's id; answered and never shown ones are not", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-rpc-dismiss-"));
		const extension = join(dir, "dialogs.mjs");
		writeFileSync(extension, EXTENSION);
		const child = spawn("node", [cli, "--mode", "rpc", "--no-session", "--no-extensions", "-e", extension], {
			env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent") },
			stdio: ["pipe", "pipe", "inherit"],
		});
		const ui: Record<string, unknown>[] = [];
		const lines = createInterface({ input: child.stdout! });
		const done = new Promise<string>((resolve) => {
			lines.on("line", (line) => {
				const event = JSON.parse(line) as Record<string, unknown>;
				if (event.type !== "extension_ui_request" || event.method === "setStatus") return;
				ui.push(event);
				if (event.method === "input" && event.title === "answered") {
					child.stdin!.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, value: "yes" })}\n`);
				}
				if (event.method === "notify") resolve(String(event.message));
			});
		});
		child.stdin!.write(`${JSON.stringify({ type: "prompt", message: "/dialogs" })}\n`);
		try {
			const results = JSON.parse(await done);
			expect(results).toEqual({ aborted: "undefined", timedOut: "undefined", preAborted: false, answered: "yes" });
		} finally {
			child.kill();
		}
		const [aborted, abortedDismiss, timedOut, timedOutDismiss, answered, notify] = ui;
		expect(ui).toHaveLength(6);
		expect(aborted).toMatchObject({ method: "select", title: "aborted" });
		expect(abortedDismiss).toEqual({ type: "extension_ui_request", id: aborted!.id, method: "dismiss" });
		expect(timedOut).toMatchObject({ method: "input", title: "timed out", timeout: 100 });
		expect(timedOutDismiss).toEqual({ type: "extension_ui_request", id: timedOut!.id, method: "dismiss" });
		expect(answered).toMatchObject({ method: "input", title: "answered" });
		expect(notify).toMatchObject({ method: "notify" });
	}, 30_000);
});
