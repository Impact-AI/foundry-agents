import { defineEventChannel } from "@platform/observability";

/**
 * How long a person waited for the voice, one line a turn.
 *
 * A live session's usage lines are one a response, and a turn is several: a
 * filler, the tools, the answer. What a person hears is none of those alone
 * — it is the quiet between their last word and the voice's first sound,
 * and between their last word and the answer. So each turn writes one
 * `voice_turn` line of timings and counts, never words: when the voice was
 * first heard, when the answer was, how long each tool took, how many
 * responses it asked for, whether the person spoke over it and how it ended.
 *
 * The clock starts where this side can see the person stop: the service's
 * `speech_stopped`, which comes after its own turn detection has waited out
 * the pause, or the arrival of typed words. It stops at the first audio the
 * service sends for the turn. The relay's hop to the browser and the
 * browser's playback come after, and are not in the number.
 *
 * The line goes to stdout as the usage line does, under the same switch
 * (`LLM_USAGE_LOG`): it is the same kind of record, and has nothing of the
 * person's in it.
 */
export const VOICE_TURN_EVENT = "voice_turn";

export interface VoiceTurnLine {
	evt: typeof VOICE_TURN_EVENT;
	ts: string;
	/** The session, as a usage line's `turnId` is for a live session. */
	turnId: string;
	surface: string | null;
	/** The voice agent and its version, as a usage line's `model`. */
	model: string;
	/** Whether the person spoke the turn or typed it. */
	how: "spoken" | "typed";
	/** From the end of the person's words to the voice's first audio, a filler's or the answer's. Null when it said nothing. */
	firstAudioMs: number | null;
	/** From the end of the person's words to the answer's own first audio. Null when no answer was spoken. */
	answerAudioMs: number | null;
	/** Responses the turn asked the voice for. */
	responses: number;
	/** How long each tool the turn called took, summed by name. */
	toolMs: Record<string, number>;
	/** The person began speaking while the voice was still answering. */
	bargedIn: boolean;
	/** `answered`: an answer was spoken. `blocked`: the filter stopped it. `unanswered`: asking again did not get one. `silent`: none of those — the turn ended, or was overtaken, with no answer spoken. */
	outcome: "answered" | "blocked" | "unanswered" | "silent";
}

const turnChannel = defineEventChannel<VoiceTurnLine>({
	event: VOICE_TURN_EVENT,
	switchVar: "LLM_USAGE_LOG",
});

/** To a tenth of a millisecond, as a usage line's timings are. */
const tenth = (ms: number) => Math.round(ms * 10) / 10;

interface Turn {
	how: VoiceTurnLine["how"];
	from: number;
	firstAudio: number | null;
	answerAudio: number | null;
	responses: number;
	toolMs: Map<string, number>;
	bargedIn: boolean;
	ended: "blocked" | "unanswered" | null;
}

/** One session's turns, timed. Nothing here reads a word or a sound. */
export class TurnClock {
	private turn: Turn | null = null;
	/** When the service last heard the person stop: where the next spoken turn's wait begins. */
	private heardAt: number | null = null;
	private readonly calls = new Map<
		string,
		{ name: string; at: number; turn: Turn }
	>();

	constructor(
		private readonly session: {
			id: string;
			surface: string | null;
			model: string;
		},
		private readonly now: () => number = () => performance.now(),
	) {}

	/** The service heard the person stop speaking. */
	heard(): void {
		this.heardAt = this.now();
	}

	/** The person's words are in: the turn before is written, and this one's wait begins. */
	begin(how: VoiceTurnLine["how"]): void {
		this.close();
		const now = this.now();
		this.turn = {
			how,
			from: how === "spoken" ? (this.heardAt ?? now) : now,
			firstAudio: null,
			answerAudio: null,
			responses: 0,
			toolMs: new Map(),
			bargedIn: false,
			ended: null,
		};
		this.heardAt = null;
	}

	/** The voice was asked for a response. */
	response(): void {
		if (this.turn) this.turn.responses++;
	}

	/** A response's first audio: a filler's, or the answer's. */
	audio(answer: boolean): void {
		const turn = this.turn;
		if (!turn) return;
		const waited = this.now() - turn.from;
		turn.firstAudio ??= waited;
		if (answer) turn.answerAudio ??= waited;
	}

	/** A tool was called, */
	called(callId: string, name: string): void {
		if (this.turn)
			this.calls.set(callId, { name, at: this.now(), turn: this.turn });
	}

	/**
	 * and answered: here, by the browser, or for it when it did not. An
	 * answer that comes after its turn was written is counted nowhere: it is
	 * not the next turn's wait.
	 */
	returned(callId: string): void {
		const call = this.calls.get(callId);
		if (!call) return;
		this.calls.delete(callId);
		const { turn } = call;
		if (turn !== this.turn) return;
		turn.toolMs.set(
			call.name,
			(turn.toolMs.get(call.name) ?? 0) + this.now() - call.at,
		);
	}

	/** The person began speaking while a response was open. */
	spokenOver(): void {
		if (this.turn) this.turn.bargedIn = true;
	}

	/** The turn's answer was stopped by the filter, or could not be had. */
	ended(how: "blocked" | "unanswered"): void {
		if (this.turn) this.turn.ended ??= how;
	}

	/** Write the open turn's line, once: at the next turn, or at the session's end. */
	close(): void {
		const turn = this.turn;
		this.turn = null;
		if (!turn) return;
		// A call this turn made and nobody answered is counted nowhere now, and would otherwise hold the turn for the session's life.
		for (const [callId, call] of this.calls)
			if (call.turn === turn) this.calls.delete(callId);
		turnChannel.emit({
			evt: VOICE_TURN_EVENT,
			ts: new Date().toISOString(),
			turnId: this.session.id,
			surface: this.session.surface,
			model: this.session.model,
			how: turn.how,
			firstAudioMs: turn.firstAudio === null ? null : tenth(turn.firstAudio),
			answerAudioMs: turn.answerAudio === null ? null : tenth(turn.answerAudio),
			responses: turn.responses,
			toolMs: Object.fromEntries(
				[...turn.toolMs].map(([name, ms]) => [name, tenth(ms)]),
			),
			bargedIn: turn.bargedIn,
			outcome:
				turn.ended ?? (turn.answerAudio === null ? "silent" : "answered"),
		});
	}
}
