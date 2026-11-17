/**
 * Where the guide's card stands relative to the thing it is about — the one
 * piece of the guide with a decision in it, stated where it can be tested
 * against a viewport.
 */
export type Spot = {
	top: number;
	left: number;
	width: number;
	height: number;
	radius: number;
};

const GAP = 14;
const EDGE = 12;

const clamp = (v: number, lo: number, hi: number) =>
	Math.max(lo, Math.min(v, hi));

/** Where the page should scroll so a stop is in the frame under the bar, or null when it already is. */
export function guideScrollTo(
	box: { top: number; height: number },
	view: { height: number; scrollY: number },
	barHeight: number,
): number | null {
	const frame = view.height - barHeight;
	if (box.top >= barHeight && box.top + box.height <= view.height) return null;
	const docTop = view.scrollY + box.top;
	const target =
		box.height >= frame
			? docTop - barHeight
			: docTop - barHeight - (frame - box.height) / 2;
	return Math.max(0, Math.round(target));
}

/**
 * Beside the thing where there is room in the margin, else above or below —
 * from above once it is past halfway down, where the composer is. Nothing
 * fits on a small screen: then the roomiest side, clamped into the frame.
 * A null spot is the opening card, centred.
 */
export function placeCard(
	spot: Spot | null,
	card: { width: number; height: number },
	view: { width: number; height: number },
): { x: number; y: number } {
	const { width: w, height: h } = card;
	const { width: vw, height: vh } = view;

	if (!spot) return { x: (vw - w) / 2, y: (vh - h) / 2 };

	const cy = spot.top + spot.height / 2;
	const inLeftMargin = spot.left + spot.width + GAP + w <= vw * 0.5;
	const inRightMargin = spot.left - GAP - w >= vw * 0.5;
	const order = inLeftMargin
		? (["right", "top", "bottom", "left"] as const)
		: inRightMargin
			? (["left", "top", "bottom", "right"] as const)
			: cy > vh * 0.5
				? (["top", "right", "left", "bottom"] as const)
				: (["bottom", "right", "left", "top"] as const);

	const across = () =>
		clamp(
			spot.left + spot.width / 2 - w / 2,
			EDGE,
			Math.max(EDGE, vw - EDGE - w),
		);
	const down = () => clamp(cy - h / 2, EDGE, Math.max(EDGE, vh - EDGE - h));

	for (const side of order) {
		if (side === "right" && spot.left + spot.width + GAP + w <= vw - EDGE)
			return { x: spot.left + spot.width + GAP, y: down() };
		if (side === "left" && spot.left - GAP - w >= EDGE)
			return { x: spot.left - GAP - w, y: down() };
		if (side === "bottom" && spot.top + spot.height + GAP + h <= vh - EDGE)
			return { x: across(), y: spot.top + spot.height + GAP };
		if (side === "top" && spot.top - GAP - h >= EDGE)
			return { x: across(), y: spot.top - GAP - h };
	}

	const room = {
		right: vw - (spot.left + spot.width),
		left: spot.left,
		bottom: vh - (spot.top + spot.height),
		top: spot.top,
	};
	const side = (Object.keys(room) as (keyof typeof room)[]).reduce((a, b) =>
		room[a] >= room[b] ? a : b,
	);
	if (side === "right")
		return {
			x: clamp(spot.left + spot.width + GAP, EDGE, vw - EDGE - w),
			y: down(),
		};
	if (side === "left")
		return { x: clamp(spot.left - GAP - w, EDGE, vw - EDGE - w), y: down() };
	if (side === "bottom")
		return {
			x: across(),
			y: clamp(spot.top + spot.height + GAP, EDGE, vh - EDGE - h),
		};
	return { x: across(), y: clamp(spot.top - GAP - h, EDGE, vh - EDGE - h) };
}
