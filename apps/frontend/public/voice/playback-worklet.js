/**
 * The voice, played: mono PCM16 at the session's rate (24 kHz) posted from
 * the page as it arrives, resampled to the device's rate by linear
 * interpolation, and played in order with no gap of its own. `clear` drops
 * everything not yet played — the person started speaking over the voice,
 * and what it was saying is no longer worth hearing. The queue holds at
 * most a minute; past it the oldest audio goes, so a stalled tab cannot
 * grow without bound.
 */
const MAX_QUEUED_SECONDS = 60;

class PcmPlayback extends AudioWorkletProcessor {
	constructor(options) {
		super();
		const sourceRate = options.processorOptions?.sourceRate ?? 24000;
		this.step = sourceRate / sampleRate;
		// The queue is counted in the source's samples, so its bound is in the source's rate.
		this.maxQueued = MAX_QUEUED_SECONDS * sourceRate;
		this.chunks = [];
		this.queued = 0;
		this.offset = 0;
		this.position = 0;
		this.playing = false;
		this.port.onmessage = (event) => {
			if (event.data === "clear") {
				this.chunks = [];
				this.queued = 0;
				this.offset = 0;
				this.position = 0;
				return;
			}
			const pcm = new Int16Array(event.data);
			const samples = new Float32Array(pcm.length);
			for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 0x8000;
			this.chunks.push(samples);
			this.queued += samples.length;
			while (this.queued > this.maxQueued && this.chunks.length > 1) {
				const dropped = this.chunks.shift();
				this.queued -= dropped.length;
				this.offset = 0;
			}
		};
	}

	/** The source sample at `index` from the read position, across chunk boundaries; null past the end. */
	at(index) {
		let i = this.offset + index;
		for (const chunk of this.chunks) {
			if (i < chunk.length) return chunk[i];
			i -= chunk.length;
		}
		return null;
	}

	process(_inputs, outputs) {
		const output = outputs[0]?.[0];
		if (!output) return true;
		for (let i = 0; i < output.length; i++) {
			const whole = Math.floor(this.position);
			const a = this.at(whole);
			if (a === null) {
				output[i] = 0;
				continue;
			}
			const b = this.at(whole + 1) ?? a;
			const fraction = this.position - whole;
			output[i] = a + (b - a) * fraction;
			this.position += this.step;
			let advance = Math.floor(this.position);
			this.position -= advance;
			while (advance > 0 && this.chunks.length) {
				const head = this.chunks[0];
				const left = head.length - this.offset;
				if (advance < left) {
					this.offset += advance;
					advance = 0;
				} else {
					advance -= left;
					this.chunks.shift();
					this.queued -= head.length;
					this.offset = 0;
				}
			}
		}
		const playing = this.chunks.length > 0;
		if (playing !== this.playing) {
			this.playing = playing;
			this.port.postMessage({ playing });
		}
		return true;
	}
}

registerProcessor("pcm-playback", PcmPlayback);
