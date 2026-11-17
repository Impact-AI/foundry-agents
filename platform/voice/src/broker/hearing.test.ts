import { expect, test } from "bun:test";
import { Hearing } from "./hearing";

function pcm(...samples: number[]): Uint8Array {
	const out = new Uint8Array(samples.length * 2);
	const view = new DataView(out.buffer);
	samples.forEach((s, i) => {
		view.setInt16(i * 2, s, true);
	});
	return out;
}

test("nothing sent reads as nothing sent", () => {
	expect(new Hearing().summary()).toBe(
		"the browser sent 0 audio frame(s), 0 byte(s), peak 0.000 of full scale; speech heard 0 time(s)",
	);
});

test("a silent microphone reads as frames at a peak of zero", () => {
	const hearing = new Hearing();
	hearing.frame(pcm(0, 0, 0));
	hearing.frame(pcm(0, 0));
	expect(hearing.summary()).toBe(
		"the browser sent 2 audio frame(s), 10 byte(s), peak 0.000 of full scale; speech heard 0 time(s)",
	);
});

test("the loudest sample of either sign is the peak, and speech is counted", () => {
	const hearing = new Hearing();
	hearing.frame(pcm(100, -16384, 200));
	// A frame cut from a larger buffer at an offset still reads its own samples.
	const larger = pcm(32767, 50, -60);
	hearing.frame(larger.subarray(2));
	hearing.speechStarted();
	expect(hearing.summary()).toBe(
		"the browser sent 2 audio frame(s), 10 byte(s), peak 0.500 of full scale; speech heard 1 time(s)",
	);
});
