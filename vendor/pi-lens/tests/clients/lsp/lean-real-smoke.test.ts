// flake-shape: real-process-spawn — real Lean elaboration and its diagnostic publication are the behavior under test; mocks cannot reproduce the Lake/elan process boundary.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLSPClient } from "../../../clients/lsp/client.js";
import { launchLSP, stopLSP } from "../../../clients/lsp/launch.js";
import { removeTempDirSync } from "../test-utils.js";
import { installedLeanToolchain } from "./lean-toolchain.js";

const lean = installedLeanToolchain();
const canRunLeanSmoke = lean !== undefined;

let root: string | undefined;
let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;
let serverProcess: Awaited<ReturnType<typeof launchLSP>> | undefined;

afterEach(async () => {
	if (client) {
		try {
			await client.shutdown();
		} catch {
			// The server may already have exited after a failed startup.
		}
		client = undefined;
	}
	if (serverProcess) {
		await stopLSP(serverProcess);
		serverProcess = undefined;
	}
	if (root) {
		removeTempDirSync(root);
		root = undefined;
	}
});

describe("Lean LSP real-process smoke", () => {
	it.skipIf(!canRunLeanSmoke)(
		"publishes a Lean type error for a .lean document opened with language id lean",
		async () => {
			root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lean-smoke-"));
			fs.writeFileSync(
				path.join(root, "lean-toolchain"),
				`${lean?.toolchain}\n`,
			);
			fs.writeFileSync(
				path.join(root, "lakefile.lean"),
				"import Lake\nopen Lake DSL\npackage leanSmoke\nlean_lib Main\n",
			);
			const file = path.join(root, "Main.lean");
			const source = 'def wrong : Nat := "not a natural number"\n';
			fs.writeFileSync(file, source);

			serverProcess = await launchLSP("lake", ["serve"], {
				cwd: root,
				env: lean?.env,
			});
			client = await createLSPClient({
				serverId: "lean",
				process: serverProcess,
				root,
			});
			expect(await client.notify.open(file, source, "lean")).toBe(true);
			expect(await client.notify.change(file, source)).toBe(true);
			// Lean can publish an initial clean snapshot before elaboration finishes;
			// waitForDiagnostics may accept that pull result, so wait for the pushed
			// type error rather than treating the early empty snapshot as final.
			await client.waitForDiagnostics(file, 20_000);
			await expect
				.poll(() => client?.getDiagnostics(file), {
					interval: 100,
					timeout: 15_000,
				})
				.toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							message: expect.stringContaining("String"),
						}),
					]),
				);
		},
		30_000,
	);
});
