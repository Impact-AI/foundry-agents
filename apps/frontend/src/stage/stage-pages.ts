/**
 * The phone's pager, as arithmetic. On a phone the workspace is a row of
 * pages the width of the screen — the conversation first, then every tile —
 * swept sideways and snapped; the strip under it lights the page in view,
 * decided here from the pager's offset and where each page begins.
 */
export interface PageBox {
	key: string;
	left: number;
}

/** Where a page begins as a scroll offset: its position less the pager's gutter, which is what the snap lands on. */
export function pageLeft(el: HTMLElement, pager: HTMLElement): number {
	const gutter = Number.parseFloat(getComputedStyle(pager).paddingLeft);
	return el.offsetLeft - (Number.isFinite(gutter) ? gutter : 0);
}

/** A tile's page in the pager, by its section — not one already on its way out. */
export function tileOf(pager: HTMLElement, key: string): HTMLElement | null {
	return pager.querySelector<HTMLElement>(
		`.stage-tile[data-key="${CSS.escape(key)}"]:not(.is-leaving)`,
	);
}

export function activePage(
	scrollLeft: number,
	pages: readonly PageBox[],
): string | null {
	let best: string | null = null;
	let nearest = Number.POSITIVE_INFINITY;
	for (const page of pages) {
		const distance = Math.abs(page.left - scrollLeft);
		if (distance < nearest) {
			nearest = distance;
			best = page.key;
		}
	}
	return best;
}
