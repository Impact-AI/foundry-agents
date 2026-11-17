import { expect, test } from "@playwright/test";
import { ANSWERS, ask, composer, openSettings, signIn } from "./fixtures";

test("a person edits who they are; the change is kept and the bar says it", async ({
	page,
}) => {
	await signIn(page);
	await openSettings(page);
	const you = page.getByRole("region", { name: "You" });
	const name = you.getByRole("textbox", { name: "Name" });
	const about = you.getByRole("textbox", { name: "About you" });
	await expect(name).toHaveValue("Ada Quill");
	await expect(you.getByRole("button", { name: "Save" })).toHaveCount(0);

	// Cancel puts the saved values back.
	await about.fill("Something I take back.");
	await you.getByRole("button", { name: "Cancel" }).click();
	await expect(about).toHaveValue("");
	await expect(you.getByRole("button", { name: "Save" })).toHaveCount(0);

	await name.fill("Ada");
	await about.fill("I look after the depot in Gothenburg.");
	await you.getByRole("button", { name: "Save" }).click();
	await expect(you.getByRole("button", { name: "Save" })).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Ada's account" }),
	).toBeVisible();

	await page.reload();
	await expect(name).toHaveValue("Ada");
	await expect(about).toHaveValue("I look after the depot in Gothenburg.");
});

test("the text size is a radio group that outlives the page", async ({
	page,
}) => {
	await signIn(page);
	await openSettings(page);
	const sizes = page.getByRole("radiogroup", { name: "Text size" });
	const root = page.locator("html");
	await expect(sizes.getByRole("radio", { name: "Standard" })).toBeChecked();
	await expect(root).toHaveAttribute("data-text-scale", "100");
	await sizes.getByText("Larger", { exact: true }).click();
	await expect(sizes.getByRole("radio", { name: "Larger" })).toBeChecked();
	await expect(root).toHaveAttribute("data-text-scale", "130");
	// The choice is written to a cookie by a server action; the group is busy until it has been.
	await expect(sizes).toHaveAttribute("aria-busy", "false");

	await page.reload();
	await expect(sizes.getByRole("radio", { name: "Larger" })).toBeChecked();
	await expect(root).toHaveAttribute("data-text-scale", "130");

	await page.getByRole("link", { name: "Back to the chat" }).click();
	await expect(page).toHaveURL(/\/chat/);
	await expect(root).toHaveAttribute("data-text-scale", "130");
});

test("what the assistant remembers is a list of statements, each corrected or removed, and all of it forgotten", async ({
	page,
}) => {
	await signIn(page);
	await ask(page, "Show me the onboarding library", ANSWERS.library);
	await openSettings(page);
	const memory = page.getByRole("region", {
		name: "What the assistant remembers about you",
	});
	// The extraction runs off the turn's path; the page reads what it holds.
	await expect(async () => {
		await page.reload();
		await expect(
			memory.getByText("Is joining the field operations team."),
		).toBeVisible({ timeout: 1_000 });
	}).toPass({ timeout: 30_000 });
	// Edit swaps the statement for its field; Save shows what was kept.
	await memory
		.getByRole("button", {
			name: "Edit: Is joining the field operations team.",
		})
		.click();
	const field = memory.getByRole("textbox", {
		name: "What the assistant remembers",
	});
	await expect(field).toBeFocused();
	await expect(field).toHaveValue("Is joining the field operations team.");
	await field.fill("Leads the field operations team.");
	await memory.getByRole("button", { name: "Save" }).click();
	await expect(
		memory.getByText("Leads the field operations team."),
	).toBeVisible();
	await expect(
		memory.getByText("Is joining the field operations team."),
	).toHaveCount(0);
	await page.reload();
	await expect(
		memory.getByText("Leads the field operations team."),
	).toBeVisible();

	// Remove takes one statement and leaves the rest.
	await memory
		.getByRole("button", {
			name: "Remove: Prefers short answers, with the document first.",
		})
		.click();
	await expect(
		memory.getByText("Prefers short answers, with the document first."),
	).toHaveCount(0);
	await expect(
		memory.getByText("Leads the field operations team."),
	).toBeVisible();

	// Forgetting asks first, with keeping it as the focused answer.
	await memory.getByRole("button", { name: "Forget all of it" }).click();
	const confirm = page.getByRole("alertdialog", {
		name: "Forget everything the assistant remembers?",
	});
	await expect(confirm.getByRole("button", { name: "Keep it" })).toBeFocused();
	await confirm.getByRole("button", { name: "Forget all of it" }).click();
	await expect(confirm).toBeHidden();
	await expect(
		memory.getByText("The assistant doesn't remember anything about you yet."),
	).toBeVisible();
	await page.reload();
	await expect(
		memory.getByText("The assistant doesn't remember anything about you yet."),
	).toBeVisible();
});

test("the language chosen in settings is the whole app's", async ({ page }) => {
	await signIn(page);
	await openSettings(page);
	await page.getByRole("combobox", { name: "Language" }).selectOption("it");
	await expect(
		page.getByRole("heading", { name: "Impostazioni", level: 1 }),
	).toBeVisible();
	await expect(page.locator("html")).toHaveAttribute("lang", "it");
	await page.getByRole("link", { name: "Torna alla chat" }).click();
	await expect(
		page.getByRole("textbox", { name: "Scrivi un messaggio…" }),
	).toBeVisible();
	await expect(
		page.getByText("L'assistente è un'IA. Può sbagliare."),
	).toBeVisible();
	await expect(composer(page)).toHaveCount(0);
});
