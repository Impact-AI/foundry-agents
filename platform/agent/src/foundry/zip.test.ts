import { expect, test } from "bun:test";
import { zipOf } from "./testing/zip";
import { unzip } from "./zip";

/** A skill folder as Python's `zipfile` writes it: one entry deflated, one stored. */
const PYTHON_ZIP =
	"UEsDBBQAAAAIAAAAIQBAHFvDfQAAAKoBAAAVAAAAc2hlbGYtZmluZGVyL1NLSUxMLm1k7c47DgIxDITh3qcYidqIR5eOMyAO4E28JNpsgtZGXJ8g0XID6tF8+pmZmqwaYFnrzHNpSTdKanErDy+9BdxM8craIJh6X1AMtZvvaVWXJC6BgNiba3POYjngcDydZYqJePi0w/WD44vTxRZ4VsTxrf3+1LFsAwT/a37WvAFQSwMEFAAAAAAAAAAhAIdsBuUTAAAAEwAAACAAAABzaGVsZi1maW5kZXIvcmVmZXJlbmNlcy9yb29tcy5tZFJvb20gb25lLCByb29tIHR3by5QSwECFAMUAAAACAAAACEAQBxbw30AAACqAQAAFQAAAAAAAAAAAAAAgAEAAAAAc2hlbGYtZmluZGVyL1NLSUxMLm1kUEsBAhQDFAAAAAAAAAAhAIdsBuUTAAAAEwAAACAAAAAAAAAAAAAAAIABsAAAAHNoZWxmLWZpbmRlci9yZWZlcmVuY2VzL3Jvb21zLm1kUEsFBgAAAAACAAIAkQAAAAEBAAAAAA==";

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

test("a zip another writer made is read whole, deflated and stored entries alike", () => {
	const files = unzip(Buffer.from(PYTHON_ZIP, "base64"));
	expect([...files.keys()]).toEqual([
		"shelf-finder/SKILL.md",
		"shelf-finder/references/rooms.md",
	]);
	const skill = text(files.get("shelf-finder/SKILL.md"));
	expect(skill.startsWith("---\nname: shelf-finder\n")).toBe(true);
	expect(skill).toContain("content-hash: 0123abcd");
	expect(skill.split("Ask the catalogue first.")).toHaveLength(4);
	expect(text(files.get("shelf-finder/references/rooms.md"))).toBe(
		"Room one, room two.",
	);
});

test("the stand-in's archives read back as written, and what is not an archive is refused", () => {
	const files = unzip(zipOf({ "a/SKILL.md": "ünïcode body", "b.md": "" }));
	expect(text(files.get("a/SKILL.md"))).toBe("ünïcode body");
	expect(text(files.get("b.md"))).toBe("");
	expect(() => unzip(new TextEncoder().encode("not a zip"))).toThrow(
		"not a zip archive",
	);
});
