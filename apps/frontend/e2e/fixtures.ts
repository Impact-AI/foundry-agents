import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * What every journey shares: signing in as a new person, sending a turn and
 * waiting for its end, and the accessibility check. Every wait is on
 * something a person would see; none is on a clock.
 */

/**
 * The door in local mode: a name, then the workspace. Each sign-in is a new
 * account, so no two tests share a conversation, a note or a setting. The
 * first visit's tour opens by itself once the workspace is drawn, and sends
 * the stage home as it does — so it is closed here, before any test fills
 * the stage.
 */
export async function signIn(page: Page, name = "Ada Quill"): Promise<void> {
	await page.goto("/chat");
	await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fchat$/);
	await page.getByLabel("Your name").fill(name);
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page).toHaveURL(/\/chat/);
	const guide = page.getByRole("dialog", { name: "Welcome to the workspace" });
	await guide.getByRole("button", { name: "Close the guide" }).click();
	await expect(guide).toBeHidden();
}

/** Settings, from the account's menu in the bar. */
export async function openSettings(
	page: Page,
	name = "Ada Quill",
): Promise<void> {
	await page.getByRole("button", { name: `${name}'s account` }).click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await expect(
		page.getByRole("heading", { name: "Settings", level: 1 }),
	).toBeVisible();
}

export function composer(page: Page): Locator {
	return page.getByRole("textbox", { name: "Write a message…" });
}

/** The status the thread carries while a turn runs. */
export function answering(page: Page): Locator {
	return page
		.getByRole("status")
		.filter({ hasText: "The assistant is answering" });
}

/** Waits for a turn to end: the answer's first words in the thread, then the busy status gone. */
export async function answered(
	page: Page,
	answerStartsWith: string,
): Promise<void> {
	await expect(
		page.getByRole("paragraph").filter({ hasText: answerStartsWith }),
	).toBeVisible({ timeout: 60_000 });
	await expect(answering(page)).toHaveCount(0, { timeout: 30_000 });
}

/** Sends `text` and waits for the turn to end, with the composer's Send back in place of Stop. */
export async function ask(
	page: Page,
	text: string,
	answerStartsWith: string,
): Promise<void> {
	await composer(page).fill(text);
	await composer(page).press("Enter");
	await answered(page, answerStartsWith);
	await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
}

/** The scripted model's three answers, by their opening words (`dev-fake.ts`). */
export const ANSWERS = {
	library: "Here is what the library holds on",
	readerAndChart: "The rollout plan is open at its first page",
	recordAndPicture: "Halvard Logistics is the customer behind wave one",
	severalActions: "Warehouse Vision is in its pilot",
} as const;

/**
 * The page has no serious or critical WCAG A/AA violation, checked at rest:
 * every page and panel fades in, and a page read mid-fade has the contrast
 * of its fade. So the check waits for every animation that ends to have
 * ended; the ones that loop for as long as they are on screen never do.
 */
export async function expectAccessible(page: Page): Promise<void> {
	await page.evaluate(() =>
		Promise.all(
			document
				.getAnimations()
				.filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
				.map((a) => a.finished.catch(() => undefined)),
		),
	);
	const { violations } = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
		.analyze();
	const blocking = violations
		.filter((v) => v.impact === "serious" || v.impact === "critical")
		.map((v) => ({
			id: v.id,
			impact: v.impact,
			help: v.help,
			targets: v.nodes.map((n) => n.target.join(" ")),
		}));
	expect(blocking).toEqual([]);
}

/**
 * Focused from the keyboard, the control's ring is drawn whole: every
 * ancestor that clips leaves room for it — a card on a scrolling track, a
 * picture in a scrolling page, an arrow at a tile's foot. A card's ring lies
 * on its own border (one ring, no gap); a round icon button keeps the house
 * ring a little outside it, so `{ gap: true }` lets that through.
 */
export async function expectRingWhole(
	page: Page,
	control: Locator,
	{ gap = false }: { gap?: boolean } = {},
) {
	// A key first, so the focus that follows is a keyboard's and shows its ring.
	await page.keyboard.press("Shift");
	await control.focus();
	const cut = await control.evaluate((el, gap) => {
		el.scrollIntoView({ block: "center", inline: "nearest" });
		if (!el.matches(":focus-visible")) return ["no ring: not :focus-visible"];
		const style = getComputedStyle(el);
		const offset = Number.parseFloat(style.outlineOffset);
		if (offset > 0 && !gap)
			return [`a ${offset}px gap between the ring and the border`];
		const reach = Number.parseFloat(style.outlineWidth) + offset;
		const box = el.getBoundingClientRect();
		const cuts: string[] = [];
		for (let up = el.parentElement; up; up = up.parentElement) {
			const { overflowX, overflowY } = getComputedStyle(up);
			if (overflowX === "visible" && overflowY === "visible") continue;
			const at = up.getBoundingClientRect();
			const left = at.left + up.clientLeft;
			const top = at.top + up.clientTop;
			if (
				box.left - reach < left - 0.5 ||
				box.top - reach < top - 0.5 ||
				box.right + reach > left + up.clientWidth + 0.5 ||
				box.bottom + reach > top + up.clientHeight + 0.5
			)
				cuts.push(`cut by .${up.className}`);
		}
		return cuts;
	}, gap);
	expect(cut).toEqual([]);
}
