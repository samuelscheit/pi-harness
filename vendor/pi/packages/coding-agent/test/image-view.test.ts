import { describe, expect, it } from "vitest";
import { type ImageBox, type ImageViewPlan, planImageView, TILE_OVERLAP } from "../src/utils/image-view.ts";

function tiles(width: number, height: number, maxTile = 2000, maxTiles = 1000, region?: ImageBox) {
	return planImageView({ kind: "tiles", region, maxTiles, maxTotalBytes: 1 }, width, height, maxTile, maxTile);
}

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
		expect(planImageView({ kind: "whole" }, 3439, 2583, 2000, 2000)).toEqual({
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
		expect(planImageView({ kind: "region", region }, 1000, 1000, 2000, 2000)).toEqual({
			ok: true,
			area: region,
			clamped: false,
			boxes: [region],
		});
	});

	it("clamps a region that extends past the image", () => {
		const plan = expectOk(
			planImageView({ kind: "region", region: { x: 900, y: 50, width: 500, height: 5000 } }, 1000, 800, 2000, 2000),
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
		const plan = planImageView({ kind: "region", region }, 1000, 800, 2000, 2000);
		expect(plan.ok).toBe(false);
		expect(plan.ok ? "" : plan.message).toContain(message);
		// Tiles over an invalid region are rejected the same way.
		expect(tiles(1000, 800, 2000, 16, region).ok).toBe(false);
	});
});
