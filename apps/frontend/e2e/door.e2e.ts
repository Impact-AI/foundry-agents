import { expect, test } from "@playwright/test";
import { signIn } from "./fixtures";

test("the door says it is an AI, signs a person in, and signs them out", async ({
	page,
}) => {
	await page.goto("/login");
	await expect(
		page.getByText("The assistant is an AI, not a person."),
	).toBeVisible();

	await signIn(page);
	await expect(
		page.getByText(
			"Hello — I'm an AI assistant. What would you like to talk about?",
		),
	).toBeVisible();
	await expect(
		page.getByText("The assistant is an AI. It can be wrong."),
	).toBeVisible();

	await page.getByRole("button", { name: "Ada Quill's account" }).click();
	await page.getByRole("menuitem", { name: "Sign out" }).click();
	await expect(page).toHaveURL(/\/login\?left=/);
	await expect(page.getByText("You're signed out.")).toBeVisible();

	await page.goto("/chat");
	await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fchat$/);
});

test("without a session a page is sent to the door and an API call is refused", async ({
	page,
	request,
}) => {
	await page.goto("/settings");
	await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fsettings$/);
	await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

	for (const path of [
		"/api/me",
		"/api/conversations",
		"/api/library?query=x",
	]) {
		const response = await request.get(path);
		expect(response.status(), path).toBe(401);
		expect(await response.json(), path).toEqual({ code: "unauthenticated" });
	}
});

test("the privacy notice is public", async ({ page }) => {
	await page.goto("/privacy");
	await expect(page).toHaveURL(/\/privacy$/);
	await expect(
		page.getByRole("heading", {
			name: "What this app knows about you",
			level: 1,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "You are talking to a machine" }),
	).toBeVisible();
});
