import { inflateRawSync } from "node:zlib";

/**
 * The files of a zip archive, by name: enough of the format to read what
 * the service hands back for a skill version (its folder, zipped). Stored
 * and deflated entries only, which is what every zip writer emits for text;
 * anything else throws rather than reading as empty.
 */
const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

export function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let end = bytes.length - 22;
	while (end >= 0 && view.getUint32(end, true) !== END_OF_DIRECTORY) end--;
	if (end < 0) throw new Error("not a zip archive");
	const count = view.getUint16(end + 10, true);
	let at = view.getUint32(end + 16, true);
	const files = new Map<string, Uint8Array>();
	for (let i = 0; i < count; i++) {
		if (view.getUint32(at, true) !== DIRECTORY_ENTRY)
			throw new Error("a damaged zip directory");
		const method = view.getUint16(at + 10, true);
		const size = view.getUint32(at + 20, true);
		const nameLength = view.getUint16(at + 28, true);
		const extraLength = view.getUint16(at + 30, true);
		const commentLength = view.getUint16(at + 32, true);
		const local = view.getUint32(at + 42, true);
		const name = new TextDecoder().decode(
			bytes.subarray(at + 46, at + 46 + nameLength),
		);
		if (view.getUint32(local, true) !== LOCAL_HEADER)
			throw new Error("a damaged zip entry");
		const start =
			local +
			30 +
			view.getUint16(local + 26, true) +
			view.getUint16(local + 28, true);
		const data = bytes.subarray(start, start + size);
		if (method === 0) files.set(name, data);
		else if (method === 8)
			files.set(name, new Uint8Array(inflateRawSync(data)));
		else throw new Error(`zip method ${method} is not read here`);
		at += 46 + nameLength + extraLength + commentLength;
	}
	return files;
}
