"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { type DocumentSource, readSources } from "@/src/chat/sources";
import type { ContextLine } from "@/src/stage/live-context";
import { type LiveEvent, machineEvent } from "@/src/voice/events";
import { INITIAL, reduce, type VoiceState } from "@/src/voice/machine";
import { frameLevel, unheardDetector } from "@/src/voice/unheard";
import { useWakeLock } from "../../components/use-wake-lock";
import { type LiveLink, openLiveLink } from "./live-link";
import type { VoiceTurn } from "./VoiceTranscript";

/**
 * The live session, as the pane uses it: the link opened while `enabled`
 * (and again for each `attempt`, which is how the pane reopens a session
 * after a replica's restart), the machine fed from the session's events,
 * the transcript lines and the documents an answer drew on handed up, and the stage driven from here as it is
 * from a typed turn — a stage call runs the same handler, and its answer is
 * sent back on the session's socket. What is on the stage is told to the
 * session whenever it changes. A session cannot be re-languaged: changing the locale ends it
 * and opens a new one. While it waits for the person, the microphone's
 * loudness is read off the meter, here and nowhere else, so the pane can say
 * when they are talking and the voice is not hearing them (`unheard`).
 */
export interface LiveOptions {
	locale: string;
	threadId: string;
	/** Increments to open a new session on the same thread. */
	attempt: number;
	onTurn: (turn: VoiceTurn) => void;
	/** The documents the answer just spoken drew on, as a typed reply's chips. */
	onSources: (sources: DocumentSource[]) => void;
	/** A stage call: the stage reacts, the answer is the status string. */
	onToolCall: (name: string, args: Record<string, unknown>) => Promise<string>;
	/** The screen's lines, sent when the session opens and whenever they change. */
	screen: readonly ContextLine[];
	/** The session's words are in the thread. */
	onSettled: (written: number) => void;
	/** The session took the thread, or let it go; said after `onSettled`, and after the pane closed. */
	onHeld: (held: boolean) => void;
}

/** How often the meter is read for the "can't hear you" hint. */
const LEVEL_EVERY_MS = 100;

/** What a stage call is answered with when its real answer could not be had: the session never waits for ever. */
const TOOL_ANSWER_LOST =
	"The control ran but its answer could not be delivered.";

export function useLiveVoice(
	enabled: boolean,
	{
		locale,
		threadId,
		attempt,
		onTurn,
		onSources,
		onToolCall,
		screen,
		onSettled,
		onHeld,
	}: LiveOptions,
) {
	const [state, dispatch] = useReducer(reduce, INITIAL);
	const stateRef = useRef<VoiceState>(state);
	stateRef.current = state;
	const turn = useRef(onTurn);
	turn.current = onTurn;
	const drewOn = useRef(onSources);
	drewOn.current = onSources;
	const call = useRef(onToolCall);
	call.current = onToolCall;
	const lines = useRef(screen);
	lines.current = screen;
	const settledRef = useRef(onSettled);
	settledRef.current = onSettled;
	const heldRef = useRef(onHeld);
	heldRef.current = onHeld;
	/** The stage calls the session is still waiting on, by id: each is answered or closed once. */
	const openCalls = useRef(new Set<string>());

	const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
	const [unheard, setUnheard] = useState(false);
	const detector = useRef(unheardDetector());
	/** The voice's audio still playing here, after its response may be done: its echo is not the person. */
	const playing = useRef(false);
	const link = useRef<LiveLink | null>(null);

	// The microphone's loudness while the session waits for the person: read here, never kept or sent.
	useEffect(() => {
		if (!analyser) return;
		const samples = new Float32Array(analyser.fftSize);
		const timer = setInterval(() => {
			const { phase, micOpen, responding } = stateRef.current;
			analyser.getFloatTimeDomainData(samples);
			setUnheard(
				detector.current.sample(
					performance.now(),
					frameLevel(samples),
					phase === "listening" && micOpen && !responding && !playing.current,
				),
			);
		}, LEVEL_EVERY_MS);
		return () => {
			clearInterval(timer);
			detector.current.clear();
			setUnheard(false);
		};
	}, [analyser]);

	// The stage, whenever it changes while the session is open.
	useEffect(() => {
		if (enabled) link.current?.screen(screen);
	}, [enabled, screen]);

	const stageCall = useCallback(
		(callId: string, name: string, args: Record<string, unknown>) => {
			openCalls.current.add(callId);
			dispatch({ type: "tool_called", name });
			const answer = (output: string) => {
				// The server may have closed the call while the control ran: it is counted down once.
				if (openCalls.current.delete(callId))
					dispatch({ type: "tool_answered" });
				link.current?.answer(callId, output);
			};
			void call
				.current(name, args)
				.then(answer)
				.catch(() => answer(TOOL_ANSWER_LOST));
		},
		[],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt is a new session
	useEffect(() => {
		if (!enabled) return;
		const onEvent = (live: LiveEvent) => {
			const event = machineEvent(live);
			if (event) dispatch(event);
			if (live.type === "speech" && live.state === "started") {
				detector.current.heard();
				setUnheard(false);
			} else if (live.type === "speech" && live.state === "stopped")
				detector.current.stopped();
			if (live.type === "line" && live.text.trim())
				turn.current({ role: live.role, text: live.text.trim() });
			else if (live.type === "sources") {
				const sources = readSources(live.sources);
				if (sources.length) drewOn.current(sources);
			} else if (live.type === "stage-call")
				stageCall(live.callId, live.name, live.args);
			else if (
				live.type === "stage-call-closed" &&
				openCalls.current.delete(live.callId)
			)
				dispatch({ type: "tool_answered" });
		};
		const opened = openLiveLink({
			threadId,
			dispatch,
			analyser: setAnalyser,
			micOpen: () => stateRef.current.micOpen,
			screen: () => [...lines.current],
			event: onEvent,
			settled: (written) => settledRef.current(written),
			held: (held) => heldRef.current(held),
			playing: (now) => {
				playing.current = now;
			},
		});
		link.current = opened;
		return () => {
			link.current = null;
			openCalls.current.clear();
			opened.close();
			dispatch({ type: "close" });
		};
	}, [enabled, locale, threadId, attempt, stageCall]);

	const toggleMic = useCallback(() => {
		const next = !stateRef.current.micOpen;
		link.current?.setMic(next);
		dispatch({ type: next ? "unmute" : "mute" });
	}, []);

	/** Words typed while the session is open go into it; false when it is not, so they can wait instead. */
	const say = useCallback((text: string) => {
		const { phase } = stateRef.current;
		if (phase !== "listening" && phase !== "thinking" && phase !== "speaking")
			return false;
		return link.current?.say(text) ?? false;
	}, []);

	useWakeLock(enabled && state.phase !== "idle" && state.phase !== "error");

	return { state, analyser, toggleMic, say, unheard };
}
