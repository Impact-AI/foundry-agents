import { expect, test } from "bun:test";
import { HttpError, page } from "./fake-state";

/**
 * The stand-in pages a list as the conversation items API defines it in
 * `openai` 7.43.0 (`ItemListParams`: `after`, `limit`, `order`), and refuses
 * what it does not define rather than answering something else.
 */
const items = ["i1", "i2", "i3", "i4", "i5"].map((id) => ({ id }));

async function read(query: string) {
	const url = new URL(`https://foundry.test/items?${query}`);
	const body = (await page(items, (i) => i.id, url, "desc").json()) as {
		data: { id: string }[];
		has_more: boolean;
	};
	return { ids: body.data.map((i) => i.id), more: body.has_more };
}

function refusal(query: string): number | null {
	try {
		page(
			items,
			(i) => i.id,
			new URL(`https://foundry.test/items?${query}`),
			"desc",
		);
		return null;
	} catch (err) {
		return err instanceof HttpError ? err.status : null;
	}
}

test("newest first by default; after an item is what follows it in the order asked for", async () => {
	expect(await read("limit=2")).toEqual({ ids: ["i5", "i4"], more: true });
	expect(await read("limit=2&after=i4")).toEqual({
		ids: ["i3", "i2"],
		more: true,
	});
	expect(await read("limit=2&after=i2")).toEqual({ ids: ["i1"], more: false });
	expect(await read("order=asc&limit=2&after=i2")).toEqual({
		ids: ["i3", "i4"],
		more: true,
	});
});

test("a cursor naming no item, a before, and an order it does not know are refused", () => {
	expect(refusal("after=gone")).toBe(400);
	expect(refusal("before=i3")).toBe(400);
	expect(refusal("order=newest")).toBe(400);
	expect(refusal("limit=101")).toBe(400);
});
