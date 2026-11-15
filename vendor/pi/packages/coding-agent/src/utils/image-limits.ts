// Pixel-size limits of an image a provider reads without downscaling: an edge box and, for
// providers that bill square patches as visual tokens (Claude: 28 px), a cap on the patch count.

/** The largest image a model reads at native resolution. */
export interface ImageSizeLimits {
	maxWidth: number;
	maxHeight: number;
	/** Edge of the square patch billed as one visual token; the patch cap applies only with maxPatches. */
	patchSize?: number;
	/** Most patches per image: ceil(width / patchSize) * ceil(height / patchSize). */
	maxPatches?: number;
}

export interface ImageSize {
	width: number;
	height: number;
}

function withinLimits(width: number, height: number, limits: ImageSizeLimits): boolean {
	if (width > limits.maxWidth || height > limits.maxHeight) return false;
	const { patchSize, maxPatches } = limits;
	if (!patchSize || !maxPatches) return true;
	return Math.ceil(width / patchSize) * Math.ceil(height / patchSize) <= maxPatches;
}

/**
 * The largest size with the image's aspect ratio that fits the limits: the image itself when it
 * fits. Like Claude's own resize, the long edge is the largest integer that fits, and the short
 * edge is rounded, so an image sent at this size is not downscaled again by the provider.
 */
export function fitImageSize(width: number, height: number, limits: ImageSizeLimits): ImageSize {
	if (withinLimits(width, height, limits)) return { width, height };
	const long = Math.max(width, height);
	const sizeAt = (edge: number): ImageSize =>
		width >= height
			? { width: edge, height: Math.max(1, Math.round((height * edge) / width)) }
			: { width: Math.max(1, Math.round((width * edge) / height)), height: edge };
	// Both edges grow with the long edge, so whether it fits is monotonic in it.
	let low = 1;
	let high = long - 1;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const size = sizeAt(mid);
		if (withinLimits(size.width, size.height, limits)) low = mid;
		else high = mid - 1;
	}
	return sizeAt(low);
}

/**
 * The largest tile for an area so that every tile is read at native resolution. A patch cap makes
 * tiles square, except where the area is narrower than a square tile: there the narrow axis keeps
 * its full length and the other axis takes the rest of the patch budget.
 */
export function tileSize(areaWidth: number, areaHeight: number, limits: ImageSizeLimits): ImageSize {
	const width = Math.min(limits.maxWidth, areaWidth);
	const height = Math.min(limits.maxHeight, areaHeight);
	const { patchSize, maxPatches } = limits;
	if (!patchSize || !maxPatches || withinLimits(width, height, limits)) return { width, height };
	const side = Math.max(1, Math.floor(Math.sqrt(maxPatches))) * patchSize;
	const rest = (edge: number) => Math.max(1, Math.floor(maxPatches / Math.ceil(edge / patchSize))) * patchSize;
	if (width <= side) return { width, height: Math.min(height, rest(width)) };
	if (height <= side) return { width: Math.min(width, rest(height)), height };
	return { width: side, height: side };
}
