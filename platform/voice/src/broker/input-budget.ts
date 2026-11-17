import { AUDIO_SAMPLE_RATE } from "./messages";
import { MAX_SPOKEN_BYTES } from "./store";

/**
 * What one session takes from its browser beyond the size of a frame: how
 * fast, and how much in all. A frame's size is bounded where it is read
 * (`messages.ts`, the socket's own payload bound); nothing there says how
 * many may come, and every one taken is kept in the session's transcript,
 * sent on to the service and, for the person's words, written into the
 * thread when the session ends. A browser this app wrote sends a
 * microphone's audio as it is captured, a typed message when a person
 * presses Enter and the screen when it changes, so it never meets these
 * bounds. They are for a client that is not this app's, and they hold before
 * anything it sends is stored or forwarded.
 */

/** PCM16, mono: two bytes a sample. */
const AUDIO_BYTES_PER_SECOND = AUDIO_SAMPLE_RATE * 2;

export const INPUT_BUDGET = {
	/** Audio is taken a quarter faster than it is spoken, for a capture clock that runs ahead of this one, */
	audioBytesPerSecond: AUDIO_BYTES_PER_SECOND * 1.25,
	/** and four seconds of it at once: twice what this app's pane holds back while its network stalls, for what a relay between them held as well. */
	audioBurstBytes: AUDIO_BYTES_PER_SECOND * 4,
	/**
	 * A minute of audio refused, faster than it is forgiven, is not a
	 * microphone: the session ends. A tenth of a second's worth is forgiven
	 * each second, so the network stalls of a long session, each refusing a
	 * few seconds now and then, never add up to an end, and audio sent
	 * steadily faster than it is taken still does, within minutes.
	 */
	audioRefusedBytesEnd: AUDIO_BYTES_PER_SECOND * 60,
	audioRefusedForgivenPerSecond: AUDIO_BYTES_PER_SECOND / 10,
	/** Typed messages: six at once, then one every two seconds, */
	typedBurst: 6,
	typedPerSecond: 0.5,
	/** and, in one session, a quarter of what its snapshot holds: the rest is for what is spoken. */
	typedBytesPerSession: MAX_SPOKEN_BYTES / 4,
	/** The screen's lines reach the service once a second at most, the latest of them. */
	screenIntervalMs: 1_000,
} as const;

/** A bucket that holds `burst` and fills again at `perSecond`. */
export class Bucket {
	private level: number;
	private at: number;

	constructor(
		private readonly perSecond: number,
		private readonly burst: number,
		now = Date.now(),
	) {
		this.level = burst;
		this.at = now;
	}

	/** Whether `cost` fits now. It is taken when it does, and nothing is when it does not. */
	take(cost: number, now = Date.now()): boolean {
		const filled = this.level + ((now - this.at) / 1000) * this.perSecond;
		this.level = Math.min(this.burst, filled);
		this.at = now;
		if (cost > this.level) return false;
		this.level -= cost;
		return true;
	}
}

/** The audio a session may still have refused before it ends: a minute's worth, refilled as `audioRefusedForgivenPerSecond` says. */
export function refusedAudioAllowance(now = Date.now()): Bucket {
	return new Bucket(
		INPUT_BUDGET.audioRefusedForgivenPerSecond,
		INPUT_BUDGET.audioRefusedBytesEnd,
		now,
	);
}
