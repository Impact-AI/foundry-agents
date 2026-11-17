import { expect, type Locator, type Page, test } from "@playwright/test";
import { ANSWERS, ask, expectRingWhole, signIn } from "./fixtures";

function tile(
	page: Page,
	name: "Library" | "Reader" | "Chart" | "Record" | "Media",
) {
	return page.getByRole("main").getByRole("region", { name, exact: true });
}

/** The picture is on screen and its bytes decoded: a broken image is visible too, with no width of its own. */
async function expectDrawn(img: Locator) {
	await expect(img).toBeVisible();
	await expect
		.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
		.toBeGreaterThan(0);
}

test("the assistant fills the stage: the library, a document, a chart, a record, a picture", async ({
	page,
}) => {
	await signIn(page);

	await ask(page, "Show me the onboarding library", ANSWERS.library);
	const library = tile(page, "Library");
	await expect(library.getByText("6 documents for “onboarding”")).toBeVisible();
	await expect(
		library.getByRole("button", { name: "Open “Onboarding handbook”" }),
	).toBeVisible();
	// The one document only a group may read is not this person's to see.
	await expect(
		library.getByRole("button", { name: "Open “Onboarding pay review”" }),
	).toHaveCount(0);

	// The handbook's card draws its picture, read through the media route, and its focus ring whole.
	const handbook = library.getByRole("button", {
		name: "Open “Onboarding handbook”",
	});
	await expectDrawn(handbook.locator("img"));
	await expectRingWhole(page, handbook);

	// A card opens its document in the reader, at its first page, its picture under it.
	await handbook.click();
	const reader = tile(page, "Reader");
	await expect(
		reader.getByRole("heading", { name: "Onboarding handbook", level: 2 }),
	).toBeVisible();
	await expect(
		reader.getByRole("heading", { name: "Day one", level: 3 }),
	).toBeVisible();
	const strip = reader.getByRole("list", { name: "Pictures in this document" });
	await expectDrawn(strip.locator("img"));
	await expectRingWhole(page, strip.getByRole("button"));

	await ask(page, "Open the rollout plan", ANSWERS.readerAndChart);
	await expect(
		reader.getByRole("heading", {
			name: "Field tablet rollout plan",
			level: 2,
		}),
	).toBeVisible();
	await expect(reader.getByText("Page 1 of 3")).toBeVisible();
	await reader.getByRole("button", { name: "Next page" }).click();
	await expect(reader.getByText("Page 2 of 3")).toBeVisible();
	await expect(
		reader.getByRole("heading", { name: "The three waves", level: 3 }),
	).toBeVisible();
	await expect(
		tile(page, "Chart").getByRole("img", {
			name: "A chart: Vans fitted, by month",
		}),
	).toBeVisible();

	await ask(page, "Who is the customer behind it?", ANSWERS.recordAndPicture);
	const record = tile(page, "Record");
	await expect(
		record.getByRole("heading", { name: "Halvard Logistics", level: 2 }),
	).toBeVisible();
	await expect(
		record.getByRole("button", { name: "Person Inés Valverde" }),
	).toBeVisible();
	// The picture came through the media route, read from the store for this person.
	const picture = tile(page, "Media").getByRole("img", {
		name: "The Nordic fleet at the Gothenburg depot",
	});
	await expectDrawn(picture);
	// Enlarged, it fills an overlay of its own, which closes back to the stage.
	await tile(page, "Media")
		.getByRole("button", {
			name: "Enlarge The Nordic fleet at the Gothenburg depot",
		})
		.click();
	const overlay = page.getByRole("complementary", { name: "Media" });
	await expect(
		overlay.getByRole("heading", {
			name: "The Nordic fleet at the Gothenburg depot",
		}),
	).toBeVisible();
	await overlay.getByRole("button", { name: "Close" }).click();
	await expect(overlay).toHaveCount(0);

	// Each tile closes on its own; the bar's control sends the stage home.
	await tile(page, "Chart").getByRole("button", { name: "Close" }).click();
	await expect(tile(page, "Chart")).toHaveCount(0);
	await expect(record).toBeVisible();
	await page.getByRole("button", { name: "Clear the stage" }).click();
	await expect(
		page.getByRole("heading", { name: "Ask, and it appears on the stage." }),
	).toBeVisible();
	await expect(record).toHaveCount(0);
});

test("a question that needs several actions at once is answered: the backend's tool and two of the stage's controls in one response", async ({
	page,
}) => {
	await signIn(page);
	// One response charts the spend on the server and puts two records on the
	// stage; the browser's answers to the two continue the turn to its words.
	await ask(
		page,
		"How is Warehouse Vision going? Show its spend by quarter and who is working on it",
		ANSWERS.severalActions,
	);
	await expect(tile(page, "Record")).toBeVisible();
	await expect(
		page.getByText("The answer was cut off. Send your message again."),
	).toHaveCount(0);
});
