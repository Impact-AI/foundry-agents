/**
 * A repainting loop that only runs while there is somebody to see it: while
 * the host element intersects the viewport and the tab is in front. The cost
 * of an off-screen loop is everything the drawing drags with it — every
 * backdrop blur over a canvas re-samples when its pixels change — so the
 * guard is the default rather than the thing a caller remembers.
 *
 * Callers clamp their own timestamp gap across a stop; this decides only
 * whether anyone is looking. Client-side only.
 */
export type FrameLoopOptions = {
	/** A ceiling in frames per second; the frame is still requested, the work is skipped. */
	readonly fps?: number;
};

export function frameLoop(
	host: Element,
	onFrame: (now: number) => void,
	options: FrameLoopOptions = {},
): () => void {
	const interval = options.fps && options.fps > 0 ? 1000 / options.fps : 0;
	let raf = 0;
	let running = false;
	let onScreen = true;
	let painted = 0;

	const tick = (now: number) => {
		raf = requestAnimationFrame(tick);
		// A tenth of an interval of slack, so a frame arriving a millisecond
		// early is not refused and the loop served at two thirds of its ceiling.
		if (interval && painted && now - painted < interval * 0.9) return;
		painted = now;
		onFrame(now);
	};

	const start = () => {
		if (running) return;
		running = true;
		raf = requestAnimationFrame(tick);
	};

	const stop = () => {
		if (!running) return;
		running = false;
		painted = 0;
		cancelAnimationFrame(raf);
		raf = 0;
	};

	const sync = () => {
		if (onScreen && document.visibilityState !== "hidden") start();
		else stop();
	};

	const observer = new IntersectionObserver(
		([entry]) => {
			onScreen = entry?.isIntersecting ?? true;
			sync();
		},
		{ threshold: 0 },
	);
	observer.observe(host);
	document.addEventListener("visibilitychange", sync);
	sync();

	return () => {
		stop();
		observer.disconnect();
		document.removeEventListener("visibilitychange", sync);
	};
}
