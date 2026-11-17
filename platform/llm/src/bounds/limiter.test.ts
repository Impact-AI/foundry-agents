import { expect, test } from "bun:test";
import { createLimiter } from "./limiter";

/** Work that reports how many of its kind were running when it started. */
function tracked() {
	let running = 0;
	let peak = 0;
	const work = async (ms = 5) => {
		running++;
		peak = Math.max(peak, running);
		await Bun.sleep(ms);
		running--;
		return "done";
	};
	return { work, peak: () => peak };
}

test("no more than the cap runs at once, and every caller is served", async () => {
	const limiter = createLimiter(() => 3);
	const { work, peak } = tracked();
	const results = await Promise.all(
		Array.from({ length: 10 }, () => limiter.run(() => work())),
	);
	expect(results).toEqual(Array(10).fill("done"));
	expect(peak()).toBe(3);
	expect(limiter.active).toBe(0);
	expect(limiter.waiting).toBe(0);
});

test("a slot is released when the work throws", async () => {
	const limiter = createLimiter(() => 1);
	await expect(
		limiter.run(async () => {
			throw new Error("boom");
		}),
	).rejects.toThrow("boom");
	expect(limiter.active).toBe(0);
	expect(await limiter.run(async () => "next")).toBe("next");
});

test("callers are admitted in the order they arrived", async () => {
	const limiter = createLimiter(() => 1);
	const order: number[] = [];
	await Promise.all(
		[1, 2, 3].map((n) =>
			limiter.run(async () => {
				order.push(n);
				await Bun.sleep(1);
			}),
		),
	);
	expect(order).toEqual([1, 2, 3]);
});

test("the cap is read at each admission, so a retuned setting applies at once", async () => {
	let cap = 1;
	const limiter = createLimiter(() => cap);
	const { work, peak } = tracked();
	const first = Promise.all([
		limiter.run(() => work(20)),
		limiter.run(() => work(20)),
	]);
	await Bun.sleep(1);
	expect(limiter.waiting).toBe(1);
	cap = 4;
	await first;
	expect(peak()).toBe(1);
	await Promise.all(Array.from({ length: 4 }, () => limiter.run(() => work())));
	expect(peak()).toBe(4);
});

test("a cap of zero or less admits one at a time rather than nobody", async () => {
	const limiter = createLimiter(() => 0);
	expect(await limiter.run(async () => "served")).toBe("served");
});

test("a waiter whose request is aborted leaves the queue without a slot", async () => {
	const limiter = createLimiter(() => 1);
	const hold = limiter.run(() => Bun.sleep(30));
	const controller = new AbortController();
	const waiting = limiter.run(async () => "never", controller.signal);
	await Bun.sleep(1);
	expect(limiter.waiting).toBe(1);
	controller.abort();
	await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
	expect(limiter.waiting).toBe(0);
	await hold;
	expect(limiter.active).toBe(0);
	await expect(
		limiter.run(async () => "x", AbortSignal.abort()),
	).rejects.toMatchObject({ name: "AbortError" });
});

test("a release is idempotent", async () => {
	const limiter = createLimiter(() => 2);
	const release = await limiter.acquire();
	release();
	release();
	expect(limiter.active).toBe(0);
});
