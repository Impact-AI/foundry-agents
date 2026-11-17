import { expect, test } from "bun:test";
import {
	changesOf,
	draftOf,
	isSavable,
	PERSON_NAME_MAX,
	PERSON_TEXT_MAX,
	readPersonPatch,
} from "./person";

const saved = draftOf({
	name: "Ada",
	about: "I collect maps.",
	preferences: null,
});

test("a draft changes only what differs once trimmed, and a cleared text is null", () => {
	expect(changesOf(saved, saved)).toBeNull();
	expect(changesOf(saved, { ...saved, name: " Ada  " })).toBeNull();
	expect(
		changesOf(saved, { ...saved, about: "", preferences: " Briefly. " }),
	).toEqual({ about: null, preferences: "Briefly." });
	expect(changesOf(saved, { ...saved, name: "Ada Quill" })).toEqual({
		name: "Ada Quill",
	});
});

test("a draft saves with a name and within bounds", () => {
	expect(isSavable(saved)).toBe(true);
	expect(isSavable({ ...saved, name: "  " })).toBe(false);
	expect(isSavable({ ...saved, name: "n".repeat(PERSON_NAME_MAX + 1) })).toBe(
		false,
	);
	expect(isSavable({ ...saved, about: "a".repeat(PERSON_TEXT_MAX + 1) })).toBe(
		false,
	);
});

test("a body's edit keeps the person's three fields, checked, and nothing else", () => {
	expect(
		readPersonPatch({ name: " Ada ", about: "", locale: "fr", extra: 1 }),
	).toEqual({ name: "Ada", about: null });
	for (const bad of [null, [], "x", {}, { locale: "fr" }, { name: "  " }])
		expect(readPersonPatch(bad)).toBeNull();
	expect(readPersonPatch({ about: 7 })).toBeNull();
	expect(
		readPersonPatch({ preferences: "p".repeat(PERSON_TEXT_MAX + 1) }),
	).toBeNull();
});
