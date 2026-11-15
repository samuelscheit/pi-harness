// The read tool's image path: renders the whole image, a region, or native-resolution tiles, and
// puts any loss of resolution in a notice line that both the model and the user see first.

import type { Api, ImageContent, Model, ModelImageResizeOptions, TextContent } from "@earendil-works/pi-ai";
import { processImage, processImageView } from "../../utils/image-process.ts";
import type { ResizedImage } from "../../utils/image-resize.ts";
import { formatBox, formatRegionArgument, type ImageBox, type ImageView } from "../../utils/image-view.ts";

/** Image arguments of the read tool. */
export interface ReadImageRequest {
	tiles?: boolean;
	region?: ImageBox;
}

/** The content blocks of an image read, and the notice lines shown to the user too. */
export interface ReadImageResult {
	content: (TextContent | ImageContent)[];
	/** Loss of resolution or omitted area the user should see; also the first text line for the model. */
	notice?: string;
}

/** Most tiles one read returns: a grid past this is capped and the rest named as regions to read. */
export const MAX_TILES_PER_READ = 16;

// Anthropic's request limit, used when the model declares none.
const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/** How an image read is processed: the user's resize setting and the current model's limits. */
export interface ReadImageSettings {
	autoResizeImages: boolean;
	resizeOptions: ModelImageResizeOptions | undefined;
	model: Model<Api> | undefined;
}

/** Read an image file's bytes as tool content for the model, following the tiles/region request. */
export async function readImageContent(
	buffer: Uint8Array,
	mimeType: string,
	request: ReadImageRequest,
	{ autoResizeImages, resizeOptions, model }: ReadImageSettings,
): Promise<ReadImageResult> {
	const view = imageViewFor(request, model);
	const nonVisionNote = getNonVisionImageNote(model);
	if (view.kind === "whole" && !autoResizeImages) {
		const processed = await processImage(buffer, mimeType, { autoResizeImages });
		if (!processed.ok) return { content: [textBlock(mimeType, [], [processed.message, nonVisionNote])] };
		return {
			content: [
				textBlock(processed.mimeType, [], [...processed.hints, nonVisionNote]),
				{ type: "image", data: processed.data, mimeType: processed.mimeType },
			],
		};
	}

	const processed = await processImageView(buffer, mimeType, view, resizeOptions);
	if (!processed.ok) {
		// An explicit region or tile request that fails (such as a region outside the image) is an error
		// the model must act on; a plain read keeps its text-only result, as for any unreadable image.
		if (view.kind !== "whole") throw new Error(processed.message);
		return { content: [textBlock(mimeType, [], [`[Image omitted: ${processed.message}]`, nonVisionNote])] };
	}
	const outputMimeType = processed.images[0].mimeType;
	const imageBlock = (image: ResizedImage): ImageContent => ({
		type: "image",
		data: image.data,
		mimeType: image.mimeType,
	});

	if (view.kind === "tiles" && processed.grid) {
		const { grid, images, area } = processed;
		const notices = [
			grid.remaining.length > 0
				? `[Tiles capped: showing ${images.length} of ${grid.total} tiles (at most ${view.maxTiles} per read). Not shown: ${grid.remaining.map(formatRegionArgument).join(" and ")}. Call read again with tiles: true and that region to see the rest.]`
				: undefined,
			images.some((image) => image.wasResized)
				? "[Some tiles were downscaled to fit the request size budget (marked below). Read a smaller region for native resolution.]"
				: undefined,
		].filter((line) => line !== undefined);
		const header = `${images.length} tile${images.length === 1 ? "" : "s"} at native resolution: grid ${grid.columns}x${grid.rows} over ${formatBox(area)} of the ${processed.originalWidth}x${processed.originalHeight} image, neighbouring tiles overlap by ${grid.overlap} px. Each tile follows its pixel box in original image coordinates.`;
		const content: (TextContent | ImageContent)[] = [
			textBlock(outputMimeType, notices, [
				header,
				clampNote(processed.clamped, request.region),
				...processed.hints,
				nonVisionNote,
			]),
		];
		images.forEach((image, index) => {
			const downscaled = image.wasResized ? ` (downscaled to ${image.width}x${image.height})` : "";
			const jpeg = image.jpegFallbackQuality !== undefined ? ` (JPEG quality ${image.jpegFallbackQuality})` : "";
			content.push({
				type: "text",
				text: `Tile ${index + 1}/${images.length}: ${formatBox(image.box)}${downscaled}${jpeg}`,
			});
			content.push(imageBlock(image));
		});
		return { content, notice: notices.length > 0 ? notices.join("\n") : undefined };
	}

	const [image] = processed.images;
	const downscaled = Math.max(image.width, image.height) < Math.max(image.box.width, image.box.height);
	const notice = downscaled ? downscaleNotice(image) : undefined;
	const regionLine =
		view.kind === "region"
			? `Region ${formatBox(image.box)} of the ${image.originalWidth}x${image.originalHeight} image.`
			: undefined;
	return {
		content: [
			textBlock(outputMimeType, notice ? [notice] : [], [
				regionLine,
				clampNote(processed.clamped, request.region),
				...processed.hints,
				nonVisionNote,
			]),
			imageBlock(image),
		],
		notice,
	};
}

/** The view a read asks for, with the tile cap and byte budget of the current model. */
function imageViewFor(request: ReadImageRequest, model: Model<Api> | undefined): ImageView {
	if (request.tiles) {
		const images = model?.inputLimits?.images;
		return {
			kind: "tiles",
			region: request.region,
			maxTiles: Math.min(
				MAX_TILES_PER_READ,
				images?.maxPerMessage ?? MAX_TILES_PER_READ,
				images?.maxPerRequest ?? MAX_TILES_PER_READ,
			),
			// Half the request limit, so the rest of the conversation still fits next to the tiles.
			maxTotalBytes: Math.floor((model?.inputLimits?.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES) / 2),
		};
	}
	return request.region ? { kind: "region", region: request.region } : { kind: "whole" };
}

/**
 * The line saying an image was sent below its native resolution, with the factor, both sizes and
 * how to read it at native resolution.
 */
function downscaleNotice(image: ResizedImage): string {
	// The long edge sets the scale; the short edge was rounded and would skew it.
	const factor = (Math.max(image.box.width, image.box.height) / Math.max(image.width, image.height)).toFixed(2);
	const isWhole = image.box.width === image.originalWidth && image.box.height === image.originalHeight;
	const sizes = isWhole
		? `original ${image.originalWidth}x${image.originalHeight}, sent at ${image.width}x${image.height}`
		: `region ${formatBox(image.box)} sent at ${image.width}x${image.height}`;
	const howTo = isWhole
		? `To read at native resolution, call read again with tiles: true (the whole image as a grid of native-resolution tiles) or region: {x, y, width, height} in original pixels (multiply coordinates in this image by ${factor}).`
		: "To read it at native resolution, call read again with tiles: true and the same region.";
	return `[Image downscaled ${factor}x: ${sizes}. Small text and fine detail may be unreadable. ${howTo}]`;
}

function clampNote(clamped: boolean, region: ImageBox | undefined): string | undefined {
	return clamped && region ? `[Requested region ${formatBox(region)} was clamped to the image bounds.]` : undefined;
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) return undefined;
	return "[Current model does not support images. The image will be omitted from this request.]";
}

/**
 * The text block of an image read. Notices go first, before the "Read image file" line, so a
 * model or user scanning the result cannot miss them.
 */
function textBlock(mimeType: string, notices: string[], lines: (string | undefined)[]): TextContent {
	const rest = lines.filter((line) => line !== undefined);
	return { type: "text", text: [...notices, `Read image file [${mimeType}]`, ...rest].join("\n") };
}
