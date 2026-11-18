// The text of a PDF that web_fetch got, through poppler's pdftotext. Anthropic's fetch tool returns
// a PDF as base64 bytes, not text, so without this the agent could only read a model's summary of
// it. pdftotext keeps the layout (columns, tables, list indents) and is exact; the cost is a system
// dependency, so a missing binary is a clear error that says how to install it.

import { execFile } from "node:child_process";

/** Where pdftotext usually lives when the harness runs with a minimal PATH (a GUI-started agent). */
const KNOWN_PATHS = ["pdftotext", "/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext", "/usr/bin/pdftotext"];
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

/** Why a PDF's text could not be extracted. */
export class PdfTextError extends Error {}

/** The pdftotext binaries to try: only PDFTOTEXT_BIN when it is set, else PATH and the usual install locations. */
const candidates = () => (process.env.PDFTOTEXT_BIN ? [process.env.PDFTOTEXT_BIN] : KNOWN_PATHS);

/** The PDF's text in reading layout, pages separated by blank lines, trailing spaces removed. */
export async function pdfText(pdf: Buffer, signal?: AbortSignal): Promise<string> {
	for (const bin of candidates()) {
		let output: string;
		try {
			output = await run(bin, pdf, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		return output
			.replace(/\f/g, "\n")
			.replace(/[ \t]+$/gm, "")
			.trim();
	}
	throw new PdfTextError(
		`pdftotext is not installed (tried ${candidates().join(", ")}); install poppler (brew install poppler, apt install poppler-utils) or set PDFTOTEXT_BIN`,
	);
}

function run(bin: string, pdf: Buffer, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			bin,
			["-layout", "-enc", "UTF-8", "-", "-"],
			{ encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, timeout: TIMEOUT_MS, signal },
			(error, stdout, stderr) => {
				if (!error) return resolve(stdout);
				if ((error as NodeJS.ErrnoException).code === "ENOENT" || error.name === "AbortError") return reject(error);
				const reason = stderr.trim().split("\n").at(-1) || error.message;
				reject(new PdfTextError(`pdftotext could not read the PDF: ${reason}`));
			},
		);
		// pdftotext may exit on a corrupt file before reading all of stdin; its exit code reports that.
		child.stdin?.on("error", () => {});
		child.stdin?.end(pdf);
	});
}
