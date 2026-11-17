/**
 * How much the device should be asked to draw, and whether it welcomes bytes
 * nobody asked for yet. Two cheap hints that only ever demote — the cores
 * the browser admits to and the memory band it reports — plus the shape of
 * the device: a finger on a narrow viewport, or a finger with no hints at
 * all, is a phone until the frame rate says otherwise. Client-side only.
 */

/** Chromium-only memory, an under-reporting core count on some fast phones: both survivable, because this only demotes. */
export function modestHardware(): boolean {
	const nav = navigator as Navigator & { deviceMemory?: number };
	const cores = nav.hardwareConcurrency ?? 8;
	const memory = nav.deviceMemory ?? 8;
	return cores <= 4 || memory <= 4 || handheld();
}

function coarsePointer(): boolean {
	return (
		typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches
	);
}

/** Under this width a coarse-pointer device is a phone rather than a tablet, in CSS pixels. */
const HANDHELD_MAX_WIDTH = 760;

function handheld(): boolean {
	if (typeof navigator === "undefined" || !coarsePointer()) return false;
	const nav = navigator as Navigator & { deviceMemory?: number };
	const hintless =
		nav.deviceMemory === undefined && nav.hardwareConcurrency === undefined;
	return hintless || window.innerWidth <= HANDHELD_MAX_WIDTH;
}

/** `saveData` is the reader saying so; the bands are the browser saying so for them. Absent on Safari and Firefox, where the device shape answers instead. */
function meteredConnection(): boolean {
	const link = (
		navigator as Navigator & {
			connection?: { saveData?: boolean; effectiveType?: string };
		}
	).connection;
	if (!link) return false;
	return (
		link.saveData === true ||
		link.effectiveType === "slow-2g" ||
		link.effectiveType === "2g" ||
		link.effectiveType === "3g"
	);
}

/** The one question every speculative warm asks. A press still gets what it pressed for. */
function welcomesSpeculation(): boolean {
	return !meteredConnection() && !handheld();
}

/** The warms' name for the inverse. */
export function thrifty(): boolean {
	return !welcomesSpeculation();
}

/** A quiet moment, with a ceiling: `requestIdleCallback` where it exists, a timer where it does not. */
export function onIdle(work: () => void, timeout: number): () => void {
	const idle = (
		window as Window & {
			requestIdleCallback?: (cb: () => void, o: { timeout: number }) => number;
			cancelIdleCallback?: (id: number) => void;
		}
	).requestIdleCallback;
	if (idle) {
		const id = idle(work, { timeout });
		return () =>
			(
				window as Window & { cancelIdleCallback?: (id: number) => void }
			).cancelIdleCallback?.(id);
	}
	const id = window.setTimeout(work, timeout);
	return () => window.clearTimeout(id);
}
