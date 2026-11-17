/**
 * The library's carousel, as arithmetic. A view is a grid of as many cards as
 * the track has room for — one on a narrow stage, a row of two or three on a
 * wide one, two rows where the tile is tall — and the carousel moves a whole
 * view at a time, so a step never shows a card the last view already showed.
 * Everything here is decided from what the track measures.
 */

/** A view's shape: columns across, rows down. */
export interface Grid {
	cols: number;
	rows: number;
}

/** A view's cards, one-based and inclusive: what "1–4 of 9" names. */
export interface ViewSpan {
	first: number;
	last: number;
}

/** The fewest pixels a card needs to read well; below that a view holds fewer cards. */
export interface CardFloor {
	width: number;
	height: number;
}

/** No more than this many across or down: past it a card is too small to be a card. */
export const GRID_MAX = 3;

function fit(room: number, floor: number, gap: number): number {
	if (!(room > 0) || !(floor > 0)) return 1;
	const n = Math.floor((room + gap + 1) / (floor + gap));
	return Math.min(GRID_MAX, Math.max(1, n));
}

/**
 * The grid the track's content box holds. A pixel of slack absorbs the
 * sub-pixel rounding of a fractional layout. Never fewer than one by one.
 */
export function gridFor(
	width: number,
	height: number,
	gap: number,
	floor: CardFloor,
): Grid {
	return {
		cols: fit(width, floor.width, gap),
		rows: fit(height, floor.height, gap),
	};
}

/** How many views it takes to show every card. */
export function viewCount(count: number, perView: number): number {
	return Math.max(1, Math.ceil(count / Math.max(1, perView)));
}

/** The view a scroll offset is nearest, given how far apart views begin. */
export function viewAt(
	scrollLeft: number,
	viewWidth: number,
	views: number,
): number {
	if (!(viewWidth > 0)) return 0;
	return Math.min(views - 1, Math.max(0, Math.round(scrollLeft / viewWidth)));
}

/** The cards a view shows; the last view may hold fewer than the others. */
export function viewSpan(
	view: number,
	perView: number,
	count: number,
): ViewSpan {
	const first = view * perView + 1;
	return { first, last: Math.min(count, first + perView - 1) };
}

/**
 * The view that keeps a card in sight when the grid changes shape — a window
 * resized, a tile opened beside it — so the person is not sent back to the start.
 */
export function viewHolding(card: number, perView: number): number {
	return Math.floor(Math.max(0, card) / Math.max(1, perView));
}
