import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, ImageContent, Model, ModelInputLimits, TextContent } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionToolContext, ToolDefinition } from "../src/core/extensions/types.ts";
import {
	createReadTool,
	createReadToolDefinition,
	type ReadToolDetails,
	type ReadToolInput,
} from "../src/core/tools/read.ts";
import { loadPhoton } from "../src/utils/photon.ts";

type Photon = NonNullable<Awaited<ReturnType<typeof loadPhoton>>>;
type ReadResult = {
	content: (TextContent | ImageContent)[];
	details: ReadToolDetails | undefined;
	structuredContent?: unknown;
};

let photon: Photon;
let dir: string;

beforeAll(async () => {
	const loaded = await loadPhoton();
	if (!loaded) throw new Error("Photon not available");
	photon = loaded;
	dir = mkdtempSync(join(tmpdir(), "read-image-"));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A PNG whose red and green channels encode the pixel position, so crops can be checked. */
function writePng(name: string, width: number, height: number): string {
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			pixels[i] = (x >> 2) & 255;
			pixels[i + 1] = (y >> 2) & 255;
			pixels[i + 2] = 0;
			pixels[i + 3] = 255;
		}
	}
	const image = new photon.PhotonImage(pixels, width, height);
	const path = join(dir, name);
	try {
		writeFileSync(path, image.get_bytes());
	} finally {
		image.free();
	}
	return path;
}

/** Width, height and top-left pixel of an image block. */
function decode(block: ImageContent): { width: number; height: number; red: number; green: number } {
	const image = photon.PhotonImage.new_from_byteslice(Buffer.from(block.data, "base64"));
	try {
		const pixels = image.get_raw_pixels();
		return { width: image.get_width(), height: image.get_height(), red: pixels[0], green: pixels[1] };
	} finally {
		image.free();
	}
}

function model(inputLimits: ModelInputLimits): Model<Api> {
	return {
		id: "vision-model",
		name: "Vision model",
		api: "test",
		provider: "test",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text", "image"],
		inputLimits,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

async function read(
	args: ReadToolInput,
	resize?: { maxWidth: number; maxHeight: number },
	inputLimits: ModelInputLimits = {},
): Promise<ReadResult> {
	const ctx = { cwd: dir, model: model({ ...inputLimits, images: { ...inputLimits.images, resize } }) };
	return createReadToolDefinition(dir).execute(
		"read",
		args,
		undefined,
		undefined,
		ctx as unknown as ExtensionToolContext,
	);
}

function texts(result: ReadResult): string[] {
	return result.content.filter((block) => block.type === "text").map((block) => block.text);
}

function images(result: ReadResult): ImageContent[] {
	return result.content.filter((block) => block.type === "image");
}

function renderCollapsed(details: ReadToolDetails | undefined): string {
	const tool = createReadToolDefinition(dir) as ToolDefinition;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
	const component = tool.renderResult!({ content: [], details }, { expanded: false, isPartial: false }, theme, {
		args: { path: "x.png" },
		state: {},
		lastComponent: undefined,
		invalidate: () => {},
		toolCallId: "read",
		cwd: dir,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 0,
		keyText: () => "",
		keyHint: (_keybinding, description) => description,
	});
	return component.render(400).join("\n");
}

describe("read image downscale notice", () => {
	it("adds no notice when the image fits", async () => {
		const result = await read({ path: writePng("small.png", 120, 80) }, { maxWidth: 200, maxHeight: 200 });
		expect(texts(result)).toEqual(["Read image file [image/png]"]);
		expect(decode(images(result)[0])).toMatchObject({ width: 120, height: 80 });
		expect(result.details).toBeUndefined();
		expect(renderCollapsed(result.details).trim()).toBe("");
	});

	it("starts with the factor, both sizes and how to read natively when downscaled", async () => {
		const result = await read({ path: writePng("large.png", 688, 517) }, { maxWidth: 200, maxHeight: 200 });
		const [text] = texts(result);
		const [first, second] = text.split("\n");
		expect(first).toBe(
			"[Image downscaled 3.44x: original 688x517, sent at 200x150. Small text and fine detail may be unreadable. To read at native resolution, call read again with tiles: true (the whole image as a grid of native-resolution tiles) or region: {x, y, width, height} in original pixels (multiply coordinates in this image by 3.44).]",
		);
		expect(second).toBe("Read image file [image/png]");
		expect(decode(images(result)[0])).toMatchObject({ width: 200, height: 150 });
		expect(result.details?.imageNotice).toBe(first);
		// The user sees the same line in the collapsed tool row.
		expect(renderCollapsed(result.details)).toContain(first);
	});

	it("reports the incident's 3439x2583 image as downscaled 1.72x to 2000x1502 with the default profile", async () => {
		const path = writePng("incident.png", 3439, 2583);
		// No model: the built-in 2000x2000 profile, as in the incident.
		const result = await createReadTool(dir).execute("read", { path });
		expect(texts(result as ReadResult)[0]).toMatch(
			/^\[Image downscaled 1\.72x: original 3439x2583, sent at 2000x1502\./,
		);
	}, 30_000);
});

describe("read image tiles", () => {
	it("returns native tiles labeled with their boxes that cover the whole image", async () => {
		const result = await read(
			{ path: writePng("grid.png", 450, 330), tiles: true },
			{ maxWidth: 200, maxHeight: 200 },
		);
		const [header, ...labels] = texts(result);
		expect(header).toBe(
			"Read image file [image/png]\n6 tiles at native resolution: grid 3x2 over x=0 y=0 w=450 h=330 of the 450x330 image, neighbouring tiles overlap by 50 px. Each tile follows its pixel box in original image coordinates.",
		);
		const tiles = images(result);
		expect(tiles).toHaveLength(6);
		expect(labels).toHaveLength(6);
		const boxes: { x: number; y: number; width: number; height: number }[] = [];
		labels.forEach((label, index) => {
			const match = label.match(/^Tile (\d+)\/6: x=(\d+) y=(\d+) w=(\d+) h=(\d+)$/);
			expect(match, label).not.toBeNull();
			const [, number, x, y, width, height] = match!.map(Number);
			expect(number).toBe(index + 1);
			// Native resolution: the tile has its box's size, and its first pixel is the box's corner.
			const pixel = decode(tiles[index]);
			expect(pixel).toMatchObject({ width, height });
			expect(Math.abs(pixel.red - ((x >> 2) & 255))).toBeLessThanOrEqual(2);
			expect(Math.abs(pixel.green - ((y >> 2) & 255))).toBeLessThanOrEqual(2);
			boxes.push({ x, y, width, height });
		});
		for (let py = 0; py < 330; py++) {
			for (let px = 0; px < 450; px++) {
				const inside = boxes.some((b) => px >= b.x && px < b.x + b.width && py >= b.y && py < b.y + b.height);
				if (!inside) throw new Error(`pixel ${px},${py} is in no tile`);
			}
		}
		// Neighbouring tiles overlap.
		expect(boxes[0].x + boxes[0].width).toBeGreaterThan(boxes[1].x);
		expect(boxes[0].y + boxes[0].height).toBeGreaterThan(boxes[3].y);
		expect(result.details).toBeUndefined();
		// Programmatic callers get every tile, each with its label as the note.
		expect(result.structuredContent).toHaveLength(6);
		expect((result.structuredContent as { note: string }[])[1].note).toBe(labels[1]);
	});

	it("caps a huge image at the maximum tile count with a notice naming the rest", async () => {
		const result = await read(
			{ path: writePng("huge.png", 1000, 1000), tiles: true },
			{ maxWidth: 50, maxHeight: 50 },
		);
		expect(images(result)).toHaveLength(16);
		const first = texts(result)[0].split("\n")[0];
		expect(first).toMatch(
			/^\[Tiles capped: showing 16 of 676 tiles \(at most 16 per read\)\. Not shown: region: \{x: \d+, y: 0, width: \d+, height: 50\} and region: \{x: 0, y: \d+, width: 1000, height: \d+\}\. Call read again with tiles: true and that region to see the rest\.\]$/,
		);
		expect(result.details?.imageNotice).toBe(first);
		expect(renderCollapsed(result.details)).toContain("Tiles capped: showing 16 of 676 tiles");
	});

	it("caps tiles at the model's per-message image limit", async () => {
		const result = await read(
			{ path: writePng("permessage.png", 450, 330), tiles: true },
			{ maxWidth: 200, maxHeight: 200 },
			{ images: { maxPerMessage: 2 } },
		);
		expect(images(result)).toHaveLength(2);
		expect(texts(result)[0]).toMatch(/^\[Tiles capped: showing 2 of 6 tiles \(at most 2 per read\)/);
	});

	it("downscales tiles to fit the request byte budget and says so", async () => {
		// Half of 6000 bytes shared by 6 tiles leaves 500 bytes each, too small for a 150x165 native tile.
		const result = await read(
			{ path: writePng("budget.png", 450, 330), tiles: true },
			{ maxWidth: 200, maxHeight: 200 },
			{ maxRequestBytes: 6000 },
		);
		const [header] = texts(result);
		expect(header.split("\n")[0]).toBe(
			"[Some tiles were downscaled to fit the request size budget (marked below). Read a smaller region for native resolution.]",
		);
		expect(texts(result).some((text) => / \(downscaled to \d+x\d+\)$/.test(text))).toBe(true);
		for (const tile of images(result)) expect(tile.data.length).toBeLessThan(500);
	});

	it("tiles only the requested region", async () => {
		const result = await read(
			{
				path: writePng("regiontiles.png", 450, 330),
				tiles: true,
				region: { x: 100, y: 40, width: 250, height: 100 },
			},
			{ maxWidth: 200, maxHeight: 200 },
		);
		expect(texts(result)[0]).toContain("grid 2x1 over x=100 y=40 w=250 h=100 of the 450x330 image");
		expect(texts(result).slice(1)).toEqual(["Tile 1/2: x=100 y=40 w=150 h=100", "Tile 2/2: x=200 y=40 w=150 h=100"]);
	});
});

describe("read image region", () => {
	it("returns the region at native resolution", async () => {
		const result = await read(
			{ path: writePng("region.png", 688, 517), region: { x: 300, y: 200, width: 120, height: 60 } },
			{ maxWidth: 200, maxHeight: 200 },
		);
		expect(texts(result)).toEqual([
			"Read image file [image/png]\nRegion x=300 y=200 w=120 h=60 of the 688x517 image.",
		]);
		const pixel = decode(images(result)[0]);
		expect(pixel).toMatchObject({ width: 120, height: 60 });
		expect(Math.abs(pixel.red - (300 >> 2))).toBeLessThanOrEqual(2);
		expect(Math.abs(pixel.green - (200 >> 2))).toBeLessThanOrEqual(2);
	});

	it("clamps a region past the image bounds and says so", async () => {
		const result = await read(
			{ path: writePng("clamp.png", 300, 200), region: { x: 250, y: 150, width: 500, height: 500 } },
			{ maxWidth: 200, maxHeight: 200 },
		);
		expect(texts(result)[0]).toContain("Region x=250 y=150 w=50 h=50 of the 300x200 image.");
		expect(texts(result)[0]).toContain("[Requested region x=250 y=150 w=500 h=500 was clamped to the image bounds.]");
		expect(decode(images(result)[0])).toMatchObject({ width: 50, height: 50 });
	});

	it("puts the downscale notice first when the region exceeds the size limit", async () => {
		const result = await read(
			{ path: writePng("bigregion.png", 688, 517), region: { x: 0, y: 0, width: 400, height: 300 } },
			{ maxWidth: 200, maxHeight: 200 },
		);
		expect(texts(result)[0].split("\n")[0]).toBe(
			"[Image downscaled 2.00x: region x=0 y=0 w=400 h=300 sent at 200x150. Small text and fine detail may be unreadable. To read it at native resolution, call read again with tiles: true and the same region.]",
		);
		expect(result.details?.imageNotice).toContain("downscaled 2.00x");
	});

	it.each([
		[{ x: 300, y: 0, width: 10, height: 10 }, "starts outside the 300x200 image"],
		[{ x: 0, y: 200, width: 10, height: 10 }, "starts outside the 300x200 image"],
	])("rejects region %j as a tool error", async (region, message) => {
		const path = writePng("invalid.png", 300, 200);
		await expect(read({ path, region })).rejects.toThrow(message);
		await expect(read({ path, region, tiles: true })).rejects.toThrow(message);
	});

	it("rejects tiles and region for text files", async () => {
		const path = join(dir, "notes.txt");
		writeFileSync(path, "hello\n");
		await expect(read({ path, tiles: true })).rejects.toThrow("tiles and region apply only to image files.");
		await expect(read({ path, region: { x: 0, y: 0, width: 1, height: 1 } })).rejects.toThrow(
			"tiles and region apply only to image files.",
		);
	});
});
