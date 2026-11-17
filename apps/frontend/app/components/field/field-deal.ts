/**
 * The field's deal — one deterministic hand of motes every rendering of the
 * backdrop draws from, so the live canvas and the server-rendered still
 * frame are two pictures of one field. No browser API here: the still frame
 * runs during server rendering.
 */
export const MOTE_COUNT = 140;

export const STRIDE = 7;
export const X = 0;
export const Y = 1;
export const DEPTH = 2;
export const SIZE = 3;
export const ALPHA = 4;
export const TINT = 5;
export const PHASE = 6;

/** mulberry32 — small enough to read, seeded once. */
export function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Positions in [0, 1) of the box, a depth that sets size and speed, a brightness, a tint, a breathing phase. */
export function deal(): Float32Array {
	const rand = prng(0x5745_4c43);
	const motes = new Float32Array(MOTE_COUNT * STRIDE);
	for (let i = 0; i < MOTE_COUNT; i++) {
		const o = i * STRIDE;
		const depth = Math.floor(rand() * 3);
		motes[o + X] = rand();
		motes[o + Y] = rand();
		motes[o + DEPTH] = depth;
		motes[o + SIZE] = 1.5 + depth * 1.6 + rand() * 1.4;
		motes[o + ALPHA] = 0.12 + depth * 0.1 + rand() * 0.18;
		const tint = rand();
		motes[o + TINT] = tint < 0.7 ? 0 : tint < 0.9 ? 1 : 2;
		motes[o + PHASE] = rand() * Math.PI * 2;
	}
	return motes;
}
