import { expect, test } from "bun:test";
import { ManifestError } from "./manifest";
import {
	ACCESS_MANIFEST_NAME,
	manifestAccessFor,
	parseAccessManifest,
} from "./readers";

const MANIFEST = JSON.stringify({
	"docs/handbook.md": { oids: ["p-1"], groups: ["g-staff"] },
	"docs/*.md": { groups: ["g-docs"] },
	"./pictures/**": { oids: [" p-2 ", "p-2"] },
	"*": { groups: ["all"] },
});

test("an exact path wins over a glob, a glob over `*`, and a file nothing names gets null", () => {
	const manifest = parseAccessManifest(MANIFEST);
	expect(manifestAccessFor(manifest, "docs/handbook.md")).toEqual({
		oids: ["p-1"],
		groups: ["g-staff"],
	});
	expect(manifestAccessFor(manifest, "docs/plan.md")).toEqual({
		oids: [],
		groups: ["g-docs"],
	});
	expect(manifestAccessFor(manifest, "pictures/deep/one.png")).toEqual({
		oids: ["p-2"],
		groups: [],
	});
	expect(manifestAccessFor(manifest, "notes.txt")).toEqual({
		oids: [],
		groups: ["all"],
	});
	expect(
		manifestAccessFor(
			parseAccessManifest(JSON.stringify({ "a.md": { oids: ["p-1"] } })),
			"b.md",
		),
	).toBeNull();
	expect(manifestAccessFor(null, "a.md")).toBeNull();
});

test("a directory is not an entry: nothing under it inherits", () => {
	const manifest = parseAccessManifest(
		JSON.stringify({ "docs/": { groups: ["g-docs"] }, docs: { oids: ["p"] } }),
	);
	expect(manifestAccessFor(manifest, "docs/plan.md")).toBeNull();
});

test("malformed manifests are a typed error naming the manifest and what is wrong", () => {
	const bad = (text: string, problem: RegExp) => {
		try {
			parseAccessManifest(text, `handbook/${ACCESS_MANIFEST_NAME}`);
		} catch (err) {
			expect(err).toBeInstanceOf(ManifestError);
			expect((err as Error).message).toMatch(problem);
			expect((err as Error).message).toContain(
				`handbook/${ACCESS_MANIFEST_NAME}`,
			);
			return;
		}
		throw new Error(`expected ${text} to be refused`);
	};
	bad("{", /not JSON/);
	bad("[]", /object keyed by path/);
	bad(JSON.stringify({ "a.md": ["p-1"] }), /must be an object/);
	bad(JSON.stringify({ "a.md": { oids: "p-1" } }), /array of ids/);
	bad(JSON.stringify({ "a.md": { oids: [""] } }), /not an id/);
	bad(JSON.stringify({ "a.md": { groups: [3] } }), /not an id/);
	bad(JSON.stringify({ "a.md": { users: ["p-1"] } }), /unknown field "users"/);
	bad(JSON.stringify({ " ": { oids: ["p-1"] } }), /empty path/);
});
