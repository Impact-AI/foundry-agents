import { expect, test } from "bun:test";
import type { DocumentDescription } from "../types";
import {
	decodeMetadata,
	documentIdOf,
	encodeMetadata,
	MAX_READERS,
	METADATA_MAX_BYTES,
	MetadataTooLargeError,
} from "./metadata";

const DESCRIPTION: DocumentDescription = {
	id: documentIdOf("handbook/Ölçüm planı.md"),
	path: "handbook/Ölçüm planı.md",
	library: "handbook",
	kind: "document",
	title: "Ölçüm planı — the survey's plan",
	summary: "Où, quand et comment: 測量の計画 🚢",
	tags: ["survey", "planification", "測量"],
	readers: {
		oids: ["0f8c2a5e-0000-4000-8000-000000000001"],
		groups: ["all"],
	},
};

test("a description round-trips through blob metadata, every value ASCII, whatever language it was written in", () => {
	const metadata = encodeMetadata(DESCRIPTION);
	for (const [key, value] of Object.entries(metadata)) {
		expect(key).toMatch(/^[a-z]+$/);
		expect(value).toMatch(/^[ -~]*$/);
	}
	expect(decodeMetadata(metadata)).toEqual(DESCRIPTION);
});

test("text travels as standard base64, which the indexer's base64Decode reads, and lists as JSON its jsonArrayToStringCollection parses", () => {
	const metadata = encodeMetadata(DESCRIPTION);
	expect(Buffer.from(metadata.title as string, "base64").toString("utf8")).toBe(
		DESCRIPTION.title,
	);
	expect(metadata.tags).toBe('["survey","planification","\\u6e2c\\u91cf"]');
	expect(JSON.parse(metadata.tags as string)).toEqual(DESCRIPTION.tags);
	expect(metadata.oids).toBe('["0f8c2a5e-0000-4000-8000-000000000001"]');
	expect(metadata.kind).toBe("document");
	expect(metadata.library).toBe("handbook");
});

test("a file may name at most a hundred readers, and is told to use a group", () => {
	const many = Array.from({ length: MAX_READERS }, (_, i) => `oid-${i}`);
	expect(() =>
		encodeMetadata({ ...DESCRIPTION, readers: { oids: many, groups: [] } }),
	).not.toThrow();
	const err = (() => {
		try {
			encodeMetadata({
				...DESCRIPTION,
				readers: { oids: many, groups: ["one-more"] },
			});
		} catch (e) {
			return e as Error;
		}
		throw new Error("expected a refusal");
	})();
	expect(err).toBeInstanceOf(MetadataTooLargeError);
	expect(err.message).toContain("handbook/Ölçüm planı.md");
	expect(err.message).toContain("101 readers");
	expect(err.message).toContain("group");
});

test("a description too large for a blob's 8 KB is refused naming the file, before anything is written", () => {
	const err = (() => {
		try {
			encodeMetadata({ ...DESCRIPTION, summary: "x".repeat(7000) });
		} catch (e) {
			return e as Error;
		}
		throw new Error("expected a refusal");
	})();
	expect(err).toBeInstanceOf(MetadataTooLargeError);
	expect(err.message).toContain(`more than the ${METADATA_MAX_BYTES}`);
	expect(err.message).toContain("handbook/Ölçüm planı.md");
});

test("a blob nobody described, or described by something else, is no document", () => {
	expect(decodeMetadata({})).toBeNull();
	const metadata = encodeMetadata(DESCRIPTION);
	expect(decodeMetadata({ ...metadata, kind: "video" })).toBeNull();
	expect(decodeMetadata({ ...metadata, oids: "p-1" })).toBeNull();
	expect(decodeMetadata({ ...metadata, groups: "[1]" })).toBeNull();
	const { id: _id, ...noId } = metadata;
	expect(decodeMetadata(noId)).toBeNull();
});

test("a document's id is short, opaque and the same for the same path", () => {
	expect(documentIdOf("a/b.md")).toMatch(/^[0-9a-f]{32}$/);
	expect(documentIdOf("a/b.md")).toBe(documentIdOf("a/b.md"));
	expect(documentIdOf("a/b.md")).not.toBe(documentIdOf("a/c.md"));
});
