/**
 * The microphone, as the live voice socket carries it: mono PCM16 at the
 * session's rate (24 kHz), in frames of 50 ms, posted to the page as
 * transferred buffers. The context runs at the device's rate; each output
 * sample is the mean of the input samples it stands for — a box filter,
 * which keeps a 48 kHz microphone's top octave from folding into speech —
 * and a context slower than the target repeats samples instead. A frame
 * posted is transferred, which empties it here, so the next one is made at
 * the size held aside rather than read off the one just sent.
 */
class PcmCapture extends AudioWorkletProcessor {
	constructor(options) {
		super();
		const target = options.processorOptions?.targetRate ?? 24000;
		this.ratio = sampleRate / target;
		this.size = Math.round(target / 20);
		this.frame = new Int16Array(this.size);
		this.fill = 0;
		this.sum = 0;
		this.count = 0;
		this.elapsed = 0;
		this.last = 0;
	}

	emit(value) {
		const clamped = Math.max(-1, Math.min(1, value));
		this.frame[this.fill++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
		if (this.fill === this.frame.length) {
			this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
			this.frame = new Int16Array(this.size);
			this.fill = 0;
		}
	}

	process(inputs) {
		const input = inputs[0]?.[0];
		if (!input) return true;
		for (let i = 0; i < input.length; i++) {
			const sample = input[i];
			this.sum += sample;
			this.count++;
			this.last = sample;
			this.elapsed += 1;
			while (this.elapsed >= this.ratio) {
				this.elapsed -= this.ratio;
				this.emit(this.count ? this.sum / this.count : this.last);
				this.sum = 0;
				this.count = 0;
			}
		}
		return true;
	}
}

registerProcessor("pcm-capture", PcmCapture);
