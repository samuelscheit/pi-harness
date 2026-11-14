import { applyExifOrientation } from "./exif-orientation.ts";
import { type ImageBox, type ImageView, planImageView, type TileGrid } from "./image-view.ts";
import { loadPhoton, type PhotonImageType } from "./photon.ts";

export interface ImageResizeOptions {
	maxWidth?: number; // Default: 2000
	maxHeight?: number; // Default: 2000
	maxBytes?: number; // Default: 4.5MB of base64 payload (below Anthropic's 5MB limit)
	jpegQuality?: number; // Default: 80
}

export interface ResizedImage {
	data: string; // base64
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
	/** The box of the original image this image shows; the whole image unless cropped. */
	box: ImageBox;
}

/** The images rendered for an image view, or why there are none. */
export type ImageViewResult =
	| {
			ok: true;
			originalWidth: number;
			originalHeight: number;
			/** The area of the original the view covers: the whole image or the clamped region. */
			area: ImageBox;
			/** Whether the requested region was clamped to the image bounds. */
			clamped: boolean;
			images: ResizedImage[];
			grid?: TileGrid;
	  }
	| { ok: false; message: string };

/**
 * Tag on image resize worker replies. Node can post its own messages on the worker channel
 * (for example `{ "watch:require": [...] }` under `node --watch`), so replies must be identifiable.
 */
export const IMAGE_RESIZE_WORKER_RESPONSE_TYPE = "pi:image-resize-response";

export type ResizeImageWorkerResponse =
	| { type: typeof IMAGE_RESIZE_WORKER_RESPONSE_TYPE; result: ImageViewResult }
	| { type: typeof IMAGE_RESIZE_WORKER_RESPONSE_TYPE; error: string };

// 4.5MB of base64 payload. Provides headroom below Anthropic's 5MB limit.
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
};

interface EncodedCandidate {
	data: string;
	encodedSize: number;
	mimeType: string;
}

function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
	const data = Buffer.from(buffer).toString("base64");
	return {
		data,
		encodedSize: Buffer.byteLength(data, "utf-8"),
		mimeType,
	};
}

const IMAGE_UNPROCESSABLE = "Image could not be decoded, or not resized below the inline image size limit.";

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Returns null if the image cannot be resized below maxBytes.
 */
export async function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const result = await renderImageViewInProcess(inputBytes, mimeType, { kind: "whole" }, options);
	return result.ok ? result.images[0] : null;
}

/**
 * Render a view of an image (the whole image, a region, or tiles) within the max dimensions and
 * encoded size, decoding the image once. Uses Photon (Rust/WASM).
 *
 * Strategy for each rendered box:
 * 1. Crop to the box and resize to fit maxWidth/maxHeight
 * 2. Try both PNG and JPEG formats, pick the smaller one
 * 3. If still too large, try JPEG with decreasing quality
 * 4. If still too large, progressively reduce dimensions until 1x1
 */
export async function renderImageViewInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	view: ImageView,
	options?: ImageResizeOptions,
): Promise<ImageViewResult> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const photon = await loadPhoton();
	if (!photon) {
		return { ok: false, message: "Image processing is unavailable (Photon could not be loaded)." };
	}

	let image: PhotonImageType | undefined;
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
		image = applyExifOrientation(photon, rawImage, inputBytes);
		if (image !== rawImage) rawImage.free();
		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		const plan = planImageView(view, originalWidth, originalHeight, opts.maxWidth, opts.maxHeight);
		if (!plan.ok) return plan;

		// Tiles share one encoded-size budget, so a grid stays within the provider's request limit.
		const maxBytes =
			view.kind === "tiles"
				? Math.min(opts.maxBytes, Math.floor(view.maxTotalBytes / plan.boxes.length))
				: opts.maxBytes;
		const images: ResizedImage[] = [];
		for (const box of plan.boxes) {
			const rendered =
				view.kind === "whole"
					? renderWhole(photon, image, inputBytes, mimeType, opts)
					: renderBox(photon, image, box, { ...opts, maxBytes });
			if (!rendered) return { ok: false, message: IMAGE_UNPROCESSABLE };
			images.push({ ...rendered, originalWidth, originalHeight, box });
		}
		return {
			ok: true,
			originalWidth,
			originalHeight,
			area: plan.area,
			clamped: plan.clamped,
			images,
			grid: plan.grid,
		};
	} catch {
		return { ok: false, message: IMAGE_UNPROCESSABLE };
	} finally {
		image?.free();
	}
}

type Photon = NonNullable<Awaited<ReturnType<typeof loadPhoton>>>;
type RenderedBox = Pick<ResizedImage, "data" | "mimeType" | "width" | "height" | "wasResized">;

/** The whole image: the input bytes as they are when within all limits, else re-encoded to fit. */
function renderWhole(
	photon: Photon,
	image: PhotonImageType,
	inputBytes: Uint8Array,
	mimeType: string,
	opts: Required<ImageResizeOptions>,
): RenderedBox | null {
	const width = image.get_width();
	const height = image.get_height();
	const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;
	if (width <= opts.maxWidth && height <= opts.maxHeight && inputBase64Size < opts.maxBytes) {
		const format = mimeType.split("/")[1] ?? "png";
		return {
			data: Buffer.from(inputBytes).toString("base64"),
			mimeType: mimeType || `image/${format}`,
			width,
			height,
			wasResized: false,
		};
	}
	const encoded = encodeWithinLimits(photon, image, opts);
	return encoded && { ...encoded, wasResized: true };
}

/** One box of the image, cropped and encoded within the limits. */
function renderBox(
	photon: Photon,
	image: PhotonImageType,
	box: ImageBox,
	opts: Required<ImageResizeOptions>,
): RenderedBox | null {
	const isWhole = box.x === 0 && box.y === 0 && box.width === image.get_width() && box.height === image.get_height();
	const cropped = isWhole ? image : photon.crop(image, box.x, box.y, box.x + box.width, box.y + box.height);
	try {
		const encoded = encodeWithinLimits(photon, cropped, opts);
		return encoded && { ...encoded, wasResized: encoded.width !== box.width || encoded.height !== box.height };
	} finally {
		if (cropped !== image) cropped.free();
	}
}

/** Encode an image within maxWidth/maxHeight and maxBytes, shrinking it until it fits; null if even 1x1 does not. */
function encodeWithinLimits(
	photon: Photon,
	source: PhotonImageType,
	opts: Required<ImageResizeOptions>,
): Pick<ResizedImage, "data" | "mimeType" | "width" | "height"> | null {
	let currentWidth = source.get_width();
	let currentHeight = source.get_height();
	if (currentWidth > opts.maxWidth) {
		currentHeight = Math.max(1, Math.round((currentHeight * opts.maxWidth) / currentWidth));
		currentWidth = opts.maxWidth;
	}
	if (currentHeight > opts.maxHeight) {
		currentWidth = Math.max(1, Math.round((currentWidth * opts.maxHeight) / currentHeight));
		currentHeight = opts.maxHeight;
	}

	const qualitySteps = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
	while (true) {
		const [png, jpeg, ...lowerQualityJpegs] = tryEncodings(photon, source, currentWidth, currentHeight, qualitySteps);
		// Prefer the smaller of PNG and JPEG at the configured quality; lower JPEG quality only if neither fits.
		const preferred = jpeg && jpeg.encodedSize < png.encodedSize ? [jpeg, png] : [png, jpeg];
		for (const candidate of [...preferred, ...lowerQualityJpegs]) {
			if (candidate && candidate.encodedSize < opts.maxBytes) {
				return { data: candidate.data, mimeType: candidate.mimeType, width: currentWidth, height: currentHeight };
			}
		}

		const nextWidth = Math.max(1, Math.floor(currentWidth * 0.75));
		const nextHeight = Math.max(1, Math.floor(currentHeight * 0.75));
		if (nextWidth === currentWidth && nextHeight === currentHeight) return null;
		currentWidth = nextWidth;
		currentHeight = nextHeight;
	}
}

function tryEncodings(
	photon: Photon,
	source: PhotonImageType,
	width: number,
	height: number,
	jpegQualities: number[],
): EncodedCandidate[] {
	const isNative = width === source.get_width() && height === source.get_height();
	const sized = isNative ? source : photon.resize(source, width, height, photon.SamplingFilter.Lanczos3);
	try {
		const candidates: EncodedCandidate[] = [encodeCandidate(sized.get_bytes(), "image/png")];
		for (const quality of jpegQualities) {
			candidates.push(encodeCandidate(sized.get_bytes_jpeg(quality), "image/jpeg"));
		}
		return candidates;
	} finally {
		if (sized !== source) sized.free();
	}
}
