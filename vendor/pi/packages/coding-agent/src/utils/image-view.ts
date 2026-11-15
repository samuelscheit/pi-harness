// Plans which pixel boxes of an image to send: the whole image, one region, or a grid of tiles.

import { type ImageSizeLimits, tileSize } from "./image-limits.ts";

/** A rectangle in original image pixels. */
export interface ImageBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** What part of an image to render, and how. */
export type ImageView =
	| { kind: "whole" }
	| { kind: "region"; region: ImageBox }
	| {
			kind: "tiles";
			/** Area to tile; the whole image when omitted. */
			region?: ImageBox;
			/** Most tiles to return; the rest is reported as remaining area. */
			maxTiles: number;
			/** Encoded size budget shared by all tiles, in base64 bytes. */
			maxTotalBytes: number;
	  };

/** The tile grid of a tiles view, with the area left out when the grid exceeds the tile cap. */
export interface TileGrid {
	columns: number;
	rows: number;
	overlap: number;
	/** Tiles in the full grid; more than the boxes returned when capped. */
	total: number;
	/** Areas not covered by the returned tiles, as regions to read next. Empty when not capped. */
	remaining: ImageBox[];
}

export type ImageViewPlan =
	| { ok: true; area: ImageBox; clamped: boolean; boxes: ImageBox[]; grid?: TileGrid }
	| { ok: false; message: string };

/** Overlap between neighbouring tiles, so text cut by a tile edge is whole in one of them. */
export const TILE_OVERLAP = 64;

/**
 * Plan the boxes to render for a view of an image of the given size. Regions are clamped to the
 * image; regions that start outside it or have no area are rejected. Tiles are the largest size
 * the limits let the model read natively, overlap by about TILE_OVERLAP pixels and cover the area.
 */
export function planImageView(
	view: ImageView,
	imageWidth: number,
	imageHeight: number,
	limits: ImageSizeLimits,
): ImageViewPlan {
	const full: ImageBox = { x: 0, y: 0, width: imageWidth, height: imageHeight };
	if (view.kind === "whole") return { ok: true, area: full, clamped: false, boxes: [full] };
	const area = view.region ? clampRegion(view.region, imageWidth, imageHeight) : { ok: true as const, box: full };
	if (!area.ok) return area;
	const clamped = view.region !== undefined && !sameBox(area.box, view.region);
	if (view.kind === "region") return { ok: true, area: area.box, clamped, boxes: [area.box] };

	const { width: maxTileWidth, height: maxTileHeight } = tileSize(area.box.width, area.box.height, limits);
	const columns = splitAxis(area.box.x, area.box.width, maxTileWidth);
	const rows = splitAxis(area.box.y, area.box.height, maxTileHeight);
	const all = rows.flatMap((row) => columns.map((column) => boxOf(column, row)));
	const maxTiles = Math.max(1, Math.floor(view.maxTiles));
	const grid: TileGrid = {
		columns: columns.length,
		rows: rows.length,
		overlap: Math.min(overlapFor(maxTileWidth), overlapFor(maxTileHeight)),
		total: all.length,
		remaining: all.length > maxTiles ? remainingArea(area.box, columns, rows, maxTiles) : [],
	};
	return { ok: true, area: area.box, clamped, boxes: all.slice(0, maxTiles), grid };
}

/** "x=10 y=20 w=300 h=400", the form used in tile labels and notes. */
export function formatBox(box: ImageBox): string {
	return `x=${box.x} y=${box.y} w=${box.width} h=${box.height}`;
}

/** The region as read tool arguments, for notes that tell the model what to read next. */
export function formatRegionArgument(box: ImageBox): string {
	return `region: {x: ${box.x}, y: ${box.y}, width: ${box.width}, height: ${box.height}}`;
}

function clampRegion(
	region: ImageBox,
	imageWidth: number,
	imageHeight: number,
): { ok: true; box: ImageBox } | { ok: false; message: string } {
	const { x, y, width, height } = region;
	// Region values come from model-written tool arguments.
	if (![x, y, width, height].every(Number.isInteger)) {
		return { ok: false, message: `Invalid region ${formatBox(region)}: values must be integers.` };
	}
	if (x < 0 || y < 0 || width < 1 || height < 1) {
		return {
			ok: false,
			message: `Invalid region ${formatBox(region)}: x and y must be >= 0, width and height >= 1.`,
		};
	}
	if (x >= imageWidth || y >= imageHeight) {
		return {
			ok: false,
			message: `Invalid region ${formatBox(region)}: it starts outside the ${imageWidth}x${imageHeight} image.`,
		};
	}
	return {
		ok: true,
		box: { x, y, width: Math.min(width, imageWidth - x), height: Math.min(height, imageHeight - y) },
	};
}

function sameBox(a: ImageBox, b: ImageBox): boolean {
	return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

interface Span {
	start: number;
	length: number;
}

function overlapFor(maxTile: number): number {
	return Math.min(TILE_OVERLAP, Math.floor(maxTile / 4));
}

/**
 * Split [start, start + length) into the fewest spans of at most maxTile that overlap by at least
 * the overlap, all of equal size and spread evenly so the last one ends at the area's edge.
 */
function splitAxis(start: number, length: number, maxTile: number): Span[] {
	if (length <= maxTile) return [{ start, length }];
	const overlap = overlapFor(maxTile);
	const count = Math.ceil((length - overlap) / (maxTile - overlap));
	// count * (maxTile - overlap) >= length - overlap, so size <= maxTile.
	const size = Math.ceil((length + (count - 1) * overlap) / count);
	return Array.from({ length: count }, (_, i) => ({
		start: start + Math.floor((i * (length - size)) / (count - 1)),
		length: size,
	}));
}

function boxOf(column: Span, row: Span): ImageBox {
	return { x: column.start, y: row.start, width: column.length, height: row.length };
}

/** The area of a row-major grid left out after its first `shown` tiles, as at most two regions. */
function remainingArea(area: ImageBox, columns: Span[], rows: Span[], shown: number): ImageBox[] {
	const lastRow = Math.floor((shown - 1) / columns.length);
	const shownInLastRow = shown - lastRow * columns.length;
	const regions: ImageBox[] = [];
	if (shownInLastRow < columns.length) {
		const x = columns[shownInLastRow].start;
		const row = rows[lastRow];
		regions.push({ x, y: row.start, width: area.x + area.width - x, height: row.length });
	}
	if (lastRow + 1 < rows.length) {
		const y = rows[lastRow + 1].start;
		regions.push({ x: area.x, y, width: area.width, height: area.y + area.height - y });
	}
	return regions;
}
