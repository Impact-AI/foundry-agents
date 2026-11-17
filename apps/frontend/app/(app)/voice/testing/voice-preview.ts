"use client";

import { useSyncExternalStore } from "react";
import { INITIAL, type VoicePhase, type VoiceState } from "@/src/voice/machine";

/**
 * Test-only: the voice pane drawn in a phase a test names, with no
 * microphone, no session and no engine. Compiled in only when the build
 * carries `NEXT_PUBLIC_VOICE_PREVIEW=1` — the dev-fake launcher's run — and
 * dead code otherwise, so a deployed bundle has no switch to find. A page
 * sets `window.__voicePreview` to a phase and dispatches `voice-preview`.
 */
const EVENT = "voice-preview";
const PHASES = new Set<VoicePhase>([
	"idle",
	"connecting",
	"listening",
	"thinking",
	"speaking",
	"error",
]);

declare global {
	interface Window {
		__voicePreview?: string;
	}
}

function read(): VoicePhase | null {
	if (process.env.NEXT_PUBLIC_VOICE_PREVIEW !== "1") return null;
	const phase = window.__voicePreview;
	return PHASES.has(phase as VoicePhase) ? (phase as VoicePhase) : null;
}

function subscribe(onChange: () => void): () => void {
	window.addEventListener(EVENT, onChange);
	return () => window.removeEventListener(EVENT, onChange);
}

export function useVoicePreview(): VoicePhase | null {
	return useSyncExternalStore(subscribe, read, () => null);
}

/** The machine's state for a previewed phase: open, unmuted, answering while it speaks. */
export function previewState(phase: VoicePhase): VoiceState {
	return {
		...INITIAL,
		phase,
		responding: phase === "speaking" || phase === "thinking",
		error: phase === "error" ? "session" : null,
	};
}
