import type { VoiceErrorCode } from "./machine";

/** A refused or missing microphone is a notice with a way past it, not a channel fault. */
function micFailure(err: unknown): VoiceErrorCode {
	const name =
		err instanceof Error
			? err.name
			: typeof err === "object" && err !== null && "name" in err
				? String((err as { name: unknown }).name)
				: "";
	switch (name) {
		case "NotAllowedError":
		case "PermissionDeniedError":
		case "SecurityError":
			return "micDenied";
		case "NotFoundError":
		case "DevicesNotFoundError":
		case "OverconstrainedError":
			return "micNone";
		default:
			return "mic";
	}
}

/**
 * The microphone, or the reason there is none. The browser cancels its own
 * echo and suppresses noise before anything is sent: the voice plays from
 * the same page, and a speaker the microphone hears would answer itself.
 */
export async function openMicrophone(): Promise<
	{ stream: MediaStream } | { error: VoiceErrorCode }
> {
	if (
		typeof window === "undefined" ||
		!window.isSecureContext ||
		!navigator.mediaDevices?.getUserMedia
	) {
		return { error: "insecure" };
	}
	try {
		return {
			stream: await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
					channelCount: 1,
				},
				video: false,
			}),
		};
	} catch (err) {
		return { error: micFailure(err) };
	}
}

export function stopStream(stream: MediaStream | null): void {
	for (const track of stream?.getTracks() ?? []) track.stop();
}
