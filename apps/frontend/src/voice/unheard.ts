/**
 * "The voice can't hear you": a microphone loud enough to move the trace
 * and too quiet, or too far, for the service's turn detection — its noise
 * suppression drops quiet speech as noise, and the browser's gain cannot
 * lift an input level set that low — so the person talks and nothing
 * happens. Measured here, on this device, from loudness alone: never kept,
 * never sent, and nothing about the voice but how loud it is.
 */

/** RMS above this is voice-like energy rather than a quiet room. */
const VOICE_FLOOR_DBFS = -50;
/** How long the energy has to last to be somebody talking. */
const VOICE_SUSTAIN_MS = 1_000;
/** A dip shorter than this between words does not end the utterance. */
const VOICE_GAP_MS = 300;
/** How long after the person began, loud enough, the service has to hear them. */
export const UNHEARD_MS = 2_000;
/** The hint is shown at most once in this long. */
export const HINT_REPEAT_MS = 30_000;

/** Loudness of one frame of samples, in dBFS. */
export function frameLevel(samples: Float32Array): number {
	let sum = 0;
	for (const v of samples) sum += v * v;
	const rms = Math.sqrt(sum / Math.max(1, samples.length));
	return rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
}

/**
 * Whether to show the hint, sample by sample. `listening` is true only while
 * the session is open and waiting for the person — not while the voice
 * answers or its audio still plays (its own sound can reach the microphone),
 * not muted. `heard()` is the service hearing speech begin (`speech` started):
 * it takes the hint down, and nothing is counted until `stopped()`, the
 * utterance over (`speech` stopped), since the person talking on is what the
 * service is hearing. The count then starts again from nothing: only a fresh
 * stretch of loud input with no speech heard shows the hint. `clear()` takes
 * the hint down and forgets the utterance, for a session that closed.
 */
export function unheardDetector() {
	let voiceSince: number | null = null;
	let lastLoud = 0;
	let shownAt = Number.NEGATIVE_INFINITY;
	let showing = false;
	/** The service is hearing an utterance: between `heard()` and `stopped()`. */
	let hearing = false;
	const reset = () => {
		voiceSince = null;
	};
	return {
		sample(now: number, levelDb: number, listening: boolean): boolean {
			if (!listening || hearing) {
				reset();
				return showing;
			}
			if (levelDb >= VOICE_FLOOR_DBFS) {
				voiceSince ??= now;
				lastLoud = now;
			} else if (
				voiceSince !== null &&
				now - lastLoud > VOICE_GAP_MS &&
				lastLoud - voiceSince < VOICE_SUSTAIN_MS
			)
				// Too short to be somebody talking: a knock, a cough.
				reset();
			if (
				!showing &&
				voiceSince !== null &&
				lastLoud - voiceSince >= VOICE_SUSTAIN_MS &&
				now - voiceSince >= UNHEARD_MS &&
				now - shownAt >= HINT_REPEAT_MS
			) {
				showing = true;
				shownAt = now;
				reset();
			}
			return showing;
		},
		heard(): void {
			showing = false;
			hearing = true;
			reset();
		},
		stopped(): void {
			hearing = false;
			reset();
		},
		clear(): void {
			showing = false;
			hearing = false;
			reset();
		},
	};
}
