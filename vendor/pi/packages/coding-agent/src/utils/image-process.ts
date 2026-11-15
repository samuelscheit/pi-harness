import { convertImageBytesToPng } from "./image-convert.ts";
import {
	formatDimensionNote,
	type ImageResizeOptions,
	type ImageViewResult,
	type ResizedImage,
	renderImageView,
	resizeImage,
} from "./image-resize.ts";
import type { ImageView } from "./image-view.ts";

export interface ProcessImageOptions {
	/** Whether to resize images to inline provider limits. Default: true */
	autoResizeImages?: boolean;
	/** Optional resize overrides. Uses resizeImage defaults when omitted. */
	resizeOptions?: ImageResizeOptions;
}

export type ProcessImageResult =
	| {
			ok: true;
			data: string;
			mimeType: string;
			hints: string[];
	  }
	| {
			ok: false;
			message: string;
	  };

/** A rendered image view with the hints that go with it, such as format conversion. */
export type ProcessImageViewResult =
	| (Extract<ImageViewResult, { ok: true }> & { hints: string[] })
	| { ok: false; message: string };

interface NormalizedImage {
	bytes: Uint8Array;
	mimeType: string;
	convertedFrom?: string;
}

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

function normalizeSupportedImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "image/png";
		case "image/jpeg":
		case "image/jpg":
			return "image/jpeg";
		case "image/gif":
			return "image/gif";
		case "image/webp":
			return "image/webp";
		default:
			return null;
	}
}

async function normalizeImage(bytes: Uint8Array, mimeType: string): Promise<NormalizedImage | null> {
	const normalizedMimeType = normalizeSupportedImageMimeType(mimeType);
	if (normalizedMimeType) {
		return { bytes, mimeType: normalizedMimeType };
	}

	const pngBytes = await convertImageBytesToPng(bytes);
	if (!pngBytes) {
		return null;
	}

	return {
		bytes: pngBytes,
		mimeType: "image/png",
		convertedFrom: baseMimeType(mimeType),
	};
}

function conversionHint(from: string | undefined, to: string): string | undefined {
	if (!from || from === to) return undefined;
	return `[Image converted from ${from} to ${to}.]`;
}

/**
 * The note for images of a lossless source sent as JPEG because their PNG exceeded the size limit,
 * so the model knows edges and small glyphs may be compression artifacts, not image content.
 */
function jpegFallbackHint(images: ResizedImage[]): string | undefined {
	const fallbacks = images.filter((image) => image.jpegFallbackQuality !== undefined);
	if (fallbacks.length === 0) return undefined;
	const qualities = [...new Set(fallbacks.map((image) => image.jpegFallbackQuality))].join("/");
	const subject =
		images.length === 1
			? `Image sent as JPEG (quality ${qualities}) because the lossless PNG exceeded`
			: `${fallbacks.length} of ${images.length} images sent as JPEG (quality ${qualities}) because their lossless PNG exceeded`;
	return `[${subject} the per-image size limit: thin lines and small text may show compression artifacts.]`;
}

/**
 * Convert an image to an inline format and render a view of it (whole, region, or tiles) within
 * the resize limits. Unlike processImage, always decodes: a region or tile needs the pixels.
 */
export async function processImageView(
	bytes: Uint8Array,
	mimeType: string,
	view: ImageView,
	resizeOptions?: ImageResizeOptions,
): Promise<ProcessImageViewResult> {
	const normalized = await normalizeImage(bytes, mimeType);
	if (!normalized) return { ok: false, message: "Image could not be converted to a supported inline image format." };
	const rendered = await renderImageView(normalized.bytes, normalized.mimeType, view, resizeOptions);
	if (!rendered.ok) return rendered;
	const hints = [
		conversionHint(normalized.convertedFrom, rendered.images[0].mimeType),
		jpegFallbackHint(rendered.images),
	].filter((hint) => hint !== undefined);
	return { ...rendered, hints };
}

export async function processImage(
	bytes: Uint8Array,
	mimeType: string,
	options?: ProcessImageOptions,
): Promise<ProcessImageResult> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const normalized = await normalizeImage(bytes, mimeType);
	if (!normalized) {
		return {
			ok: false,
			message: "[Image omitted: could not be converted to a supported inline image format.]",
		};
	}

	if (autoResizeImages) {
		const resized = await resizeImage(normalized.bytes, normalized.mimeType, options?.resizeOptions);
		if (!resized) {
			return {
				ok: false,
				message: "[Image omitted: could not be resized below the inline image size limit.]",
			};
		}

		const hints = [
			conversionHint(normalized.convertedFrom, resized.mimeType),
			jpegFallbackHint([resized]),
			formatDimensionNote(resized),
		].filter((hint) => hint !== undefined);

		return {
			ok: true,
			data: resized.data,
			mimeType: resized.mimeType,
			hints,
		};
	}

	const hints: string[] = [];
	const convertedHint = conversionHint(normalized.convertedFrom, normalized.mimeType);
	if (convertedHint) hints.push(convertedHint);

	return {
		ok: true,
		data: Buffer.from(normalized.bytes).toString("base64"),
		mimeType: normalized.mimeType,
		hints,
	};
}
