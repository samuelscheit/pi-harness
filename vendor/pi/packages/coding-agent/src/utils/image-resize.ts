import { Worker } from "node:worker_threads";
import {
	IMAGE_RESIZE_WORKER_RESPONSE_TYPE,
	type ImageResizeOptions,
	type ImageViewResult,
	type ResizedImage,
	type ResizeImageWorkerResponse,
	renderImageViewInProcess,
} from "./image-resize-core.ts";
import type { ImageView } from "./image-view.ts";

export type { ImageResizeOptions, ImageViewResult, ResizedImage } from "./image-resize-core.ts";

function toTransferableBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
	// Transfer detaches the buffer, so transfer a worker-owned copy and leave the
	// caller's bytes intact.
	return new Uint8Array(input);
}

function isResizeImageWorkerResponse(value: unknown): value is ResizeImageWorkerResponse {
	return (
		value !== null && typeof value === "object" && "type" in value && value.type === IMAGE_RESIZE_WORKER_RESPONSE_TYPE
	);
}

function createResizeWorker(workerSpecifier: string | URL): Worker {
	return new Worker(workerSpecifier);
}

async function renderImageViewInWorker(
	workerSpecifier: string | URL,
	inputBytes: Uint8Array,
	mimeType: string,
	view: ImageView,
	options?: ImageResizeOptions,
): Promise<ImageViewResult> {
	const worker = createResizeWorker(workerSpecifier);
	try {
		const inputBytesForWorker = toTransferableBytes(inputBytes);
		return await new Promise<ImageViewResult>((resolve, reject) => {
			let settled = false;
			const settle = (result: ImageViewResult): void => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				reject(error);
			};

			worker.on("message", (message: unknown) => {
				// Ignore messages Node posts on the worker channel itself, such as
				// `{ "watch:require": [...] }` under `node --watch` (nodejs/node#65044).
				if (!isResizeImageWorkerResponse(message)) return;
				if ("error" in message) fail(new Error(message.error));
				else settle(message.result);
			});
			worker.once("error", fail);
			worker.once("exit", (code) => {
				if (!settled) {
					fail(new Error(`Image resize worker exited with code ${code}`));
				}
			});
			worker.postMessage(
				{
					inputBytes: inputBytesForWorker,
					mimeType,
					view,
					options,
				},
				[inputBytesForWorker.buffer],
			);
		});
	} finally {
		// Await termination so a serial resize never starts a worker while this one is
		// still shutting down; that overlap aborted the process on macOS with Node 24 (#10695).
		await worker.terminate().catch(() => undefined);
	}
}

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Returns null if it cannot be decoded or resized below maxBytes.
 */
export async function resizeImage(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const result = await renderImageView(inputBytes, mimeType, { kind: "whole" }, options);
	return result.ok ? result.images[0] : null;
}

/**
 * Render a view of an image (whole, region, or tiles) within the max dimensions and encoded size.
 * Runs Photon in a worker thread so WASM decoding, resizing, and encoding do not
 * block the TUI event loop. If the worker cannot be loaded (for example in some
 * Bun compiled executable layouts), fall back to in-process rendering so image
 * reads still work.
 */
export async function renderImageView(
	inputBytes: Uint8Array,
	mimeType: string,
	view: ImageView,
	options?: ImageResizeOptions,
): Promise<ImageViewResult> {
	const isTypeScriptRuntime = import.meta.url.endsWith(".ts");
	const workerUrl = new URL(
		isTypeScriptRuntime ? "./image-resize-worker.ts" : "./image-resize-worker.js",
		import.meta.url,
	);

	// Bun compiled executables resolve worker entrypoints by string path, not via
	// new URL(..., import.meta.url). Try the string path first under Bun so the
	// release binary uses the embedded worker instead of falling back in-process.
	if (typeof process.versions.bun === "string") {
		try {
			return await renderImageViewInWorker(
				"./src/utils/image-resize-worker.ts",
				inputBytes,
				mimeType,
				view,
				options,
			);
		} catch {}
	}

	try {
		return await renderImageViewInWorker(workerUrl, inputBytes, mimeType, view, options);
	} catch {
		return renderImageViewInProcess(inputBytes, mimeType, view, options);
	}
}

/**
 * Format a dimension note for resized images.
 * This helps the model understand the coordinate mapping.
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) {
		return undefined;
	}

	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
