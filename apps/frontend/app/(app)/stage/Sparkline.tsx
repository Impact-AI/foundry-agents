import { bandFraction, niceBand } from "@/src/stage/chart-band";
import { runsOf } from "@/src/stage/chart-grid";

/** A series at glancing size: one line, no rules, in the thread's card; a point with no value is a gap, never a zero. */
export function Sparkline({
	points,
	hue = 0,
}: {
	points: readonly { y: number | null }[];
	hue?: number;
}) {
	const W = 160;
	const H = 40;
	const ys = points.map((p) => p.y);
	const band = niceBand(ys.filter((y): y is number => y !== null));
	const slots = Math.max(1, points.length - 1);
	const at = (i: number, y: number) =>
		`${(i / slots) * W},${4 + (1 - bandFraction(band, y)) * (H - 8)}`;
	return (
		<svg
			className="sparkline"
			viewBox={`0 0 ${W} ${H}`}
			preserveAspectRatio="none"
			aria-hidden="true"
			data-hue={hue}
		>
			{runsOf(ys).map((run) => (
				<polyline
					key={run[0]?.i}
					// A lone value is its point twice: a line of no length, drawn as a dot.
					points={(run.length > 1 ? run : [...run, ...run])
						.map((p) => at(p.i, p.y))
						.join(" ")}
				/>
			))}
		</svg>
	);
}
