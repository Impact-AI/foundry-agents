import { expect, test } from "bun:test";
import { type Probe, Warmer } from "./warmup";

test("a warm in which every probe failed is tried again at the next call; one with something warm is trusted for the while", async () => {
	let runs = 0;
	let healthy = false;
	const warmer = new Warmer((): Probe[] => [
		[
			"store",
			async () => {
				runs++;
				if (!healthy) throw new Error("cold");
			},
		],
	]);
	await warmer.warm();
	await warmer.warm();
	expect(runs).toBe(2);
	healthy = true;
	await warmer.warm();
	await warmer.warm();
	expect(runs).toBe(3);
});

test("probes that cannot even be listed are logged, never thrown", async () => {
	const warmer = new Warmer(() => {
		throw new Error("no probes");
	});
	await warmer.warm();
});
