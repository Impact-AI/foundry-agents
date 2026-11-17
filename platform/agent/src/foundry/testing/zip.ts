/**
 * A zip archive of stored entries, as the stand-in serves a skill version:
 * the local headers, the central directory and its end record, each with
 * the entry's CRC-32, so any reader takes it.
 */
export function zipOf(files: Record<string, string>): Uint8Array {
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const directory: Uint8Array[] = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const nameBytes = encoder.encode(name);
		const data = encoder.encode(content);
		const crc = Bun.hash.crc32(data);
		const local = new Uint8Array(30 + nameBytes.length + data.length);
		const l = new DataView(local.buffer);
		l.setUint32(0, 0x04034b50, true);
		l.setUint16(4, 20, true);
		l.setUint32(14, crc, true);
		l.setUint32(18, data.length, true);
		l.setUint32(22, data.length, true);
		l.setUint16(26, nameBytes.length, true);
		local.set(nameBytes, 30);
		local.set(data, 30 + nameBytes.length);
		const entry = new Uint8Array(46 + nameBytes.length);
		const d = new DataView(entry.buffer);
		d.setUint32(0, 0x02014b50, true);
		d.setUint16(4, 20, true);
		d.setUint16(6, 20, true);
		d.setUint32(16, crc, true);
		d.setUint32(20, data.length, true);
		d.setUint32(24, data.length, true);
		d.setUint16(28, nameBytes.length, true);
		d.setUint32(42, offset, true);
		entry.set(nameBytes, 46);
		locals.push(local);
		directory.push(entry);
		offset += local.length;
	}
	const directorySize = directory.reduce((n, e) => n + e.length, 0);
	const end = new Uint8Array(22);
	const e = new DataView(end.buffer);
	e.setUint32(0, 0x06054b50, true);
	e.setUint16(8, directory.length, true);
	e.setUint16(10, directory.length, true);
	e.setUint32(12, directorySize, true);
	e.setUint32(16, offset, true);
	const out = new Uint8Array(offset + directorySize + end.length);
	let at = 0;
	for (const part of [...locals, ...directory, end]) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}
