import { expect, type Page, test } from "@playwright/test";
import { ANSWERS, ask, expectAccessible, signIn } from "./fixtures";

/**
 * The deployment's logo (dev-fake stores one), drawn and loaded through the
 * relay, and decorative: the name beside it says the same thing, so the
 * picture adds nothing to the name of the link or the heading it sits in.
 */
async function expectLogoDrawn(page: Page, where: string): Promise<void> {
	const logo = page.locator(`${where} img.brand-logo`);
	await expect(logo).toHaveCount(1);
	await expect(logo).toHaveAttribute("alt", "");
	await expect
		.poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth))
		.toBeGreaterThan(0);
}

test("the door and the notice have no serious accessibility violation", async ({
	page,
}) => {
	await page.goto("/login");
	await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
	await expectLogoDrawn(page, "main");
	await expectAccessible(page);
	await page.goto("/privacy");
	await expect(
		page.getByRole("heading", {
			name: "What this app knows about you",
			level: 1,
		}),
	).toBeVisible();
	await expectAccessible(page);
});

test("the workspace, a filled stage, and the settings have no serious accessibility violation", async ({
	page,
}) => {
	await signIn(page);
	await expectLogoDrawn(page, ".topbar");
	await expectAccessible(page);
	await ask(page, "Show me the onboarding library", ANSWERS.library);
	await expectAccessible(page);
	await page.goto("/settings");
	await expect(
		page.getByRole("heading", { name: "Settings", level: 1 }),
	).toBeVisible();
	await expectAccessible(page);
});

test("a typed turn says whose each turn is, that the answer is over, and what it put on the stage", async ({
	page,
}) => {
	await signIn(page);
	const status = (text: string) =>
		page.getByRole("status").filter({ hasText: text });
	await expect(status("The assistant has answered.")).toHaveCount(0);
	await ask(page, "Show me the onboarding library", ANSWERS.library);
	await expect(status("The assistant has answered.")).toHaveCount(1);
	await expect(status("On the stage: Library.")).toHaveCount(1);
	await expect(
		page.getByRole("heading", { name: "You said:", level: 3 }),
	).toHaveCount(1);
	await expect(
		page.getByRole("heading", { name: "The assistant said:", level: 3 }),
	).not.toHaveCount(0);
	await page.getByRole("button", { name: "Clear the stage" }).click();
	await expect(status("The stage is clear.")).toHaveCount(1);
});

test("the first visit's tour opens by itself and comes back from the composer", async ({
	page,
}) => {
	await signIn(page);
	await page.getByRole("button", { name: "How this works" }).click();
	const guide = page.getByRole("dialog", { name: "Welcome to the workspace" });
	await expect(guide).toBeVisible();
	await expectAccessible(page);
	await guide.getByRole("button", { name: "Next" }).click();
	await expect(
		page.getByRole("dialog", { name: "The conversation" }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("dialog", { name: "The conversation" }),
	).toBeHidden();
});
