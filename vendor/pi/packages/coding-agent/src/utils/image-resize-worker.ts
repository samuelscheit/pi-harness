import { parentPort } from "node:worker_threads";
import {
	IMAGE_RESIZE_WORKER_RESPONSE_TYPE,
	type ImageResizeOptions,
	type ResizeImageWorkerResponse,
	renderImageViewInProcess,
} from "./image-resize-core.ts";
import type { ImageView } from "./image-view.ts";

interface ResizeImageWorkerRequest {
	inputBytes: Uint8Array;
	mimeType: string;
	view: ImageView;
	options?: ImageResizeOptions;
}

function isResizeImageWorkerRequest(value: unknown): value is ResizeImageWorkerRequest {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		record.inputBytes instanceof Uint8Array &&
		typeof record.mimeType === "string" &&
		typeof record.view === "object" &&
		record.view !== null
	);
}

const port = parentPort;
if (!port) {
	throw new Error("image resize worker requires parentPort");
}

port.once("message", (message: unknown) => {
	void (async () => {
		try {
			if (!isResizeImageWorkerRequest(message)) {
				throw new Error("Invalid image resize worker request");
			}
			const result = await renderImageViewInProcess(
				message.inputBytes,
				message.mimeType,
				message.view,
				message.options,
			);
			const response: ResizeImageWorkerResponse = { type: IMAGE_RESIZE_WORKER_RESPONSE_TYPE, result };
			port.postMessage(response);
		} catch (error) {
			const response: ResizeImageWorkerResponse = {
				type: IMAGE_RESIZE_WORKER_RESPONSE_TYPE,
				error: error instanceof Error ? error.message : String(error),
			};
			port.postMessage(response);
		}
	})();
});
