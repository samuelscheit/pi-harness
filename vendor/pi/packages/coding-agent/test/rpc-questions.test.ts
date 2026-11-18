import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

// An extension command asks questions dialogs: one the client answers, one it cancels, one Pi
// closes itself (abort), and a single question.
const EXTENSION = `
export default function (pi) {
	pi.registerCommand("ask", {
		description: "questions dialogs",
		handler: async (_args, ctx) => {
			const answered = await ctx.ui.questions([
				{ title: "Which area?", options: [{ label: "Limitation", description: "time bars", extra: "dropped" }, { label: "Contracts", description: "" }], extra: "dropped" },
				{ title: "Anything else?" },
				{ title: "Skipped?", options: [{ label: "a" }] },
			]);
			const cancelled = await ctx.ui.questions([{ title: "cancel me" }, { title: "and me" }]);
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 100);
			const aborted = await ctx.ui.questions([{ title: "aborted" }, { title: "too" }], { signal: controller.signal });
			const single = await ctx.ui.questions([{ title: "Only one?", options: [{ label: "yes", description: "go on" }] }], { timeout: 60_000 });
			const shown = (value) => (value === undefined ? "undefined" : value.map((v) => (v === undefined ? "undefined" : v)));
			ctx.ui.notify(JSON.stringify({ answered: shown(answered), cancelled: shown(cancelled), aborted: shown(aborted), single: shown(single) }));
		},
	});
}
`;

describe("RPC questions dialogs", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	test("are one request with every question, answered by position, cancellable and dismissable", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-rpc-questions-"));
		const extension = join(dir, "ask.mjs");
		writeFileSync(extension, EXTENSION);
		const child = spawn("node", [cli, "--mode", "rpc", "--no-session", "--no-extensions", "-e", extension], {
			env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_RPC_DIALOGS: "questions" },
			stdio: ["pipe", "pipe", "inherit"],
		});
		const send = (response: Record<string, unknown>) =>
			child.stdin!.write(`${JSON.stringify({ type: "extension_ui_response", ...response })}\n`);
		const ui: Record<string, unknown>[] = [];
		const lines = createInterface({ input: child.stdout! });
		const done = new Promise<string>((resolve) => {
			lines.on("line", (line) => {
				const event = JSON.parse(line) as Record<string, unknown>;
				if (event.type !== "extension_ui_request" || event.method === "setStatus") return;
				ui.push(event);
				if (event.method === "questions" && event.title === "3 questions") {
					// One value short: a missing value counts as unanswered, like null.
					send({ id: event.id, values: ["Contracts", null] });
				}
				if (event.method === "questions" && event.title === "2 questions" && ui.length === 2) {
					send({ id: event.id, cancelled: true });
				}
				if (event.method === "questions" && event.title === "Only one?") send({ id: event.id, values: [""] });
				if (event.method === "notify") resolve(String(event.message));
			});
		});
		child.stdin!.write(`${JSON.stringify({ type: "prompt", message: "/ask" })}\n`);
		try {
			expect(JSON.parse(await done)).toEqual({
				answered: ["Contracts", "undefined", "undefined"],
				cancelled: "undefined",
				aborted: "undefined",
				single: [""],
			});
		} finally {
			child.kill();
		}
		const [answered, cancelled, aborted, abortedDismiss, single, notify] = ui;
		expect(ui).toHaveLength(6);
		expect(answered).toEqual({
			type: "extension_ui_request",
			id: answered!.id,
			method: "questions",
			title: "3 questions",
			questions: [
				{
					title: "Which area?",
					options: [{ label: "Limitation", description: "time bars" }, { label: "Contracts" }],
				},
				{ title: "Anything else?" },
				{ title: "Skipped?", options: [{ label: "a" }] },
			],
		});
		expect(cancelled).toMatchObject({ method: "questions", title: "2 questions" });
		expect(aborted).toMatchObject({ method: "questions", title: "2 questions" });
		expect(abortedDismiss).toEqual({ type: "extension_ui_request", id: aborted!.id, method: "dismiss" });
		expect(single).toMatchObject({ method: "questions", title: "Only one?", timeout: 60_000 });
		expect(notify).toMatchObject({ method: "notify" });
	}, 30_000);

	test("go out as one select or input per question when the client did not declare them", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-rpc-questions-"));
		const extension = join(dir, "ask.mjs");
		writeFileSync(extension, EXTENSION);
		const env: Record<string, string | undefined> = { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent") };
		delete env.PI_RPC_DIALOGS;
		const child = spawn("node", [cli, "--mode", "rpc", "--no-session", "--no-extensions", "-e", extension], {
			env,
			stdio: ["pipe", "pipe", "inherit"],
		});
		const send = (response: Record<string, unknown>) =>
			child.stdin!.write(`${JSON.stringify({ type: "extension_ui_response", ...response })}\n`);
		const ui: Record<string, unknown>[] = [];
		const lines = createInterface({ input: child.stdout! });
		const done = new Promise<string>((resolve) => {
			lines.on("line", (line) => {
				const event = JSON.parse(line) as Record<string, unknown>;
				if (event.type !== "extension_ui_request" || event.method === "setStatus") return;
				ui.push(event);
				// The first dialog: every question answered, the free-text one typed.
				if (event.title === "(1/3) Which area?") send({ id: event.id, value: "Contracts" });
				if (event.title === "(2/3) Anything else?") send({ id: event.id, value: "no" });
				if (event.title === "(3/3) Skipped?") send({ id: event.id, value: "a" });
				// The second: cancelled at its first question, so its second is never asked.
				if (event.title === "(1/2) cancel me") send({ id: event.id, cancelled: true });
				// The third is aborted by Pi; the single question has no position prefix.
				if (event.title === "Only one?") send({ id: event.id, value: "yes" });
				if (event.method === "notify") resolve(String(event.message));
			});
		});
		child.stdin!.write(`${JSON.stringify({ type: "prompt", message: "/ask" })}\n`);
		try {
			expect(JSON.parse(await done)).toEqual({
				answered: ["Contracts", "no", "a"],
				cancelled: "undefined",
				aborted: "undefined",
				single: ["yes"],
			});
		} finally {
			child.kill();
		}
		expect(ui.map((e) => [e.method, e.title])).toEqual([
			["select", "(1/3) Which area?"],
			["input", "(2/3) Anything else?"],
			["select", "(3/3) Skipped?"],
			["input", "(1/2) cancel me"],
			["input", "(1/2) aborted"],
			["dismiss", undefined],
			["select", "Only one?"],
			["notify", undefined],
		]);
		expect(ui[0]).toMatchObject({ options: ["Limitation — time bars", "Contracts"] });
		expect(ui[6]).toMatchObject({ options: ["yes — go on"], timeout: 60_000 });
		expect(ui.some((e) => e.method === "questions")).toBe(false);
	}, 30_000);

	test("the declaration is not passed on to processes Pi starts", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-rpc-questions-"));
		const extension = join(dir, "env.mjs");
		writeFileSync(
			extension,
			`export default function (pi) { pi.registerCommand("env", { description: "env", handler: async (_a, ctx) => ctx.ui.notify(String(process.env.PI_RPC_DIALOGS)) }); }`,
		);
		const child = spawn("node", [cli, "--mode", "rpc", "--no-session", "--no-extensions", "-e", extension], {
			env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_RPC_DIALOGS: "questions" },
			stdio: ["pipe", "pipe", "inherit"],
		});
		const lines = createInterface({ input: child.stdout! });
		const seen = new Promise<string>((resolve) => {
			lines.on("line", (line) => {
				const event = JSON.parse(line) as Record<string, unknown>;
				if (event.type === "extension_ui_request" && event.method === "notify") resolve(String(event.message));
			});
		});
		child.stdin!.write(`${JSON.stringify({ type: "prompt", message: "/env" })}\n`);
		try {
			expect(await seen).toBe("undefined");
		} finally {
			child.kill();
		}
	}, 30_000);
});
