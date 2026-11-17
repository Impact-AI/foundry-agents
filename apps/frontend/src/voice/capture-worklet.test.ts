import { expect, test } from "bun:test";

/**
 * The capture worklet as the audio thread runs it: the processor registered
 * under its name, `process` called with the device's 128-sample blocks, and
 * every frame posted transferred — so the buffer it posted is detached
 * afterwards, as Chrome's is. A frame sized off one already transferred
 * is empty, so a worklet that does that sends the session one frame and
 * then nothing.
 */

type Processor = {
	process(inputs: Float32Array[][]): boolean;
	port: { posted: ArrayBuffer[] };
};

async function capture(contextRate: number): Promise<Processor> {
	let made: (new (options: unknown) => Processor) | undefined;
	const scope = globalThis as Record<string, unknown>;
	const saved = {
		AudioWorkletProcessor: scope.AudioWorkletProcessor,
		registerProcessor: scope.registerProcessor,
		sampleRate: scope.sampleRate,
	};
	scope.sampleRate = contextRate;
	scope.AudioWorkletProcessor = class {
		port = {
			posted: [] as ArrayBuffer[],
			postMessage(data: ArrayBuffer, transfer: ArrayBuffer[]) {
				// What the port does: the receiver gets the bytes, the sender's buffer is emptied.
				this.posted.push(structuredClone(data, { transfer }));
			},
		};
	};
	scope.registerProcessor = (_name: string, ctor: typeof made) => {
		made = ctor;
	};
	try {
		const source = await Bun.file(
			`${import.meta.dir}/../../public/voice/capture-worklet.js`,
		).text();
		new Function(source)();
		if (!made) throw new Error("no processor registered");
		// The context's rate is read as the processor is made, as the audio thread's global.
		return new made({ processorOptions: { targetRate: 24_000 } });
	} finally {
		Object.assign(scope, saved);
	}
}

test("a second of microphone becomes twenty 50 ms frames, every one of them whole, not just the first", async () => {
	const processor = await capture(48_000);
	const block = new Float32Array(128).fill(0.25);
	for (let i = 0; i < 48_000 / 128; i++) processor.process([[block]]);
	const frames = processor.port.posted;
	expect(frames).toHaveLength(20);
	for (const frame of frames) {
		expect(frame.byteLength).toBe(2_400);
		expect(new Int16Array(frame)[0]).toBe(Math.trunc(0.25 * 0x7fff));
	}
});
