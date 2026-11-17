import { expect, type Page, test } from "@playwright/test";
import { ANSWERS, ask, signIn } from "./fixtures";

/**
 * The policy as a browser enforces it: a page that needed an inline script
 * the nonce did not cover would report a violation, or never hydrate.
 */
function violations(page: Page): string[] {
	const seen: string[] = [];
	page.on("console", (message) => {
		if (/Content Security Policy/i.test(message.text()))
			seen.push(message.text());
	});
	return seen;
}

test("the door, the workspace and the settings load under a nonce, with no inline script allowed and nothing refused", async ({
	page,
}) => {
	const seen = violations(page);
	const response = await page.goto("/login");
	const policy = response?.headers()["content-security-policy"] ?? "";
	const script = policy
		.split(";")
		.find((d) => d.trim().startsWith("script-src"));
	expect(script).toMatch(/'nonce-[^']+' 'strict-dynamic'/);
	expect(script).not.toContain("unsafe-inline");
	expect(script).not.toContain("unsafe-eval");

	// Hydrated, not only served: the form signs a person in.
	await signIn(page);
	await expect(page).toHaveURL(/\/chat/);
	await expect(page.getByRole("textbox").first()).toBeVisible();

	await page.goto("/settings");
	await expect(page.getByRole("heading").first()).toBeVisible();

	// A second load is given another nonce.
	const again = await page.goto("/settings");
	const nonce = (value: string) => /'nonce-([^']+)'/.exec(value)?.[1];
	expect(nonce(again?.headers()["content-security-policy"] ?? "")).not.toBe(
		nonce(policy),
	);
	expect(seen).toEqual([]);
});

test("a path nothing serves is answered by a page that runs: a file's name or not, signed in or not", async ({
	page,
}) => {
	const seen = violations(page);
	// Nobody signed in: a path that names a file is not sent to the door,
	// and the page that says it is not there hydrates under its nonce.
	for (const path of ["/nope.txt", "/foo/bar.html"]) {
		const response = await page.goto(path);
		expect(response?.status()).toBe(404);
		expect(response?.headers()["content-security-policy"]).toMatch(
			/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/,
		);
		await page.waitForLoadState("networkidle");
	}
	await signIn(page);
	for (const path of ["/nope.txt", "/nope"]) {
		const response = await page.goto(path);
		expect(response?.status()).toBe(404);
		await page.waitForLoadState("networkidle");
	}
	expect(seen).toEqual([]);
});

test("a picture answers with its own sandbox, never the page's policy, and a copy held is not sent again", async ({
	page,
}) => {
	await signIn(page);
	await ask(page, "Show me the onboarding library", ANSWERS.library);
	const src = await page
		.locator('img[src^="/api/media/"]')
		.first()
		.getAttribute("src");
	expect(src).toBeTruthy();
	const first = await page.request.get(src as string);
	expect(first.status()).toBe(200);
	expect(first.headers()["content-security-policy"]).toBe(
		"default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
	);
	expect(first.headers()["cache-control"]).toBe("private, no-cache");
	const etag = first.headers().etag;
	expect(etag).toBeTruthy();
	const again = await page.request.get(src as string, {
		headers: { "If-None-Match": etag as string },
	});
	expect(again.status()).toBe(304);
	expect((await again.body()).length).toBe(0);
});

test("a file under public/ is answered with no cookie, whoever asks, and a path under /api that nothing answers is data", async ({
	page,
}) => {
	const worklet = "/voice/capture-worklet.js";
	const anonymous = await page.request.get(worklet);
	expect(anonymous.status()).toBe(200);
	expect(anonymous.headers()["set-cookie"]).toBeUndefined();
	// Nobody signed in: an endpoint that is not there is the door's refusal, as any endpoint's is.
	const refused = await page.request.get("/api/nope");
	expect(refused.status()).toBe(401);
	expect(refused.headers()["content-type"]).toContain("application/json");

	await signIn(page);
	const signedIn = await page.request.get(worklet);
	expect(signedIn.status()).toBe(200);
	expect(signedIn.headers()["set-cookie"]).toBeUndefined();
	for (const path of ["/api/nope", "/api/nope.json", "/api/me/nope"]) {
		const missing = await page.request.get(path);
		expect(missing.status()).toBe(404);
		expect(missing.headers()["content-type"]).toContain("application/json");
		expect(await missing.json()).toEqual({ code: "not_found" });
	}
});
