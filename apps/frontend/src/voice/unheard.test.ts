import { expect, test } from "bun:test";
import {
	frameLevel,
	HINT_REPEAT_MS,
	UNHEARD_MS,
	unheardDetector,
} from "./unheard";

const LOUD = -30;
const QUIET = -70;

/** Samples every 50 ms from `from` to `to`, at `level`, as the pane reads the meter. */
function run(
	detector: ReturnType<typeof unheardDetector>,
	from: number,
	to: number,
	level: number,
	listening = true,
): boolean {
	let showing = false;
	for (let now = from; now <= to; now += 50)
		showing = detector.sample(now, level, listening);
	return showing;
}

test("a frame's loudness is its RMS in dBFS, and silence is minus infinity", () => {
	expect(frameLevel(new Float32Array(128).fill(1))).toBeCloseTo(0);
	expect(frameLevel(new Float32Array(128).fill(0.1))).toBeCloseTo(-20);
	expect(frameLevel(new Float32Array(128))).toBe(Number.NEGATIVE_INFINITY);
});

test("talking loud enough with no speech heard for two seconds shows the hint; the service hearing speech takes it down", () => {
	const detector = unheardDetector();
	expect(run(detector, 0, UNHEARD_MS - 100, LOUD)).toBe(false);
	expect(run(detector, UNHEARD_MS, UNHEARD_MS + 100, LOUD)).toBe(true);
	detector.heard();
	expect(detector.sample(UNHEARD_MS + 200, QUIET, true)).toBe(false);
});

test("speech heard in time, a short sound, a quiet room, or the voice answering never shows it", () => {
	const heardInTime = unheardDetector();
	run(heardInTime, 0, 1_500, LOUD);
	heardInTime.heard();
	expect(run(heardInTime, 1_550, 2_500, LOUD)).toBe(false);
	heardInTime.stopped();

	const knock = unheardDetector();
	run(knock, 0, 400, LOUD);
	expect(run(knock, 450, 3_000, QUIET)).toBe(false);

	expect(run(unheardDetector(), 0, 5_000, QUIET)).toBe(false);
	expect(run(unheardDetector(), 0, 5_000, LOUD, false)).toBe(false);
});

test("the hint comes back at most once in thirty seconds", () => {
	const detector = unheardDetector();
	expect(run(detector, 0, UNHEARD_MS + 100, LOUD)).toBe(true);
	detector.heard();
	detector.stopped();
	expect(run(detector, 3_000, 3_000 + UNHEARD_MS + 500, LOUD)).toBe(false);
	detector.heard();
	detector.stopped();
	const later = HINT_REPEAT_MS + 1_000;
	expect(run(detector, later, later + UNHEARD_MS + 100, LOUD)).toBe(true);
});

test("a long sentence the service hears never shows it, however long it runs on after speech began", () => {
	const detector = unheardDetector();
	expect(run(detector, 0, 500, LOUD)).toBe(false);
	detector.heard();
	expect(run(detector, 550, 4_000, LOUD)).toBe(false);
	detector.stopped();
	expect(run(detector, 4_050, 4_500, QUIET)).toBe(false);
});

test("once the utterance is over, a fresh stretch of loud input the service does not hear shows it again", () => {
	const detector = unheardDetector();
	run(detector, 0, 500, LOUD);
	detector.heard();
	run(detector, 550, 4_000, LOUD);
	detector.stopped();
	// The count starts again at the end of the utterance, not at its loud samples.
	expect(run(detector, 4_050, 4_050 + UNHEARD_MS - 100, LOUD)).toBe(false);
	expect(
		run(detector, 4_050 + UNHEARD_MS, 4_050 + UNHEARD_MS + 100, LOUD),
	).toBe(true);
});

test("clearing the detector takes the hint down and listens afresh, even mid-utterance", () => {
	const detector = unheardDetector();
	expect(run(detector, 0, UNHEARD_MS + 100, LOUD)).toBe(true);
	detector.clear();
	expect(detector.sample(UNHEARD_MS + 150, QUIET, true)).toBe(false);

	const midUtterance = unheardDetector();
	midUtterance.heard();
	midUtterance.clear();
	const later = HINT_REPEAT_MS + 1_000;
	expect(run(midUtterance, later, later + UNHEARD_MS + 100, LOUD)).toBe(true);
});
