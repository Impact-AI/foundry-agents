import { expect, test } from "bun:test";
import type { TranscriptMessage } from "../backend/conversations";
import {
	IMAGE_SLOT_MARKER,
	imageKey,
	isImageDataPart,
	isSlotPart,
	pictureForSlot,
	replayMessages,
	type SentImage,
	sentImagesIn,
	slotKeysIn,
} from "./sent-images";

const image = (value: string) => ({
	type: "image",
	source: { type: "data", value, mimeType: "image/jpeg" },
});
const text = (t: string) => ({ type: "text" as const, text: t });
const slot = () => text(IMAGE_SLOT_MARKER);

test("a data part and a slot are told apart from text", () => {
	expect(isImageDataPart(image("abc"))).toBe(true);
	expect(
		isImageDataPart({ type: "image", source: { type: "url", value: "x" } }),
	).toBe(false);
	expect(isSlotPart(slot())).toBe(true);
	expect(isSlotPart(text("hello"))).toBe(false);
});

test("pictures are indexed among the image-shaped parts of their message", () => {
	const thread = [
		{
			id: "m1",
			role: "user",
			content: [text("look"), image("A"), text("and"), image("B")],
		},
		{ id: "m2", role: "assistant", content: "nice" },
		{ id: "m3", role: "user", content: [slot(), image("C")] },
	];
	expect(sentImagesIn(thread)).toEqual([
		{ messageId: "m1", index: 0, value: "A", mimeType: "image/jpeg" },
		{ messageId: "m1", index: 1, value: "B", mimeType: "image/jpeg" },
		// The slot in m3 holds position 0, so the fresh picture is 1.
		{ messageId: "m3", index: 1, value: "C", mimeType: "image/jpeg" },
	]);
	expect(sentImagesIn(thread, new Set(["m1"])).map((i) => i.messageId)).toEqual(
		["m3"],
	);
});

test("a transcript's image slots replay as markers, text as text", () => {
	const transcript: TranscriptMessage[] = [
		{
			id: "u1",
			role: "user",
			parts: [{ type: "text", text: "see" }, { type: "image-slot" }],
			createdAt: "",
		},
		{
			id: "a1",
			role: "assistant",
			parts: [{ type: "text", text: "I see." }],
			createdAt: "",
		},
	];
	expect(replayMessages(transcript)).toEqual([
		{ id: "u1", role: "user", content: [text("see"), slot()] },
		{ id: "a1", role: "assistant", content: "I see." },
	]);
});

test("a slot is filled by its key first, by its position second, else not at all", () => {
	const thread = [
		{ id: "u1", role: "user", content: [slot()] },
		{ id: "u2", role: "user", content: [text("two"), slot(), slot()] },
	];
	const keys = slotKeysIn(thread);
	expect(keys).toEqual([
		imageKey("u1", 0),
		imageKey("u2", 0),
		imageKey("u2", 1),
	]);

	const kept: SentImage[] = [
		{ messageId: "old-1", index: 0, value: "A", mimeType: "image/jpeg" },
		{ messageId: "u2", index: 0, value: "B", mimeType: "image/jpeg" },
		{ messageId: "old-3", index: 0, value: "C", mimeType: "image/jpeg" },
	];
	const byKey = new Map(kept.map((k) => [imageKey(k.messageId, k.index), k]));

	expect(pictureForSlot(byKey, kept, keys, imageKey("u2", 0))?.value).toBe("B");
	expect(pictureForSlot(byKey, kept, keys, imageKey("u1", 0))?.value).toBe("A");
	expect(pictureForSlot(byKey, kept, keys, imageKey("u2", 1))?.value).toBe("C");
	expect(pictureForSlot(byKey, kept, keys, imageKey("nowhere", 0))).toBeNull();
	expect(pictureForSlot(new Map(), [], keys, imageKey("u1", 0))).toBeNull();
});
