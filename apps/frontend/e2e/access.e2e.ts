import { expect, test } from "@playwright/test";
import { signIn } from "./fixtures";

/**
 * The backend loads, beside the sample library, one document and its picture only the group
 * `people-team` may read (`apps/backend/src/testing/restricted-library`),
 * with access control enforced. A local account carries no group, so the
 * library a person searches never lists it, whatever they ask for.
 */
test("a document restricted to a group is not listed for a person outside it", async ({
	page,
}) => {
	await signIn(page);
	for (const query of ["onboarding pay review", "onboarding"]) {
		const response = await page.request.get(
			`/api/library?query=${encodeURIComponent(query)}`,
		);
		expect(response.status()).toBe(200);
		const { documents } = (await response.json()) as {
			documents: { title: string }[];
		};
		const titles = documents.map((d) => d.title);
		// The search ran and found what this person may read...
		expect(titles, query).toContain("Onboarding handbook");
		// ...and nothing they may not.
		expect(titles, query).not.toContain("Onboarding pay review");
	}
});

/**
 * A picture is a blob of its own and has no chunk to filter, so the media
 * route reads its readers off the blob: the restricted document's picture
 * is the same 404 as a path nobody uploaded, while the sample's is served.
 */
test("a picture restricted to a group is not served to a person outside it", async ({
	page,
}) => {
	await signIn(page);
	const open = await page.request.get(
		"/api/media/%40sample/pictures/depot-dawn.png",
	);
	expect(open.status()).toBe(200);
	expect(open.headers()["content-type"]).toContain("image/png");
	for (const path of [
		"/api/media/restricted/pictures/pay-bands.png",
		"/api/media/restricted/pictures/no-such-picture.png",
	]) {
		const response = await page.request.get(path);
		expect(response.status(), path).toBe(404);
	}
});
