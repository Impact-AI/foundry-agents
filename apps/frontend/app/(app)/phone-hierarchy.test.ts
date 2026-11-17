import { describe, expect, test } from "bun:test";

/**
 * The phone's arrangement (workspace.css, `max-width: 1080px` in portrait):
 * the bar, then a pager — the conversation first and every placed tile a
 * page after it — with the strip of what is open and the conversation's
 * foot pinned under it. Nothing scrolls as a page; each page scrolls inside
 * itself. Read from the stylesheets rather than rendered: what is asserted
 * is the rule's presence and shape, which is what an edit can undo.
 */
const here = (p: string) => new URL(p, import.meta.url);
const css = await Bun.file(here("./workspace/workspace.css")).text();
const phone = css.slice(
	css.indexOf("@media (max-width: 1080px) and (min-height: 481px)"),
);

describe("the phone hierarchy", () => {
	test("the block exists", () => {
		expect(phone.length).toBeGreaterThan(200);
	});

	test("the page is the viewport: bar, pager, strip, foot", () => {
		expect(phone).toMatch(
			/\.main:has\(> \.workspace\)\s*\{\s*height: calc\(\s*var\(--vvh, 100dvh\) -\s*var\(--topbar-h\) -\s*var\(--composer-fixed-h, 0px\) -\s*var\(--stage-pages-h, 0px\)\s*\);/,
		);
		expect(phone).toMatch(
			/\.main:has\(> \.stage-pages\)\s*\{\s*--stage-pages-h: 58px;/,
		);
		expect(phone).toMatch(
			/html\[data-vv-keyboard\] \.main:has\(> \.stage-pages\)\s*\{\s*--stage-pages-h: 0px;/,
		);
	});

	test("the workspace is a pager that snaps a page at a time", () => {
		expect(phone).toMatch(
			/\.workspace\s*\{[^}]*flex-direction: row;[^}]*overflow-x: auto;[^}]*scroll-snap-type: x mandatory;/,
		);
		expect(phone).toMatch(
			/\.workspace > \.workspace-main:has\(> \.stage\),\s*\.workspace \.stage,\s*\.workspace \.chat-column\s*\{\s*display: contents;/,
		);
		expect(phone).toMatch(
			/\.workspace \.chat-column \.chat-pane,\s*\.workspace \.stage-tile\s*\{[^}]*width: 100%;[^}]*height: 100%;[^}]*scroll-snap-align: start;/,
		);
	});

	test("the conversation's panel fills its page, solid, so the foot pinned inside it stays pinned to the viewport", () => {
		expect(phone).toMatch(
			/\.workspace \.chat-column \.panel\.chat-pane\s*\{[^}]*background: var\(--pane-solid\);[^}]*backdrop-filter: none;/,
		);
	});

	test("the conversation is the first page and the desk has none", () => {
		expect(phone).toMatch(
			/\.workspace \.chat-column \.chat-pane\s*\{\s*order: -1;/,
		);
		expect(phone).toMatch(
			/\.workspace > \.workspace-main:has\(> \.landing\)\s*\{\s*display: none;/,
		);
	});

	test("the pager keeps a gutter, and the page never rubber-bands", () => {
		expect(phone).toMatch(
			/\.workspace\s*\{[^}]*padding: 6px 8px;[^}]*gap: 16px;[^}]*scroll-padding-inline: 8px;/,
		);
		expect(phone).toMatch(
			/html:has\(\.main > \.workspace\),\s*html:has\(\.main > \.workspace\) body\s*\{\s*overscroll-behavior: none;/,
		);
	});

	test("the chart takes the whole gesture on a page", () => {
		expect(phone).toMatch(
			/\.workspace \.chart-plot\s*\{\s*touch-action: none;/,
		);
	});

	test("the foot — composer or voice pane — is pinned to the viewport's foot, over the page", () => {
		expect(phone).toMatch(
			/\.workspace \.chat-column \.chat-foot\s*\{[^}]*position: fixed;[^}]*bottom: 0;/,
		);
		expect(phone).toMatch(/\.chat-foot\s*\{[^}]*z-index: 30;/);
		expect(phone).toMatch(/env\(safe-area-inset-bottom, 0px\)/);
	});

	test("the next steps are one sideways row, so the foot stays short", () => {
		expect(phone).toMatch(
			/\.workspace \.chat-column \.chat-suggests\s*\{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;/,
		);
	});

	test("the voice pane keeps room for its trace", () => {
		expect(phone).toMatch(
			/\.voice-pane \.waveform\s*\{\s*flex: none;\s*height: 150px;/,
		);
	});

	test("the foot follows the visual viewport while the keyboard is up", () => {
		expect(phone).toMatch(
			/html\[data-vv-keyboard\] \.workspace \.chat-column \.chat-foot\s*\{[^}]*--vvh/,
		);
	});
});

const pages = await Bun.file(here("./stage/stage-pages.css")).text();

describe("the strip of pages", () => {
	test("exists only on the stacked layout in portrait", () => {
		expect(pages).toMatch(/^\.stage-pages\s*\{\s*display: none;/m);
		expect(pages).toContain(
			"@media (max-width: 1080px) and (min-height: 481px)",
		);
	});

	test("is pinned above the foot and stands down under the keyboard", () => {
		expect(pages).toMatch(
			/\.stage-pages\s*\{[^}]*position: fixed;[^}]*bottom: var\(--composer-fixed-h, 0px\);[^}]*height: 58px;/,
		);
		expect(pages).toMatch(
			/html\[data-vv-keyboard\] \.stage-pages\s*\{\s*display: none;/,
		);
		expect(pages).toMatch(
			/\.stage-page\.is-active\s*\{[^}]*border-color: var\(--accent\);/,
		);
	});

	test("a press is a press: no double-tap zoom, a chip that gives", () => {
		expect(pages).toMatch(/\.stage-page\s*\{[^}]*touch-action: manipulation;/);
		expect(pages).toMatch(
			/\.stage-page:active\s*\{\s*transform: scale\(0\.95\);/,
		);
	});
});
