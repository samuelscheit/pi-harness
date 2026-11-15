import { describe, expect, it } from "vitest";
import { fitImageSize, type ImageSizeLimits, tileSize } from "../src/utils/image-limits.ts";
import { type ImageBox, type ImageViewPlan, planImageView, TILE_OVERLAP } from "../src/utils/image-view.ts";

const BOX_2000: ImageSizeLimits = { maxWidth: 2000, maxHeight: 2000 };
// Claude's tiers: https://platform.claude.com/docs/en/build-with-claude/vision#resolution-and-token-cost
const CLAUDE_STANDARD: ImageSizeLimits = { maxWidth: 1568, maxHeight: 1568, patchSize: 28, maxPatches: 1568 };
const CLAUDE_HIGH_RES: ImageSizeLimits = { maxWidth: 2576, maxHeight: 2576, patchSize: 28, maxPatches: 4784 };

function patches(width: number, height: number, patchSize = 28): number {
	return Math.ceil(width / patchSize) * Math.ceil(height / patchSize);
}

function tiles(width: number, height: number, maxTile = 2000, maxTiles = 1000, region?: ImageBox) {
	return tilesWithin(width, height, { maxWidth: maxTile, maxHeight: maxTile }, maxTiles, region);
}

function tilesWithin(width: number, height: number, limits: ImageSizeLimits, maxTiles = 1000, region?: ImageBox) {
	return planImageView({ kind: "tiles", region, maxTiles, maxTotalBytes: 1 }, width, height, limits);
}

describe("fitImageSize", () => {
	// The examples Anthropic documents for its own downscaling, so a pre-resized image is not resized again.
	it.each([
		[1920, 1080, CLAUDE_STANDARD, 1456, 819],
		[2000, 1500, CLAUDE_STANDARD, 1269, 952],
		[3840, 2160, CLAUDE_STANDARD, 1456, 819],
		[1075, 1520, CLAUDE_STANDARD, 924, 1307],
		[1092, 1092, CLAUDE_STANDARD, 1092, 1092],
		[1920, 1080, CLAUDE_HIGH_RES, 1920, 1080],
		[2000, 1500, CLAUDE_HIGH_RES, 2000, 1500],
		[3840, 2160, CLAUDE_HIGH_RES, 2576, 1449],
		[1075, 1520, CLAUDE_HIGH_RES, 1075, 1520],
	])("fits %ix%i to %o as %ix%i", (width, height, limits, expectedWidth, expectedHeight) => {
		expect(fitImageSize(width, height, limits)).toEqual({ width: expectedWidth, height: expectedHeight });
	});

	it("binds on the patch cap before the edge cap: the incident's 3439x2583 scan on a high-res model", () => {
		const fitted = fitImageSize(3439, 2583, CLAUDE_HIGH_RES);
		// The edge cap alone would allow 2576x1935, which is 6440 patches.
		expect(patches(2576, 1935)).toBeGreaterThan(4784);
		// 79x60 patches = 4740; one pixel more on the long edge starts an 80th column: 80x60 = 4800.
		expect(fitted).toEqual({ width: 2212, height: 1661 });
		expect(patches(fitted.width, fitted.height)).toBe(4740);
		expect(patches(2213, Math.round((2583 * 2213) / 3439))).toBe(4800);
	});

	it("binds on the edge cap for elongated images", () => {
		expect(fitImageSize(10000, 500, CLAUDE_HIGH_RES)).toEqual({ width: 2576, height: 129 });
		expect(fitImageSize(300, 9000, CLAUDE_STANDARD)).toEqual({ width: 52, height: 1568 });
	});

	it("keeps the box-only behaviour without a patch cap", () => {
		expect(fitImageSize(3439, 2583, BOX_2000)).toEqual({ width: 2000, height: 1502 });
		expect(fitImageSize(2000, 2000, BOX_2000)).toEqual({ width: 2000, height: 2000 });
		// The long edge is the largest that fits; the short edge is rounded (1601 * 1000 / 4000 = 400.25).
		expect(fitImageSize(4000, 1000, { maxWidth: 2000, maxHeight: 400 })).toEqual({ width: 1601, height: 400 });
	});

	it("never returns a size above the limits or below 1x1, for many shapes", () => {
		for (const limits of [CLAUDE_STANDARD, CLAUDE_HIGH_RES, { ...CLAUDE_STANDARD, maxPatches: 1 }]) {
			for (const [width, height] of [
				[1, 1],
				[1, 100000],
				[100000, 1],
				[8000, 8000],
				[2577, 2576],
				[2591, 1459],
				[1569, 29],
			]) {
				const fitted = fitImageSize(width, height, limits);
				expect(fitted.width).toBeGreaterThanOrEqual(1);
				expect(fitted.height).toBeGreaterThanOrEqual(1);
				expect(fitted.width).toBeLessThanOrEqual(Math.min(width, limits.maxWidth));
				expect(fitted.height).toBeLessThanOrEqual(Math.min(height, limits.maxHeight));
				expect(patches(fitted.width, fitted.height)).toBeLessThanOrEqual(limits.maxPatches!);
			}
		}
	});
});

describe("tileSize", () => {
	it("is the edge box without a patch cap", () => {
		expect(tileSize(5000, 5000, BOX_2000)).toEqual({ width: 2000, height: 2000 });
		expect(tileSize(300, 5000, BOX_2000)).toEqual({ width: 300, height: 2000 });
	});

	it("is the largest square of whole patches under the patch cap", () => {
		// floor(sqrt(4784)) = 69 patches; floor(sqrt(1568)) = 39 patches.
		expect(tileSize(5000, 5000, CLAUDE_HIGH_RES)).toEqual({ width: 1932, height: 1932 });
		expect(tileSize(5000, 5000, CLAUDE_STANDARD)).toEqual({ width: 1092, height: 1092 });
	});

	it("gives a narrow area's patch budget to its long axis", () => {
		// 500 px is 18 patches wide, leaving floor(4784 / 18) = 265 patches; the edge cap binds first.
		expect(tileSize(500, 9000, CLAUDE_HIGH_RES)).toEqual({ width: 500, height: 2576 });
		// 1000 px is 36 patches, leaving 132 patches = 3696 px, capped at 2576.
		expect(tileSize(1000, 9000, CLAUDE_HIGH_RES)).toEqual({ width: 1000, height: 2576 });
		// 1500 px is 54 patches, leaving 88 patches = 2464 px.
		expect(tileSize(1500, 9000, CLAUDE_HIGH_RES)).toEqual({ width: 1500, height: 2464 });
		expect(tileSize(9000, 1500, CLAUDE_HIGH_RES)).toEqual({ width: 2464, height: 1500 });
	});

	it("is the whole area when it fits", () => {
		expect(tileSize(2000, 1500, CLAUDE_HIGH_RES)).toEqual({ width: 2000, height: 1500 });
	});
});

function expectOk(plan: ImageViewPlan): Extract<ImageViewPlan, { ok: true }> {
	if (!plan.ok) throw new Error(`expected a plan, got: ${plan.message}`);
	return plan;
}

function contains(box: ImageBox, x: number, y: number): boolean {
	return x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
}

/** Distinct sorted spans of the boxes along one axis. */
function spans(boxes: ImageBox[], axis: "x" | "y"): [number, number][] {
	const size = axis === "x" ? "width" : "height";
	const keys = new Set(boxes.map((box) => `${box[axis]},${box[axis] + box[size]}`));
	return [...keys].map((key) => key.split(",").map(Number) as [number, number]).sort((a, b) => a[0] - b[0]);
}

/** Checks one axis of a grid: spans start at the area start, end at its end, and overlap neighbours by `overlap`. */
function expectAxisCovered(
	axisSpans: [number, number][],
	start: number,
	end: number,
	maxTile: number,
	overlap: number,
) {
	expect(axisSpans[0][0]).toBe(start);
	expect(axisSpans.at(-1)![1]).toBe(end);
	for (const [from, to] of axisSpans) expect(to - from).toBeLessThanOrEqual(maxTile);
	for (let i = 1; i < axisSpans.length; i++) {
		expect(axisSpans[i - 1][1] - axisSpans[i][0]).toBeGreaterThanOrEqual(overlap);
	}
}

describe("planImageView whole", () => {
	it("returns the full image as one box", () => {
		expect(planImageView({ kind: "whole" }, 3439, 2583, BOX_2000)).toEqual({
			ok: true,
			area: { x: 0, y: 0, width: 3439, height: 2583 },
			clamped: false,
			boxes: [{ x: 0, y: 0, width: 3439, height: 2583 }],
		});
	});
});

describe("planImageView tiles", () => {
	it("tiles the 3439x2583 image from the incident into a 2x2 grid of native tiles", () => {
		const plan = expectOk(tiles(3439, 2583));
		expect(plan.grid).toMatchObject({ columns: 2, rows: 2, total: 4, overlap: TILE_OVERLAP, remaining: [] });
		expect(plan.boxes).toEqual([
			{ x: 0, y: 0, width: 1752, height: 1324 },
			{ x: 1687, y: 0, width: 1752, height: 1324 },
			{ x: 0, y: 1259, width: 1752, height: 1324 },
			{ x: 1687, y: 1259, width: 1752, height: 1324 },
		]);
	});

	it("tiles the 7016x4960 image from the incident into a 4x3 grid that covers it", () => {
		const plan = expectOk(tiles(7016, 4960));
		expect(plan.grid).toMatchObject({ columns: 4, rows: 3, total: 12 });
		expect(plan.boxes).toHaveLength(12);
		expectAxisCovered(spans(plan.boxes, "x"), 0, 7016, 2000, TILE_OVERLAP);
		expectAxisCovered(spans(plan.boxes, "y"), 0, 4960, 2000, TILE_OVERLAP);
	});

	it("covers every pixel, stays within the tile size and overlaps neighbours, for many sizes", () => {
		for (const maxTile of [1, 2, 3, 7, 100, 256, 2000]) {
			for (const length of [
				1,
				2,
				maxTile - 1,
				maxTile,
				maxTile + 1,
				2 * maxTile,
				2 * maxTile + 1,
				5 * maxTile - 3,
				9973,
			]) {
				if (length < 1) continue;
				const plan = expectOk(tiles(length, 1, maxTile, Number.POSITIVE_INFINITY));
				expect(plan.grid?.remaining).toEqual([]);
				const overlap = Math.min(TILE_OVERLAP, Math.floor(maxTile / 4));
				const axis = spans(plan.boxes, "x");
				expectAxisCovered(axis, 0, length, maxTile, length <= maxTile ? 0 : overlap);
				// Fewest tiles: one fewer could not cover the length with the required overlap.
				const count = axis.length;
				if (count > 1) expect((count - 1) * (maxTile - overlap) + overlap).toBeLessThan(length);
				expect(plan.boxes.every((box) => box.height === 1 && box.y === 0)).toBe(true);
			}
		}
	});

	it("returns one tile when the image fits a tile, and two when it is one pixel larger", () => {
		expect(expectOk(tiles(2000, 2000)).boxes).toEqual([{ x: 0, y: 0, width: 2000, height: 2000 }]);
		expect(expectOk(tiles(2001, 10)).boxes).toEqual([
			{ x: 0, y: 0, width: 1033, height: 10 },
			{ x: 968, y: 0, width: 1033, height: 10 },
		]);
	});

	it("tiles a region in original image coordinates", () => {
		const region = { x: 500, y: 300, width: 2500, height: 1000 };
		const plan = expectOk(tiles(7016, 4960, 2000, 1000, region));
		expect(plan.area).toEqual(region);
		expectAxisCovered(spans(plan.boxes, "x"), 500, 3000, 2000, TILE_OVERLAP);
		expectAxisCovered(spans(plan.boxes, "y"), 300, 1300, 2000, 0);
	});
});

describe("planImageView tiles under a patch cap", () => {
	it("tiles the incident's 3439x2583 scan for a high-res model so the API reads every tile natively", () => {
		const plan = expectOk(tilesWithin(3439, 2583, CLAUDE_HIGH_RES));
		expect(plan.grid).toMatchObject({ columns: 2, rows: 2, total: 4, overlap: TILE_OVERLAP });
		for (const box of plan.boxes) {
			expect(patches(box.width, box.height)).toBeLessThanOrEqual(4784);
			expect(box.width).toBeLessThanOrEqual(1932);
			expect(box.height).toBeLessThanOrEqual(1932);
		}
		expectAxisCovered(spans(plan.boxes, "x"), 0, 3439, 1932, TILE_OVERLAP);
		expectAxisCovered(spans(plan.boxes, "y"), 0, 2583, 1932, TILE_OVERLAP);
	});

	it("uses smaller tiles for a standard model than for a high-res one", () => {
		const standard = expectOk(tilesWithin(3439, 2583, CLAUDE_STANDARD));
		expect(standard.grid).toMatchObject({ columns: 4, rows: 3 });
		for (const box of standard.boxes) expect(patches(box.width, box.height)).toBeLessThanOrEqual(1568);
	});

	it("tiles a tall narrow strip in one column of tall tiles", () => {
		const plan = expectOk(tilesWithin(500, 9000, CLAUDE_HIGH_RES));
		expect(plan.grid).toMatchObject({ columns: 1, rows: 4 });
		for (const box of plan.boxes) expect(patches(box.width, box.height)).toBeLessThanOrEqual(4784);
	});
});

describe("planImageView tile cap", () => {
	it("caps a huge image at maxTiles and names the rest as regions that cover it", () => {
		const plan = expectOk(tiles(50000, 50000, 2000, 16));
		expect(plan.boxes).toHaveLength(16);
		expect(plan.grid?.total).toBe(26 * 26);
		// 16 tiles of a 26-column grid end mid-row: the rest of row 0, then everything below it.
		expect(plan.grid?.remaining).toEqual([
			{ x: plan.grid!.remaining[0].x, y: 0, width: 50000 - plan.grid!.remaining[0].x, height: plan.boxes[0].height },
			{ x: 0, y: plan.grid!.remaining[1].y, width: 50000, height: 50000 - plan.grid!.remaining[1].y },
		]);
		const covered = [...plan.boxes, ...plan.grid!.remaining];
		for (let y = 0; y < 50000; y += 997) {
			for (let x = 0; x < 50000; x += 997) {
				expect(covered.some((box) => contains(box, x, y))).toBe(true);
			}
		}
	});

	it("names only the area below when the cap ends at a row end", () => {
		const plan = expectOk(tiles(6000, 6000, 2000, 4));
		expect(plan.grid).toMatchObject({ columns: 4, rows: 4, total: 16 });
		expect(plan.boxes.every((box) => box.y === 0)).toBe(true);
		expect(plan.grid?.remaining).toEqual([
			{ x: 0, y: plan.grid!.remaining[0].y, width: 6000, height: 6000 - plan.grid!.remaining[0].y },
		]);
		// The next region starts inside the shown row, so it keeps the overlap.
		expect(plan.grid!.remaining[0].y).toBeLessThan(plan.boxes[0].height);
	});

	it("names only the rest of the row for a very wide image", () => {
		const plan = expectOk(tiles(100000, 10, 2000, 16));
		expect(plan.boxes).toHaveLength(16);
		expect(plan.grid?.remaining).toEqual([
			{ x: plan.grid!.remaining[0].x, y: 0, width: 100000 - plan.grid!.remaining[0].x, height: 10 },
		]);
		expect(plan.grid!.remaining[0].x).toBeLessThan(plan.boxes[15].x + plan.boxes[15].width);
	});

	it("keeps at least one tile for a cap below one", () => {
		expect(expectOk(tiles(5000, 5000, 2000, 0)).boxes).toHaveLength(1);
	});
});

describe("planImageView region", () => {
	it("keeps a region inside the image unchanged", () => {
		const region = { x: 10, y: 20, width: 300, height: 400 };
		expect(planImageView({ kind: "region", region }, 1000, 1000, BOX_2000)).toEqual({
			ok: true,
			area: region,
			clamped: false,
			boxes: [region],
		});
	});

	it("clamps a region that extends past the image", () => {
		const plan = expectOk(
			planImageView({ kind: "region", region: { x: 900, y: 50, width: 500, height: 5000 } }, 1000, 800, BOX_2000),
		);
		expect(plan.boxes).toEqual([{ x: 900, y: 50, width: 100, height: 750 }]);
		expect(plan.clamped).toBe(true);
	});

	it.each([
		[{ x: 1000, y: 0, width: 10, height: 10 }, "starts outside the 1000x800 image"],
		[{ x: 0, y: 800, width: 10, height: 10 }, "starts outside the 1000x800 image"],
		[{ x: -1, y: 0, width: 10, height: 10 }, "x and y must be >= 0"],
		[{ x: 0, y: 0, width: 0, height: 10 }, "width and height >= 1"],
		[{ x: 0, y: 0, width: 10, height: -5 }, "width and height >= 1"],
		[{ x: 0.5, y: 0, width: 10, height: 10 }, "must be integers"],
		[{ x: 0, y: 0, width: Number.NaN, height: 10 }, "must be integers"],
	])("rejects %j", (region, message) => {
		const plan = planImageView({ kind: "region", region }, 1000, 800, BOX_2000);
		expect(plan.ok).toBe(false);
		expect(plan.ok ? "" : plan.message).toContain(message);
		// Tiles over an invalid region are rejected the same way.
		expect(tiles(1000, 800, 2000, 16, region).ok).toBe(false);
	});
});
