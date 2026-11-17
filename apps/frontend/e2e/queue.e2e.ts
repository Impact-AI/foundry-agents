import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { ANSWERS, answered, answering, composer, signIn } from "./fixtures";

/**
 * A message sent while the assistant is still answering waits and goes once
 * the answer is over — including the pause while the page answers a stage
 * control, when the run has stopped but the answer has not (send-queue.ts).
 */

/** A turn under way, and a second message written while it runs. */
async function writtenMidAnswer(page: Page): Promise<void> {
	await signIn(page);
	await composer(page).fill("Show me the onboarding library");
	await composer(page).press("Enter");
	await expect(answering(page)).toHaveCount(1, { timeout: 30_000 });
	await composer(page).fill("Open the rollout plan");
}

test("a message sent mid-answer waits, then goes once the answer is over", async ({
	page,
}) => {
	await writtenMidAnswer(page);
	// Mid-answer, the send queues instead of interrupting.
	await expect(
		page.getByRole("button", { name: "Send when the answer is done" }),
	).toBeEnabled();
	await composer(page).press("Enter");
	const waiting = page
		.getByRole("status")
		.filter({ hasText: "Waiting to send: “Open the rollout plan”" });
	await expect(waiting).toBeVisible();
	await expect(composer(page)).toHaveValue("");

	// The first answer finishes whole — its stage control answered, its words
	// written — and only then does the queued message go and get its answer.
	await expect(
		page.getByRole("paragraph").filter({ hasText: ANSWERS.library }),
	).toBeVisible({ timeout: 60_000 });
	await expect(waiting).toHaveCount(0, { timeout: 30_000 });
	await expect(
		page.getByRole("paragraph").filter({ hasText: ANSWERS.readerAndChart }),
	).toBeVisible({ timeout: 60_000 });
	await expect(
		page.getByText("Open the rollout plan", { exact: true }),
	).toHaveCount(1);
});

test("words sent while the page is still opening its thread wait for it, and are not lost", async ({
	page,
}) => {
	// The runtime's first answers held back, as a slow connection holds them:
	// the page is drawn and can be typed into before it has heard from it.
	let letThrough: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		letThrough = resolve;
	});
	await page.route("**/api/copilotkit", async (route) => {
		await held;
		await route.continue();
	});
	await signIn(page);
	await composer(page).fill("Show me the onboarding library");
	await composer(page).press("Enter");
	const waiting = page
		.getByRole("status")
		.filter({ hasText: "Waiting to send: “Show me the onboarding library”" });
	await expect(waiting).toBeVisible();
	await expect(composer(page)).toHaveValue("");

	letThrough();
	await answered(page, ANSWERS.library);
	await expect(waiting).toHaveCount(0);
	await expect(
		page.getByText("Show me the onboarding library", { exact: true }),
	).toHaveCount(1);
});

test("a queued message can be taken back into the field before it goes", async ({
	page,
}) => {
	await writtenMidAnswer(page);
	await composer(page).press("Enter");
	await page.getByRole("button", { name: "Edit" }).click();
	await expect(composer(page)).toHaveValue("Open the rollout plan");
	await expect(
		page.getByRole("status").filter({ hasText: "Waiting to send" }),
	).toHaveCount(0);

	// Nothing goes on its own once the answer is over.
	await answered(page, ANSWERS.library);
	await expect(
		page.getByRole("paragraph").filter({ hasText: ANSWERS.readerAndChart }),
	).toHaveCount(0);
});

test("a chip's words go as a turn of their own: the draft half typed and the picture waiting in the composer stay", async ({
	page,
}) => {
	await signIn(page);
	// A picture waiting to go, and words not yet sent.
	const chooser = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Add to your message" }).click();
	await page.getByRole("menuitem", { name: "Attach a picture" }).click();
	await (await chooser).setFiles({
		name: "desk.png",
		mimeType: "image/png",
		buffer: Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
			"base64",
		),
	});
	const waiting = page.getByRole("list", { name: "Pictures to send" });
	await expect(waiting.getByRole("listitem")).toHaveCount(1);
	await composer(page).fill("my half-written draft");

	const chip = page.locator(".chat-suggest").first();
	const words = (await chip.textContent()) ?? "";
	expect(words).not.toBe("");
	await chip.click();

	// The chip's words are the person's turn, alone,
	await expect(page.getByText(words, { exact: true }).first()).toBeVisible();
	await expect(answering(page)).toHaveCount(0, { timeout: 60_000 });
	// and what was in the composer is still there to send.
	await expect(composer(page)).toHaveValue("my half-written draft");
	await expect(waiting.getByRole("listitem")).toHaveCount(1);
});

test("a chip pressed twice in one instant is one turn", async ({ page }) => {
	await signIn(page);
	const chip = page.locator(".chat-suggest").first();
	const words = (await chip.textContent()) ?? "";
	expect(words).not.toBe("");
	const turns = page.locator(".user-message .bubble");
	// Two presses before the page has drawn the first.
	await chip.evaluate((button: HTMLElement) => {
		button.click();
		button.click();
	});
	await expect(turns).toHaveCount(1);
	// The answer comes and goes, and nothing was kept to send after it.
	await expect(answering(page)).toHaveCount(1, { timeout: 30_000 });
	await expect(answering(page)).toHaveCount(0, { timeout: 60_000 });
	await page.waitForTimeout(1_500);
	await expect(turns).toHaveCount(1);
	await expect(turns.first()).toHaveText(words);
});
