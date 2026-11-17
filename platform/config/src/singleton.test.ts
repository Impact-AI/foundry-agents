import { expect, test } from "bun:test";
import {
	hasSingleton,
	processSingleton,
	resetSingleton,
	setSingleton,
} from "./singleton";

test("one instance per key, created once, and asking whether one is held creates none", () => {
	let built = 0;
	const key = "singleton-test-a";
	expect(hasSingleton(key)).toBe(false);
	const first = processSingleton(key, () => ({ n: ++built }));
	const second = processSingleton(key, () => ({ n: ++built }));
	expect(second).toBe(first);
	expect(built).toBe(1);
	expect(hasSingleton(key)).toBe(true);
	resetSingleton(key);
	expect(hasSingleton(key)).toBe(false);
});

test("reset creates again; set injects", () => {
	const key = "singleton-test-b";
	processSingleton(key, () => "first");
	resetSingleton(key);
	expect(processSingleton(key, () => "second")).toBe("second");
	setSingleton(key, "injected");
	expect(processSingleton(key, () => "never")).toBe("injected");
	resetSingleton(key);
});
