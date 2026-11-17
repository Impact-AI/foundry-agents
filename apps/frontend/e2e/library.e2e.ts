import { expect, type Locator, type Page, test } from "@playwright/test";
import { ANSWERS, ask, expectRingWhole, signIn } from "./fixtures";

function library(page: Page): Locator {
	return page
		.getByRole("main")
		.getByRole("region", { name: "Library", exact: true });
}

/** The cards wholly inside the track's view, by name, in reading order. */
async function inView(tile: Locator): Promise<string[]> {
	return tile.locator(".carousel-track").evaluate((track) => {
		const box = track.getBoundingClientRect();
		return Array.from(track.querySelectorAll<HTMLElement>(".document-card"))
			.filter((card) => {
				const at = card.getBoundingClientRect();
				return (
					at.left >= box.left - 1 &&
					at.right <= box.right + 1 &&
					at.top >= box.top - 1 &&
					at.bottom <= box.bottom + 1
				);
			})
			.map((card) => card.getAttribute("aria-label") ?? "");
	});
}

/**
 * Step forward through every view. Each must show a whole view of cards no
 * earlier view showed, and the position must name exactly those cards.
 */
async function walk(tile: Locator, total: number): Promise<string[][]> {
	const seen: string[][] = [];
	const next = tile.getByRole("button", { name: "Next document" });
	const position = tile.locator(".carousel-position");
	for (;;) {
		const before = new Set(seen.flat());
		const named = (view: string[]) => {
			const first = before.size + 1;
			const last = before.size + view.length;
			return first === last
				? `${first} of ${total}`
				: `${first}–${last} of ${total}`;
		};
		// The smooth scroll has landed: the cards in view are new, and the
		// position names exactly them.
		let view: string[] = [];
		await expect
			.poll(async () => {
				view = await inView(tile);
				const fresh = view.length > 0 && view.every((c) => !before.has(c));
				return fresh && (await position.textContent()) === named(view);
			})
			.toBe(true);
		seen.push(view);
		if (await next.isDisabled()) break;
		await next.click();
	}
	return seen;
}

/** Sign in at a screen size and ask for the onboarding library: its six documents. */
async function openLibrary(
	page: Page,
	size: { width: number; height: number },
): Promise<Locator> {
	await page.setViewportSize(size);
	await signIn(page);
	await ask(page, "Show me the onboarding library", ANSWERS.library);
	const tile = library(page);
	await expect(tile.getByText("6 documents for “onboarding”")).toBeVisible();
	return tile;
}

test("a wide, tall stage holds the whole library in one grid, with no arrows", async ({
	page,
}) => {
	const tile = await openLibrary(page, { width: 1800, height: 1100 });

	await expect.poll(async () => (await inView(tile)).length).toBe(6);
	await expect(tile.locator(".carousel-foot")).toHaveCount(0);
	await expectRingWhole(
		page,
		tile.getByRole("button", { name: "Open “Employee handbook”" }),
	);
});

test("a smaller stage steps whole views, never showing a card twice", async ({
	page,
}) => {
	const tile = await openLibrary(page, { width: 1280, height: 720 });

	const seen = await walk(tile, 6);
	expect(seen.length).toBeGreaterThan(1);
	expect(seen.flat()).toHaveLength(6);
	expect(new Set(seen.flat()).size).toBe(6);
	// The arrows' focus rings are drawn whole at the tile's foot.
	await expectRingWhole(
		page,
		tile.getByRole("button", { name: "Previous document" }),
		{ gap: true },
	);
});
