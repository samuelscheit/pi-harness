import { describe, expect, it, vi } from "vitest";
import { runKnip } from "../../scripts/lib/knip-runner.mjs";

function fakeSpawn(status: number | null, error?: Error) {
	return vi.fn().mockReturnValue({ status, error });
}

const command = () =>
	vi.fn().mockReturnValue({ command: "node", args: ["bin/knip.js"] });

describe("runKnip", () => {
	it("runs knip in a copy of the tree, removes the copy, and propagates knip's exit code", () => {
		const snapshot = vi.fn().mockReturnValue({ dir: "/tmp/copy", files: 3 });
		const removeSnapshot = vi.fn();
		const spawn = fakeSpawn(3);

		const code = runKnip(["--x"], "/repo", {
			snapshot,
			removeSnapshot,
			resolveCommand: vi
				.fn()
				.mockReturnValue({ command: "node", args: ["bin/knip.js", "--x"] }),
			spawn,
			log: vi.fn(),
			logError: vi.fn(),
		});

		expect(snapshot).toHaveBeenCalledWith("/repo");
		expect(spawn).toHaveBeenCalledWith(
			"node",
			["bin/knip.js", "--x"],
			expect.objectContaining({ cwd: "/tmp/copy" }),
		);
		expect(removeSnapshot).toHaveBeenCalledWith("/tmp/copy");
		expect(code).toBe(3);
	});

	it("removes the copy when knip throws", () => {
		const removeSnapshot = vi.fn();
		expect(() =>
			runKnip([], "/repo", {
				snapshot: vi.fn().mockReturnValue({ dir: "/tmp/copy", files: 1 }),
				removeSnapshot,
				resolveCommand: command(),
				spawn: vi.fn().mockImplementation(() => {
					throw new Error("spawn blew up");
				}),
				log: vi.fn(),
				logError: vi.fn(),
			}),
		).toThrow("spawn blew up");
		expect(removeSnapshot).toHaveBeenCalledWith("/tmp/copy");
	});

	it("aborts with a non-zero exit, and never runs knip in the checkout, when the copy fails", () => {
		const spawn = vi.fn();
		const logError = vi.fn();

		const code = runKnip(["--reporter", "json"], "/repo", {
			snapshot: vi.fn().mockImplementation(() => {
				throw new Error("git ls-files ENOBUFS");
			}),
			removeSnapshot: vi.fn(),
			resolveCommand: command(),
			spawn,
			log: vi.fn(),
			logError,
			isCI: false,
		});

		expect(code).toBe(1);
		expect(spawn).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalledWith(
			expect.stringContaining("git ls-files ENOBUFS"),
		);
		expect(logError).not.toHaveBeenCalledWith(
			expect.stringMatching(/^::error::/),
		);
	});

	it("prints an ::error:: line under CI when the copy fails", () => {
		const logError = vi.fn();
		runKnip([], "/repo", {
			snapshot: vi.fn().mockImplementation(() => {
				throw new Error("boom");
			}),
			resolveCommand: command(),
			spawn: vi.fn(),
			log: vi.fn(),
			logError,
			isCI: true,
		});
		expect(logError).toHaveBeenCalledWith(expect.stringMatching(/^::error::/));
	});

	// knip's short version flag is `-V`; `-v` is "Unknown option" to knip and
	// so is analysed like any other run (#2698 review round 3, R2-F1).
	it.each([
		["--help", 0, "/repo"],
		["-h", 0, "/repo"],
		["--version", 0, "/repo"],
		["-V", 0, "/repo"],
		["-v", 1, "/tmp/copy"],
	])("%s makes %i copies and runs in %s", (arg, copies, cwd) => {
		const snapshot = vi.fn().mockReturnValue({ dir: "/tmp/copy", files: 1 });
		const spawn = fakeSpawn(0);

		const code = runKnip([arg], "/repo", {
			snapshot,
			removeSnapshot: vi.fn(),
			resolveCommand: command(),
			spawn,
			log: vi.fn(),
			logError: vi.fn(),
		});

		expect(snapshot).toHaveBeenCalledTimes(copies);
		expect(spawn).toHaveBeenCalledWith(
			"node",
			["bin/knip.js"],
			expect.objectContaining({ cwd }),
		);
		expect(code).toBe(0);
	});

	it.each([
		["a failure to start knip", fakeSpawn(null, new Error("ENOENT"))],
		["a signal-killed knip (no numeric status)", fakeSpawn(null)],
	])("treats %s as a failure and still removes the copy", (_, spawn) => {
		const removeSnapshot = vi.fn();
		const code = runKnip([], "/repo", {
			snapshot: vi.fn().mockReturnValue({ dir: "/tmp/copy", files: 1 }),
			removeSnapshot,
			resolveCommand: command(),
			spawn,
			log: vi.fn(),
			logError: vi.fn(),
		});
		expect(code).toBe(1);
		expect(removeSnapshot).toHaveBeenCalledWith("/tmp/copy");
	});
});
