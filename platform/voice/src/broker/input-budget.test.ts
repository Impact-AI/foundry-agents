import { expect, test } from "bun:test";
import { Bucket, INPUT_BUDGET, refusedAudioAllowance } from "./input-budget";

test("a bucket gives its burst at once, then only what has filled since, and never holds more than its burst", () => {
	const bucket = new Bucket(2, 4, 0);
	expect([1, 1, 1, 1].map((cost) => bucket.take(cost, 0))).toEqual([
		true,
		true,
		true,
		true,
	]);
	expect(bucket.take(1, 0)).toBe(false);
	// Half a second at two a second is one.
	expect(bucket.take(1, 500)).toBe(true);
	expect(bucket.take(1, 500)).toBe(false);
	// A long quiet fills it to the burst and no further.
	expect(bucket.take(5, 60_000)).toBe(false);
	expect(bucket.take(4, 60_000)).toBe(true);
});

test("a cost that does not fit takes nothing from the bucket", () => {
	const bucket = new Bucket(1, 3, 0);
	expect(bucket.take(4, 0)).toBe(false);
	expect(bucket.take(3, 0)).toBe(true);
});

const SECOND = INPUT_BUDGET.audioBytesPerSecond / 1.25;

test("a long session whose network stalls now and then is never ended for the audio refused, however much it adds up to", () => {
	const allowance = refusedAudioAllowance(0);
	// Ten seconds refused every two minutes for two hours: ten minutes refused in all.
	for (let minute = 2; minute <= 120; minute += 2)
		expect(allowance.take(10 * SECOND, minute * 60_000)).toBe(true);
});

test("audio sent steadily faster than it is taken still ends the session, within minutes", () => {
	const allowance = refusedAudioAllowance(0);
	// A second refused every second: twice as fast as a microphone, near enough.
	let second = 1;
	while (allowance.take(SECOND, second * 1000)) second++;
	expect(second).toBeGreaterThan(60);
	expect(second).toBeLessThan(120);
});
