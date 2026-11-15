import type { ModelImageResizeOptions } from "@earendil-works/pi-ai";
import { applyExifOrientation } from "./exif-orientation.ts";
import { fitImageSize } from "./image-limits.ts";
import { type ImageBox, type ImageView, planImageView, type TileGrid } from "./image-view.ts";
import { loadPhoton, type PhotonImageType } from "./photon.ts";

/**
 * The model's resize profile. Unset fields use the defaults: 2000x2000, 4.5 MiB of base64 payload,
 * JPEG quality 80, and no patch cap.
 */
export type ImageResizeOptions = ModelImageResizeOptions;

export interface ResizedImage {
	data: string; // base64
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
	/**
	 * Set when a lossless source was sent as JPEG at this quality because its PNG did not fit
	 * maxBytes: thin lines and small text may carry compression artifacts.
	 */
	jpegFallbackQuality?: number;
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

type ResolvedOptions = Required<Omit<ImageResizeOptions, "patchSize" | "maxPatches">> &
	Pick<ImageResizeOptions, "patchSize" | "maxPatches">;

const DEFAULT_OPTIONS: ResolvedOptions = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
};

// Lower JPEG qualities tried, after the configured one, before the image is shrunk.
const FALLBACK_JPEG_QUALITIES = [70, 55, 40];

/** The base64 payload of the encoded bytes when it is below maxBytes, else undefined. */
function base64Within(buffer: Uint8Array, maxBytes: number): string | undefined {
	const data = Buffer.from(buffer).toString("base64");
	return data.length < maxBytes ? data : undefined;
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
 * 1. Crop to the box and resize to the largest size within maxWidth/maxHeight and the patch cap
 * 2. Encode a lossless source as PNG; a JPEG source, or a PNG over maxBytes, as JPEG
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
		const plan = planImageView(view, originalWidth, originalHeight, opts);
		if (!plan.ok) return plan;

		// Tiles share one encoded-size budget, so a grid stays within the provider's request limit.
		const maxBytes =
			view.kind === "tiles"
				? Math.min(opts.maxBytes, Math.floor(view.maxTotalBytes / plan.boxes.length))
				: opts.maxBytes;
		// Re-encoding a JPEG as PNG cannot restore what its compression lost, and only costs bytes.
		const lossless = mimeType !== "image/jpeg";
		const images: ResizedImage[] = [];
		for (const box of plan.boxes) {
			const rendered =
				view.kind === "whole"
					? renderWhole(photon, image, inputBytes, mimeType, lossless, opts)
					: renderBox(photon, image, box, lossless, { ...opts, maxBytes });
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
type EncodedImage = Pick<ResizedImage, "data" | "mimeType" | "width" | "height" | "jpegFallbackQuality">;
type RenderedBox = EncodedImage & Pick<ResizedImage, "wasResized">;

/** The whole image: the input bytes as they are when within all limits, else re-encoded to fit. */
function renderWhole(
	photon: Photon,
	image: PhotonImageType,
	inputBytes: Uint8Array,
	mimeType: string,
	lossless: boolean,
	opts: ResolvedOptions,
): RenderedBox | null {
	const width = image.get_width();
	const height = image.get_height();
	const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;
	const fitted = fitImageSize(width, height, opts);
	if (fitted.width === width && fitted.height === height && inputBase64Size < opts.maxBytes) {
		const format = mimeType.split("/")[1] ?? "png";
		return {
			data: Buffer.from(inputBytes).toString("base64"),
			mimeType: mimeType || `image/${format}`,
			width,
			height,
			wasResized: false,
		};
	}
	const encoded = encodeWithinLimits(photon, image, lossless, opts);
	return encoded && { ...encoded, wasResized: true };
}

/** One box of the image, cropped and encoded within the limits. */
function renderBox(
	photon: Photon,
	image: PhotonImageType,
	box: ImageBox,
	lossless: boolean,
	opts: ResolvedOptions,
): RenderedBox | null {
	const isWhole = box.x === 0 && box.y === 0 && box.width === image.get_width() && box.height === image.get_height();
	const cropped = isWhole ? image : photon.crop(image, box.x, box.y, box.x + box.width, box.y + box.height);
	try {
		const encoded = encodeWithinLimits(photon, cropped, lossless, opts);
		return encoded && { ...encoded, wasResized: encoded.width !== box.width || encoded.height !== box.height };
	} finally {
		if (cropped !== image) cropped.free();
	}
}

/**
 * Encode an image at the largest size within the size limits and maxBytes, shrinking it until it
 * fits; null if even 1x1 does not. A lossless source stays PNG whenever the PNG fits, so line art
 * and small text keep their edges; JPEG is its fallback at that same size, before any shrinking,
 * because lost resolution costs more detail than JPEG artifacts do.
 */
function encodeWithinLimits(
	photon: Photon,
	source: PhotonImageType,
	lossless: boolean,
	opts: ResolvedOptions,
): EncodedImage | null {
	let { width, height } = fitImageSize(source.get_width(), source.get_height(), opts);
	const jpegQualities = [opts.jpegQuality, ...FALLBACK_JPEG_QUALITIES.filter((quality) => quality < opts.jpegQuality)];
	while (true) {
		const isNative = width === source.get_width() && height === source.get_height();
		const sized = isNative ? source : photon.resize(source, width, height, photon.SamplingFilter.Lanczos3);
		try {
			const png = lossless ? base64Within(sized.get_bytes(), opts.maxBytes) : undefined;
			if (png) return { data: png, mimeType: "image/png", width, height };
			for (const quality of jpegQualities) {
				const jpeg = base64Within(sized.get_bytes_jpeg(quality), opts.maxBytes);
				if (jpeg) {
					return {
						data: jpeg,
						mimeType: "image/jpeg",
						width,
						height,
						...(lossless ? { jpegFallbackQuality: quality } : {}),
					};
				}
			}
		} finally {
			if (sized !== source) sized.free();
		}

		const nextWidth = Math.max(1, Math.floor(width * 0.75));
		const nextHeight = Math.max(1, Math.floor(height * 0.75));
		if (nextWidth === width && nextHeight === height) return null;
		width = nextWidth;
		height = nextHeight;
	}
}
