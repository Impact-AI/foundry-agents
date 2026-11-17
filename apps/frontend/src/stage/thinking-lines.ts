/**
 * The line beside the dot while the assistant is thinking: one short
 * sentence per wait, drawn from a pool, never the same line twice running.
 * Everything here is the choosing; the words are catalogue entries under
 * `thinking`, written per language rather than translated.
 */

/** How often a wait draws from the rare pool instead. */
export const RARE_ODDS = 1 / 12;

/** A fast turn keeps the bare dot: a line that appears and is gone inside a second reads as a fault. */
export const FIRST_LINE_MS = 1200;

/** How fast a line types itself on, per character. */
export const TYPE_MS = 24;

/** A cursor remounting inside this window carries the last wait on rather than drawing a new line. */
export const RESUME_MS = 2000;

export type ThinkingPool = "lines" | "rare";

export function poolFor(roll: number): ThinkingPool {
	return roll < RARE_ODDS ? "rare" : "lines";
}

export function pickLine(
	lines: readonly string[],
	previous: string | null,
	roll: number,
): string | null {
	const fresh = lines.filter((line) => line !== previous);
	const from = fresh.length > 0 ? fresh : lines;
	if (from.length === 0) return null;
	const index = Math.min(from.length - 1, Math.floor(roll * from.length));
	return from[index] ?? null;
}
