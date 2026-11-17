import { expect, test } from "bun:test";
import { mergeSources, readSources, sourcesOwner } from "./sources";

test("a sources event is read as documents: id and title kept, a thumbnail only on this origin, anything else dropped", () => {
	expect(
		readSources([
			{ id: "a", title: "A", thumbnailUrl: "/api/media/lib/a.png" },
			{ id: "b", title: "B", thumbnailUrl: "https://elsewhere.example/b.png" },
			{ id: "c", title: "C", thumbnailUrl: 7 },
			{ id: "", title: "No id" },
			{ title: "No id at all" },
			{ id: "d" },
			"not an entry",
			null,
		]),
	).toEqual([
		{ id: "a", title: "A", thumbnailUrl: "/api/media/lib/a.png" },
		{ id: "b", title: "B" },
		{ id: "c", title: "C" },
	]);
	expect(readSources({ id: "a", title: "A" })).toEqual([]);
	expect(readSources(undefined)).toEqual([]);
});

test("sources merge each document once, in the order it first came", () => {
	expect(
		mergeSources(
			[{ id: "a", title: "A" }],
			[
				{ id: "b", title: "B" },
				{ id: "a", title: "A again" },
				{ id: "b", title: "B again" },
			],
		),
	).toEqual([
		{ id: "a", title: "A" },
		{ id: "b", title: "B" },
	]);
});

test("a run's sources go under its last assistant message, and nowhere while it has none", () => {
	expect(
		sourcesOwner([
			{ id: "u1", role: "user" },
			{ id: "a1", role: "assistant" },
			{ id: "t1", role: "tool" },
			{ id: "a2", role: "assistant" },
		]),
	).toBe("a2");
	expect(sourcesOwner([{ id: "u1", role: "user" }])).toBeNull();
});
