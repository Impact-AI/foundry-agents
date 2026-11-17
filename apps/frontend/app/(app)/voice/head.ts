import type { VoicePhase } from "@/src/voice/machine";
import type { StatusTone } from "../../components/controls";

/**
 * The pane head's tone and status key for a phase. A failure is told once,
 * on the danger line the chat uses for its own, so the head of a failed
 * channel says only that it is closed.
 */
export function headOf(phase: VoicePhase): {
	tone: StatusTone;
	status: Exclude<VoicePhase, "error">;
} {
	switch (phase) {
		case "listening":
			return { tone: "live", status: phase };
		case "connecting":
		case "thinking":
		case "speaking":
			return { tone: "busy", status: phase };
		default:
			return { tone: "idle", status: "idle" };
	}
}
