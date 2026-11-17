import {
	ALPHA,
	deal,
	MOTE_COUNT,
	SIZE,
	STRIDE,
	TINT,
	X,
	Y,
} from "./field-deal";

/**
 * The field's still frame — the backdrop before any script has run. The same
 * deal as the live canvas, serialised once at module scope into a handful of
 * SVG paths, so there is a field the moment there is anything; the canvas
 * crossfades over it at hydration. Computed from constants alone, so the
 * server and the client serialise the identical string.
 */
const W = 1600;
const H = 1000;
const ALPHA_STEP = 0.05;

const TINTS = [
	"var(--field-tint)",
	"var(--field-tint-2)",
	"var(--field-tint-3)",
];

function stillFrame(): { d: string; fill: string; opacity: number }[] {
	const motes = deal();
	const buckets = new Map<
		string,
		{ d: string[]; fill: string; opacity: number }
	>();
	for (let i = 0; i < MOTE_COUNT; i++) {
		const o = i * STRIDE;
		const x = (motes[o + X] ?? 0) * W;
		const y = (motes[o + Y] ?? 0) * H;
		const r = Math.round((motes[o + SIZE] ?? 1) * 10) / 10;
		const a =
			Math.round((motes[o + ALPHA] ?? 0) * (1 / ALPHA_STEP)) * ALPHA_STEP;
		if (a === 0) continue;
		const tint = motes[o + TINT] ?? 0;
		const key = `${tint}:${a}`;
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = { d: [], fill: TINTS[tint] ?? "var(--field-tint)", opacity: a };
			buckets.set(key, bucket);
		}
		bucket.d.push(
			`M${(x - r).toFixed(1)} ${y.toFixed(1)}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0z`,
		);
	}
	return Array.from(buckets.values(), (b) => ({
		d: b.d.join(""),
		fill: b.fill,
		opacity: Math.round(b.opacity * 100) / 100,
	}));
}

const FRAME = stillFrame();

export function StillField() {
	return (
		<svg
			className="field-still"
			viewBox={`0 0 ${W} ${H}`}
			preserveAspectRatio="xMidYMid slice"
			aria-hidden="true"
		>
			{FRAME.map((layer) => (
				<path
					key={`${layer.fill}:${layer.opacity}`}
					d={layer.d}
					style={{ fill: layer.fill }}
					fillOpacity={layer.opacity}
				/>
			))}
		</svg>
	);
}
