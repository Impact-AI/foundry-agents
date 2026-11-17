import { expect, type Locator, type Page, test } from "@playwright/test";
import { signIn } from "./fixtures";

/**
 * On a phone the workspace is a row of pages — the conversation, then every
 * tile. What the person opens by hand is brought across to them; nothing is
 * left placed on a page they cannot see (bring-across.ts).
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

function tile(page: Page, name: "Library" | "Reader" | "Records"): Locator {
	return page.getByRole("main").getByRole("region", { name, exact: true });
}

/** The tile's page fills the screen: the pager has brought it across. */
async function inView(page: Page, region: Locator): Promise<boolean> {
	const box = await region.boundingBox();
	const width = page.viewportSize()?.width ?? 0;
	return box !== null && box.x >= -1 && box.x + box.width <= width + 1;
}

test("the bar's Library and Records, and a document card, each bring their page across", async ({
	page,
}) => {
	await signIn(page);

	await page.getByRole("button", { name: "Library", exact: true }).click();
	const library = tile(page, "Library");
	await expect(library).toBeAttached();
	await expect.poll(() => inView(page, library)).toBe(true);

	// A card in the library opens its document, and the reader comes across.
	await library
		.getByRole("button", { name: /^Open “/ })
		.first()
		.click();
	const reader = tile(page, "Reader");
	await expect(reader).toBeAttached();
	await expect.poll(() => inView(page, reader)).toBe(true);

	await page.getByRole("button", { name: "Records", exact: true }).click();
	const records = tile(page, "Records");
	await expect(records).toBeAttached();
	await expect.poll(() => inView(page, records)).toBe(true);
});
