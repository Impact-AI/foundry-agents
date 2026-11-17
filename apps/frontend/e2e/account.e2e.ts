import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { ANSWERS, ask, openSettings, signIn } from "./fixtures";

test("a person downloads a copy of what is kept, then deletes the account and is signed out", async ({
	page,
}) => {
	await signIn(page);
	await ask(page, "Show me the onboarding library", ANSWERS.library);
	await openSettings(page);
	const data = page.getByRole("region", { name: "Your information" });

	const downloading = page.waitForEvent("download");
	await data.getByRole("button", { name: "Download a copy" }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe("account-export.json");
	const copy = JSON.parse(await readFile(await download.path(), "utf8")) as {
		format: string;
		account: unknown;
		conversations: { title: string | null; messages: unknown[] }[];
	};
	expect(copy.format).toBe("personal-data-export/3");
	expect(JSON.stringify(copy.account)).toContain("Ada Quill");
	expect(copy.conversations).toHaveLength(1);
	expect(JSON.stringify(copy.conversations[0]?.messages)).toContain(
		"Show me the onboarding library",
	);

	await data.getByRole("button", { name: "Delete this account" }).click();
	const confirm = page.getByRole("alertdialog", {
		name: "Delete this account?",
	});
	await expect(
		confirm.getByRole("button", { name: "Keep my account" }),
	).toBeFocused();
	await confirm.getByRole("button", { name: "Delete everything" }).click();
	await expect(page).toHaveURL(/\/login\?left=erased/);
	await expect(page.getByText("That account is deleted")).toBeVisible();
	await page.goto("/chat");
	await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fchat$/);
});
