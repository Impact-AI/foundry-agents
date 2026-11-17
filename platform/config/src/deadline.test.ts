import { expect, test } from "bun:test";
import { withDeadline } from "./deadline";

test("work that finishes in time is returned", async () => {
	const result = await withDeadline(
		async () => "done",
		1000,
		() => new Error("late"),
	);
	expect(result).toBe("done");
});

test("work that overruns costs the caller the deadline and is told to stop", async () => {
	let aborted = false;
	const started = Date.now();
	await expect(
		withDeadline(
			(signal) =>
				new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => {
						aborted = true;
						reject(new Error("aborted"));
					});
				}),
			50,
			() => new Error("late"),
		),
	).rejects.toThrow("late");
	expect(Date.now() - started).toBeLessThan(1000);
	expect(aborted).toBe(true);
});
