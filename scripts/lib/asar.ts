// Read and rewrite files inside an Electron asar archive in place.
//
// Layout: a pickle holding the header size, a pickle holding the header JSON, then the packed
// files' bytes. Each packed file node has `size`, `offset` (a string, relative to the data start)
// and optionally `integrity`; `unpacked` files live in `<archive>.unpacked/` and have no bytes
// here, so rewriting never touches them. Replacing a file rewrites the header (new size, offsets
// and integrity) and streams every other file's bytes through unchanged.

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, renameSync, writeSync } from "node:fs";

const INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024;

export interface Integrity {
	algorithm: "SHA256";
	hash: string;
	blockSize: number;
	blocks: string[];
}

export interface FileNode {
	size: number;
	offset: string;
	unpacked?: boolean;
	link?: string;
	executable?: boolean;
	integrity?: Integrity;
}

export interface DirectoryNode {
	files: Record<string, DirectoryNode | FileNode>;
}

export interface PackedFile {
	path: string;
	node: FileNode;
}

const isDirectory = (node: DirectoryNode | FileNode): node is DirectoryNode => "files" in node;

const pad4 = (n: number): number => (n + 3) & ~3;

/** The archive's header: `{ header, dataOffset }`, where `dataOffset` is where file bytes start. */
export function readHeader(path: string): { header: DirectoryNode; dataOffset: number } {
	const fd = openSync(path, "r");
	try {
		const sizePickle = Buffer.alloc(8);
		readSync(fd, sizePickle, 0, 8, 0);
		const headerPickleSize = sizePickle.readUInt32LE(4);
		const headerPickle = Buffer.alloc(headerPickleSize);
		readSync(fd, headerPickle, 0, headerPickleSize, 8);
		const length = headerPickle.readUInt32LE(4);
		return { header: JSON.parse(headerPickle.subarray(8, 8 + length).toString("utf8")), dataOffset: 8 + headerPickleSize };
	} finally {
		closeSync(fd);
	}
}

/** Every packed file node, with its path, in archive order. */
export function packedFiles(header: DirectoryNode): PackedFile[] {
	const files: PackedFile[] = [];
	const walk = (node: DirectoryNode, prefix: string) => {
		for (const [name, child] of Object.entries(node.files)) {
			const path = prefix ? `${prefix}/${name}` : name;
			if (isDirectory(child)) walk(child, path);
			else if (!child.unpacked && !child.link) files.push({ path, node: child });
		}
	};
	walk(header, "");
	return files.sort((a, b) => Number(a.node.offset) - Number(b.node.offset));
}

function findFile(header: DirectoryNode, path: string): PackedFile {
	const file = packedFiles(header).find((f) => f.path === path);
	if (!file) throw new Error(`${path}: not a packed file in the archive`);
	return file;
}

export function readFile(path: string, filePath: string): Buffer {
	const { header, dataOffset } = readHeader(path);
	const { node } = findFile(header, filePath);
	const buffer = Buffer.alloc(node.size);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buffer, 0, node.size, dataOffset + Number(node.offset));
	} finally {
		closeSync(fd);
	}
	return buffer;
}

export function integrity(content: Buffer): Integrity {
	const blocks = [];
	// An empty file still has one (empty) block.
	for (let at = 0; at === 0 || at < content.length; at += INTEGRITY_BLOCK_SIZE) {
		blocks.push(createHash("sha256").update(content.subarray(at, at + INTEGRITY_BLOCK_SIZE)).digest("hex"));
	}
	return { algorithm: "SHA256", hash: createHash("sha256").update(content).digest("hex"), blockSize: INTEGRITY_BLOCK_SIZE, blocks };
}

function headerBytes(header: DirectoryNode): Buffer {
	const json = Buffer.from(JSON.stringify(header), "utf8");
	const payload = Buffer.alloc(4 + pad4(json.length));
	payload.writeUInt32LE(json.length, 0);
	json.copy(payload, 4);
	const headerPickle = Buffer.alloc(4 + payload.length);
	headerPickle.writeUInt32LE(payload.length, 0);
	payload.copy(headerPickle, 4);
	const sizePickle = Buffer.alloc(8);
	sizePickle.writeUInt32LE(4, 0);
	sizePickle.writeUInt32LE(headerPickle.length, 4);
	return Buffer.concat([sizePickle, headerPickle]);
}

/** Replace the bytes of packed files (`{ path: Buffer }`), writing a new archive atomically. */
export function replaceFiles(path: string, replacements: Record<string, Buffer>): void {
	const { header, dataOffset } = readHeader(path);
	const files = packedFiles(header);
	for (const filePath of Object.keys(replacements)) findFile(header, filePath);
	const sources = files.map(({ path: filePath, node }) => ({ node, offset: Number(node.offset), size: node.size, content: replacements[filePath] }));
	let next = 0;
	for (const source of sources) {
		source.node.offset = String(next);
		if (source.content) {
			source.node.size = source.content.length;
			source.node.integrity = integrity(source.content);
		}
		next += source.node.size;
	}
	const temporary = `${path}.rewrite`;
	const input = openSync(path, "r");
	const output = openSync(temporary, "w");
	try {
		writeSync(output, headerBytes(header));
		const chunk = Buffer.alloc(8 * 1024 * 1024);
		for (const source of sources) {
			if (source.content) {
				writeSync(output, source.content);
				continue;
			}
			for (let done = 0; done < source.size; ) {
				const read = readSync(input, chunk, 0, Math.min(chunk.length, source.size - done), dataOffset + source.offset + done);
				if (read <= 0) throw new Error(`unexpected end of archive in ${path}`);
				writeSync(output, chunk, 0, read);
				done += read;
			}
		}
	} finally {
		closeSync(input);
		closeSync(output);
	}
	renameSync(temporary, path);
}
