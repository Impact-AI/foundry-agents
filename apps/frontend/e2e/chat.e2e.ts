import { expect, test } from "@playwright/test";
import {
	ANSWERS,
	answered,
	answering,
	ask,
	composer,
	signIn,
} from "./fixtures";

/** A conversation is named off the request path: the server's wait, its sweep and the picker's reads of the list. */
const NAMED_WITHIN_MS = 20_000;

test("a turn shows its reasoning while it runs, answers, and the server names the conversation", async ({
	page,
}) => {
	await signIn(page);
	await expect(
		page.getByRole("button", { name: "Conversation: Untitled" }),
	).toBeVisible();

	await composer(page).fill("Show me the onboarding library");
	await composer(page).press("Enter");
	await expect(answering(page)).toBeVisible();
	await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Thinking…" })).toBeVisible();

	await answered(page, ANSWERS.library);
	// The next steps the assistant offered with `suggestNext`, as chips.
	for (const next of [
		"Open the onboarding handbook",
		"Who looks after new colleagues?",
		"Show me the rollout plan",
	])
		await expect(page.getByRole("button", { name: next })).toBeVisible();

	const reasoning = page.getByRole("button", { name: /^Thought for / });
	await expect(reasoning).toHaveAttribute("aria-expanded", "false");
	const summary = page.getByText("Finding the onboarding documents");
	await expect(summary).toBeHidden();
	await reasoning.click();
	await expect(reasoning).toHaveAttribute("aria-expanded", "true");
	await expect(summary).toBeVisible();
	await reasoning.click();
	await expect(reasoning).toHaveAttribute("aria-expanded", "false");
	await expect(summary).toBeHidden();

	// Named on the server a moment after the run settles: the picker reads
	// the list again until the name is there.
	await expect(
		page.getByRole("button", { name: "Conversation: The document library" }),
	).toBeVisible({ timeout: NAMED_WITHIN_MS });
});

test("conversations are listed, switched between, deleted behind a confirmation, and renamed", async ({
	page,
}) => {
	await signIn(page);
	await ask(page, "Show me the onboarding library", ANSWERS.library);
	const picker = page.getByRole("button", {
		name: "Conversation: The document library",
	});
	await expect(picker).toBeVisible({ timeout: NAMED_WITHIN_MS });
	const first = page.url();

	await page.getByRole("button", { name: "Start a new conversation" }).click();
	await expect(
		page.getByRole("button", { name: "Conversation: Untitled" }),
	).toBeVisible();
	await ask(page, "Chart the spend for me", ANSWERS.library);
	await expect(
		page.getByRole("button", { name: "Conversation: Spend by quarter" }),
	).toBeVisible({ timeout: NAMED_WITHIN_MS });
	expect(page.url()).not.toBe(first);

	// Switch back to the first one: its own turn is in the thread again.
	await page
		.getByRole("button", { name: "Conversation: Spend by quarter" })
		.click();
	const list = page.getByRole("dialog", { name: "Conversations" });
	await expect(list.getByRole("link")).toHaveCount(2);
	await list.getByRole("link", { name: /The document library/ }).click();
	await expect(picker).toBeVisible();
	await expect(page.getByText("Show me the onboarding library")).toBeVisible();
	await expect(page.getByText("Chart the spend for me")).toHaveCount(0);
	// The turns are the backend's, not this page's: a page loaded afresh reads them again.
	await page.reload();
	await expect(page.getByText("Show me the onboarding library")).toBeVisible();
	await expect(
		page.getByRole("paragraph").filter({ hasText: ANSWERS.library }),
	).toBeVisible();

	// Delete the other one: the dialog asks first, with the safe answer focused.
	await picker.click();
	await list.getByRole("button", { name: "Delete “Spend by quarter”" }).click();
	const confirm = page.getByRole("alertdialog", { name: "Delete" });
	await expect(confirm).toContainText(
		"Delete “Spend by quarter”? It goes for good",
	);
	await expect(confirm.getByRole("button", { name: "Keep" })).toBeFocused();
	await confirm.getByRole("button", { name: "Delete" }).click();
	await expect(confirm).toBeHidden();
	await expect(picker).toBeFocused();

	await picker.click();
	await expect(list.getByRole("link")).toHaveCount(1);

	// Renamed in place: the field takes the focus, and the head says the new name.
	await list
		.getByRole("button", { name: "Rename “The document library”" })
		.click();
	const name = list.getByRole("textbox", {
		name: "A new name for this conversation",
	});
	await expect(name).toBeFocused();
	await name.fill("Reading for my first week");
	await name.press("Enter");
	await expect(
		list.getByRole("link", { name: /Reading for my first week/ }),
	).toBeVisible();
	await expect(
		page.getByRole("button", {
			name: "Conversation: Reading for my first week",
		}),
	).toBeVisible();

	// And the thread still reads from its first line, long after the page settled on it:
	// the turns it was opened with are not there only until the runtime has answered.
	await expect(page.getByText("Show me the onboarding library")).toBeVisible();
	await expect(
		page.getByRole("paragraph").filter({ hasText: ANSWERS.library }),
	).toBeVisible();
});

test("a turn the provider refuses is told in the thread", async ({ page }) => {
	await signIn(page);
	await composer(page).fill("this one will fail");
	await composer(page).press("Enter");
	await expect(
		page.getByText("The answer was cut off. Send your message again."),
	).toBeVisible({
		timeout: 30_000,
	});
});
