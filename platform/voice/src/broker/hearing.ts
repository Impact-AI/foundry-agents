/**
 * What a session heard from the person, read when it ends: how much audio
 * the browser sent, how loud the loudest of it was, and how often the voice
 * agent heard speech begin. A session that answered nothing reads its cause
 * off this one line — no frames is a browser that sent nothing, frames at a
 * peak near zero is a microphone that is silent, and frames with a peak and
 * no speech is the service not hearing a voice in them.
 */
export class Hearing {
	private frames = 0;
	private bytes = 0;
	private peak = 0;
	private speech = 0;

	/** A frame of the person's audio: PCM16, little-endian, mono. */
	frame(pcm: Uint8Array): void {
		this.frames++;
		this.bytes += pcm.byteLength;
		const samples = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
		for (let i = 0; i + 1 < pcm.byteLength; i += 2) {
			const level = Math.abs(samples.getInt16(i, true));
			if (level > this.peak) this.peak = level;
		}
	}

	/** The voice agent heard speech begin. */
	speechStarted(): void {
		this.speech++;
	}

	/** The line logged at the end: counts, and the peak as a share of full scale. */
	summary(): string {
		const peak = Math.min(1, this.peak / 32767).toFixed(3);
		return `the browser sent ${this.frames} audio frame(s), ${this.bytes} byte(s), peak ${peak} of full scale; speech heard ${this.speech} time(s)`;
	}
}
