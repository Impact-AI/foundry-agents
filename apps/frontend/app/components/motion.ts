/** The one place the app asks whether the reader wants motion. Client-side only. */
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
	return typeof matchMedia === "function" && matchMedia(REDUCED_MOTION).matches;
}

export function reducedMotionQuery(): MediaQueryList {
	return matchMedia(REDUCED_MOTION);
}
