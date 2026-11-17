/**
 * The keyframes a tile moves on — the arithmetic behind the stage's FLIP,
 * pure so it can be tested away from the DOM.
 *
 * A tile handed a new cell is played from where it stood: a translate for
 * the move and a scale for the change of size. The scale would stretch
 * everything inside the tile for the length of the move, so the element
 * inside it is scaled by exactly the reciprocal at every sample: the content
 * sits at its final size from the first frame and what moves is the clip. A
 * reciprocal of an eased value is not the eased value of a reciprocal, so the
 * curve is sampled here and the browser interpolates straight lines between.
 */

/** The shell's decelerating curve — `--ease`, as its four control points. */
const EASE = [0.22, 1, 0.36, 1] as const;

const STEPS = 24;

const MIN_SCALE = 0.02;
const MAX_SCALE = 50;

export type FlipFrame = {
	offset: number;
	transformOrigin: string;
	transform: string;
};

export type FlipMove = {
	dx: number;
	dy: number;
	/** Old width over new. */
	sx: number;
	/** Old height over new. */
	sy: number;
};

const clamp = (n: number, lo: number, hi: number) =>
	n < lo ? lo : n > hi ? hi : n;

function bezier(a: number, b: number, t: number): number {
	const u = 1 - t;
	return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
}

/** The curve's y for a given x, by bisection: monotonic, so it always converges. */
export function eased(x: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const [x1, y1, x2, y2] = EASE;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 30; i++) {
		const mid = (lo + hi) / 2;
		if (bezier(x1, x2, mid) < x) lo = mid;
		else hi = mid;
	}
	return bezier(y1, y2, (lo + hi) / 2);
}

/** Under half a pixel of travel and a fifth of a percent of scale there is nothing to see. */
export function worthPlaying({ dx, dy, sx, sy }: FlipMove): boolean {
	return (
		Math.abs(dx) >= 0.5 ||
		Math.abs(dy) >= 0.5 ||
		Math.abs(sx - 1) >= 0.002 ||
		Math.abs(sy - 1) >= 0.002
	);
}

export function flipFrames(move: FlipMove): {
	tile: FlipFrame[];
	inner: FlipFrame[];
} {
	const sx = clamp(move.sx, MIN_SCALE, MAX_SCALE);
	const sy = clamp(move.sy, MIN_SCALE, MAX_SCALE);
	const tile: FlipFrame[] = [];
	const inner: FlipFrame[] = [];
	for (let i = 0; i <= STEPS; i++) {
		const offset = i / STEPS;
		const e = eased(offset);
		const x = move.dx * (1 - e);
		const y = move.dy * (1 - e);
		const kx = sx + (1 - sx) * e;
		const ky = sy + (1 - sy) * e;
		tile.push({
			offset,
			transformOrigin: "0 0",
			transform: `translate(${x}px, ${y}px) scale(${kx}, ${ky})`,
		});
		inner.push({
			offset,
			transformOrigin: "0 0",
			transform: `scale(${1 / kx}, ${1 / ky})`,
		});
	}
	return { tile, inner };
}
