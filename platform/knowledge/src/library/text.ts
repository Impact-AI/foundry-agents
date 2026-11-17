import { readBlob } from "@platform/storage";

/**
 * A text file of a library, read whole: a manifest, a Markdown file's front
 * matter, a document the reader renders. Bounded, because whole means held
 * in memory; a file past the bound is answered as too large rather than
 * read, and the caller decides what that means. A byte-order mark an
 * editor wrote at the head of the file is not part of its text: left in, a
 * manifest is not JSON and a Markdown file's front matter does not open on
 * its first line.
 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export type TextRead =
	| {
			kind: "text";
			text: string;
			/** The blob's metadata as it came with these bytes. */
			metadata: Record<string, string>;
	  }
	| { kind: "absent" }
	| { kind: "too-large"; bytes: number };

export async function readText(name: string): Promise<TextRead> {
	const object = await readBlob(name);
	if (!object) return { kind: "absent" };
	if ((object.contentLength ?? 0) > MAX_TEXT_BYTES) {
		await object.body.cancel();
		return { kind: "too-large", bytes: object.contentLength ?? 0 };
	}
	// The declared length is a hint a store may not give, so the bound is
	// held on the bytes as they arrive.
	const parts: Uint8Array[] = [];
	let bytes = 0;
	const reader = object.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > MAX_TEXT_BYTES) {
			await reader.cancel();
			return { kind: "too-large", bytes };
		}
		parts.push(value);
	}
	const text = Buffer.concat(parts).toString("utf8");
	return {
		kind: "text",
		text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
		metadata: object.metadata,
	};
}
